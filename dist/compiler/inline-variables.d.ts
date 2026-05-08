import * as t from '@babel/types';
export type InlineVariablesResult = {
    /** Number of variables inlined (equal to declarators removed). */
    inlined: number;
};
export declare function inlineVariables(ast: t.File): InlineVariablesResult;
