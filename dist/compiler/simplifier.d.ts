import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
export type SimplifyStats = {
    iterations: number;
    folded: number;
    removed: number;
    inlined: number;
    deadAssigns: number;
    minimized: number;
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
/**
 * Walk the program and simplify every Function node bottom-up. Bottom-up so
 * inner functions are simplified before outer; outer simplification then sees
 * the already-cleaned inner shape.
 */
export declare function simplifyAll(root: t.Node): SimplifyStats;
