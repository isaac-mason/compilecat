import * as t from '@babel/types';
export type RemoveResult = {
    /** Number of statements/expressions deleted or simplified. */
    removed: number;
};
export type RemoveOptions = {
    /** Mirrors Closure's `isASTNormalized()` flag passed through to
     *  NodeUtil.tryMergeBlock as `ignoreBlockScopedDeclarations`. When true,
     *  block-flatten is allowed even when the inner block has let/const/class/
     *  function declarations — safe because Normalize has already uniquified
     *  every declared name across the whole file. See
     *  NodeUtil.java:2483-2508. */
    normalized?: boolean;
};
export declare function runPeepholeRemoveDeadCode(root: t.Node, options?: RemoveOptions): RemoveResult;
