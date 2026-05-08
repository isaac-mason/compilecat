// Per-function simplifier fixpoint. Mirrors the inner loop of Closure's
// `DefaultPassConfig` "simplify" group: alternate constant-folding, dead-code
// removal, flow-sensitive variable inlining, and dead-assignment elimination
// until no pass reports a change.
//
// Each iteration rebuilds CFG + LocalVariableTable from scratch because the
// AST mutates. This is wasteful in the limit but matches Closure's per-pass
// invalidation model and keeps invariants clean. CFG construction bails on
// try/with/generator/async — those functions short-circuit immediately.

import * as t from '@babel/types';

import { buildControlFlowGraph } from './control-flow-analysis';
import { eliminateDeadAssignments } from './dead-assignments-elimination';
import { runFlowSensitiveInlineVariables } from './flow-sensitive-inline-variables';
import { runLiveVariablesAnalysis } from './live-variables-analysis';
import { buildLocalVariableTable } from './local-variable-table';
import { getSlot } from './node-util';
import { runPeepholeFoldConstants } from './peephole-fold-constants';
import { runPeepholeMinimizeConditions } from './peephole-minimize-conditions';
import { runPeepholeRemoveDeadCode } from './peephole-remove-dead-code';

export type SimplifyStats = {
    iterations: number;
    folded: number;
    removed: number;
    inlined: number;
    deadAssigns: number;
    minimized: number;
};

const MAX_ITERATIONS = 16;

/**
 * Simplify a single function in place. Caller is responsible for picking
 * which functions to simplify (zone gating happens in the pipeline layer).
 */
export function simplifyFunction(fn: t.Function): SimplifyStats {
    const stats: SimplifyStats = {
        iterations: 0,
        folded: 0,
        removed: 0,
        inlined: 0,
        deadAssigns: 0,
        minimized: 0,
    };

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        let changed = false;

        const fold = runPeepholeFoldConstants(fn.body);
        if (fold.folded > 0) {
            changed = true;
            stats.folded += fold.folded;
        }

        const min = runPeepholeMinimizeConditions(fn.body);
        if (min.minimized > 0) {
            changed = true;
            stats.minimized += min.minimized;
        }

        const dead = runPeepholeRemoveDeadCode(fn.body);
        if (dead.removed > 0) {
            changed = true;
            stats.removed += dead.removed;
        }

        const cfg = buildControlFlowGraph({ root: fn.body });
        if (cfg !== null) {
            const table = buildLocalVariableTable(fn);

            const inline = runFlowSensitiveInlineVariables(fn, cfg, table);
            if (inline.inlined > 0) {
                changed = true;
                stats.inlined += inline.inlined;
            }

            // DAE needs a fresh CFG+table after inline, since inline mutates.
            if (inline.inlined > 0) {
                const cfg2 = buildControlFlowGraph({ root: fn.body });
                const table2 = buildLocalVariableTable(fn);
                if (cfg2 !== null) {
                    const live = runLiveVariablesAnalysis(cfg2, table2);
                    const da = eliminateDeadAssignments(fn, cfg2, live);
                    if (da.removed > 0) {
                        changed = true;
                        stats.deadAssigns += da.removed;
                    }
                }
            } else {
                const live = runLiveVariablesAnalysis(cfg, table);
                const da = eliminateDeadAssignments(fn, cfg, live);
                if (da.removed > 0) {
                    changed = true;
                    stats.deadAssigns += da.removed;
                }
            }
        }

        stats.iterations++;
        if (!changed) break;
    }

    return stats;
}

/**
 * Walk the program and simplify every Function node bottom-up. Bottom-up so
 * inner functions are simplified before outer; outer simplification then sees
 * the already-cleaned inner shape.
 */
export function simplifyAll(root: t.Node): SimplifyStats {
    const total: SimplifyStats = {
        iterations: 0,
        folded: 0,
        removed: 0,
        inlined: 0,
        deadAssigns: 0,
        minimized: 0,
    };

    const visit = (n: t.Node | null | undefined): void => {
        if (n == null) return;
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c) visit(c);
                }
            } else {
                visit(child);
            }
        }
        if (t.isFunction(n)) {
            const s = simplifyFunction(n);
            total.iterations += s.iterations;
            total.folded += s.folded;
            total.removed += s.removed;
            total.inlined += s.inlined;
            total.deadAssigns += s.deadAssigns;
            total.minimized += s.minimized;
        }
    };

    visit(root);

    // Program-level cleanup: AST-only peepholes (no CFG) over the whole tree
    // for top-level statements outside any function.
    let topChanged = true;
    let topIters = 0;
    while (topChanged && topIters < MAX_ITERATIONS) {
        topChanged = false;
        const f = runPeepholeFoldConstants(root);
        if (f.folded > 0) {
            topChanged = true;
            total.folded += f.folded;
        }
        const m = runPeepholeMinimizeConditions(root);
        if (m.minimized > 0) {
            topChanged = true;
            total.minimized += m.minimized;
        }
        const d = runPeepholeRemoveDeadCode(root);
        if (d.removed > 0) {
            topChanged = true;
            total.removed += d.removed;
        }
        topIters++;
    }
    total.iterations += topIters;

    return total;
}
