import * as t from '@babel/types';
export type InlineResult = {
    /** Number of distinct candidates that were resolved at least once. */
    inlined: number;
    /** Call sites attempted (DIRECT or BLOCK). */
    calls: number;
    /** Call sites where injection succeeded. */
    succeeded: number;
};
export declare function inlineFunctions(root: t.Node): InlineResult;
