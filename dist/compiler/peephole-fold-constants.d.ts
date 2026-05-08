import * as t from '@babel/types';
export type FoldResult = {
    /** Number of nodes rewritten. */
    folded: number;
};
export declare function runPeepholeFoldConstants(root: t.Node): FoldResult;
