import * as t from '@babel/types';
export type InlineVariablesResult = {
    /** Number of variables inlined (equal to declarators removed). */
    inlined: number;
};
export type InlineVariablesOptions = {
    /** Declarators inside a function not in this set are skipped. If omitted,
     *  every declarator is visited (legacy/test behavior). */
    touched?: WeakSet<t.Function>;
};
export declare function inlineVariables(ast: t.File, options?: InlineVariablesOptions): InlineVariablesResult;
