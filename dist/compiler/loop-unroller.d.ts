import * as t from '@babel/types';
export type UnrollResult = {
    unrolled: number;
};
export declare function unrollLoops(root: t.Node): UnrollResult;
