// Port of jscomp/MustBeReachingVariableDef.java
//
// Forward must-reach analysis. At every program point, for each local
// variable v, what is the unique definition that must reach? "Must" =
// every path from entry passes through that def and there's no later def
// before this point. The lattice per variable is:
//
//   TOP          -> not in the map (initial estimate / unreachable)
//   Definition d -> mapped to d (we know exactly which def)
//   BOTTOM       -> mapped to null (multiple distinct defs reach)
//
// Join (over predecessors): per variable, agree-or-go-to-BOTTOM. Closure's
// table at the top of the file:
//
//                       (TOP)
//                      / | | \
//                    N1 N2 N3 ... Nn
//                      \ | | /
//                     (BOTTOM)
//
// Variable identity is by binding-slot — see local-variable-table.ts. Maps
// here key by slot, not by name; this is what makes shadowing correct.
//
// Used by FlowSensitiveInlineVariables.
//
// Performance: the per-CFG-node transfer function is structurally invariant
// across worklist visits — only the input lattice changes. We precompute a
// flat event list per CFG node once (see buildMustTransfer) and the
// fixpoint loop's flowThrough becomes a tight iteration over that list.
// Eliminates the deep AST recursion that previously ran on every visit.

import * as t from '@babel/types';

import { isEnteringNewCfgNode } from './control-flow-graph';
import type { CfgNode, ControlFlowGraph } from './control-flow-graph';
import { analyze, type DataFlowConfig, type LinearFlowState } from './data-flow-analysis';
import type { LocalVariableTable } from './local-variable-table';
import { getSlot } from './node-util';

export type Definition = {
    /** CFG node (or function root for parameter sentinel) where the def lives. */
    node: t.Node;
    /** Slots that this def's RHS reads from. */
    depends: Set<number>;
    /** True if RHS references a name not in our local table — we then can't
     *  reason about whether the def is invariant across reorderings. */
    unknownDependencies: boolean;
};

/** Per-slot reaching def, indexed by slot id. `undefined` = TOP (no def
 *  recorded), `null` = BOTTOM (multiple distinct defs), `Definition` = the
 *  unique reaching def. Flat array (not Map) so clone is a `.slice()` and
 *  join/equals are tight index loops. */
export type MustDef = {
    reachingDef: (Definition | null | undefined)[];
};

function newMustDef(size: number): MustDef {
    // Pre-sized + filled to keep the array dense (V8 fast path).
    return { reachingDef: new Array(size).fill(undefined) };
}

function cloneMustDef(d: MustDef): MustDef {
    return { reachingDef: d.reachingDef.slice() };
}

function entryMustDef(table: LocalVariableTable, fnRoot: t.Node): MustDef {
    const arr: (Definition | null | undefined)[] = new Array(table.size);
    for (let slot = 0; slot < table.size; slot++) {
        arr[slot] = {
            node: fnRoot,
            depends: new Set(),
            unknownDependencies: false,
        };
    }
    return { reachingDef: arr };
}

function defsEqual(a: Definition | null, b: Definition | null): boolean {
    // Closure: definitions are equal iff their cfg-node identity matches.
    if (a === null || b === null) return a === b;
    return a.node === b.node;
}

function mustDefEquals(a: MustDef, b: MustDef): boolean {
    const aa = a.reachingDef;
    const bb = b.reachingDef;
    const len = aa.length > bb.length ? aa.length : bb.length;
    for (let i = 0; i < len; i++) {
        const va = aa[i];
        const vb = bb[i];
        if (va === vb) continue;
        // TOP vs anything-non-TOP and BOTTOM vs Definition are all distinct.
        if (va === undefined || vb === undefined) return false;
        if (!defsEqual(va, vb)) return false;
    }
    return true;
}

function mustDefJoin(a: MustDef, b: MustDef): MustDef {
    const aa = a.reachingDef;
    const bb = b.reachingDef;
    const len = aa.length > bb.length ? aa.length : bb.length;
    const out: (Definition | null | undefined)[] = new Array(len);
    for (let i = 0; i < len; i++) {
        const va = aa[i];
        const vb = bb[i];
        // Closure lattice: TOP ⊔ x = x; BOTTOM ⊔ x = BOTTOM; D ⊔ D = D;
        // D1 ⊔ D2 = BOTTOM (when D1.node !== D2.node).
        if (va === undefined) {
            out[i] = vb;
        } else if (vb === undefined) {
            out[i] = va;
        } else if (va === null || vb === null) {
            out[i] = null;
        } else if (defsEqual(va, vb)) {
            out[i] = va;
        } else {
            out[i] = null;
        }
    }
    return { reachingDef: out };
}

// ---------------------------------------------------------------------------
// Public entry

export type MustReachResult = {
    /** True if the analysis ran (false if too many vars). */
    ran: boolean;
    table: LocalVariableTable;
    /** The CFG passed in, with annotations populated. */
    cfg: ControlFlowGraph;
    /** Lookup: at the start of `cfgNode`, what def reaches the binding for
     *  this identifier? */
    getDef: (id: t.Identifier, cfgNode: CfgNode) => Definition | null | undefined;
};

export function runMustReachingDef(fn: t.Function, cfg: ControlFlowGraph, table: LocalVariableTable): MustReachResult {
    // Precompute the transfer function for each CFG node once. flowThrough
    // then becomes a tight loop over events; no AST recursion per visit.
    const transfers = new WeakMap<CfgNode, MustTransfer>();
    for (const node of cfg.nodes.values()) {
        if (node === cfg.implicitReturn) continue;
        const value = node.value;
        if (typeof value === 'symbol') continue;
        transfers.set(node, buildMustTransfer(value as t.Node, table));
    }

    const size = table.size;
    const config: DataFlowConfig<MustDef> = {
        direction: 'forward',
        flowThrough: (node, input) => {
            const out = cloneMustDef(input);
            const transfer = transfers.get(node);
            if (transfer !== undefined) applyMustTransfer(transfer, out, table);
            return out;
        },
        joinFlows: mustDefJoin,
        equals: mustDefEquals,
        bottom: () => newMustDef(size),
        entry: () => entryMustDef(table, fn),
    };
    analyze(cfg, config);

    // Snapshot per-CFG-node IN states. Subsequent analyses on the same CFG
    // will overwrite `node.annotation`, so we can't read it later.
    const snapshot = new WeakMap<CfgNode, MustDef>();
    for (const node of cfg.nodes.values()) {
        const state = node.annotation as LinearFlowState<MustDef> | undefined;
        if (state === undefined) continue;
        snapshot.set(node, state.in);
    }

    return {
        ran: true,
        table,
        cfg,
        getDef: (id, cfgNode) => {
            const m = snapshot.get(cfgNode);
            if (m === undefined) return undefined;
            const slot = table.resolve(id);
            if (slot === undefined) return undefined;
            return m.reachingDef[slot];
        },
    };
}

// ---------------------------------------------------------------------------
// Precomputed transfer
//
// The semantics of computeMustDef (the previous per-visit walker) decompose
// into a flat list of events in evaluation order. We extract them once.
//
// Event kinds:
//   Write          — a local binding was rebound. The Definition object is
//                    precomputed (its node + depends + unknownDeps are
//                    invariant across visits). `conditional` selects between
//                    "set to this def" and "set to BOTTOM"; invalidation of
//                    dependents on `slot` happens either way.
//   InvalidateAll  — `arguments` was read, so Closure's escapeParameters
//                    rule wipes every slot to BOTTOM. (Closure ignores
//                    conditionality for this case; we mirror.)

type MustEvent =
    | { kind: 'write'; slot: number; conditional: boolean; def: Definition }
    | { kind: 'invalidateAll' };

type MustTransfer = MustEvent[];

function applyMustTransfer(events: MustTransfer, out: MustDef, table: LocalVariableTable): void {
    const arr = out.reachingDef;
    for (const e of events) {
        if (e.kind === 'invalidateAll') {
            const n = arr.length;
            for (let s = 0; s < n; s++) arr[s] = null;
            continue;
        }
        // Write: invalidate dependents, then write self.
        const slot = e.slot;
        const n = arr.length;
        for (let k = 0; k < n; k++) {
            const def = arr[k];
            if (def === null || def === undefined) continue;
            if (def.depends.has(slot)) arr[k] = null;
        }
        if (table.escaped.has(slot)) continue;
        arr[slot] = e.conditional ? null : e.def;
    }
}

function buildMustTransfer(cfgNodeValue: t.Node, table: LocalVariableTable): MustTransfer {
    const events: MustEvent[] = [];

    const emitWrite = (id: t.Identifier, rhs: t.Node | null, conditional: boolean) => {
        const slot = table.resolve(id);
        if (slot === undefined) return;
        // The Definition's node is the CFG-node value (invariant identity).
        // depends/unknownDeps come from a one-time RHS walk.
        const def: Definition = {
            node: cfgNodeValue,
            depends: new Set(),
            unknownDependencies: false,
        };
        if (rhs !== null) computeDependence(def, rhs, table);
        events.push({ kind: 'write', slot, conditional, def });
    };

    const visit = (n: t.Node, conditional: boolean) => {
        if (t.isProgram(n) || t.isFile(n) || t.isFunction(n) || t.isBlockStatement(n)) {
            return;
        }
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
                if (last && t.isIdentifier(last.id)) {
                    emitWrite(last.id, n.right, conditional);
                }
            } else if (t.isIdentifier(lhs)) {
                emitWrite(lhs, n.right, conditional);
            }
            return;
        }
        if (t.isLogicalExpression(n)) {
            visit(n.left, conditional);
            visit(n.right, true);
            return;
        }
        if (t.isConditionalExpression(n)) {
            visit(n.test, conditional);
            visit(n.consequent, true);
            visit(n.alternate, true);
            return;
        }
        if (t.isOptionalMemberExpression(n)) {
            visit(n.object, conditional);
            if (n.computed) visit(n.property, true);
            return;
        }
        if (t.isOptionalCallExpression(n)) {
            visit(n.callee, conditional);
            for (const arg of n.arguments) {
                if (t.isExpression(arg)) visit(arg, true);
            }
            return;
        }
        if (t.isVariableDeclaration(n)) {
            for (const d of n.declarations) {
                if (d.init && t.isIdentifier(d.id)) {
                    visit(d.init, conditional);
                    emitWrite(d.id, d.init, conditional);
                } else if (d.init) {
                    visit(d.init, conditional);
                }
            }
            return;
        }
        if (t.isAssignmentExpression(n)) {
            if (t.isIdentifier(n.left)) {
                visit(n.right, conditional);
                emitWrite(n.left, n.right, conditional);
                return;
            }
            // Member or destructure assign — descend defensively.
            if ('type' in n.left) visit(n.left as t.Node, conditional);
            visit(n.right, conditional);
            return;
        }
        if (t.isUpdateExpression(n)) {
            if (t.isIdentifier(n.argument)) {
                // Treat ++/-- as a self-referencing redefinition with depends={x}.
                emitWrite(n.argument, n.argument, conditional);
                return;
            }
        }
        if (t.isIdentifier(n) && n.name === 'arguments') {
            events.push({ kind: 'invalidateAll' });
            return;
        }

        for (const key of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, key);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
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

function computeDependence(def: Definition, rhs: t.Node, table: LocalVariableTable): void {
    const visit = (n: t.Node, parent: t.Node | null) => {
        if (parent !== null && isEnteringNewCfgNode(n, parent)) return;
        if (t.isIdentifier(n)) {
            const slot = table.resolve(n);
            if (slot === undefined) {
                // External name (closure-captured, global, etc.) — we don't
                // know whether it can change.
                def.unknownDependencies = true;
            } else {
                def.depends.add(slot);
            }
            return;
        }
        for (const key of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, key);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c) visit(c, n);
                }
            } else {
                visit(child, n);
            }
        }
    };
    visit(rhs, null);
}

// Used by FlowSensitiveInlineVariables to decide whether the def's RHS
// dependencies live entirely within the local-variable table (= safe) or
// reference outer-scope names (= not safe to reorder).
export function dependsOnOuterScopeVars(def: Definition): boolean {
    return def.unknownDependencies;
}
