import * as t from '@babel/types';
export type SimplifyStats = {
    iterations: number;
    folded: number;
    removed: number;
    inlined: number;
    deadAssigns: number;
    minimized: number;
};
/**
 * Simplify a single function in place. Caller is responsible for picking
 * which functions to simplify (zone gating happens in the pipeline layer).
 */
export declare function simplifyFunction(fn: t.Function): SimplifyStats;
/**
 * Walk the program and simplify every Function node bottom-up. Bottom-up so
 * inner functions are simplified before outer; outer simplification then sees
 * the already-cleaned inner shape.
 */
export declare function simplifyAll(root: t.Node): SimplifyStats;
