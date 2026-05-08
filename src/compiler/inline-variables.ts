// Port of jscomp/InlineVariables.java (subset).
//
// Closure's InlineVariables is a 1000+ LOC pass driving ReferenceCollector
// to find variables safe to inline. We port the subset that complements
// flow-sensitive-inline-variables.ts (which handles intra-function flow):
//
//   - `const|let x = <pure>;` declared once, read exactly once → replace
//     the read with the init and drop the declarator.
//   - Works at any scope (module, function, block) — handy at module level
//     where flow-sensitive bails by design.
//
// What's intentionally out of scope for v1:
//   - Alias inlining (`const a = b; ...a...` where `b` is impure but `a`
//     is a clean alias). Closure has a dedicated `VarExpert` for this; we
//     skip it because most aliases evaporate via flow-sensitive inline.
//   - Multi-use inlining of literals. Useful but requires a cost model
//     (size impact) — `peephole-fold-constants` already covers many cases.
//   - CONSTANTS_ONLY / LOCALS_ONLY / ALL mode toggles. We always operate
//     in the equivalent of LOCALS_ONLY+module behavior.
//
// We rely on Babel's scope analysis — `path.scope.getBinding(name)` —
// instead of porting `ReferenceCollector`. Iterates to fixpoint because
// inlining one variable can make another's reference count drop to 1.

import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

import { mayHaveSideEffects } from './ast-analyzer';
import { traverse } from './babel-interop';

export type InlineVariablesResult = {
    /** Number of variables inlined (equal to declarators removed). */
    inlined: number;
};

export function inlineVariables(ast: t.File): InlineVariablesResult {
    let total = 0;
    while (true) {
        const round = sweep(ast);
        if (round === 0) break;
        total += round;
    }
    return { inlined: total };
}

function sweep(ast: t.File): number {
    let inlined = 0;

    traverse(ast, {
        // Force a scope rebuild — our previous round's mutations may have
        // changed reference counts.
        Program(path) {
            path.scope.crawl();
        },

        VariableDeclarator(path) {
            // v1: only `const|let x = INIT` — skip destructuring.
            if (!t.isIdentifier(path.node.id)) return;
            const init = path.node.init;
            if (!init) return;

            const name = path.node.id.name;
            const binding = path.scope.getBinding(name);
            if (!binding) return;

            // Treat `let` as inlineable only if it's never reassigned.
            if (binding.constantViolations.length > 0) return;
            if (binding.references !== 1) return;

            // Don't strip exported declarations.
            if (path.parentPath?.parent && t.isExportDeclaration(path.parentPath.parent)) return;

            // Init must be pure — we're moving it to a new evaluation point.
            if (mayHaveSideEffects(init)) return;

            // Free identifiers in init must reference bindings that are
            // never written. Otherwise relocating the read may observe a
            // different value.
            const initPath = path.get('init') as NodePath<t.Expression | null | undefined>;
            if (!initPath.node) return;
            if (initFreeVarsAreUnstable(initPath as NodePath<t.Expression>, path.scope)) return;

            const refPath = binding.referencePaths[0];
            if (!refPath) return;

            // Don't inline across async/generator/yield boundaries — a
            // suspended frame may observe a different world at resume.
            if (crossesAsyncBoundary(path, refPath)) return;

            // Don't inline into a loop body when the def sits outside it —
            // would re-evaluate `init` once per iteration. Exception: a
            // primitive literal is free to re-evaluate, so allow it.
            if (!isPrimitiveLiteral(init) && useIsInsideLoopOutOfDef(path, refPath)) return;

            // Don't inline a var hoisted from a conditional — the def may
            // not have executed before the use.
            if (defIsConditional(path, refPath)) return;

            // Replace the read with a clone of init, then drop the declarator.
            refPath.replaceWith(t.cloneNode(init, /* deep */ true, /* withoutLoc */ false));
            path.remove();
            inlined++;
        },
    });

    return inlined;
}

// True if init reads any identifier that may change between def site and
// use site. Property keys, member-access names, label names, etc. are
// skipped — handled by Babel's `ReferencedIdentifier` virtual visitor.
function initFreeVarsAreUnstable(initPath: NodePath<t.Expression>, scope: NodePath['scope']): boolean {
    let unstable = false;
    initPath.traverse({
        ReferencedIdentifier(p) {
            if (unstable) return;
            const b = scope.getBinding(p.node.name);
            if (!b) {
                // Global or `undefined` — can't prove stable.
                unstable = true;
                return;
            }
            if (b.constantViolations.length > 0) unstable = true;
        },
    });
    // Don't forget initPath itself if it's a bare identifier — `traverse`
    // visits children, not the root.
    if (!unstable && t.isIdentifier(initPath.node)) {
        const b = scope.getBinding(initPath.node.name);
        if (!b) return true;
        if (b.constantViolations.length > 0) return true;
    }
    return unstable;
}

function crossesAsyncBoundary(defPath: NodePath, usePath: NodePath): boolean {
    // Walk usePath upwards until we hit defPath's enclosing function (or
    // Program). If we cross any async / generator function boundary, bail.
    const defFn = defPath.getFunctionParent() ?? defPath.scope.getProgramParent().path;
    let p: NodePath | null = usePath;
    while (p && p.node !== defFn.node) {
        if (
            (t.isFunction(p.node) || t.isFunctionDeclaration(p.node) || t.isFunctionExpression(p.node) || t.isArrowFunctionExpression(p.node)) &&
            // biome-ignore lint/suspicious/noExplicitAny: union narrowing
            ((p.node as any).async === true || (p.node as any).generator === true)
        ) {
            return true;
        }
        p = p.parentPath;
    }
    return false;
}

// A primitive literal is cheap to re-evaluate (no allocation, no observable
// side effect, value identity is the value itself). Safe to inline into a
// loop body.
function isPrimitiveLiteral(n: t.Expression): boolean {
    if (
        t.isNumericLiteral(n) ||
        t.isStringLiteral(n) ||
        t.isBooleanLiteral(n) ||
        t.isNullLiteral(n) ||
        t.isBigIntLiteral(n)
    ) {
        return true;
    }
    if (t.isIdentifier(n) && n.name === 'undefined') return true;
    return false;
}

// True iff the def's binding is hoisted out of a conditional construct (if,
// switch case, &&/||/?? branch, or hook branch) that doesn't enclose the use.
// Inlining would relocate work from the conditional path to the unconditional
// site of the use.
function defIsConditional(defPath: NodePath, usePath: NodePath): boolean {
    // Collect the use's ancestor chain so we can check containment.
    const useAncestors = new Set<t.Node>();
    let up: NodePath | null = usePath;
    while (up) {
        useAncestors.add(up.node);
        up = up.parentPath;
    }
    let p: NodePath | null = defPath.parentPath;
    while (p) {
        if (useAncestors.has(p.node)) return false; // common ancestor reached
        if (
            t.isIfStatement(p.node) ||
            t.isSwitchCase(p.node) ||
            t.isConditionalExpression(p.node) ||
            (t.isLogicalExpression(p.node) && (p.node.operator === '&&' || p.node.operator === '||' || p.node.operator === '??'))
        ) {
            return true;
        }
        p = p.parentPath;
    }
    return false;
}

function useIsInsideLoopOutOfDef(defPath: NodePath, usePath: NodePath): boolean {
    let p: NodePath | null = usePath.parentPath;
    while (p && p.node !== defPath.node) {
        if (
            t.isForStatement(p.node) ||
            t.isForInStatement(p.node) ||
            t.isForOfStatement(p.node) ||
            t.isWhileStatement(p.node) ||
            t.isDoWhileStatement(p.node)
        ) {
            return true;
        }
        p = p.parentPath;
    }
    return false;
}
