// Per-function simplifier fixpoint. Mirrors the inner loop of Closure's
// `DefaultPassConfig` "simplify" group: alternate constant-folding, dead-code
// removal, flow-sensitive variable inlining, and dead-assignment elimination
// until no pass reports a change.
//
// Each iteration rebuilds CFG + LocalVariableTable from scratch because the
// AST mutates. This is wasteful in the limit but matches Closure's per-pass
// invalidation model and keeps invariants clean. CFG construction bails on
// try/with/generator/async — those functions short-circuit immediately.
//
// Deliberate deviation from Closure: we do NOT run OptimizeLetAndConstPeephole
// here. Closure lowers function-body-top `let`/`const` to `var` as a late
// keyword-homogenization step (better gzip on its standalone output). For
// compilecat the output feeds a downstream bundler/minifier (Vite, Rollup,
// esbuild) which performs the same lowering if it actually wants it, so doing
// it here is a no-op for shipped bytes. Meanwhile it degrades the readability
// of the intermediate compilecat output (which is what users debug), reintroduces
// TDZ-less semantics on locals, and *amplifies* normalize's `__N` suffix
// proliferation by hoisting block-scoped decls into the function scope where
// they collide. We keep `let`/`const` as-authored.

import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

import { traverse } from './babel-interop';
import { buildControlFlowGraph } from './control-flow-analysis';
import { eliminateDeadAssignments } from './dead-assignments-elimination';
import { runFlowSensitiveInlineVariables } from './flow-sensitive-inline-variables';
import { runLiveVariablesAnalysis } from './live-variables-analysis';
import { buildLocalVariableTable } from './local-variable-table';
import { runMinimizeExitPoints } from './minimize-exit-points';
import { renameForFlatten } from './normalize';
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
    timings: SimplifyTimings;
};

/** Wall-clock ms per sub-pass, summed across all simplified functions and
 *  all fixpoint iterations. `renameForFlatten` runs once per function before
 *  the loop; everything else runs once per iteration. */
export type SimplifyTimings = {
    renameForFlatten: number;
    foldConstants: number;
    minimizeExitPoints: number;
    minimizeConditions: number;
    removeDeadCode: number;
    cfgBuild: number;
    localVarTable: number;
    flowInline: number;
    liveVars: number;
    deadAssigns: number;
};

function emptyTimings(): SimplifyTimings {
    return {
        renameForFlatten: 0,
        foldConstants: 0,
        minimizeExitPoints: 0,
        minimizeConditions: 0,
        removeDeadCode: 0,
        cfgBuild: 0,
        localVarTable: 0,
        flowInline: 0,
        liveVars: 0,
        deadAssigns: 0,
    };
}

function addTimings(into: SimplifyTimings, from: SimplifyTimings): void {
    into.renameForFlatten += from.renameForFlatten;
    into.foldConstants += from.foldConstants;
    into.minimizeExitPoints += from.minimizeExitPoints;
    into.minimizeConditions += from.minimizeConditions;
    into.removeDeadCode += from.removeDeadCode;
    into.cfgBuild += from.cfgBuild;
    into.localVarTable += from.localVarTable;
    into.flowInline += from.flowInline;
    into.liveVars += from.liveVars;
    into.deadAssigns += from.deadAssigns;
}

const MAX_ITERATIONS = 16;

export type SimplifyOptions = {
    /** Retained for source compatibility with callers; ignored. Block-merge
     *  safety is now established per-function by `renameForFlatten`. */
    normalized?: boolean;
};

/**
 * Simplify a single function in place. Caller is responsible for picking
 * which functions to simplify (zone gating happens in the pipeline layer).
 */
export function simplifyFunction(fnPath: NodePath<t.Function>, _options: SimplifyOptions = {}): SimplifyStats {
    const stats: SimplifyStats = {
        iterations: 0,
        folded: 0,
        removed: 0,
        inlined: 0,
        deadAssigns: 0,
        minimized: 0,
        timings: emptyTimings(),
    };
    const timings = stats.timings;

    const fn = fnPath.node;

    // Rename nested-block bindings that would collide on flatten. After this
    // pass, every let/const/class/function-declaration inside `fn` is uniquely
    // named within the function, so `PeepholeRemoveDeadCode` can splice nested
    // blocks into their parents with `ignoreBlockScopedDeclarations=true`.
    const renameStart = performance.now();
    renameForFlatten(fnPath);
    timings.renameForFlatten += performance.now() - renameStart;
    const normalized = true;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        let changed = false;

        const foldStart = performance.now();
        const fold = runPeepholeFoldConstants(fn.body);
        timings.foldConstants += performance.now() - foldStart;
        if (fold.folded > 0) {
            changed = true;
            stats.folded += fold.folded;
        }

        // MinimizeExitPoints reshapes labeled-block / loop / function exits
        // into implicit fall-through. Run before PeepholeMinimizeConditions so
        // the resulting if/else gets collapsed to ternaries.
        const exitsStart = performance.now();
        const exits = runMinimizeExitPoints(fn);
        timings.minimizeExitPoints += performance.now() - exitsStart;
        if (exits.minimized > 0) {
            changed = true;
            stats.minimized += exits.minimized;
        }

        const minStart = performance.now();
        const min = runPeepholeMinimizeConditions(fn.body);
        timings.minimizeConditions += performance.now() - minStart;
        if (min.minimized > 0) {
            changed = true;
            stats.minimized += min.minimized;
        }

        const deadStart = performance.now();
        const dead = runPeepholeRemoveDeadCode(fn.body, { normalized });
        timings.removeDeadCode += performance.now() - deadStart;
        if (dead.removed > 0) {
            changed = true;
            stats.removed += dead.removed;
        }

        const cfgStart = performance.now();
        const cfg = buildControlFlowGraph({ root: fn.body });
        timings.cfgBuild += performance.now() - cfgStart;
        if (cfg !== null) {
            const tableStart = performance.now();
            const table = buildLocalVariableTable(fnPath);
            timings.localVarTable += performance.now() - tableStart;

            const flowStart = performance.now();
            const inline = runFlowSensitiveInlineVariables(fn, cfg, table);
            timings.flowInline += performance.now() - flowStart;
            if (inline.inlined > 0) {
                changed = true;
                stats.inlined += inline.inlined;
            }

            // DAE needs a fresh CFG+table after inline, since inline mutates.
            if (inline.inlined > 0) {
                const cfg2Start = performance.now();
                const cfg2 = buildControlFlowGraph({ root: fn.body });
                timings.cfgBuild += performance.now() - cfg2Start;
                const table2Start = performance.now();
                const table2 = buildLocalVariableTable(fnPath);
                timings.localVarTable += performance.now() - table2Start;
                if (cfg2 !== null) {
                    const liveStart = performance.now();
                    const live = runLiveVariablesAnalysis(cfg2, table2);
                    timings.liveVars += performance.now() - liveStart;
                    const daStart = performance.now();
                    const da = eliminateDeadAssignments(fn, cfg2, live);
                    timings.deadAssigns += performance.now() - daStart;
                    if (da.removed > 0) {
                        changed = true;
                        stats.deadAssigns += da.removed;
                    }
                }
            } else {
                const liveStart = performance.now();
                const live = runLiveVariablesAnalysis(cfg, table);
                timings.liveVars += performance.now() - liveStart;
                const daStart = performance.now();
                const da = eliminateDeadAssignments(fn, cfg, live);
                timings.deadAssigns += performance.now() - daStart;
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

export type SimplifyAllOptions = {
    /** Functions to simplify. If omitted, every Function is simplified
     *  (legacy/test behavior). The pipeline always passes a populated set. */
    touched?: WeakSet<t.Function>;
};

/**
 * Walk the program and simplify every touched Function node bottom-up.
 * Bottom-up so inner functions are simplified before outer; outer
 * simplification then sees the already-cleaned inner shape.
 */
export function simplifyAll(root: t.Node, options: SimplifyAllOptions = {}): SimplifyStats {
    const touched = options.touched;
    // Top-level rename is intentionally not performed — we only uniquify
    // names within each function (see `simplifyFunction`). At the program
    // level we leave `normalized=false` so PeepholeRemoveDeadCode keeps the
    // conservative block-merge check for any top-level inner blocks.
    const normalized = false;
    const total: SimplifyStats = {
        iterations: 0,
        folded: 0,
        removed: 0,
        inlined: 0,
        deadAssigns: 0,
        minimized: 0,
        timings: emptyTimings(),
    };

    traverse(root, {
        Function: {
            exit(path) {
                if (touched && !touched.has(path.node)) return;
                const s = simplifyFunction(path, { normalized });
                total.iterations += s.iterations;
                total.folded += s.folded;
                total.removed += s.removed;
                total.inlined += s.inlined;
                total.deadAssigns += s.deadAssigns;
                total.minimized += s.minimized;
                addTimings(total.timings, s.timings);
            },
        },
    });

    // Program-level cleanup: AST-only peepholes (no CFG) over the whole tree
    // for top-level statements outside any function. Cheap relative to the
    // per-function CFG-based work above, so we always run it.
    let topChanged = true;
    let topIters = 0;
    while (topChanged && topIters < MAX_ITERATIONS) {
        topChanged = false;
        const fStart = performance.now();
        const f = runPeepholeFoldConstants(root);
        total.timings.foldConstants += performance.now() - fStart;
        if (f.folded > 0) {
            topChanged = true;
            total.folded += f.folded;
        }
        const mStart = performance.now();
        const m = runPeepholeMinimizeConditions(root);
        total.timings.minimizeConditions += performance.now() - mStart;
        if (m.minimized > 0) {
            topChanged = true;
            total.minimized += m.minimized;
        }
        const dStart = performance.now();
        const d = runPeepholeRemoveDeadCode(root, { normalized });
        total.timings.removeDeadCode += performance.now() - dStart;
        if (d.removed > 0) {
            topChanged = true;
            total.removed += d.removed;
        }
        topIters++;
    }
    total.iterations += topIters;

    return total;
}
