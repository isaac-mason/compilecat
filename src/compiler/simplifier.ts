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
import * as t from '@babel/types';

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
};

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
export function simplifyFunction(
    fnPath: NodePath<t.Function>,
    _options: SimplifyOptions = {},
): SimplifyStats {
    const stats: SimplifyStats = {
        iterations: 0,
        folded: 0,
        removed: 0,
        inlined: 0,
        deadAssigns: 0,
        minimized: 0,
    };

    const fn = fnPath.node;

    // Rename nested-block bindings that would collide on flatten. After this
    // pass, every let/const/class/function-declaration inside `fn` is uniquely
    // named within the function, so `PeepholeRemoveDeadCode` can splice nested
    // blocks into their parents with `ignoreBlockScopedDeclarations=true`.
    renameForFlatten(fnPath);
    const normalized = true;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        let changed = false;

        const fold = runPeepholeFoldConstants(fn.body);
        if (fold.folded > 0) {
            changed = true;
            stats.folded += fold.folded;
        }

        // MinimizeExitPoints reshapes labeled-block / loop / function exits
        // into implicit fall-through. Run before PeepholeMinimizeConditions so
        // the resulting if/else gets collapsed to ternaries.
        const exits = runMinimizeExitPoints(fn);
        if (exits.minimized > 0) {
            changed = true;
            stats.minimized += exits.minimized;
        }

        const min = runPeepholeMinimizeConditions(fn.body);
        if (min.minimized > 0) {
            changed = true;
            stats.minimized += min.minimized;
        }

        const dead = runPeepholeRemoveDeadCode(fn.body, { normalized });
        if (dead.removed > 0) {
            changed = true;
            stats.removed += dead.removed;
        }

        const cfg = buildControlFlowGraph({ root: fn.body });
        if (cfg !== null) {
            const table = buildLocalVariableTable(fnPath);

            const inline = runFlowSensitiveInlineVariables(fn, cfg, table);
            if (inline.inlined > 0) {
                changed = true;
                stats.inlined += inline.inlined;
            }

            // DAE needs a fresh CFG+table after inline, since inline mutates.
            if (inline.inlined > 0) {
                const cfg2 = buildControlFlowGraph({ root: fn.body });
                const table2 = buildLocalVariableTable(fnPath);
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
    };

    traverse(root, {
        Function: {
            exit(path) {
                const s = simplifyFunction(path, { normalized });
                total.iterations += s.iterations;
                total.folded += s.folded;
                total.removed += s.removed;
                total.inlined += s.inlined;
                total.deadAssigns += s.deadAssigns;
                total.minimized += s.minimized;
            },
        },
    });

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
        const d = runPeepholeRemoveDeadCode(root, { normalized });
        if (d.removed > 0) {
            topChanged = true;
            total.removed += d.removed;
        }
        topIters++;
    }
    total.iterations += topIters;

    return total;
}
