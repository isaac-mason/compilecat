// Port of jscomp/LiveVariablesAnalysis.java
//
// Backward dataflow producing per-CFG-node liveness sets. A variable is
// "live at point P" if its current value might be read after P. The lattice
// is a BitSet over the function's local-variable index space; JOIN is OR;
// flow is L_in = (L_out − KILL[n]) | GEN[n].
//
// GEN/KILL are computed per CFG node by walking the node's expression tree:
//
//   - reads of a local      → gen[idx] = 1
//   - assignments to a local → kill[idx] = 1, but ONLY when not under a
//                              short-circuiting / conditional sub-expression
//   - compound assigns (+= etc.) → both gen and kill (LHS is read, then
//                                  written)
//   - `arguments` reference  → escape all simple parameters
//
// Differs from Closure:
//   - Variable identity is by NAME (we don't have Closure's Var with scope
//     resolution). See LocalVariableTable.ts for the limitations.
//   - No ON_EX edges in the v1 CFG, so the "conditional kill if can throw"
//     bit collapses; we still respect short-circuit conditional contexts in
//     expression sub-trees.

import * as t from '@babel/types';

import type { CfgNode, ControlFlowGraph } from './control-flow-graph';
import { analyze, type DataFlowConfig } from './data-flow-analysis';
import type { LocalVariableTable } from './local-variable-table';
import { getSlot } from './node-util';

export const MAX_VARIABLES_TO_ANALYZE = 100;

export type LiveVariableLattice = {
    /** Uint32Array-backed bitset; one bit per indexed variable. */
    bits: Uint32Array;
};

function newLattice(table: LocalVariableTable): LiveVariableLattice {
    const words = (table.size + 31) >>> 5;
    return { bits: new Uint32Array(Math.max(1, words)) };
}

function bsClone(l: LiveVariableLattice): LiveVariableLattice {
    return { bits: new Uint32Array(l.bits) };
}

function bsEquals(a: LiveVariableLattice, b: LiveVariableLattice): boolean {
    if (a.bits.length !== b.bits.length) return false;
    for (let i = 0; i < a.bits.length; i++) {
        if (a.bits[i] !== b.bits[i]) return false;
    }
    return true;
}

function bsOr(into: LiveVariableLattice, src: LiveVariableLattice): void {
    for (let i = 0; i < into.bits.length; i++) into.bits[i] |= src.bits[i];
}

function bsAndNot(into: LiveVariableLattice, src: LiveVariableLattice): void {
    for (let i = 0; i < into.bits.length; i++) into.bits[i] &= ~src.bits[i];
}

function bsSet(l: LiveVariableLattice, idx: number): void {
    l.bits[idx >>> 5] |= 1 << (idx & 31);
}

export function isLive(l: LiveVariableLattice, idx: number): boolean {
    return (l.bits[idx >>> 5] & (1 << (idx & 31))) !== 0;
}

export type LiveVariablesResult = {
    table: LocalVariableTable;
    /** True if the analysis ran. False if the function had too many vars. */
    ran: boolean;
};

/**
 * Run live-variables analysis. Annotates `cfg` nodes with LinearFlowState<L>
 * (per DataFlowAnalysis convention). Returns null if we bailed (too many
 * variables in the function).
 */
export function runLiveVariablesAnalysis(
    cfg: ControlFlowGraph,
    table: LocalVariableTable,
): LiveVariablesResult {
    if (table.size > MAX_VARIABLES_TO_ANALYZE) {
        return { table, ran: false };
    }

    const config: DataFlowConfig<LiveVariableLattice> = {
        direction: 'backward',
        flowThrough: (node, output) => flowThrough(node, output, table),
        joinFlows: (a, b) => {
            const r = bsClone(a);
            bsOr(r, b);
            return r;
        },
        equals: bsEquals,
        bottom: () => newLattice(table),
        // Backward: "entry" lattice flows into the implicit return.
        // Escaped locals are live-out at function exit.
        entry: () => {
            const l = newLattice(table);
            for (const name of table.escaped) {
                const idx = table.indexByName.get(name);
                if (idx !== undefined) bsSet(l, idx);
            }
            return l;
        },
    };

    analyze(cfg, config);
    return { table, ran: true };
}

// ---------------------------------------------------------------------------
// flowThrough — compute GEN/KILL for `node`, then L_in = (L_out − KILL) | GEN

function flowThrough(
    node: CfgNode,
    out: LiveVariableLattice,
    table: LocalVariableTable,
): LiveVariableLattice {
    const gen = newLattice(table);
    const kill = newLattice(table);
    const value = node.value;
    if (typeof value !== 'symbol' && typeof value === 'object' && value !== null && 'type' in value) {
        computeGenKill(value as t.Node, table, gen, kill, /* conditional */ false);
    }
    const result = bsClone(out);
    bsAndNot(result, kill);
    bsOr(result, gen);
    return result;
}

// ---------------------------------------------------------------------------
// computeGenKill — Closure's algorithm, Babel-flavored
//
// Walks an AST node and accumulates reads (gen) and definite writes (kill).
// `conditional` propagates "we are inside a sub-expression that may not
// execute" (e.g. RHS of && / ||, branches of ?:, optional chaining tail) —
// in that context we may NOT kill, only gen.

function computeGenKill(
    n: t.Node,
    table: LocalVariableTable,
    gen: LiveVariableLattice,
    kill: LiveVariableLattice,
    conditional: boolean,
): void {
    // Container nodes — Closure returns immediately for SCRIPT/ROOT/FUNCTION/BLOCK.
    if (
        t.isProgram(n) ||
        t.isFile(n) ||
        t.isFunction(n) ||
        t.isBlockStatement(n)
    ) {
        return;
    }

    if (
        t.isWhileStatement(n) ||
        t.isDoWhileStatement(n) ||
        t.isIfStatement(n)
    ) {
        computeGenKill(n.test, table, gen, kill, conditional);
        return;
    }
    if (t.isForStatement(n)) {
        if (n.test) computeGenKill(n.test, table, gen, kill, conditional);
        return;
    }
    if (t.isForInStatement(n) || t.isForOfStatement(n)) {
        // For `for (x in y)` the "node" represents the header. Closure handles
        // the LHS as a possible-no-write site. We mirror: only walk the LHS
        // (collection is its own CFG predecessor).
        const lhs = n.left;
        if (t.isVariableDeclaration(lhs)) {
            // for (var x in y) — last declarator's id is the binding.
            const last = lhs.declarations[lhs.declarations.length - 1];
            if (last) computeGenKill(last.id, table, gen, kill, conditional);
        } else {
            computeGenKill(lhs, table, gen, kill, conditional);
        }
        return;
    }
    if (t.isVariableDeclaration(n)) {
        for (const d of n.declarations) {
            if (d.init) {
                computeGenKill(d.init, table, gen, kill, conditional);
                if (!conditional) addBindingsToKill(d.id, table, kill);
            }
            // No init = `let x;` — does NOT kill in Closure (the var is born
            // undefined and the kill bit is for "I overwrite a prior value").
        }
        return;
    }
    if (t.isLogicalExpression(n)) {
        // && || ?? — RHS conditional.
        computeGenKill(n.left, table, gen, kill, conditional);
        computeGenKill(n.right, table, gen, kill, /* conditional */ true);
        return;
    }
    if (t.isOptionalMemberExpression(n)) {
        computeGenKill(n.object, table, gen, kill, conditional);
        if (n.computed) computeGenKill(n.property, table, gen, kill, true);
        return;
    }
    if (t.isOptionalCallExpression(n)) {
        computeGenKill(n.callee, table, gen, kill, conditional);
        for (const arg of n.arguments) {
            if (t.isExpression(arg)) computeGenKill(arg, table, gen, kill, true);
        }
        return;
    }
    if (t.isConditionalExpression(n)) {
        computeGenKill(n.test, table, gen, kill, conditional);
        computeGenKill(n.consequent, table, gen, kill, true);
        computeGenKill(n.alternate, table, gen, kill, true);
        return;
    }
    if (t.isIdentifier(n)) {
        if (n.name === 'arguments') {
            // Treated upstream by buildLocalVariableTable as escape source.
            return;
        }
        const idx = table.indexByName.get(n.name);
        if (idx !== undefined && !table.escaped.has(n.name)) {
            bsSet(gen, idx);
        }
        return;
    }
    if (t.isAssignmentExpression(n)) {
        if (t.isIdentifier(n.left)) {
            // Plain `x = expr` or `x += expr`.
            if (!conditional) {
                const idx = table.indexByName.get(n.left.name);
                if (idx !== undefined && !table.escaped.has(n.left.name)) bsSet(kill, idx);
            }
            if (n.operator !== '=') {
                // Compound assign reads x first.
                const idx = table.indexByName.get(n.left.name);
                if (idx !== undefined && !table.escaped.has(n.left.name)) bsSet(gen, idx);
            }
            computeGenKill(n.right, table, gen, kill, conditional);
            return;
        }
        if (t.isArrayPattern(n.left) || t.isObjectPattern(n.left)) {
            if (!conditional) addBindingsToKill(n.left, table, kill);
            computeGenKill(n.left, table, gen, kill, conditional);
            computeGenKill(n.right, table, gen, kill, conditional);
            return;
        }
        // member assignments: read both sides.
        computeGenKill(n.left as t.Node, table, gen, kill, conditional);
        computeGenKill(n.right, table, gen, kill, conditional);
        return;
    }
    if (t.isUpdateExpression(n)) {
        // `x++` or `++x` — both read and write x.
        if (t.isIdentifier(n.argument)) {
            const idx = table.indexByName.get(n.argument.name);
            if (idx !== undefined && !table.escaped.has(n.argument.name)) {
                bsSet(gen, idx);
                if (!conditional) bsSet(kill, idx);
            }
            return;
        }
    }

    // Default: walk children at the same conditional level.
    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, key);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c) computeGenKill(c, table, gen, kill, conditional);
            }
        } else {
            computeGenKill(child, table, gen, kill, conditional);
        }
    }
}

function addBindingsToKill(
    pattern: t.Node,
    table: LocalVariableTable,
    kill: LiveVariableLattice,
): void {
    const visit = (n: t.Node) => {
        if (t.isIdentifier(n)) {
            const idx = table.indexByName.get(n.name);
            if (idx !== undefined && !table.escaped.has(n.name)) bsSet(kill, idx);
            return;
        }
        if (t.isAssignmentPattern(n)) {
            visit(n.left);
            return;
        }
        if (t.isRestElement(n)) {
            visit(n.argument);
            return;
        }
        if (t.isArrayPattern(n)) {
            for (const el of n.elements) if (el !== null) visit(el);
            return;
        }
        if (t.isObjectPattern(n)) {
            for (const p of n.properties) {
                if (t.isRestElement(p)) visit(p.argument);
                else if (t.isObjectProperty(p)) visit(p.value);
            }
            return;
        }
    };
    visit(pattern);
}
