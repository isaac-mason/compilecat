import { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { traverse } from '../util/babel';
import { DIRECTIVE_PATTERNS } from './directives';

/**
 * discover — builds a FileIndex for a single source file.
 *
 * Surfaces the structural facts the inliner needs:
 *   - `@cc-inline`-annotated top-level functions (with their params/body)
 *   - module-scope variables (scratch buffers, constants)
 *   - imports (named / default / namespace)
 *   - namespace re-exports (`export * as X from './Y'`)
 *   - per-function free references (module vars, other functions, imports)
 *
 * Everything here is pure: parse + walk, no AST mutation. Re-invoke after
 * mutations invalidate the previous index.
 */

// Directive patterns live in `directives.ts` — imported here rather than
// duplicated so adding or renaming a directive is a one-line change.
const INLINE_PATTERN = DIRECTIVE_PATTERNS.inline;
const INLINE_BODY_PATTERN = DIRECTIVE_PATTERNS['inline-body'];
const SROA_PATTERN = DIRECTIVE_PATTERNS.sroa;
const UNROLL_PATTERN = DIRECTIVE_PATTERNS.unroll;
const OPTIMIZE_PATTERN = DIRECTIVE_PATTERNS.optimize;

function hasBlockAnnotation(node: t.Node | null | undefined, pattern: RegExp): boolean {
    if (!node) return false;
    const comments = (node as { leadingComments?: readonly t.Comment[] }).leadingComments;
    if (!comments) return false;
    return comments.some((c) => c.type === 'CommentBlock' && pattern.test(c.value));
}

export function hasInlineAnnotation(node: t.Node | null | undefined): boolean {
    return hasBlockAnnotation(node, INLINE_PATTERN);
}

export function hasInlineBodyAnnotation(node: t.Node | null | undefined): boolean {
    return hasBlockAnnotation(node, INLINE_BODY_PATTERN) || hasBlockAnnotation(node, OPTIMIZE_PATTERN);
}

export function hasSroaAnnotation(node: t.Node | null | undefined): boolean {
    return hasBlockAnnotation(node, SROA_PATTERN) || hasBlockAnnotation(node, OPTIMIZE_PATTERN);
}

export function hasUnrollAnnotation(node: t.Node | null | undefined): boolean {
    return hasBlockAnnotation(node, UNROLL_PATTERN) || hasBlockAnnotation(node, OPTIMIZE_PATTERN);
}

/**
 * Callsite `@cc-inline` detection — handles both
 *   `/* @cc-inline *​/ foo();`       (comment on the enclosing statement)
 *   `const x = /* @cc-inline *​/ foo();`  (comment on the call expression itself)
 */
export function callSiteHasInlineAnnotation(path: NodePath<t.CallExpression>): boolean {
    if (hasInlineAnnotation(path.node)) return true;
    const parent = path.parentPath;
    if (parent && parent.isExpressionStatement()) {
        if (hasInlineAnnotation(parent.node)) return true;
    }
    return false;
}

export type FunctionKind = 'declaration' | 'arrow' | 'expression';

export type IndexedFunction = {
    name: string;
    sourceFile: string;
    kind: FunctionKind;
    params: t.Node[];
    body: t.BlockStatement;
    hasInlineAnnotation: boolean;
    /**
     * `@cc-inline-body` — caller-side bulk directive. Any resolvable call
     * inside this function's body is treated as if its callsite had `@cc-inline`.
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

    // Second pass: free-reference analysis. Needs the full top-level name set
    // to distinguish "reads a module var" from "reads a local".
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

/**
 * Collect a top-level statement. The `inherited*` flags let a block comment
 * above an export declaration flow down to the exported function.
 */
function collectStatement(
    stmt: t.Statement,
    sourceFile: string,
    functions: Map<string, IndexedFunction>,
    moduleVars: Map<string, ModuleVar>,
    imports: Map<string, ImportBinding>,
    namespaceReexports: Map<string, string>,
    inheritedInline: boolean,
    inheritedInlineBody: boolean,
): void {
    const localInline = inheritedInline || hasInlineAnnotation(stmt);
    const localInlineBody = inheritedInlineBody || hasInlineBodyAnnotation(stmt);

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
                localInlineBody,
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
                buildFunctionEntry('default', sourceFile, decl, null, localInline, localInlineBody),
            );
        }
        return;
    }
    if (t.isFunctionDeclaration(stmt) && stmt.id) {
        functions.set(
            stmt.id.name,
            buildFunctionEntry(stmt.id.name, sourceFile, stmt, null, localInline, localInlineBody),
        );
        return;
    }
    if (t.isVariableDeclaration(stmt)) {
        for (const decl of stmt.declarations) {
            if (!t.isIdentifier(decl.id)) continue;
            const name = decl.id.name;
            if (decl.init && (t.isArrowFunctionExpression(decl.init) || t.isFunctionExpression(decl.init))) {
                functions.set(
                    name,
                    buildFunctionEntry(name, sourceFile, decl.init, null, localInline, localInlineBody),
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
    path: NodePath | null,
    hasInlineAnnotation: boolean,
    hasInlineBodyAnnotation: boolean,
): IndexedFunction {
    let body: t.BlockStatement;
    if (t.isBlockStatement(fn.body)) {
        body = fn.body;
    } else {
        // arrow with expression body: wrap in `{ return <expr> }` equivalent
        body = t.blockStatement([t.returnStatement(fn.body)]);
    }

    const { isSimpleReturn, returnExpression } = classifyBody(body);

    const kind = t.isFunctionDeclaration(fn)
        ? 'declaration'
        : t.isArrowFunctionExpression(fn)
          ? 'arrow'
          : 'expression';

    return {
        name,
        sourceFile,
        kind,
        params: fn.params,
        body,
        hasInlineAnnotation,
        hasInlineBodyAnnotation,
        isSimpleReturn,
        returnExpression,
        moduleVarRefs: new Set(),
        functionRefs: new Set(),
        importRefs: new Set(),
        declarationPath: path,
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

function recordImports(decl: t.ImportDeclaration, imports: Map<string, ImportBinding>): void {
    const source = decl.source.value;
    for (const spec of decl.specifiers) {
        if (t.isImportSpecifier(spec)) {
            const importedName = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
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

/**
 * Walk a function body and record which top-level names it references. Uses
 * babel scope to filter out locals and parameters.
 */
function analyzeFreeRefs(
    fn: IndexedFunction,
    topLevelNames: Set<string>,
    functions: Map<string, IndexedFunction>,
    moduleVars: Map<string, ModuleVar>,
    imports: Map<string, ImportBinding>,
    ast: t.File,
): void {
    // We need a NodePath to use babel scope. Re-find the function via traversal.
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
            // Skip identifiers in binding positions (decls, function params, etc.).
            if (!innerPath.isReferencedIdentifier()) return;
            const scopeBinding = innerPath.scope.getBinding(name);
            // No binding: treat as global (e.g. `Math`, `console`) — not a top-level ref.
            if (!scopeBinding) return;
            // Any binding that isn't at Program scope is a local shadow.
            if (scopeBinding.scope.block.type !== 'Program') return;
            if (functions.has(name)) fn.functionRefs.add(name);
            else if (moduleVars.has(name)) fn.moduleVarRefs.add(name);
            else if (imports.has(name)) fn.importRefs.add(name);
        },
    });
}
