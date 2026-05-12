// Helper used by LiveVariablesAnalysis (and downstream DeadAssignmentsElim,
// MustBeReachingVariableDef, MaybeReachingVariableUse, FlowSensitiveInline).
//
// Closure has a full Scope/Var/ScopeCreator stack (jscomp/Scope.java +
// SyntacticScopeCreator etc., ~1000 LOC). Rather than port that stack, we
// lean on Babel's already-correct `path.scope` analysis and translate:
//
//   - Each local Babel `Binding` becomes a numeric "slot" — the index space
//     the analyses' lattices use.
//   - Each `Identifier` node anywhere in the function maps to its binding's
//     slot via `resolve(idNode)`. Outer-scope references and globals return
//     `undefined`. This is the canonical scope answer Babel computes.
//   - Closure capture from a nested function and `arguments` reference each
//     mark the relevant slot as ESCAPED — escaped slots are treated as
//     live-out at the implicit return so liveness doesn't drop their stores.
//
// Why per-binding identity (not per-name): two `let x` in different scopes
// (or shadowing) are distinct bindings with their own lifetimes. Keying by
// name would conflate them, leading to phantom kills/uses across unrelated
// shadows. Babel's scope analysis tracks them separately; we propagate that.
//
// Slot IDs are stable only within a single `LocalVariableTable` instance.
// Each simplifier iteration rebuilds the table from scratch, so callers must
// not persist slot IDs across iterations.
//
// Limitations vs Closure (deliberate, orthogonal to scope handling):
//
//   - `MAX_VARIABLES_TO_ANALYZE` cap stays in the consumers (LiveVars).
//   - DAE bails entire functions with nested closures — Closure does too.

import type { Binding, NodePath, Scope } from '@babel/traverse';
import type * as t from '@babel/types';

export type LocalVariableTable = {
    /** Resolve an identifier-use site to its lattice slot. Returns undefined
     *  when the identifier refers to something that isn't a local of this
     *  function (outer-scope capture, global, free reference). */
    resolve: (id: t.Identifier) => number | undefined;
    /** Slots whose binding is observable after the function returns:
     *  - referenced from inside a nested function (closure capture)
     *  - any param when `arguments` is referenced in the function body */
    escaped: Set<number>;
    /** Number of allocated slots. */
    size: number;
    /** Debug helper — name of the binding behind a slot. */
    nameOfSlot: (slot: number) => string;
    /** Debug helper — every slot allocated for `name` (multiple if shadowed). */
    slotsByName: (name: string) => readonly number[];
    /** AST node that defines the binding's scope (BlockStatement, Function,
     *  ForStatement, etc.). Used by FlowSensitiveInlineVariables to check
     *  that a slot is in lexical scope at a candidate use site. */
    scopeNodeOfSlot: (slot: number) => t.Node | undefined;
};

export function buildLocalVariableTable(fnPath: NodePath<t.Function>): LocalVariableTable {
    // Refresh scope so bindings reflect the current AST. Per-iteration the
    // simplifier mutates the body — Babel's scope cache must be rebuilt.
    fnPath.scope.crawl();

    const idToSlot = new WeakMap<t.Identifier, number>();
    const escaped = new Set<number>();
    const nameBySlot: string[] = [];
    const slotsByNameMap = new Map<string, number[]>();
    const localBindingToSlot = new Map<Binding, number>();
    const scopeNodeBySlot: (t.Node | undefined)[] = [];

    const allocSlot = (binding: Binding): number => {
        const existing = localBindingToSlot.get(binding);
        if (existing !== undefined) return existing;
        const slot = nameBySlot.length;
        nameBySlot.push(binding.identifier.name);
        const arr = slotsByNameMap.get(binding.identifier.name) ?? [];
        arr.push(slot);
        slotsByNameMap.set(binding.identifier.name, arr);
        localBindingToSlot.set(binding, slot);
        scopeNodeBySlot.push(binding.scope.path.node);
        return slot;
    };

    // Step 1: allocate slots in declaration order.
    //
    // Params first (Closure indexes parameters before body locals). They live
    // in fnPath.scope.bindings. Then descend into block scopes within the
    // function body, skipping nested functions (each has its own table).

    for (const name of Object.keys(fnPath.scope.bindings)) {
        allocSlot(fnPath.scope.bindings[name] as Binding);
    }

    const bodyPath = fnPath.get('body');
    if (!Array.isArray(bodyPath) && bodyPath.node) {
        bodyPath.traverse({
            Function(p) {
                p.skip();
            },
            enter(p) {
                if (p.scope.path === p && p.scope !== fnPath.scope) {
                    for (const name of Object.keys(p.scope.bindings)) {
                        const b = p.scope.bindings[name] as Binding;
                        if (b.scope === p.scope) allocSlot(b);
                    }
                }
            },
        });
    }

    // Step 2: map every Identifier in this function (excluding nested fn
    // bodies) to its binding's slot. Babel resolves the binding for us via
    // `path.scope.getBinding(name)` walking the scope chain.

    fnPath.traverse({
        Function(p: NodePath<t.Function>) {
            p.skip();
        },
        Identifier(p: NodePath<t.Identifier>) {
            const isRef = p.isReferencedIdentifier();
            const isBind = p.isBindingIdentifier();
            if (!isRef && !isBind) return;
            const binding = p.scope.getBinding(p.node.name);
            if (binding === undefined) return;
            const slot = localBindingToSlot.get(binding);
            if (slot === undefined) return;
            idToSlot.set(p.node, slot);
        },
    });

    // Step 3: closure-escape detection. A binding escapes if any of its
    // reference / write paths lives in a scope nested inside a Function that
    // isn't the binding's own function.

    for (const [binding, slot] of localBindingToSlot) {
        if (escapes(binding, fnPath)) escaped.add(slot);
    }

    // Step 4: `arguments` reference forces all params to escape. Closure
    // calls this `escapeParameters`. Arrow functions inherit `arguments` from
    // their enclosing function so we must recurse into them; non-arrow
    // nested functions get their own `arguments` so we skip those.

    if (referencesArguments(fnPath)) {
        for (const [binding, slot] of localBindingToSlot) {
            if (binding.kind === 'param') escaped.add(slot);
        }
    }

    return {
        resolve: (id) => idToSlot.get(id),
        escaped,
        size: nameBySlot.length,
        nameOfSlot: (slot) => nameBySlot[slot],
        slotsByName: (name) => slotsByNameMap.get(name) ?? [],
        scopeNodeOfSlot: (slot) => scopeNodeBySlot[slot],
    };
}

function escapes(binding: Binding, fnPath: NodePath<t.Function>): boolean {
    const check = (refScope: Scope): boolean => {
        // Walk from refScope up to (but not past) the binding's own scope.
        // Crossing a Function boundary that isn't fnPath itself = closure
        // capture.
        let scope: Scope | null = refScope;
        while (scope !== null && scope !== binding.scope) {
            const p = scope.path;
            if (p.isFunction() && p.node !== fnPath.node) return true;
            scope = scope.parent;
        }
        return false;
    };
    for (const ref of binding.referencePaths) {
        if (check(ref.scope)) return true;
    }
    for (const cv of binding.constantViolations) {
        if (check(cv.scope)) return true;
    }
    return false;
}

function referencesArguments(fnPath: NodePath<t.Function>): boolean {
    let found = false;
    fnPath.traverse({
        Function(p) {
            // Arrow fns inherit `arguments`; non-arrow fns get their own.
            if (!p.isArrowFunctionExpression()) p.skip();
        },
        Identifier(p) {
            if (found) return;
            if (p.node.name !== 'arguments') return;
            if (!p.isReferencedIdentifier()) return;
            // Belongs to an enclosing non-arrow function? If we walked up from
            // here through arrow fns and reached fnPath, yes.
            let cur: NodePath | null = p.parentPath;
            while (cur !== null && cur !== fnPath) {
                if (cur.isFunction() && !cur.isArrowFunctionExpression()) return;
                cur = cur.parentPath;
            }
            found = true;
        },
    });
    return found;
}
