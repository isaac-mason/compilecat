import * as t from '@babel/types';
export type BlockMutateInput = {
    body: t.BlockStatement;
    /** Names of the callee's parameters, in order. */
    params: string[];
    /** Argument expressions at the call site, already cloned. */
    args: t.Expression[];
    /** Label used on the wrapper block; caller picks a unique name. */
    label: string;
    /** Name of the result temp used in `_r = X; break LABEL;`. */
    resultName: string;
    /** When false, return statements are rewritten as bare `break LABEL;`
     *  (caller doesn't need the result — e.g. function used as a statement). */
    needsResult: boolean;
};
export type BlockMutateOutput = {
    block: t.LabeledStatement;
    /** True when at least one return was rewritten — i.e. `_r` is initialized
     *  on at least one path. Caller may choose to declare `_r` only when this
     *  is true. */
    hasResultWrite: boolean;
};
export declare function mutateForBlockInline(input: BlockMutateInput): BlockMutateOutput;
