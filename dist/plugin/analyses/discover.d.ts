import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
export declare function hasInlineAnnotation(node: t.Node | null | undefined): boolean;
export declare function hasInlineBodyAnnotation(node: t.Node | null | undefined): boolean;
export declare function hasSroaAnnotation(node: t.Node | null | undefined): boolean;
export declare function hasUnrollAnnotation(node: t.Node | null | undefined): boolean;
/**
 * Callsite `@inline` detection — handles both
 *   `/* @inline *​/ foo();`       (comment on the enclosing statement)
 *   `const x = /* @inline *​/ foo();`  (comment on the call expression itself)
 */
export declare function callSiteHasInlineAnnotation(path: NodePath<t.CallExpression>): boolean;
export type FunctionKind = 'declaration' | 'arrow' | 'expression';
export type IndexedFunction = {
    name: string;
    sourceFile: string;
    kind: FunctionKind;
    params: t.Node[];
    body: t.BlockStatement;
    hasInlineAnnotation: boolean;
    /**
     * `@inline-body` — caller-side bulk directive. Any resolvable call
     * inside this function's body is treated as if its callsite had `@inline`.
     */
    hasInlineBodyAnnotation: boolean;
    /** body is `{ return <expr>; }` with no other statements. */
    isSimpleReturn: boolean;
    /** when isSimpleReturn, the expression returned. */
    returnExpression: t.Expression | null;
    /** free refs to other top-level bindings (resolved by name only here). */
    moduleVarRefs: Set<string>;
    functionRefs: Set<string>;
    importRefs: Set<string>;
    /** path to the declaring node (null if function was reconstructed). */
    declarationPath: NodePath | null;
};
export type ModuleVar = {
    name: string;
    declaration: t.VariableDeclaration;
    isExported: boolean;
};
export type ImportStyle = 'named' | 'default' | 'namespace';
export type ImportBinding = {
    localName: string;
    /** for 'named' this is the imported name, for 'default' it's 'default', namespace is '*'. */
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
    /** `export * as Foo from './src'` — Foo → './src'. */
    namespaceReexports: Map<string, string>;
};
export declare function indexFile(absolutePath: string, ast: t.File): FileIndex;
