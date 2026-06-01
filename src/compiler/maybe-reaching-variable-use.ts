// Port of jscomp/MaybeReachingVariableUse.java, simplified.
//
// Backward may-reach analysis. At every program point, for each local
// variable v, what use might be reached next?
//
// FlowSensitiveInlineVariables — the only caller — only ever asks
// "is there exactly one use that reaches, and is it this particular
// Identifier node?" So we collapse Closure's Set<Node> per-slot lattice
// to a 3-state lattice mirroring MustBeReachingVariableDef:
//
//   TOP        = undefined  (no use is recorded as reaching yet)
//   Identifier = exactly this single use might reach
//   BOTTOM     = null       (multiple distinct uses might reach)
//
// Join (over successors): TOP ⊔ x = x. BOTTOM ⊔ x = BOTTOM. I ⊔ I = I.
// I ⊔ J = BOTTOM. Same shape as must-reach, with `Identifier` substituted
// for `Definition`. Eliminates per-flow Set cloning, which previously
// dominated the simplifier's runtime on large functions.
//
// Variable identity is by binding-slot — see local-variable-table.ts.
//
// Performance: like the must-def analysis, per-CFG-node transfer is
// invariant across worklist visits — we precompute a flat event list of
// kills and uses in reverse-eval order, filtered to in-table non-escaped
// slots. flowThrough is then a tight event loop with no AST recursion.

import * as t from '@babel/types';

import type { CfgNode, ControlFlowGraph } from './control-flow-graph';
import { analyze, type DataFlowConfig, type LinearFlowState } from './data-flow-analysis';
import type { LocalVariableTable } from './local-variable-table';
import { getSlot } from './node-util';

/** Per-slot 3-state reach. Indexed by slot id.
 *    `undefined` = TOP (no use reaches),
 *    `Identifier` = exactly that single use might reach,
 *    `null` = BOTTOM (multiple distinct uses might reach).
 *  Flat array for fast clone (slice) and equality (index loop). */
export type ReachingUses = {
    uses: (t.Identifier | null | undefined)[];
};

function newReachingUses(size: number): ReachingUses {
    return { uses: new Array(size).fill(undefined) };
}

function cloneReachingUses(r: ReachingUses): ReachingUses {
    return { uses: r.uses.slice() };
}

function reachingEquals(a: ReachingUses, b: ReachingUses): boolean {
    const aa = a.uses;
    const bb = b.uses;
    const len = aa.length > bb.length ? aa.length : bb.length;
    for (let i = 0; i < len; i++) {
        if (aa[i] !== bb[i]) return false;
    }
    return true;
}

function reachingJoin(a: ReachingUses, b: ReachingUses): ReachingUses {
    const aa = a.uses;
    const bb = b.uses;
    const len = aa.length > bb.length ? aa.length : bb.length;
    const out: (t.Identifier | null | undefined)[] = new Array(len);
    for (let i = 0; i < len; i++) {
        const va = aa[i];
        const vb = bb[i];
        if (va === vb) {
            out[i] = va;
        } else if (va === undefined) {
            out[i] = vb;
        } else if (vb === undefined) {
            out[i] = va;
        } else {
            // Either at least one is BOTTOM (null), or two distinct Identifiers.
            // Both cases collapse to BOTTOM.
            out[i] = null;
        }
    }
    return { uses: out };
}

// ---------------------------------------------------------------------------
// Public entry

export type MaybeReachResult = {
    ran: boolean;
    table: LocalVariableTable;
    cfg: ControlFlowGraph;
    /** Returns the unique Identifier that might be read for `id`'s slot at the
     *  start of `cfgNode`'s successor (= just after `cfgNode` executes), OR
     *  `null` (BOTTOM — multiple distinct uses) OR `undefined` (TOP — no use).
     *  FSIV accepts iff the returned identifier === the target use. */
    getUsesAfter: (id: t.Identifier, cfgNode: CfgNode) => t.Identifier | null | undefined;
    /** Slot-keyed variant. */
    getUsesAfterSlot: (slot: number, cfgNode: CfgNode) => t.Identifier | null | undefined;
};

export function runMaybeReachingUse(cfg: ControlFlowGraph, table: LocalVariableTable): MaybeReachResult {
    const transfers = new WeakMap<CfgNode, MayUseTransfer>();
    for (const node of cfg.nodes.values()) {
        if (node === cfg.implicitReturn) continue;
        const value = node.value;
        if (typeof value === 'symbol') continue;
        transfers.set(node, buildMayUseTransfer(value as t.Node, table));
    }

    const size = table.size;
    const config: DataFlowConfig<ReachingUses> = {
        direction: 'backward',
        flowThrough: (node, output) => {
            const result = cloneReachingUses(output);
            const transfer = transfers.get(node);
            if (transfer !== undefined) applyMayUseTransfer(transfer, result);
            return result;
        },
        joinFlows: reachingJoin,
        equals: reachingEquals,
        bottom: () => newReachingUses(size),
        entry: () => newReachingUses(size), // function-end: no use reaches.
    };
    analyze(cfg, config);

    const snapshot = new WeakMap<CfgNode, ReachingUses>();
    for (const node of cfg.nodes.values()) {
        const state = node.annotation as LinearFlowState<ReachingUses> | undefined;
        if (state === undefined) continue;
        snapshot.set(node, state.out);
    }

    const getUsesAfterSlot = (slot: number, cfgNode: CfgNode): t.Identifier | null | undefined => {
        const r = snapshot.get(cfgNode);
        if (r === undefined) return undefined;
        return r.uses[slot];
    };

    return {
        ran: true,
        table,
        cfg,
        getUsesAfterSlot,
        getUsesAfter: (id, cfgNode) => {
            const slot = table.resolve(id);
            if (slot === undefined) return undefined;
            return getUsesAfterSlot(slot, cfgNode);
        },
    };
}

// ---------------------------------------------------------------------------
// Precomputed transfer

type MayUseEvent = { kind: 'kill'; slot: number } | { kind: 'use'; slot: number; id: t.Identifier };

type MayUseTransfer = MayUseEvent[];

function applyMayUseTransfer(events: MayUseTransfer, out: ReachingUses): void {
    const arr = out.uses;
    for (const e of events) {
        if (e.kind === 'kill') {
            arr[e.slot] = undefined;
            continue;
        }
        const cur = arr[e.slot];
        if (cur === undefined) {
            arr[e.slot] = e.id;
        } else if (cur !== e.id) {
            // Either BOTTOM already (null) or a different Identifier — collapse
            // to BOTTOM. Note: same Identifier won't appear twice (each AST
            // node is unique), so the cur===e.id case is unreachable in
            // practice; we keep the branch for safety.
            arr[e.slot] = null;
        }
    }
}

function buildMayUseTransfer(cfgNodeValue: t.Node, table: LocalVariableTable): MayUseTransfer {
    const events: MayUseEvent[] = [];

    const emitKill = (id: t.Identifier) => {
        const slot = table.resolve(id);
        if (slot === undefined) return;
        if (table.escaped.has(slot)) return;
        events.push({ kind: 'kill', slot });
    };

    const emitUse = (id: t.Identifier) => {
        const slot = table.resolve(id);
        if (slot === undefined) return;
        if (table.escaped.has(slot)) return;
        events.push({ kind: 'use', slot, id });
    };

    const visit = (n: t.Node, conditional: boolean) => {
        if (t.isProgram(n) || t.isFile(n) || t.isFunction(n) || t.isBlockStatement(n)) return;

        if (t.isWhileStatement(n) || t.isDoWhileStatement(n) || t.isIfStatement(n)) {
            visit(n.test, conditional);
            return;
        }
        if (t.isForStatement(n)) {
            if (n.test) visit(n.test, conditional);
            return;
        }
        if (t.isForInStatement(n) || t.isForOfStatement(n)) {
            const lhs = n.left;
            if (t.isVariableDeclaration(lhs)) {
                const last = lhs.declarations[lhs.declarations.length - 1];
                if (last && t.isIdentifier(last.id) && !conditional) {
                    emitKill(last.id);
                }
            } else if (t.isIdentifier(lhs) && !conditional) {
                emitKill(lhs);
            }
            visit(n.right, conditional);
            return;
        }
        if (t.isLogicalExpression(n)) {
            // Reverse eval order: RHS conditional, LHS unconditional.
            visit(n.right, true);
            visit(n.left, conditional);
            return;
        }
        if (t.isConditionalExpression(n)) {
            visit(n.alternate, true);
            visit(n.consequent, true);
            visit(n.test, conditional);
            return;
        }
        if (t.isOptionalMemberExpression(n)) {
            if (n.computed) visit(n.property, true);
            visit(n.object, conditional);
            return;
        }
        if (t.isOptionalCallExpression(n)) {
            for (let i = n.arguments.length - 1; i >= 0; i--) {
                const a = n.arguments[i];
                if (t.isExpression(a)) visit(a, true);
            }
            visit(n.callee, conditional);
            return;
        }
        if (t.isVariableDeclaration(n)) {
            for (let i = n.declarations.length - 1; i >= 0; i--) {
                const d = n.declarations[i];
                if (t.isIdentifier(d.id)) {
                    if (d.init) {
                        if (!conditional) emitKill(d.id);
                        visit(d.init, conditional);
                    }
                } else if (d.init) {
                    visit(d.init, conditional);
                }
            }
            return;
        }
        if (t.isAssignmentExpression(n)) {
            if (t.isIdentifier(n.left)) {
                if (!conditional) emitKill(n.left);
                if (n.operator !== '=') emitUse(n.left);
                visit(n.right, conditional);
                return;
            }
            visit(n.right, conditional);
            if ('type' in n.left) visit(n.left as t.Node, conditional);
            return;
        }
        if (t.isUpdateExpression(n)) {
            if (t.isIdentifier(n.argument)) {
                if (!conditional) emitKill(n.argument);
                emitUse(n.argument);
                return;
            }
        }
        if (t.isIdentifier(n)) {
            emitUse(n);
            return;
        }

        const keys = t.VISITOR_KEYS[n.type] ?? [];
        for (let ki = keys.length - 1; ki >= 0; ki--) {
            const child = getSlot(n, keys[ki]);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (let i = child.length - 1; i >= 0; i--) {
                    const c = child[i];
                    if (c) visit(c, conditional);
                }
            } else {
                visit(child, conditional);
            }
        }
    };

    visit(cfgNodeValue, false);
    return events;
}
