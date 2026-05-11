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

export type MustDef = {
    /** Per-slot reaching def. Missing key = TOP, null value = BOTTOM. */
    reachingDef: Map<number, Definition | null>;
};

function newMustDef(): MustDef {
    return { reachingDef: new Map() };
}

function cloneMustDef(d: MustDef): MustDef {
    return { reachingDef: new Map(d.reachingDef) };
}

function entryMustDef(table: LocalVariableTable, fnRoot: t.Node): MustDef {
    const m = newMustDef();
    for (let slot = 0; slot < table.size; slot++) {
        m.reachingDef.set(slot, {
            node: fnRoot,
            depends: new Set(),
            unknownDependencies: false,
        });
    }
    return m;
}

function defsEqual(a: Definition | null, b: Definition | null): boolean {
    // Closure: definitions are equal iff their cfg-node identity matches.
    if (a === null || b === null) return a === b;
    return a.node === b.node;
}

function mustDefEquals(a: MustDef, b: MustDef): boolean {
    if (a.reachingDef.size !== b.reachingDef.size) return false;
    for (const [k, va] of a.reachingDef) {
        if (!b.reachingDef.has(k)) return false;
        if (!defsEqual(va, b.reachingDef.get(k) ?? null)) return false;
    }
    return true;
}

function mustDefJoin(a: MustDef, b: MustDef): MustDef {
    const result = newMustDef();
    const merge = (input: MustDef) => {
        for (const [k, vIn] of input.reachingDef) {
            if (vIn === null) {
                result.reachingDef.set(k, null);
                continue;
            }
            if (!result.reachingDef.has(k)) {
                result.reachingDef.set(k, vIn);
                continue;
            }
            const cur = result.reachingDef.get(k)!;
            if (defsEqual(cur, vIn)) continue;
            result.reachingDef.set(k, null);
        }
    };
    merge(a);
    merge(b);
    return result;
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

export function runMustReachingDef(
    fn: t.Function,
    cfg: ControlFlowGraph,
    table: LocalVariableTable,
): MustReachResult {
    const config: DataFlowConfig<MustDef> = {
        direction: 'forward',
        flowThrough: (node, input) => flowThrough(fn, node, input, table),
        joinFlows: mustDefJoin,
        equals: mustDefEquals,
        bottom: newMustDef,
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
            return m.reachingDef.get(slot);
        },
    };
}

// ---------------------------------------------------------------------------
// flowThrough

function flowThrough(
    fn: t.Function,
    cfgNode: CfgNode,
    input: MustDef,
    table: LocalVariableTable,
): MustDef {
    const output = cloneMustDef(input);
    const value = cfgNode.value;
    if (typeof value !== 'symbol') {
        computeMustDef(fn, value as t.Node, value as t.Node, output, false, table);
    }
    return output;
}

function computeMustDef(
    fn: t.Function,
    n: t.Node,
    cfgNode: t.Node,
    out: MustDef,
    conditional: boolean,
    table: LocalVariableTable,
): void {
    if (t.isProgram(n) || t.isFile(n) || t.isFunction(n) || t.isBlockStatement(n)) {
        return;
    }
    if (t.isWhileStatement(n) || t.isDoWhileStatement(n) || t.isIfStatement(n)) {
        computeMustDef(fn, n.test, cfgNode, out, conditional, table);
        return;
    }
    if (t.isForStatement(n)) {
        if (n.test) computeMustDef(fn, n.test, cfgNode, out, conditional, table);
        return;
    }
    if (t.isForInStatement(n) || t.isForOfStatement(n)) {
        const lhs = n.left;
        if (t.isVariableDeclaration(lhs)) {
            const last = lhs.declarations[lhs.declarations.length - 1];
            if (last && t.isIdentifier(last.id)) {
                addToDefIfLocal(last.id, conditional ? null : cfgNode, n.right, out, table);
            }
        } else if (t.isIdentifier(lhs)) {
            addToDefIfLocal(lhs, conditional ? null : cfgNode, n.right, out, table);
        }
        return;
    }
    if (t.isLogicalExpression(n)) {
        computeMustDef(fn, n.left, cfgNode, out, conditional, table);
        computeMustDef(fn, n.right, cfgNode, out, /* conditional */ true, table);
        return;
    }
    if (t.isConditionalExpression(n)) {
        computeMustDef(fn, n.test, cfgNode, out, conditional, table);
        computeMustDef(fn, n.consequent, cfgNode, out, true, table);
        computeMustDef(fn, n.alternate, cfgNode, out, true, table);
        return;
    }
    if (t.isOptionalMemberExpression(n)) {
        computeMustDef(fn, n.object, cfgNode, out, conditional, table);
        if (n.computed) computeMustDef(fn, n.property, cfgNode, out, true, table);
        return;
    }
    if (t.isOptionalCallExpression(n)) {
        computeMustDef(fn, n.callee, cfgNode, out, conditional, table);
        for (const arg of n.arguments) {
            if (t.isExpression(arg)) computeMustDef(fn, arg, cfgNode, out, true, table);
        }
        return;
    }
    if (t.isVariableDeclaration(n)) {
        for (const d of n.declarations) {
            if (d.init && t.isIdentifier(d.id)) {
                computeMustDef(fn, d.init, cfgNode, out, conditional, table);
                addToDefIfLocal(d.id, conditional ? null : cfgNode, d.init, out, table);
            } else if (d.init) {
                computeMustDef(fn, d.init, cfgNode, out, conditional, table);
            }
        }
        return;
    }
    if (t.isAssignmentExpression(n)) {
        if (t.isIdentifier(n.left)) {
            computeMustDef(fn, n.right, cfgNode, out, conditional, table);
            addToDefIfLocal(n.left, conditional ? null : cfgNode, n.right, out, table);
            return;
        }
        // Member or destructure assign — descend defensively.
        if ('type' in n.left) computeMustDef(fn, n.left as t.Node, cfgNode, out, conditional, table);
        computeMustDef(fn, n.right, cfgNode, out, conditional, table);
        return;
    }
    if (t.isUpdateExpression(n)) {
        if (t.isIdentifier(n.argument)) {
            // Treat ++/-- as a self-referencing redefinition with depends={x}.
            addToDefIfLocal(n.argument, conditional ? null : cfgNode, n.argument, out, table);
            return;
        }
    }
    if (t.isIdentifier(n) && n.name === 'arguments') {
        // Closure's escapeParameters: lose all parameter knowledge. We can't
        // tell which slots are params from the table, so invalidate all
        // slots. (escaped slots are filtered downstream.)
        for (let slot = 0; slot < table.size; slot++) {
            out.reachingDef.set(slot, null);
        }
        void fn;
        return;
    }

    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, key);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c) computeMustDef(fn, c, cfgNode, out, conditional, table);
            }
        } else {
            computeMustDef(fn, child, cfgNode, out, conditional, table);
        }
    }
}

function addToDefIfLocal(
    id: t.Identifier,
    cfgNode: t.Node | null,
    rhs: t.Node | null,
    out: MustDef,
    table: LocalVariableTable,
): void {
    const slot = table.resolve(id);
    if (slot === undefined) return;

    // Invalidate any existing def that depends on `slot` (we just rebound it).
    for (const [k, def] of out.reachingDef) {
        if (def === null) continue;
        if (def.depends.has(slot)) out.reachingDef.set(k, null);
    }

    if (table.escaped.has(slot)) return;

    if (cfgNode === null) {
        out.reachingDef.set(slot, null);
        return;
    }

    const def: Definition = {
        node: cfgNode,
        depends: new Set(),
        unknownDependencies: false,
    };
    if (rhs !== null) computeDependence(def, rhs, table);
    out.reachingDef.set(slot, def);
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
