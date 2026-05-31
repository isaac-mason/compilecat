import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
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
export type SimplifyOptions = {
    /** Retained for source compatibility with callers; ignored. Block-merge
     *  safety is now established per-function by `renameForFlatten`. */
    normalized?: boolean;
};
/**
 * Simplify a single function in place. Caller is responsible for picking
 * which functions to simplify (zone gating happens in the pipeline layer).
 */
export declare function simplifyFunction(fnPath: NodePath<t.Function>, _options?: SimplifyOptions): SimplifyStats;
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
export declare function simplifyAll(root: t.Node, options?: SimplifyAllOptions): SimplifyStats;
