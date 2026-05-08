import * as t from '@babel/types';
export type RemoveResult = {
    /** Number of statements/expressions deleted or simplified. */
    removed: number;
};
export declare function runPeepholeRemoveDeadCode(root: t.Node): RemoveResult;
