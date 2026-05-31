import * as t from '@babel/types';
export declare function hasInlineAnnotation(node: t.Node | null | undefined): boolean;
export declare function hasFlattenAnnotation(node: t.Node | null | undefined): boolean;
export type FunctionKind = 'declaration' | 'arrow' | 'expression';
export type IndexedFunction = {
    name: string;
    sourceFile: string;
    kind: FunctionKind;
    /** The original Function node (declaration / expression / arrow) — used
     *  by the inliner to clone params + body when applying a cross-file inline. */
    fnNode: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression;
    params: t.Node[];
    body: t.BlockStatement;
    hasInlineAnnotation: boolean;
    hasFlattenAnnotation: boolean;
    isSimpleReturn: boolean;
    returnExpression: t.Expression | null;
    moduleVarRefs: Set<string>;
    functionRefs: Set<string>;
    importRefs: Set<string>;
    /** Program-scope identifiers we can't classify (e.g. TS enums, classes).
     *  Their presence means the body cannot be safely spliced cross-file —
     *  the hoister wouldn't know how to bring the dependency along. */
    unresolvedRefs: Set<string>;
};
export type ModuleVar = {
    name: string;
    declaration: t.VariableDeclaration | t.TSEnumDeclaration;
    isExported: boolean;
};
export type ImportStyle = 'named' | 'default' | 'namespace';
export type ImportBinding = {
    localName: string;
    importedName: string;
    style: ImportStyle;
    source: string;
};
export type FileIndex = {
    absolutePath: string;
    ast: t.File;
    functions: Map<string, IndexedFunction>;
    moduleVars: Map<string, ModuleVar>;
    imports: Map<string, ImportBinding>;
    namespaceReexports: Map<string, string>;
};
export declare function indexFile(absolutePath: string, ast: t.File): FileIndex;
