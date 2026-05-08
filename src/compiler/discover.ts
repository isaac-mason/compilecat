// Per-file index. Mirrors src/plugin/analyses/discover.ts; standalone — no
// cross-tree imports. Surfaces the structural facts the cross-file inliner
// needs:
//   - Top-level functions (with annotations)
//   - Module-scope variables (scratch buffers, constants)
//   - Imports (named / default / namespace)
//   - Namespace re-exports (`export * as X from './Y'`)
//   - Per-function free references to top-level names
//
// Pure: parse + walk, no AST mutation. Re-invoke after mutations invalidate
// the previous index.

import { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';

import { traverse } from './babel-interop';
import { DIRECTIVE_PATTERNS } from './directives';

const INLINE_PATTERN = DIRECTIVE_PATTERNS.inline;
const FLATTEN_PATTERN = DIRECTIVE_PATTERNS.flatten;
const OPTIMIZE_PATTERN = DIRECTIVE_PATTERNS.optimize;

function hasBlockAnnotation(
    node: t.Node | null | undefined,
    pattern: RegExp,
): boolean {
    if (!node) return false;
    const comments = (node as { leadingComments?: readonly t.Comment[] }).leadingComments;
    if (!comments) return false;
    return comments.some((c) => c.type === 'CommentBlock' && pattern.test(c.value));
}

export function hasInlineAnnotation(node: t.Node | null | undefined): boolean {
    return hasBlockAnnotation(node, INLINE_PATTERN);
}

export function hasFlattenAnnotation(node: t.Node | null | undefined): boolean {
    return (
        hasBlockAnnotation(node, FLATTEN_PATTERN) ||
        hasBlockAnnotation(node, OPTIMIZE_PATTERN)
    );
}

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
};

export type ModuleVar = {
    name: string;
    declaration: t.VariableDeclaration;
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

export function indexFile(absolutePath: string, ast: t.File): FileIndex {
    const functions = new Map<string, IndexedFunction>();
    const moduleVars = new Map<string, ModuleVar>();
    const imports = new Map<string, ImportBinding>();
    const namespaceReexports = new Map<string, string>();

    for (const stmt of ast.program.body) {
        collectStatement(
            stmt,
            absolutePath,
            functions,
            moduleVars,
            imports,
            namespaceReexports,
            false,
            false,
        );
    }

    const topLevelNames = new Set<string>([
        ...functions.keys(),
        ...moduleVars.keys(),
        ...imports.keys(),
    ]);
    for (const fn of functions.values()) {
        analyzeFreeRefs(fn, topLevelNames, functions, moduleVars, imports, ast);
    }

    return { absolutePath, ast, functions, moduleVars, imports, namespaceReexports };
}

function collectStatement(
    stmt: t.Statement,
    sourceFile: string,
    functions: Map<string, IndexedFunction>,
    moduleVars: Map<string, ModuleVar>,
    imports: Map<string, ImportBinding>,
    namespaceReexports: Map<string, string>,
    inheritedInline: boolean,
    inheritedFlatten: boolean,
): void {
    const localInline = inheritedInline || hasInlineAnnotation(stmt);
    const localFlatten = inheritedFlatten || hasFlattenAnnotation(stmt);

    if (t.isImportDeclaration(stmt)) {
        recordImports(stmt, imports);
        return;
    }
    if (t.isExportNamedDeclaration(stmt)) {
        if (stmt.source && stmt.specifiers.length > 0) {
            for (const spec of stmt.specifiers) {
                if (t.isExportNamespaceSpecifier(spec)) {
                    namespaceReexports.set(spec.exported.name, stmt.source.value);
                }
            }
        }
        if (stmt.declaration) {
            collectStatement(
                stmt.declaration,
                sourceFile,
                functions,
                moduleVars,
                imports,
                namespaceReexports,
                localInline,
                localFlatten,
            );
        }
        return;
    }
    if (t.isExportDefaultDeclaration(stmt)) {
        const decl = stmt.declaration;
        if (
            t.isFunctionDeclaration(decl) ||
            t.isFunctionExpression(decl) ||
            t.isArrowFunctionExpression(decl)
        ) {
            functions.set(
                'default',
                buildFunctionEntry('default', sourceFile, decl, localInline, localFlatten),
            );
        }
        return;
    }
    if (t.isFunctionDeclaration(stmt) && stmt.id) {
        functions.set(
            stmt.id.name,
            buildFunctionEntry(stmt.id.name, sourceFile, stmt, localInline, localFlatten),
        );
        return;
    }
    if (t.isVariableDeclaration(stmt)) {
        for (const decl of stmt.declarations) {
            if (!t.isIdentifier(decl.id)) continue;
            const name = decl.id.name;
            if (
                decl.init &&
                (t.isArrowFunctionExpression(decl.init) || t.isFunctionExpression(decl.init))
            ) {
                functions.set(
                    name,
                    buildFunctionEntry(name, sourceFile, decl.init, localInline, localFlatten),
                );
            } else {
                moduleVars.set(name, { name, declaration: stmt, isExported: false });
            }
        }
        return;
    }
}

function buildFunctionEntry(
    name: string,
    sourceFile: string,
    fn: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression,
    inlineAnnot: boolean,
    flattenAnnot: boolean,
): IndexedFunction {
    const body: t.BlockStatement = t.isBlockStatement(fn.body)
        ? fn.body
        : t.blockStatement([t.returnStatement(fn.body)]);

    const { isSimpleReturn, returnExpression } = classifyBody(body);

    const kind: FunctionKind = t.isFunctionDeclaration(fn)
        ? 'declaration'
        : t.isArrowFunctionExpression(fn)
          ? 'arrow'
          : 'expression';

    return {
        name,
        sourceFile,
        kind,
        fnNode: fn,
        params: fn.params,
        body,
        hasInlineAnnotation: inlineAnnot,
        hasFlattenAnnotation: flattenAnnot,
        isSimpleReturn,
        returnExpression,
        moduleVarRefs: new Set(),
        functionRefs: new Set(),
        importRefs: new Set(),
    };
}

function classifyBody(body: t.BlockStatement): {
    isSimpleReturn: boolean;
    returnExpression: t.Expression | null;
} {
    if (body.body.length !== 1) return { isSimpleReturn: false, returnExpression: null };
    const only = body.body[0];
    if (!t.isReturnStatement(only)) return { isSimpleReturn: false, returnExpression: null };
    if (!only.argument) return { isSimpleReturn: false, returnExpression: null };
    return { isSimpleReturn: true, returnExpression: only.argument };
}

function recordImports(
    decl: t.ImportDeclaration,
    imports: Map<string, ImportBinding>,
): void {
    const source = decl.source.value;
    for (const spec of decl.specifiers) {
        if (t.isImportSpecifier(spec)) {
            const importedName = t.isIdentifier(spec.imported)
                ? spec.imported.name
                : spec.imported.value;
            imports.set(spec.local.name, {
                localName: spec.local.name,
                importedName,
                style: 'named',
                source,
            });
        } else if (t.isImportDefaultSpecifier(spec)) {
            imports.set(spec.local.name, {
                localName: spec.local.name,
                importedName: 'default',
                style: 'default',
                source,
            });
        } else if (t.isImportNamespaceSpecifier(spec)) {
            imports.set(spec.local.name, {
                localName: spec.local.name,
                importedName: '*',
                style: 'namespace',
                source,
            });
        }
    }
}

function analyzeFreeRefs(
    fn: IndexedFunction,
    topLevelNames: Set<string>,
    functions: Map<string, IndexedFunction>,
    moduleVars: Map<string, ModuleVar>,
    imports: Map<string, ImportBinding>,
    ast: t.File,
): void {
    let rootPath: NodePath<t.Function> | null = null;
    traverse(ast, {
        FunctionDeclaration(path) {
            if (path.node.id?.name === fn.name) {
                rootPath = path as unknown as NodePath<t.Function>;
                path.stop();
            }
        },
        VariableDeclarator(path) {
            if (
                t.isIdentifier(path.node.id) &&
                path.node.id.name === fn.name &&
                (t.isArrowFunctionExpression(path.node.init) ||
                    t.isFunctionExpression(path.node.init))
            ) {
                rootPath = path.get('init') as unknown as NodePath<t.Function>;
                path.stop();
            }
        },
        ExportDefaultDeclaration(path) {
            if (fn.name !== 'default') return;
            const decl = path.node.declaration;
            if (
                t.isFunctionDeclaration(decl) ||
                t.isFunctionExpression(decl) ||
                t.isArrowFunctionExpression(decl)
            ) {
                rootPath = path.get('declaration') as unknown as NodePath<t.Function>;
                path.stop();
            }
        },
    });

    if (!rootPath) return;
    const safePath = rootPath as NodePath<t.Function>;

    safePath.traverse({
        Identifier(innerPath) {
            const name = innerPath.node.name;
            if (!topLevelNames.has(name)) return;
            if (!innerPath.isReferencedIdentifier()) return;
            const scopeBinding = innerPath.scope.getBinding(name);
            if (!scopeBinding) return;
            if (scopeBinding.scope.block.type !== 'Program') return;
            if (functions.has(name)) fn.functionRefs.add(name);
            else if (moduleVars.has(name)) fn.moduleVarRefs.add(name);
            else if (imports.has(name)) fn.importRefs.add(name);
        },
    });
}
