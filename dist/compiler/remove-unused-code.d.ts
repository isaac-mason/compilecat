import * as t from '@babel/types';
export type RemoveUnusedResult = {
    /** `let|const|var` declarators removed. */
    removedDeclarators: number;
    /** `function NAME() {}` declarations removed. */
    removedFunctionDecls: number;
    /** Individual import specifiers removed (counts each name). */
    removedImportSpecifiers: number;
    /** Whole `import ... from '…'` statements removed. */
    removedImportDeclarations: number;
};
export type RemoveUnusedOptions = {
    /** Declarators / function decls inside a function not in this set are
     *  skipped. If omitted, every declarator is visited (legacy/test
     *  behavior). */
    touched?: WeakSet<t.Function>;
};
export declare function removeUnusedCode(ast: t.File, options?: RemoveUnusedOptions): RemoveUnusedResult;
