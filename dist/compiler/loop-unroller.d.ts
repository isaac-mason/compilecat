import * as t from '@babel/types';
export type UnrollResult = {
    unrolled: number;
};
export type UnrollOptions = {
    /** Set populated with the enclosing function of every unrolled loop. */
    touched?: WeakSet<t.Function>;
};
export declare function unrollLoops(root: t.Node, options?: UnrollOptions): UnrollResult;
