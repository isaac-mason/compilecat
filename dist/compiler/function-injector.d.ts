import * as t from '@babel/types';
export type InliningMode = 'DIRECT' | 'BLOCK' | 'NO';
export type InjectorOptions = {
    /** Used to allocate fresh `_compilecat_inline_*` ids. */
    nextId: () => number;
};
export type Callee = {
    /** Function declaration / expression / arrow whose body is to be inlined. */
    fn: t.Function;
    /** Names of declared parameters (only simple identifiers supported). */
    paramNames: string[];
};
export declare function classifyCallee(fn: t.Function): {
    mode: InliningMode;
    reason?: string;
};
export type CallSite = {
    /** The CallExpression to inline. */
    call: t.CallExpression;
    /** The statement that contains the CallExpression — used as the splice
     *  point for BLOCK mode hoisting. Must sit in a statement-list container. */
    enclosingStatement: t.Statement;
    /** The container holding the enclosing statement (Block/Program body, or
     *  SwitchCase consequent), plus the index of the enclosing statement. */
    statementParent: t.BlockStatement | t.Program | t.SwitchCase;
    statementIndex: number;
    /** Parent of the CallExpression and key/index for in-place replacement. */
    callParent: t.Node;
    callKey: string;
    callIndex?: number;
};
export declare function inlineDirect(callee: Callee, site: CallSite): boolean;
export declare function inlineBlock(callee: Callee, site: CallSite, options: InjectorOptions): boolean;
