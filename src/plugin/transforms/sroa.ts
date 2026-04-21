import { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { hasSroaAnnotation } from '../analyses/discover';
import { generate, traverse } from '../util/babel';

/**
 * Scalar Replacement of Aggregates (SROA).
 *
 * Converts `const v = [a, b, c]` + constant-index accesses (`v[0]`, `v[1]`,
 * `v[2]`) into scalar locals `let v_0 = a, v_1 = b, v_2 = c` with the
 * accesses rewritten. This is purely a readability/codegen win for hot loops
 * that manipulate tuple-shaped data (vec3, quat, mat4) — downstream V8 can
 * keep the components in registers rather than as array slots.
 *
 * Opt-in via `/* @sroa *​/` annotation on either:
 *   - the VariableDeclaration itself, or
 *   - an enclosing function / arrow-bound const.
 * File-level annotation is intentionally not supported — pick a scope.
 *
 * Safety is guarded by escape analysis on the declaring scope only (so a
 * same-name variable in another function doesn't create false escapes). A
 * candidate escapes on any non-indexed reference, spread, passing to a
 * function, assigning to another name, using a non-constant/out-of-bounds
 * index, or accessing a member property like `.length`.
 */

export type SroaOptions = Record<string, never>;

type Candidate = {
    name: string;
    size: number;
    initExprs: (t.Expression | undefined)[];
    declaratorNode: t.VariableDeclarator;
    declarationStatement: t.VariableDeclaration;
    /** enclosing function body or Program — escape-analysis boundary */
    scopeNode: t.Node;
};

export function applySroa(ast: t.File): boolean {
    const candidates = collectCandidates(ast);
    if (candidates.length === 0) return false;

    const safe: Candidate[] = [];
    for (const c of candidates) {
        if (passesEscapeAnalysis(c.scopeNode, c.name, c.size, c.declaratorNode.id as t.Identifier)) {
            safe.push(c);
        }
    }
    if (safe.length === 0) return false;

    rewriteDeclarations(safe);
    rewriteAccesses(ast, safe);
    return true;
}

// ============================================================================
// Phase 1: collect candidates
// ============================================================================

function collectCandidates(ast: t.File): Candidate[] {
    const out: Candidate[] = [];

    traverse(ast, {
        VariableDeclarator(declaratorPath) {
            const declarator = declaratorPath.node;
            if (!t.isIdentifier(declarator.id)) return;
            if (!declarator.init) return;

            const init = inferInitializer(declarator.init);
            if (!init) return;

            const annotatedSize = inferSizeFromAnnotation(ast, declarator);
            if (annotatedSize !== null && annotatedSize !== init.size) return;

            const declPath = declaratorPath.parentPath;
            if (!declPath || !t.isVariableDeclaration(declPath.node)) return;

            if (!isSroaEnabled(declaratorPath)) return;

            out.push({
                name: (declarator.id as t.Identifier).name,
                size: init.size,
                initExprs: init.initExprs,
                declaratorNode: declarator,
                declarationStatement: declPath.node,
                scopeNode: findEnclosingScope(declaratorPath),
            });
        },
    });

    return out;
}

function inferInitializer(
    init: t.Expression,
): { size: number; initExprs: (t.Expression | undefined)[] } | null {
    if (!t.isArrayExpression(init)) return null;

    const size = init.elements.length;
    // Below 2 there's nothing to gain; above 16 the scalar explosion hurts.
    if (size < 2 || size > 16) return null;

    const exprs: (t.Expression | undefined)[] = [];
    for (const el of init.elements) {
        if (el === null || t.isSpreadElement(el)) return null;
        exprs.push(el);
    }
    return { size, initExprs: exprs };
}

function inferSizeFromAnnotation(ast: t.File, declarator: t.VariableDeclarator): number | null {
    const annotation = (declarator.id as t.Identifier).typeAnnotation;
    if (!annotation || !t.isTSTypeAnnotation(annotation)) return null;
    const typeNode = annotation.typeAnnotation;
    if (!t.isTSTupleType(typeNode)) {
        if (t.isTSTypeReference(typeNode) && t.isIdentifier(typeNode.typeName)) {
            return resolveTupleTypeSize(ast, typeNode.typeName.name);
        }
        return null;
    }
    return typeNode.elementTypes.length;
}

function resolveTupleTypeSize(ast: t.File, typeName: string): number | null {
    for (const stmt of ast.program.body) {
        if (!t.isTSTypeAliasDeclaration(stmt)) continue;
        if (stmt.id.name !== typeName) continue;
        if (!t.isTSTupleType(stmt.typeAnnotation)) continue;
        return stmt.typeAnnotation.elementTypes.length;
    }
    return null;
}

function isSroaEnabled(declaratorPath: NodePath<t.VariableDeclarator>): boolean {
    let current: NodePath | null = declaratorPath.parentPath;
    while (current && !t.isProgram(current.node)) {
        if (hasSroaAnnotation(current.node)) return true;
        current = current.parentPath;
    }
    return false;
}

function findEnclosingScope(path: NodePath): t.Node {
    let current = path.parentPath;
    while (current) {
        if (
            t.isFunctionDeclaration(current.node) ||
            t.isFunctionExpression(current.node) ||
            t.isArrowFunctionExpression(current.node) ||
            t.isProgram(current.node)
        ) {
            return current.node;
        }
        current = current.parentPath;
    }
    return path.node;
}

// ============================================================================
// Phase 2: escape analysis
// ============================================================================

function passesEscapeAnalysis(
    scopeNode: t.Node,
    name: string,
    size: number,
    declaratorId: t.Identifier,
): boolean {
    let safe = true;

    const wrapper = t.isProgram(scopeNode)
        ? t.file(scopeNode, [], [])
        : t.file(
              t.program([
                  t.isStatement(scopeNode)
                      ? scopeNode
                      : t.expressionStatement(scopeNode as t.Expression),
              ]),
              [],
              [],
          );

    traverse(wrapper, {
        Identifier(path) {
            if (!safe) {
                path.stop();
                return;
            }
            if (path.node.name !== name) return;
            if (path.node === declaratorId) return;
            if (!path.isReferencedIdentifier()) return;

            const parent = path.parent;
            if (t.isMemberExpression(parent) && parent.object === path.node) {
                if (parent.computed && t.isNumericLiteral(parent.property)) {
                    const idx = parent.property.value;
                    if (idx >= 0 && idx < size && Number.isInteger(idx)) return;
                }
                safe = false;
                return;
            }
            safe = false;
        },
        // Nested functions that shadow the name are a different binding; skip.
        FunctionDeclaration(path) {
            if (path.node.params.some((p) => t.isIdentifier(p) && p.name === name)) path.skip();
        },
        FunctionExpression(path) {
            if (path.node.params.some((p) => t.isIdentifier(p) && p.name === name)) path.skip();
        },
        ArrowFunctionExpression(path) {
            if (path.node.params.some((p) => t.isIdentifier(p) && p.name === name)) path.skip();
        },
    });

    return safe;
}

// ============================================================================
// Phase 3: rewrite declarations + accesses
// ============================================================================

function rewriteDeclarations(safe: Candidate[]): void {
    for (const c of safe) {
        const newDeclarators: t.VariableDeclarator[] = [];
        for (let i = 0; i < c.size; i++) {
            const scalarName = `${c.name}_${i}`;
            const initExpr = c.initExprs[i]
                ? t.cloneNode(c.initExprs[i]!, true, false)
                : t.identifier('undefined');
            newDeclarators.push(t.variableDeclarator(t.identifier(scalarName), initExpr));
        }

        const declStmt = c.declarationStatement;
        const idx = declStmt.declarations.indexOf(c.declaratorNode);
        if (idx === -1) continue;

        if (declStmt.declarations.length === 1) {
            // `const` → `let` because we may write to the scalars later.
            declStmt.kind = 'let';
            declStmt.declarations = newDeclarators;
            tagAppliedSroa(declStmt, c.name, c.initExprs);
        } else {
            declStmt.declarations.splice(idx, 1, ...newDeclarators);
            // Multi-decl — tag the first new declarator so the breadcrumb sits
            // adjacent to the scalars without being mistaken for a directive
            // on the sibling declarations.
            tagAppliedSroa(newDeclarators[0], c.name, c.initExprs);
        }
    }
}

/**
 * Add a leading ` @applied-sroa <name> [<init0>, <init1>, ...] ` block comment,
 * preserving the original initializer expressions so the breadcrumb reflects
 * real values (e.g. `[0, 0, 0, 1]` for an identity quat) rather than indices.
 * The `@applied-*` prefix marks compilecat-emitted breadcrumbs — never user-
 * authored — so they're trivially distinguishable from consumable directives.
 */
function tagAppliedSroa(node: t.Node, name: string, initExprs: (t.Expression | undefined)[]): void {
    const parts = initExprs.map((e) =>
        e ? generate(e, { concise: true, comments: false }).code : 'undefined',
    );
    t.addComment(node, 'leading', ` @applied-sroa ${name} [${parts.join(', ')}] `);
}

function rewriteAccesses(ast: t.File, safe: Candidate[]): void {
    const byScope = new Map<t.Node, Candidate[]>();
    for (const c of safe) {
        const list = byScope.get(c.scopeNode) ?? [];
        list.push(c);
        byScope.set(c.scopeNode, list);
    }

    traverse(ast, {
        MemberExpression(path) {
            if (!path.node.computed) return;
            if (!t.isIdentifier(path.node.object)) return;
            if (!t.isNumericLiteral(path.node.property)) return;

            const name = path.node.object.name;

            let scopeNode: t.Node | null = null;
            let cursor: NodePath | null = path.parentPath;
            while (cursor) {
                if (byScope.has(cursor.node)) {
                    scopeNode = cursor.node;
                    break;
                }
                cursor = cursor.parentPath;
            }
            if (!scopeNode) return;

            const candidate = byScope.get(scopeNode)!.find((c) => c.name === name);
            if (!candidate) return;

            const idx = path.node.property.value;
            path.replaceWith(t.identifier(`${candidate.name}_${idx}`));
        },
    });
}
