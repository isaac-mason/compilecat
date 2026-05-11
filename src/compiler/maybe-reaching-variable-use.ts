// Port of jscomp/MaybeReachingVariableUse.java
//
// Backward may-reach analysis. At every program point, for each local
// variable v, what is the set of "upward exposed" use sites that might
// read v's current value? Use sites are Identifier nodes.
//
// Lattice per variable: a Set<Node>. Bigger = "more uses might reach".
// Join (over multiple successors) = union. Kill = an unconditional write to
// v removes v's set entirely (the prior value can no longer reach those uses
// from this point). Reads add to the set.
//
// Variable identity is by binding-slot — see local-variable-table.ts. Maps
// here key by slot, not by name.
//
// Used by FlowSensitiveInlineVariables to check the "exactly one use of this
// def" condition.

import * as t from '@babel/types';

import type { CfgNode, ControlFlowGraph } from './control-flow-graph';
import { analyze, type DataFlowConfig, type LinearFlowState } from './data-flow-analysis';
import type { LocalVariableTable } from './local-variable-table';
import { getSlot } from './node-util';

export type ReachingUses = {
    /** Per-slot set of identifier nodes whose read might be reached
     *  from this program point. */
    uses: Map<number, Set<t.Node>>;
};

function newReachingUses(): ReachingUses {
    return { uses: new Map() };
}

function cloneReachingUses(r: ReachingUses): ReachingUses {
    const out = newReachingUses();
    for (const [k, set] of r.uses) out.uses.set(k, new Set(set));
    return out;
}

function reachingEquals(a: ReachingUses, b: ReachingUses): boolean {
    if (a.uses.size !== b.uses.size) return false;
    for (const [k, sa] of a.uses) {
        const sb = b.uses.get(k);
        if (sb === undefined) return false;
        if (sa.size !== sb.size) return false;
        for (const node of sa) if (!sb.has(node)) return false;
    }
    return true;
}

function reachingJoin(a: ReachingUses, b: ReachingUses): ReachingUses {
    const out = cloneReachingUses(a);
    for (const [k, sb] of b.uses) {
        const dst = out.uses.get(k);
        if (dst === undefined) out.uses.set(k, new Set(sb));
        else for (const n of sb) dst.add(n);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Public entry

export type MaybeReachResult = {
    ran: boolean;
    table: LocalVariableTable;
    cfg: ControlFlowGraph;
    /** At the OUT of `cfgNode` (= just after this node executes — equivalently,
     *  the in-set of its CFG successor), which use sites of the binding behind
     *  `id` might be reached? Used by FSIV to count uses of a def. */
    getUsesAfter: (id: t.Identifier, cfgNode: CfgNode) => Set<t.Node>;
    /** Slot-keyed variant — used when the caller already has a slot in hand. */
    getUsesAfterSlot: (slot: number, cfgNode: CfgNode) => Set<t.Node>;
};

export function runMaybeReachingUse(
    cfg: ControlFlowGraph,
    table: LocalVariableTable,
): MaybeReachResult {
    const config: DataFlowConfig<ReachingUses> = {
        direction: 'backward',
        flowThrough: (node, output) => flowThrough(node, output, table),
        joinFlows: reachingJoin,
        equals: reachingEquals,
        bottom: newReachingUses,
        entry: newReachingUses, // function-end: no use is reached.
    };
    analyze(cfg, config);

    const snapshot = new WeakMap<CfgNode, ReachingUses>();
    for (const node of cfg.nodes.values()) {
        const state = node.annotation as LinearFlowState<ReachingUses> | undefined;
        if (state === undefined) continue;
        snapshot.set(node, state.out);
    }

    const getUsesAfterSlot = (slot: number, cfgNode: CfgNode): Set<t.Node> => {
        const r = snapshot.get(cfgNode);
        if (r === undefined) return new Set();
        return r.uses.get(slot) ?? new Set();
    };

    return {
        ran: true,
        table,
        cfg,
        getUsesAfterSlot,
        getUsesAfter: (id, cfgNode) => {
            const slot = table.resolve(id);
            if (slot === undefined) return new Set();
            return getUsesAfterSlot(slot, cfgNode);
        },
    };
}

// ---------------------------------------------------------------------------
// flowThrough — compute IN from OUT by walking the node's expression. We
// process in reverse evaluation order so writes (that kill) and reads (that
// add) land in their correct relative order.

function flowThrough(
    cfgNode: CfgNode,
    out: ReachingUses,
    table: LocalVariableTable,
): ReachingUses {
    const result = cloneReachingUses(out);
    const value = cfgNode.value;
    if (typeof value !== 'symbol') {
        computeMayUse(value as t.Node, result, /* conditional */ false, table);
    }
    return result;
}

function computeMayUse(
    n: t.Node,
    out: ReachingUses,
    conditional: boolean,
    table: LocalVariableTable,
): void {
    if (t.isProgram(n) || t.isFile(n) || t.isFunction(n) || t.isBlockStatement(n)) return;

    if (t.isWhileStatement(n) || t.isDoWhileStatement(n) || t.isIfStatement(n)) {
        computeMayUse(n.test, out, conditional, table);
        return;
    }
    if (t.isForStatement(n)) {
        if (n.test) computeMayUse(n.test, out, conditional, table);
        return;
    }
    if (t.isForInStatement(n) || t.isForOfStatement(n)) {
        const lhs = n.left;
        if (t.isVariableDeclaration(lhs)) {
            const last = lhs.declarations[lhs.declarations.length - 1];
            if (last && t.isIdentifier(last.id) && !conditional) {
                killUse(last.id, out, table);
            }
        } else if (t.isIdentifier(lhs) && !conditional) {
            killUse(lhs, out, table);
        }
        computeMayUse(n.right, out, conditional, table);
        return;
    }
    if (t.isLogicalExpression(n)) {
        // Reverse eval order: RHS conditional, LHS unconditional.
        computeMayUse(n.right, out, /* conditional */ true, table);
        computeMayUse(n.left, out, conditional, table);
        return;
    }
    if (t.isConditionalExpression(n)) {
        computeMayUse(n.alternate, out, true, table);
        computeMayUse(n.consequent, out, true, table);
        computeMayUse(n.test, out, conditional, table);
        return;
    }
    if (t.isOptionalMemberExpression(n)) {
        if (n.computed) computeMayUse(n.property, out, true, table);
        computeMayUse(n.object, out, conditional, table);
        return;
    }
    if (t.isOptionalCallExpression(n)) {
        for (let i = n.arguments.length - 1; i >= 0; i--) {
            const a = n.arguments[i];
            if (t.isExpression(a)) computeMayUse(a, out, true, table);
        }
        computeMayUse(n.callee, out, conditional, table);
        return;
    }
    if (t.isVariableDeclaration(n)) {
        for (let i = n.declarations.length - 1; i >= 0; i--) {
            const d = n.declarations[i];
            if (t.isIdentifier(d.id)) {
                if (d.init) {
                    if (!conditional) killUse(d.id, out, table);
                    computeMayUse(d.init, out, conditional, table);
                }
            } else if (d.init) {
                computeMayUse(d.init, out, conditional, table);
            }
        }
        return;
    }
    if (t.isAssignmentExpression(n)) {
        if (t.isIdentifier(n.left)) {
            if (!conditional) killUse(n.left, out, table);
            // Compound assign reads x first.
            if (n.operator !== '=') addUse(n.left, out, table);
            computeMayUse(n.right, out, conditional, table);
            return;
        }
        // Member or destructure — descend.
        computeMayUse(n.right, out, conditional, table);
        if ('type' in n.left) computeMayUse(n.left as t.Node, out, conditional, table);
        return;
    }
    if (t.isUpdateExpression(n)) {
        if (t.isIdentifier(n.argument)) {
            if (!conditional) killUse(n.argument, out, table);
            addUse(n.argument, out, table);
            return;
        }
    }
    if (t.isIdentifier(n)) {
        addUse(n, out, table);
        return;
    }

    // Default: walk children in reverse order.
    const keys = t.VISITOR_KEYS[n.type] ?? [];
    for (let ki = keys.length - 1; ki >= 0; ki--) {
        const child = getSlot(n, keys[ki]);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (let i = child.length - 1; i >= 0; i--) {
                const c = child[i];
                if (c) computeMayUse(c, out, conditional, table);
            }
        } else {
            computeMayUse(child, out, conditional, table);
        }
    }
}

function addUse(id: t.Identifier, out: ReachingUses, table: LocalVariableTable): void {
    const slot = table.resolve(id);
    if (slot === undefined) return;
    if (table.escaped.has(slot)) return;
    let set = out.uses.get(slot);
    if (set === undefined) {
        set = new Set();
        out.uses.set(slot, set);
    }
    set.add(id);
}

function killUse(id: t.Identifier, out: ReachingUses, table: LocalVariableTable): void {
    const slot = table.resolve(id);
    if (slot === undefined) return;
    if (table.escaped.has(slot)) return;
    out.uses.delete(slot);
}
