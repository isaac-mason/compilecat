import { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { DIRECTIVE_PATTERNS } from '../analyses/directives';
import { hasUnrollAnnotation } from '../analyses/discover';
import { traverse } from '../util/babel';

/**
 * Loop unrolling.
 *
 * Replaces an opt-in `/* @cc-unroll *​/` loop with a flat sequence of its body,
 * one copy per iteration, with the loop variable substituted by its concrete
 * value. Works on:
 *
 *   - `for (let i = <lit>; i <(=) <lit>; i(++|+= <lit>)) { ... }`
 *   - `for (const x of <array literal | const array binding>) { ... }`
 *
 * Unrolling is only safe when the trip count is statically known and the body
 * contains no break/continue/return that would cross the loop boundary. A
 * loop that fails any precondition is left untouched with a console.warn
 * pointing at the source location — this is a soft-failure channel for
 * silent no-ops.
 *
 * Nested `@cc-unroll` directives are handled by running the pass to a fixpoint
 * (with a hard ceiling on total passes to guard against pathological input).
 */

const MAX_UNROLL_ITERATIONS = 1024;
const MAX_UNROLL_PASSES = 16;

type LoopShape = {
    varName: string;
    start: number;
    bound: number;
    /** `i <= N` vs `i < N` */
    inclusive: boolean;
    step: number;
};

export function applyUnroll(ast: t.File): boolean {
    let anyChange = false;
    for (let pass = 0; pass < MAX_UNROLL_PASSES; pass++) {
        if (!unrollPass(ast)) break;
        anyChange = true;
    }
    return anyChange;
}

function unrollPass(ast: t.File): boolean {
    let changed = false;

    traverse(ast, {
        ForStatement(path) {
            if (!hasUnrollAnnotation(path.node)) return;
            if (unrollForStatement(path)) changed = true;
        },
        ForOfStatement(path) {
            if (!hasUnrollAnnotation(path.node)) return;
            if (unrollForOfStatement(path)) changed = true;
        },
    });

    return changed;
}

// ============================================================================
// for (let i = 0; i < N; i++) — classic counted loop
// ============================================================================

function unrollForStatement(path: NodePath<t.ForStatement>): boolean {
    const shape = parseLoopShape(path.node);
    if (!shape) {
        warn(path.node, 'could not determine loop shape');
        stripUnrollComments(path.node);
        return false;
    }

    const values = computeIterationValues(shape);
    if (!values) {
        warn(path.node, `trip count exceeds maximum (${MAX_UNROLL_ITERATIONS})`);
        stripUnrollComments(path.node);
        return false;
    }

    if (values.length === 0) {
        path.remove();
        return true;
    }

    if (bodyHasUnsafeControlFlow(path.node.body)) {
        warn(path.node, 'loop body contains break/continue/return');
        stripUnrollComments(path.node);
        return false;
    }

    const bodyStmts = t.isBlockStatement(path.node.body) ? path.node.body.body : [path.node.body];
    const unrolled: t.Statement[] = [];
    for (const value of values) {
        for (const stmt of bodyStmts) {
            unrolled.push(cloneAndSubstitute(stmt, shape.varName, t.numericLiteral(value)));
        }
    }

    // Strip @cc-unroll off the original before replaceWithMultiple — otherwise
    // babel transfers the leading comment onto the first replacement statement
    // and the next pass would try to unroll it again (the replacement isn't a
    // loop, but the warning path would fire).
    stripUnrollComments(path.node);
    path.replaceWithMultiple(unrolled);
    return true;
}

function parseLoopShape(node: t.ForStatement): LoopShape | null {
    const init = node.init;
    if (!t.isVariableDeclaration(init) || init.declarations.length !== 1) return null;

    const declarator = init.declarations[0];
    if (!t.isIdentifier(declarator.id)) return null;
    if (!declarator.init || !t.isNumericLiteral(declarator.init)) return null;

    const varName = declarator.id.name;
    const start = declarator.init.value;

    const test = node.test;
    if (!t.isBinaryExpression(test)) return null;
    if (!t.isIdentifier(test.left) || test.left.name !== varName) return null;
    if (!t.isNumericLiteral(test.right)) return null;
    const bound = test.right.value;

    let inclusive: boolean;
    if (test.operator === '<') inclusive = false;
    else if (test.operator === '<=') inclusive = true;
    else return null;

    const update = node.update;
    if (!update) return null;

    let step: number;
    if (t.isUpdateExpression(update)) {
        if (!t.isIdentifier(update.argument) || update.argument.name !== varName) return null;
        if (update.operator !== '++') return null;
        step = 1;
    } else if (t.isAssignmentExpression(update)) {
        if (!t.isIdentifier(update.left) || update.left.name !== varName) return null;
        if (!t.isNumericLiteral(update.right)) return null;
        if (update.operator !== '+=') return null;
        step = update.right.value;
    } else {
        return null;
    }

    if (step <= 0 || !Number.isInteger(step)) return null;

    return { varName, start, bound, inclusive, step };
}

function computeIterationValues(shape: LoopShape): number[] | null {
    const values: number[] = [];
    const limit = shape.inclusive ? shape.bound + 1 : shape.bound;
    for (let i = shape.start; i < limit; i += shape.step) {
        values.push(i);
        if (values.length > MAX_UNROLL_ITERATIONS) return null;
    }
    return values;
}

// ============================================================================
// for (const x of [...]) — iterable-unroll
// ============================================================================

function unrollForOfStatement(path: NodePath<t.ForOfStatement>): boolean {
    const node = path.node;

    if (!t.isVariableDeclaration(node.left)) {
        warn(node, 'for-of left-hand side must be a variable declaration');
        stripUnrollComments(node);
        return false;
    }
    if (node.left.declarations.length !== 1 || !t.isIdentifier(node.left.declarations[0].id)) {
        warn(node, 'for-of must declare a single identifier');
        stripUnrollComments(node);
        return false;
    }

    const varName = (node.left.declarations[0].id as t.Identifier).name;

    const elements = resolveStaticIterable(node.right, path);
    if (!elements) {
        warn(node, 'could not resolve for-of iterable to static values');
        stripUnrollComments(node);
        return false;
    }

    if (elements.length > MAX_UNROLL_ITERATIONS) {
        warn(node, `for-of iterable exceeds maximum (${MAX_UNROLL_ITERATIONS})`);
        stripUnrollComments(node);
        return false;
    }

    if (elements.length === 0) {
        path.remove();
        return true;
    }

    if (bodyHasUnsafeControlFlow(node.body)) {
        warn(node, 'for-of body contains break/continue/return');
        stripUnrollComments(node);
        return false;
    }

    const bodyStmts = t.isBlockStatement(node.body) ? node.body.body : [node.body];
    const unrolled: t.Statement[] = [];
    for (const element of elements) {
        for (const stmt of bodyStmts) {
            unrolled.push(cloneAndSubstitute(stmt, varName, element));
        }
    }

    stripUnrollComments(node);
    path.replaceWithMultiple(unrolled);
    return true;
}

function resolveStaticIterable(
    right: t.Expression,
    path: NodePath<t.ForOfStatement>,
): t.Expression[] | null {
    if (t.isArrayExpression(right)) {
        return collectArrayElements(right);
    }
    if (t.isIdentifier(right)) {
        const binding = path.scope.getBinding(right.name);
        if (!binding || binding.kind !== 'const') return null;
        const declarator = binding.path.node;
        if (!t.isVariableDeclarator(declarator)) return null;
        if (!declarator.init || !t.isArrayExpression(declarator.init)) return null;
        return collectArrayElements(declarator.init);
    }
    return null;
}

function collectArrayElements(arr: t.ArrayExpression): t.Expression[] | null {
    const out: t.Expression[] = [];
    for (const el of arr.elements) {
        if (el === null || t.isSpreadElement(el)) return null;
        out.push(el);
    }
    return out;
}

// ============================================================================
// shared: substitute loop var into cloned body, control-flow safety, comments
// ============================================================================

function bodyHasUnsafeControlFlow(body: t.Statement): boolean {
    return walk(body, false, false);

    function walk(node: t.Node, insideNestedLoop: boolean, insideFunction: boolean): boolean {
        if (!node) return false;
        if (t.isReturnStatement(node) && !insideFunction) return true;
        if ((t.isBreakStatement(node) || t.isContinueStatement(node)) && !insideNestedLoop) {
            return true;
        }
        if (t.isFunction(node)) {
            insideFunction = true;
            insideNestedLoop = true;
        }
        if (
            t.isForStatement(node) ||
            t.isWhileStatement(node) ||
            t.isDoWhileStatement(node) ||
            t.isForInStatement(node) ||
            t.isForOfStatement(node) ||
            t.isSwitchStatement(node)
        ) {
            insideNestedLoop = true;
        }
        for (const key of t.VISITOR_KEYS[node.type] || []) {
            const child = (node as unknown as Record<string, unknown>)[key];
            if (Array.isArray(child)) {
                for (const item of child) {
                    if (item && typeof item === 'object' && 'type' in item) {
                        if (walk(item as t.Node, insideNestedLoop, insideFunction)) return true;
                    }
                }
            } else if (child && typeof child === 'object' && 'type' in (child as object)) {
                if (walk(child as t.Node, insideNestedLoop, insideFunction)) return true;
            }
        }
        return false;
    }
}

function cloneAndSubstitute(
    stmt: t.Statement,
    varName: string,
    replacement: t.Expression,
): t.Statement {
    const cloned = t.cloneNode(stmt, true, false);
    const wrapper = t.file(t.program([cloned]), [], []);

    traverse(wrapper, {
        Identifier(idPath) {
            if (idPath.node.name !== varName) return;
            // skip declaration IDs (e.g. `let ${varName} = ...` inside body)
            if (idPath.parentPath?.isVariableDeclarator() && idPath.key === 'id') return;
            // skip when a closer scope shadows the loop var
            if (
                idPath.scope.hasOwnBinding(varName) &&
                idPath.scope.getBindingIdentifier(varName) !== idPath.node
            ) {
                return;
            }
            // property keys and labels aren't referenced identifiers
            if (!idPath.isReferencedIdentifier()) return;

            idPath.replaceWith(t.cloneNode(replacement, true, false));
        },
        Function(fnPath) {
            if (fnPath.scope.hasOwnBinding(varName)) fnPath.skip();
        },
    });

    return wrapper.program.body[0];
}

function stripUnrollComments(node: t.Node): void {
    if (!node.leadingComments) return;
    node.leadingComments = node.leadingComments.filter(
        (c) => !(c.type === 'CommentBlock' && DIRECTIVE_PATTERNS.unroll.test(c.value)),
    );
    if (node.leadingComments.length === 0) {
        node.leadingComments = null as unknown as t.Comment[];
    }
}

function warn(node: t.Node, reason: string): void {
    const loc = node.loc?.start;
    const locStr = loc ? ` (line ${loc.line})` : '';
    console.warn(`[compilecat] @cc-unroll: ${reason}${locStr}, skipping`);
}
