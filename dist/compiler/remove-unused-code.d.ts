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
export declare function removeUnusedCode(ast: t.File): RemoveUnusedResult;
