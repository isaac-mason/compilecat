import * as t from '@babel/types';
export type SroaResult = {
    sroad: number;
};
export type SroaOptions = {
    /** Set populated with the enclosing function of every SROA'd local. */
    touched?: WeakSet<t.Function>;
};
export declare function applySroa(root: t.Node, options?: SroaOptions): SroaResult;
