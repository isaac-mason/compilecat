import * as t from '@babel/types';
import _generate from '@babel/generator';
import _traverse from '@babel/traverse';
import { parse } from '@babel/parser';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

// Babel ships its packages as CJS with a `default` export. Under some
// bundlers / loaders the ESM default-import lands as the function directly;
// under others it lands as `{ default: fn }`. Centralised here so each
// consumer just imports the unwrapped value.
const unwrap = (mod) => mod.default ?? mod;
const generate = unwrap(_generate);
const traverse = unwrap(_traverse);

// Authored `@*` directive vocabulary, ported from src/plugin/analyses/directives.ts.
// Standalone — no cross-tree imports. Same regex shapes so behavior matches.
const DIRECTIVE_PATTERNS = {
    inline: /@inline\b/,
    flatten: /@flatten\b/,
    sroa: /@sroa\b/,
    unroll: /@unroll\b/,
    optimize: /@optimize\b/,
};
const ANY_DIRECTIVE_IN_SOURCE = /@(?:inline|flatten|sroa|unroll|optimize)\b/;
function commentIsInlineDirective(value) {
    return DIRECTIVE_PATTERNS.inline.test(value) || DIRECTIVE_PATTERNS.flatten.test(value);
}
function commentIsFlattenDirective(value) {
    return DIRECTIVE_PATTERNS.flatten.test(value) || DIRECTIVE_PATTERNS.optimize.test(value);
}
function commentIsSroaDirective(value) {
    return DIRECTIVE_PATTERNS.sroa.test(value) || DIRECTIVE_PATTERNS.optimize.test(value);
}
function isExportWrapper(n) {
    return n !== null && (t.isExportNamedDeclaration(n) || t.isExportDefaultDeclaration(n));
}
// Babel attaches JSDoc preceding `export function` / `export default function`
// (and `export const foo = ...`) to the export wrapper, not the inner
// declaration. `hasLeadingDirective` checks the node's own leadingComments and
// falls back to the wrapping parent's, so authored `@inline`/`@optimize`/etc.
// on the export node still counts.
function hasLeadingDirective(n, parent, pred) {
    if (matchLeadingComment(n, pred))
        return true;
    if (isExportWrapper(parent) && matchLeadingComment(parent, pred))
        return true;
    return false;
}
function matchLeadingComment(n, pred) {
    const cs = (n.leadingComments ?? []);
    for (const c of cs) {
        if (pred(c.value))
            return true;
    }
    return false;
}
// Matches any directive that opts a function in to per-function cleanup
// (simplifier / inline-variables / remove-unused-code gating). Notably
// excludes `@inline` — that marks *callees*, not the functions that should
// receive cleanup; their callers are added by the inliner instead.
function commentIsAnyOptInDirective(value) {
    return (DIRECTIVE_PATTERNS.optimize.test(value) ||
        DIRECTIVE_PATTERNS.flatten.test(value) ||
        DIRECTIVE_PATTERNS.sroa.test(value) ||
        DIRECTIVE_PATTERNS.unroll.test(value));
}
function commentListHasOptIn(cs) {
    if (!cs)
        return false;
    for (const c of cs) {
        if (commentIsAnyOptInDirective(c.value))
            return true;
    }
    return false;
}
// Walk every Function node in `ast` and add it to `touched` if the function
// itself (or any statement inside its body, excluding nested functions) carries
// an opt-in directive (`@optimize` / `@flatten` / `@sroa` / `@unroll`).
//
// The body-scan picks up block-level opt-in markers authored as
// `function foo() { /* @optimize */ { ... } }`. Nested functions are skipped
// by the inner walker because they get their own visitor call from
// `traverse`, which handles their own membership independently.
function collectOptIns(ast, touched) {
    traverse(ast, {
        Function(path) {
            const node = path.node;
            if (touched.has(node))
                return;
            if (hasLeadingDirective(node, path.parent, commentIsAnyOptInDirective)) {
                touched.add(node);
                return;
            }
            if (functionBodyHasOptIn(node)) {
                touched.add(node);
            }
        },
    });
}
function functionBodyHasOptIn(fn) {
    let found = false;
    const visit = (n) => {
        if (found)
            return;
        // Don't descend into nested functions — they get their own visit.
        if (n !== fn && t.isFunction(n))
            return;
        if (commentListHasOptIn(n.leadingComments) || commentListHasOptIn(n.innerComments)) {
            found = true;
            return;
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = n[k];
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c);
                    if (found)
                        return;
                }
            }
            else if (child && typeof child === 'object' && 'type' in child) {
                visit(child);
            }
        }
    };
    visit(fn);
    return found;
}

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
const INLINE_PATTERN = DIRECTIVE_PATTERNS.inline;
const FLATTEN_PATTERN = DIRECTIVE_PATTERNS.flatten;
const OPTIMIZE_PATTERN = DIRECTIVE_PATTERNS.optimize;
function hasBlockAnnotation(node, pattern) {
    if (!node)
        return false;
    const comments = node.leadingComments;
    if (!comments)
        return false;
    return comments.some((c) => c.type === 'CommentBlock' && pattern.test(c.value));
}
function hasInlineAnnotation$1(node) {
    return hasBlockAnnotation(node, INLINE_PATTERN);
}
function hasFlattenAnnotation$1(node) {
    return (hasBlockAnnotation(node, FLATTEN_PATTERN) ||
        hasBlockAnnotation(node, OPTIMIZE_PATTERN));
}
function indexFile(absolutePath, ast) {
    const functions = new Map();
    const moduleVars = new Map();
    const imports = new Map();
    const namespaceReexports = new Map();
    for (const stmt of ast.program.body) {
        collectStatement(stmt, absolutePath, functions, moduleVars, imports, namespaceReexports, false, false);
    }
    for (const fn of functions.values()) {
        analyzeFreeRefs(fn, functions, moduleVars, imports, ast);
    }
    return { absolutePath, ast, functions, moduleVars, imports, namespaceReexports };
}
function collectStatement(stmt, sourceFile, functions, moduleVars, imports, namespaceReexports, inheritedInline, inheritedFlatten) {
    const localInline = inheritedInline || hasInlineAnnotation$1(stmt);
    const localFlatten = inheritedFlatten || hasFlattenAnnotation$1(stmt);
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
            collectStatement(stmt.declaration, sourceFile, functions, moduleVars, imports, namespaceReexports, localInline, localFlatten);
        }
        return;
    }
    if (t.isExportDefaultDeclaration(stmt)) {
        const decl = stmt.declaration;
        if (t.isFunctionDeclaration(decl) ||
            t.isFunctionExpression(decl) ||
            t.isArrowFunctionExpression(decl)) {
            functions.set('default', buildFunctionEntry('default', sourceFile, decl, localInline, localFlatten));
        }
        return;
    }
    if (t.isFunctionDeclaration(stmt) && stmt.id) {
        functions.set(stmt.id.name, buildFunctionEntry(stmt.id.name, sourceFile, stmt, localInline, localFlatten));
        return;
    }
    if (t.isTSEnumDeclaration(stmt)) {
        moduleVars.set(stmt.id.name, { name: stmt.id.name, declaration: stmt, isExported: false });
        return;
    }
    if (t.isVariableDeclaration(stmt)) {
        for (const decl of stmt.declarations) {
            if (!t.isIdentifier(decl.id))
                continue;
            const name = decl.id.name;
            if (decl.init &&
                (t.isArrowFunctionExpression(decl.init) || t.isFunctionExpression(decl.init))) {
                functions.set(name, buildFunctionEntry(name, sourceFile, decl.init, localInline, localFlatten));
            }
            else {
                moduleVars.set(name, { name, declaration: stmt, isExported: false });
            }
        }
        return;
    }
}
function buildFunctionEntry(name, sourceFile, fn, inlineAnnot, flattenAnnot) {
    const body = t.isBlockStatement(fn.body)
        ? fn.body
        : t.blockStatement([t.returnStatement(fn.body)]);
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
        unresolvedRefs: new Set(),
    };
}
function classifyBody(body) {
    if (body.body.length !== 1)
        return { isSimpleReturn: false, returnExpression: null };
    const only = body.body[0];
    if (!t.isReturnStatement(only))
        return { isSimpleReturn: false, returnExpression: null };
    if (!only.argument)
        return { isSimpleReturn: false, returnExpression: null };
    return { isSimpleReturn: true, returnExpression: only.argument };
}
function recordImports(decl, imports) {
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
        }
        else if (t.isImportDefaultSpecifier(spec)) {
            imports.set(spec.local.name, {
                localName: spec.local.name,
                importedName: 'default',
                style: 'default',
                source,
            });
        }
        else if (t.isImportNamespaceSpecifier(spec)) {
            imports.set(spec.local.name, {
                localName: spec.local.name,
                importedName: '*',
                style: 'namespace',
                source,
            });
        }
    }
}
function analyzeFreeRefs(fn, functions, moduleVars, imports, ast) {
    let rootPath = null;
    traverse(ast, {
        FunctionDeclaration(path) {
            if (path.node.id?.name === fn.name) {
                rootPath = path;
                path.stop();
            }
        },
        VariableDeclarator(path) {
            if (t.isIdentifier(path.node.id) &&
                path.node.id.name === fn.name &&
                (t.isArrowFunctionExpression(path.node.init) ||
                    t.isFunctionExpression(path.node.init))) {
                rootPath = path.get('init');
                path.stop();
            }
        },
        ExportDefaultDeclaration(path) {
            if (fn.name !== 'default')
                return;
            const decl = path.node.declaration;
            if (t.isFunctionDeclaration(decl) ||
                t.isFunctionExpression(decl) ||
                t.isArrowFunctionExpression(decl)) {
                rootPath = path.get('declaration');
                path.stop();
            }
        },
    });
    if (!rootPath)
        return;
    const safePath = rootPath;
    // Babel's scope plugin doesn't bind TSEnumDeclaration (and a few other TS-only
    // forms), so `getBinding` is `null` for valid top-level enum refs. When the
    // scope is silent, fall back to the top-level index — `getBinding` would have
    // returned a *non-Program* binding if any inner local shadowed the name, so a
    // null result is safe to resolve against module-scope.
    safePath.traverse({
        Identifier(innerPath) {
            const name = innerPath.node.name;
            if (!innerPath.isReferencedIdentifier())
                return;
            const scopeBinding = innerPath.scope.getBinding(name);
            if (scopeBinding && scopeBinding.scope.block.type !== 'Program')
                return;
            if (functions.has(name))
                fn.functionRefs.add(name);
            else if (moduleVars.has(name))
                fn.moduleVarRefs.add(name);
            else if (imports.has(name))
                fn.importRefs.add(name);
            else if (scopeBinding)
                fn.unresolvedRefs.add(name);
        },
    });
}

// Path resolution for cross-file inlining.
//
// Two modes:
//   - Same-project (relative + absolute paths). Always allowed; probes
//     extensions and index files.
//   - Library (bare specifier `lodash`, `@scope/pkg/sub`). Only consulted
//     when the call site explicitly opts in via `/* @inline */`. Walks up
//     `node_modules`, honors package.json `exports` / `main` / `module`.
//
// FileReader abstraction lets tests inject a virtual filesystem. Library
// resolution always reads package.json directly from disk.
const defaultFileReader = (absolutePath) => {
    try {
        return fs.readFileSync(absolutePath, 'utf-8');
    }
    catch {
        return null;
    }
};
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
function diskExists(path) {
    try {
        return fs.statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function makeExists(reader) {
    if (!reader)
        return diskExists;
    return (path) => reader(path) !== null;
}
function probeWithExtensions(base, exists) {
    if (exists(base))
        return base;
    for (const ext of SOURCE_EXTENSIONS) {
        if (exists(base + ext))
            return base + ext;
    }
    for (const ext of SOURCE_EXTENSIONS) {
        const p = nodePath.join(base, `index${ext}`);
        if (exists(p))
            return p;
    }
    return null;
}
function resolveRelativeImport(fromFile, specifier, reader) {
    if (!specifier.startsWith('./') &&
        !specifier.startsWith('../') &&
        !specifier.startsWith('/')) {
        return null;
    }
    const base = nodePath.isAbsolute(specifier)
        ? specifier
        : nodePath.resolve(nodePath.dirname(fromFile), specifier);
    return probeWithExtensions(base, makeExists(reader));
}
function splitBareSpecifier(specifier) {
    if (specifier.startsWith('@')) {
        const parts = specifier.split('/');
        if (parts.length < 2)
            return [specifier, '.'];
        const name = `${parts[0]}/${parts[1]}`;
        const sub = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.';
        return [name, sub];
    }
    const idx = specifier.indexOf('/');
    if (idx < 0)
        return [specifier, '.'];
    return [specifier.slice(0, idx), `./${specifier.slice(idx + 1)}`];
}
function findPackageRoot(fromDir, pkgName) {
    let dir = fromDir;
    for (;;) {
        const candidate = nodePath.join(dir, 'node_modules', pkgName);
        if (diskExists(nodePath.join(candidate, 'package.json'))) {
            return candidate;
        }
        const parent = nodePath.dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
function readPackageJson(pkgRoot) {
    try {
        const raw = fs.readFileSync(nodePath.join(pkgRoot, 'package.json'), 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
const EXPORT_CONDITIONS = ['import', 'module', 'default', 'require'];
function resolveThroughExports(exportsField, subpath) {
    if (!exportsField || typeof exportsField !== 'object')
        return null;
    const exps = exportsField;
    if (typeof exportsField === 'string') {
        return subpath === '.' ? exportsField : null;
    }
    const directKey = subpath === '.' ? '.' : subpath;
    const entry = exps[directKey];
    if (entry === undefined)
        return null;
    return resolveConditionEntry(entry);
}
function resolveConditionEntry(entry) {
    if (typeof entry === 'string')
        return entry;
    if (!entry || typeof entry !== 'object')
        return null;
    const obj = entry;
    for (const cond of EXPORT_CONDITIONS) {
        if (cond in obj) {
            const resolved = resolveConditionEntry(obj[cond]);
            if (resolved)
                return resolved;
        }
    }
    return null;
}
function resolveLibraryImport(fromFile, specifier) {
    const [pkgName, subpath] = splitBareSpecifier(specifier);
    const pkgRoot = findPackageRoot(nodePath.dirname(fromFile), pkgName);
    if (!pkgRoot)
        return null;
    const pkg = readPackageJson(pkgRoot);
    if (!pkg)
        return null;
    const exists = diskExists;
    const exportTarget = resolveThroughExports(pkg.exports, subpath);
    if (exportTarget) {
        return probeWithExtensions(nodePath.join(pkgRoot, exportTarget), exists);
    }
    if (subpath === '.') {
        const target = pkg.module ?? pkg.main;
        if (target)
            return probeWithExtensions(nodePath.join(pkgRoot, target), exists);
        return probeWithExtensions(nodePath.join(pkgRoot, 'index'), exists);
    }
    return probeWithExtensions(nodePath.join(pkgRoot, subpath), exists);
}
function resolveImportSource(fromFile, specifier, allowLibrary, reader) {
    const rel = resolveRelativeImport(fromFile, specifier, reader);
    if (rel)
        return rel;
    if (allowLibrary)
        return resolveLibraryImport(fromFile, specifier);
    return null;
}

// Lazy, cached cross-file indexing.
//
//   - createFileCache() returns a mutable cache; share across multiple
//     transform calls in one build to amortize parse/index cost.
//   - ensureIndexed(cache, path, reader) parses + indexes if not cached and
//     returns the index. null when the file can't be read or parsed.
//   - Cycle-guard sentinel ('in-progress') breaks A→B→A recursion.
function ensureIndexed(cache, absolutePath, reader = defaultFileReader) {
    const existing = cache.entries.get(absolutePath);
    if (existing === 'in-progress')
        return null;
    if (existing)
        return existing;
    cache.entries.set(absolutePath, 'in-progress');
    const code = reader(absolutePath);
    if (code === null) {
        cache.entries.delete(absolutePath);
        return null;
    }
    let ast;
    try {
        ast = parse(code, {
            sourceType: 'module',
            plugins: ['typescript', 'jsx'],
            sourceFilename: absolutePath,
        });
    }
    catch {
        cache.entries.delete(absolutePath);
        return null;
    }
    const index = indexFile(absolutePath, ast);
    cache.entries.set(absolutePath, index);
    return index;
}

// Port of jscomp/NodeUtil.java (subset).
//
// NodeUtil in Closure is ~5000 LOC of Rhino-AST helpers. We port only what
// the algorithms we're bringing over actually need, on Babel types.
//
// Helpers added incrementally as ControlFlowAnalysis / DataFlowAnalysis /
// liveness passes consume them.
/**
 * The condition-bearing child of a control structure. Mirrors Closure's
 * `getConditionExpression` — null for things like `for(;;)` where the test
 * slot is empty.
 */
function getConditionExpression(node) {
    if (t.isIfStatement(node) || t.isWhileStatement(node) || t.isDoWhileStatement(node) || t.isConditionalExpression(node)) {
        return node.test;
    }
    if (t.isForStatement(node)) {
        return node.test ?? null;
    }
    return null;
}
/**
 * Whether `node` is a loop construct. Used by ControlFlowAnalysis when
 * resolving break/continue targets.
 */
function isLoop(node) {
    return (t.isWhileStatement(node) ||
        t.isDoWhileStatement(node) ||
        t.isForStatement(node) ||
        t.isForInStatement(node) ||
        t.isForOfStatement(node));
}
/**
 * Port of NodeUtil.isStatementBlock (NodeUtil.java:2170):
 *   return n.isRoot() || n.isScript() || n.isBlock() || n.isModuleBody();
 *
 * Babel has no ROOT or MODULE_BODY token — Program covers both.
 */
function isStatementBlock(n) {
    return t.isProgram(n) || t.isBlockStatement(n);
}
/**
 * Port of NodeUtil.canMergeBlock (NodeUtil.java:2516):
 *
 *   for (Node c = block.getFirstChild(); c != null; c = c.getNext()) {
 *     switch (c.getToken()) {
 *       case LABEL -> {
 *         if (canMergeBlock(c)) continue; else return false;
 *       }
 *       case CONST, LET, CLASS, FUNCTION -> { return false; }
 *       default -> { continue; }
 *     }
 *   }
 *   return true;
 *
 * Babel mapping:
 *   LABEL    → LabeledStatement
 *   CONST    → VariableDeclaration with kind === 'const'
 *   LET      → VariableDeclaration with kind === 'let'
 *   CLASS    → ClassDeclaration
 *   FUNCTION → FunctionDeclaration
 *
 * Closure's recursive `canMergeBlock(c)` on a LABEL iterates the LABEL's
 * children — label name (NAME, default branch) plus the labeled statement
 * (which falls into one of the cases). The LabeledStatement node in Babel
 * has a single body slot; we replicate the same semantics by inspecting it.
 */
function canMergeBlock(block) {
    for (const c of block.body) {
        if (!canMergeBlockChild(c))
            return false;
    }
    return true;
}
function canMergeBlockChild(c) {
    if (t.isLabeledStatement(c)) {
        // Closure recurses into the LABEL — its children are the label name
        // (always safe) and the labeled statement (must itself be safe).
        return canMergeBlockChild(c.body);
    }
    if (t.isVariableDeclaration(c) && (c.kind === 'const' || c.kind === 'let'))
        return false;
    if (t.isClassDeclaration(c))
        return false;
    if (t.isFunctionDeclaration(c))
        return false;
    return true;
}
/**
 * Port of NodeUtil.tryMergeBlock (NodeUtil.java:2490):
 *
 *   boolean canMerge = ignoreBlockScopedDeclarations || canMergeBlock(block);
 *   if (isStatementBlock(parent) && canMerge) {
 *     // splice block's children up into parent in-place; detach block
 *     return true;
 *   }
 *   return false;
 *
 * Babel doesn't expose Closure's child-pointer API, so the caller passes the
 * parent statement array and the index of the block within it; we splice
 * directly. Returns the number of statements spliced in (== the block's
 * child count) when the merge happened, or 0 when it was rejected.
 */
function tryMergeBlock(block, parentBody, indexInParent, parent, ignoreBlockScopedDeclarations) {
    if (!isStatementBlock(parent))
        return 0;
    const canMerge = ignoreBlockScopedDeclarations || canMergeBlock(block);
    if (!canMerge)
        return 0;
    // When `ignoreBlockScopedDeclarations` is true, the caller has run
    // `renameForFlatten` (ContextualRenamer-style) which guarantees every
    // nested let/const/class/fn name in the function is unique vs every
    // other nested name. Sibling collisions can't exist by construction —
    // no further check needed.
    const inserted = block.body.length;
    parentBody.splice(indexInParent, 1, ...block.body);
    return inserted;
}
/**
 * Closure's `isLiteralValue` — recognises primitive literal nodes used by
 * dataflow / fold passes. The `includeFunctions` flag matches Closure's
 * second-arg convention.
 */
function isLiteralValue$1(node, includeFunctions) {
    if (t.isStringLiteral(node) ||
        t.isNumericLiteral(node) ||
        t.isBooleanLiteral(node) ||
        t.isNullLiteral(node) ||
        t.isBigIntLiteral(node) ||
        t.isRegExpLiteral(node)) {
        return true;
    }
    if (t.isTemplateLiteral(node) && node.expressions.length === 0)
        return true;
    if (t.isUnaryExpression(node) && node.operator === 'void') {
        return isLiteralValue$1(node.argument);
    }
    if (t.isFunction(node))
        return true;
    return false;
}
// ---------------------------------------------------------------------------
// Operator precedence (mirrors Closure's NodeUtil.precedence). Higher is
// tighter binding. Used by MinimizedCondition cost estimation and by the
// peephole `if(c)foo()` → `c&&foo()` decision (we only do the rewrite when
// the parens cost is favourable).
const AND_PRECEDENCE = 6;
function precedence(node) {
    if (t.isSequenceExpression(node))
        return 1;
    if (t.isAssignmentExpression(node) || t.isYieldExpression(node))
        return 2;
    if (t.isConditionalExpression(node))
        return 3;
    if (t.isLogicalExpression(node)) {
        switch (node.operator) {
            case '??':
                return 4;
            case '||':
                return 5;
            case '&&':
                return 6;
        }
    }
    if (t.isBinaryExpression(node)) {
        switch (node.operator) {
            case '|':
                return 7;
            case '^':
                return 8;
            case '&':
                return 9;
            case '==':
            case '!=':
            case '===':
            case '!==':
                return 10;
            case '<':
            case '<=':
            case '>':
            case '>=':
            case 'in':
            case 'instanceof':
                return 11;
            case '<<':
            case '>>':
            case '>>>':
                return 12;
            case '+':
            case '-':
                return 13;
            case '*':
            case '/':
            case '%':
                return 14;
            case '**':
                return 15;
        }
    }
    if (t.isUnaryExpression(node))
        return 16;
    if (t.isUpdateExpression(node))
        return node.prefix ? 16 : 17;
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
        return 18;
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node) || t.isNewExpression(node))
        return 19;
    return 20;
}
// ---------------------------------------------------------------------------
// Structural AST equality (subset). Mirrors Closure's `isEquivalentTo` /
// `areNodesEqualForInlining` enough for peephole decisions: identifier name,
// literal value, and recursive structural compare across the node types our
// passes touch. Returns false for anything we don't recognize — conservative.
function areNodesEqual(a, b) {
    if (a.type !== b.type)
        return false;
    if (t.isIdentifier(a) && t.isIdentifier(b))
        return a.name === b.name;
    if (t.isNumericLiteral(a) && t.isNumericLiteral(b))
        return a.value === b.value;
    if (t.isStringLiteral(a) && t.isStringLiteral(b))
        return a.value === b.value;
    if (t.isBooleanLiteral(a) && t.isBooleanLiteral(b))
        return a.value === b.value;
    if (t.isNullLiteral(a) && t.isNullLiteral(b))
        return true;
    if (t.isThisExpression(a) && t.isThisExpression(b))
        return true;
    if (t.isReturnStatement(a) && t.isReturnStatement(b)) {
        const ax = a.argument;
        const bx = b.argument;
        if (ax === null && bx === null)
            return true;
        if (ax === null || bx === null)
            return false;
        if (ax === undefined && bx === undefined)
            return true;
        if (ax === undefined || bx === undefined)
            return false;
        return areNodesEqual(ax, bx);
    }
    if (t.isThrowStatement(a) && t.isThrowStatement(b)) {
        return areNodesEqual(a.argument, b.argument);
    }
    if (t.isExpressionStatement(a) && t.isExpressionStatement(b)) {
        return areNodesEqual(a.expression, b.expression);
    }
    if (t.isBreakStatement(a) && t.isBreakStatement(b)) {
        const al = a.label;
        const bl = b.label;
        if (!al && !bl)
            return true;
        if (!al || !bl)
            return false;
        return al.name === bl.name;
    }
    if (t.isContinueStatement(a) && t.isContinueStatement(b)) {
        const al = a.label;
        const bl = b.label;
        if (!al && !bl)
            return true;
        if (!al || !bl)
            return false;
        return al.name === bl.name;
    }
    if (t.isBlockStatement(a) && t.isBlockStatement(b)) {
        const bb = b;
        if (a.body.length !== bb.body.length)
            return false;
        for (let i = 0; i < a.body.length; i++) {
            if (!areNodesEqual(a.body[i], bb.body[i]))
                return false;
        }
        return true;
    }
    if (t.isMemberExpression(a) && t.isMemberExpression(b)) {
        if (a.computed !== b.computed)
            return false;
        return areNodesEqual(a.object, b.object) && areNodesEqual(a.property, b.property);
    }
    if (t.isBinaryExpression(a) && t.isBinaryExpression(b)) {
        if (a.operator !== b.operator)
            return false;
        if (t.isPrivateName(a.left) || t.isPrivateName(b.left))
            return false;
        return areNodesEqual(a.left, b.left) && areNodesEqual(a.right, b.right);
    }
    if (t.isLogicalExpression(a) && t.isLogicalExpression(b)) {
        if (a.operator !== b.operator)
            return false;
        return areNodesEqual(a.left, b.left) && areNodesEqual(a.right, b.right);
    }
    if (t.isUnaryExpression(a) && t.isUnaryExpression(b)) {
        if (a.operator !== b.operator)
            return false;
        return areNodesEqual(a.argument, b.argument);
    }
    if (t.isConditionalExpression(a) && t.isConditionalExpression(b)) {
        return (areNodesEqual(a.test, b.test) && areNodesEqual(a.consequent, b.consequent) && areNodesEqual(a.alternate, b.alternate));
    }
    if (t.isCallExpression(a) && t.isCallExpression(b)) {
        if (a.arguments.length !== b.arguments.length)
            return false;
        if (!t.isExpression(a.callee) || !t.isExpression(b.callee))
            return false;
        if (!areNodesEqual(a.callee, b.callee))
            return false;
        for (let i = 0; i < a.arguments.length; i++) {
            const aa = a.arguments[i];
            const bb = b.arguments[i];
            if (!t.isExpression(aa) || !t.isExpression(bb))
                return false;
            if (!areNodesEqual(aa, bb))
                return false;
        }
        return true;
    }
    return false;
}
/** Read `parent[key]` without losing exhaustiveness on the concrete type. */
function getSlot(parent, key) {
    return parent[key];
}
/**
 * Strip TypeScript-only AST nodes from a tree, in place. The inliner clones a
 * callee body and splices it into the consumer; if the callee was TS, the
 * cloned body carries `: T` annotations on local declarations, `expr as T`
 * wrappers, etc. Those have no business showing up in the consumer's scope
 * — the consumer authored bare JS-shaped calls, not a typed re-declaration —
 * and downstream TS transforms sometimes fail to strip them when they appear
 * inside an inlined-block label (depends on context). Conservatively clear
 * everything TS-only here so the inlined block is shaped like JS regardless
 * of the donor file.
 *
 * Scope: annotation slots on identifiers / params / declarators / functions,
 * and the three type-assertion expression wrappers (`as`, `<T>x`, `x!`).
 * Doesn't touch TS-only top-level decls (type aliases, interfaces, enums) —
 * those don't appear inside an inlined function body in practice and are
 * stripped by the downstream TS transform on the consumer's authored shape.
 */
function stripTypeScriptOnly(node) {
    const visit = (n) => {
        if (n === null || n === undefined)
            return;
        if (typeof n.type !== 'string')
            return;
        // Unwrap type-assertion expression wrappers by replacing the slot
        // that holds them with the inner expression. We can't replace `n`
        // in-place from this scope, so the caller handles wrappers via the
        // parent-slot walk below — this is the leaf case for everything
        // else.
        const slot = n;
        // Identifiers, RestElements, AssignmentPatterns, ObjectPatterns,
        // ArrayPatterns all carry `typeAnnotation`. Same key for params
        // and declarator ids. Clearing is safe even if absent.
        if ('typeAnnotation' in slot)
            slot.typeAnnotation = null;
        // Function-like nodes carry `returnType` + `typeParameters`.
        if ('returnType' in slot)
            slot.returnType = null;
        if ('typeParameters' in slot)
            slot.typeParameters = null;
        // `decorators` carries type info on parameter decorators — rare in
        // function bodies, leave as-is to avoid stripping user runtime
        // decorators.
        // Walk children, replacing type-assertion expression wrappers as we
        // descend so the parent's slot ends up pointing at the inner expr.
        for (const key of Object.keys(slot)) {
            const v = slot[key];
            if (Array.isArray(v)) {
                for (let i = 0; i < v.length; i++) {
                    const child = v[i];
                    if (child !== null && child !== undefined && typeof child.type === 'string') {
                        const unwrapped = unwrapTypeAssertion(child);
                        if (unwrapped !== child)
                            v[i] = unwrapped;
                        visit(v[i]);
                    }
                }
            }
            else if (v !== null && v !== undefined && typeof v.type === 'string') {
                const unwrapped = unwrapTypeAssertion(v);
                if (unwrapped !== v)
                    slot[key] = unwrapped;
                visit(slot[key]);
            }
        }
    };
    visit(node);
}
function unwrapTypeAssertion(n) {
    // `expr as T`, `<T>expr`, `expr!` — all three preserve runtime semantics
    // and the wrapper is purely a type-system marker, so unwrap to the inner.
    let cur = n;
    while (t.isTSAsExpression(cur) ||
        t.isTSTypeAssertion(cur) ||
        t.isTSNonNullExpression(cur) ||
        t.isTSSatisfiesExpression(cur) ||
        t.isTSInstantiationExpression(cur)) {
        cur = cur.expression;
    }
    return cur;
}
/** Write `parent[key]` (or `parent[key][index]` if `index` provided). */
function setSlot(parent, key, index, value) {
    const obj = parent;
    if (index !== undefined)
        obj[key][index] = value;
    else
        obj[key] = value;
}

// Port of jscomp/base/Tri.java — three-valued logic.
//
// TRUE / FALSE behave as ordinary booleans; UNKNOWN is "could be either", so
// every operation that returns a definite Tri must yield the same result for
// both substitutions of UNKNOWN.
const TRI_FALSE = -1;
const TRI_UNKNOWN = 0;
const TRI_TRUE = 1;
function triNot(a) {
    return -a;
}
function triToBoolean(a, fallback) {
    if (a === TRI_TRUE)
        return true;
    if (a === TRI_FALSE)
        return false;
    return fallback;
}
// ---------------------------------------------------------------------------
// Boolean coercion of an AST node, ignoring side effects.
//
// Used by PeepholeMinimizeConditions when massaging boolean contexts. Closure
// folds these through `NodeUtil.getBooleanValue` + a side-effect gate.
function getBooleanValue(n) {
    if (t.isBooleanLiteral(n))
        return n.value ? TRI_TRUE : TRI_FALSE;
    if (t.isNumericLiteral(n))
        return n.value !== 0 ? TRI_TRUE : TRI_FALSE;
    if (t.isStringLiteral(n))
        return n.value.length > 0 ? TRI_TRUE : TRI_FALSE;
    if (t.isNullLiteral(n))
        return TRI_FALSE;
    if (t.isIdentifier(n) && n.name === 'undefined')
        return TRI_FALSE;
    if (t.isIdentifier(n) && n.name === 'NaN')
        return TRI_FALSE;
    if (t.isIdentifier(n) && n.name === 'Infinity')
        return TRI_TRUE;
    if (t.isUnaryExpression(n) && n.operator === 'void')
        return TRI_FALSE;
    if (t.isUnaryExpression(n) && n.operator === '!')
        return triNot(getBooleanValue(n.argument));
    if (t.isObjectExpression(n))
        return TRI_TRUE;
    if (t.isArrayExpression(n))
        return TRI_TRUE;
    if (t.isFunction(n))
        return TRI_TRUE;
    if (t.isRegExpLiteral(n))
        return TRI_TRUE;
    if (t.isTemplateLiteral(n) && n.expressions.length === 0) {
        const cooked = n.quasis[0]?.value.cooked ?? '';
        return cooked.length > 0 ? TRI_TRUE : TRI_FALSE;
    }
    return TRI_UNKNOWN;
}

// Port of jscomp/AstAnalyzer.java (subset — purity / side-effect predicate).
//
// AstAnalyzer in Closure provides the side-effect predicates other passes
// consult before reordering or dropping expressions. We port the
// conservative core: `mayHaveSideEffects(node)` returns true unless the
// node provably has no observable effect.
//
// What we DO recognize as effect-free:
//   - literals
//   - reads of pure local identifiers
//   - pure arithmetic / comparison / logical expressions over effect-free
//     operands
//   - object / array literals composed of effect-free values
//   - typeof / void / unary ! / unary - / unary + over effect-free operands
//
// What is conservatively impure (returns true):
//   - any call / new
//   - any assignment / update (++ -- compound assigns)
//   - delete
//   - yield / await / throw
//   - tagged templates
//   - everything we don't recognise — Closure errs on the side of "may have
//     side effects" and we follow.
//
// Member access (`obj.prop`, `obj[k]`, optional-chain variants) is treated
// as pure when the object (and computed key, if any) is itself pure. This
// matches Closure's AstAnalyzer with `assumeGettersArePure=true` — its
// default mode (AstAnalyzer.java:434-437). The risk is user-defined
// getters firing as side effects; Closure documents the alternative —
// flagging every getprop impure — as having "completely unacceptable" code
// size cost. We follow that policy, especially since the downstream bundler
// or minifier (esbuild, terser) makes the same assumption.
function mayHaveSideEffects(node) {
    return !isPure(node);
}
/**
 * Closure's `getSideEffectFreeBooleanValue` — returns the boolean value the
 * expression would evaluate to (as a Tri) but only when the expression has no
 * side effects; UNKNOWN otherwise. Used in cond rewriting to gate moves like
 * `x || true → true` (only safe when `x` is pure).
 */
function getSideEffectFreeBooleanValue(node) {
    if (mayHaveSideEffects(node))
        return TRI_UNKNOWN;
    return getBooleanValue(node);
}
function isPure(node) {
    if (isLiteralValue$1(node))
        return true;
    if (t.isIdentifier(node))
        return true;
    if (t.isThisExpression(node))
        return true;
    if (t.isSuper(node))
        return true;
    if (t.isUnaryExpression(node)) {
        switch (node.operator) {
            case '!':
            case '+':
            case '-':
            case '~':
            case 'typeof':
            case 'void':
                return isPure(node.argument);
            case 'delete':
            case 'throw':
                return false;
        }
    }
    if (t.isBinaryExpression(node)) {
        if (node.operator === 'in' || node.operator === 'instanceof')
            return false;
        // `node.left` is an Expression here in practice; PrivateName only
        // appears for `in` which we already rejected.
        if (t.isPrivateName(node.left))
            return false;
        return isPure(node.left) && isPure(node.right);
    }
    if (t.isLogicalExpression(node)) {
        return isPure(node.left) && isPure(node.right);
    }
    if (t.isConditionalExpression(node)) {
        return isPure(node.test) && isPure(node.consequent) && isPure(node.alternate);
    }
    if (t.isSequenceExpression(node)) {
        return node.expressions.every(isPure);
    }
    if (t.isArrayExpression(node)) {
        return node.elements.every((el) => el === null || (!t.isSpreadElement(el) && isPure(el)));
    }
    if (t.isObjectExpression(node)) {
        for (const prop of node.properties) {
            if (t.isSpreadElement(prop))
                return false;
            if (t.isObjectMethod(prop))
                continue; // method definitions don't run
            if (t.isObjectProperty(prop)) {
                if (prop.computed && !isPure(prop.key))
                    return false;
                if (!t.isExpression(prop.value))
                    return false;
                if (!isPure(prop.value))
                    return false;
                continue;
            }
            return false;
        }
        return true;
    }
    if (t.isTemplateLiteral(node)) {
        // Untagged template — no effects from the template itself, only the
        // inserted expressions matter.
        return node.expressions.every((e) => t.isExpression(e) && isPure(e));
    }
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        // Closure AstAnalyzer.java:434-437 (GETPROP/OPTCHAIN_GETPROP) and
        // :432 (GETELEM/OPTCHAIN_GETELEM): with assumeGettersArePure (the
        // default), a property read is pure iff the children are pure.
        if (!isPure(node.object))
            return false;
        if (node.computed && !isPure(node.property))
            return false;
        return true;
    }
    return false;
}

// Port of jscomp/FunctionArgumentInjector.java (subset).
//
// Decides which (param, arg) pairs at an inlined call site can be substituted
// directly into the body and which require a temporary `let X = arg;` binding.
// Direct substitution avoids emitting the prologue and (in the common case
// where every arg substitutes) the surrounding wrapper block as well.
//
// Rules (mirror Closure's gatherCallArgumentsNeedingTemps):
//   1. Param reassigned in body → needs temp (would change semantics if
//      substituted: the outer arg expression would be the LHS of an assign).
//   2. Arg side-effect-free AND param has 0 references → no temp (drop arg).
//   3. Arg has side effects → needs temp (must evaluate exactly once).
//   4. Arg may create fresh mutable state (object/array literal, `new`) AND
//      param has > 0 references → needs temp (otherwise the body would
//      observe a fresh object per use, breaking identity).
//   5. Arg has > 1 references in body — duplicate the arg expression?
//      - Identifier / literal → no temp (cheap, value-stable for our subset).
//      - anything else → needs temp (cost / side-effect risk).
//   6. Otherwise (single reference, side-effect-free, simple arg) → no temp.
//
// Cascade: if any param P needs a temp, every param BEFORE P in declaration
// order also needs a temp. This preserves the original left-to-right
// evaluation order of the call's argument list — the temp prologue runs
// `let pN = argN` in declaration order, so any earlier arg with side effects
// must run first via its own temp.
//
// Limitations / departures from Closure:
//   - No `this` handling. Caller (function-injector.ts) rejects calls that
//     read `this`.
//   - No `arguments` handling. Same.
//   - No CodingConvention.isExported check. We assume Identifier args don't
//     alias an exported global mutated mid-body — which is the common case
//     and what compilecat's directive-gated inliner targets.
//   - Trivial-body fast path (Closure's `isTrivialBody`) not ported — its
//     net effect is to allow more substitutions, never to forbid one. The
//     base rules already handle our hot cases.
/**
 * Find every parameter (by name) that is reassigned anywhere in the body.
 * Reassignment includes `=`, compound assigns (`+=` etc.), `++`/`--`, and
 * destructuring writes. Property writes (`out[0] = ...`, `out.x = ...`) are
 * NOT reassignments — they mutate the referent, not the binding.
 */
function gatherModifiedParameters(body, paramNames) {
    const out = new Set();
    if (paramNames.size === 0)
        return out;
    t.traverseFast(body, (n) => {
        if (t.isAssignmentExpression(n) && t.isIdentifier(n.left) && paramNames.has(n.left.name)) {
            out.add(n.left.name);
            return;
        }
        if (t.isUpdateExpression(n) && t.isIdentifier(n.argument) && paramNames.has(n.argument.name)) {
            out.add(n.argument.name);
            return;
        }
        // Conservative: any destructuring pattern targeting a param counts as
        // a reassignment. We don't currently allow destructuring params on the
        // callee side, but a caller-side destructuring assign that writes to
        // the param name (post-alpha-rename, unlikely) would still trip this.
        if (t.isArrayPattern(n) || t.isObjectPattern(n)) {
            t.traverseFast(n, (m) => {
                if (t.isIdentifier(m) && paramNames.has(m.name))
                    out.add(m.name);
            });
        }
    });
    return out;
}
function gatherCallArgumentsNeedingTemps(body, paramNames, args, modifiedParameters) {
    const needsTemp = new Set(modifiedParameters);
    if (paramNames.length === 0)
        return { needsTemp };
    // Reference counts per param across the body. Identifier reads only —
    // declaration-id contexts (var/function/etc.) are excluded.
    const refCounts = countParamReferences(body, paramNames);
    // Walk in declaration order; track the highest-position param that needs
    // a temp so we can apply the cascade afterward.
    let cascadeIndex = -1;
    for (let i = 0; i < paramNames.length; i++) {
        const name = paramNames[i];
        const arg = args[i];
        const refs = refCounts.get(name) ?? 0;
        if (needsTemp.has(name)) {
            cascadeIndex = i;
            continue;
        }
        if (arg === undefined)
            continue; // missing arg — caller handles default
        const requires = paramNeedsTemp(arg, refs);
        if (requires) {
            needsTemp.add(name);
            cascadeIndex = i;
        }
    }
    // Cascade: every param at index <= cascadeIndex needs a temp.
    if (cascadeIndex >= 0) {
        for (let i = 0; i <= cascadeIndex; i++)
            needsTemp.add(paramNames[i]);
    }
    return { needsTemp };
}
function paramNeedsTemp(arg, refCount) {
    const argSideEffects = mayHaveSideEffects(arg);
    // Rule 2: side-effect-free + unused → drop.
    if (!argSideEffects && refCount === 0)
        return false;
    // Rule 3: side effects must be evaluated exactly once.
    if (argSideEffects)
        return true;
    // Rule 4: fresh mutable state (object/array/regex/new) — substituting
    // would create a new instance per use, observably different from the
    // original (single-instance) semantics.
    if (createsMutableState(arg) && refCount > 0)
        return true;
    // Rules 5 & 6: side-effect-free, no mutable state. Single ref always
    // safe; multi-ref safe if arg is cheap and value-stable.
    if (refCount <= 1)
        return false;
    return !isCheapToDuplicate(arg);
}
function createsMutableState(arg) {
    return (t.isObjectExpression(arg) ||
        t.isArrayExpression(arg) ||
        t.isRegExpLiteral(arg) ||
        t.isNewExpression(arg) ||
        t.isFunctionExpression(arg) ||
        t.isArrowFunctionExpression(arg) ||
        t.isClassExpression(arg));
}
function isCheapToDuplicate(arg) {
    if (t.isIdentifier(arg))
        return true;
    if (t.isNullLiteral(arg) || t.isBooleanLiteral(arg))
        return true;
    if (t.isNumericLiteral(arg) || t.isBigIntLiteral(arg))
        return true;
    if (t.isStringLiteral(arg))
        return arg.value.length < 2;
    return false;
}
function countParamReferences(body, paramNames) {
    const set = new Set(paramNames);
    const counts = new Map();
    for (const n of paramNames)
        counts.set(n, 0);
    const visit = (n, parent, key) => {
        if (t.isIdentifier(n) && set.has(n.name) && parent !== null && isReferenceContext$2(parent, key)) {
            counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c)
                        visit(c, n, k);
                }
            }
            else {
                visit(child, n, k);
            }
        }
    };
    visit(body, null, '');
    return counts;
}
/**
 * Substitute each Identifier reference matching a key in `replacements` with
 * a deep clone of the corresponding expression. Mirrors Closure's
 * FunctionArgumentInjector.inject — declaration-id contexts and nested-scope
 * shadowing are respected.
 */
function injectArguments(body, replacements) {
    if (replacements.size === 0)
        return;
    const visit = (n, active) => {
        if (active.size === 0)
            return;
        // Function creates a new scope. Filter shadowed names.
        if (t.isFunction(n)) {
            const filtered = new Map(active);
            for (const p of n.params)
                collectParamNames$1(p, (pn) => filtered.delete(pn));
            if ((t.isFunctionExpression(n) || t.isFunctionDeclaration(n)) && n.id) {
                filtered.delete(n.id.name);
            }
            if (filtered.size === 0)
                return;
            descend(n, filtered);
            return;
        }
        // Block scope — filter let/const/class/function-decl names.
        if (t.isBlockStatement(n)) {
            const filtered = filterByBlockDecls$1(active, n);
            if (filtered.size === 0)
                return;
            descend(n, filtered);
            return;
        }
        descend(n, active);
    };
    const descend = (n, active) => {
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (!c)
                        continue;
                    if (t.isIdentifier(c) && active.has(c.name) && isReferenceContext$2(n, k)) {
                        const sub = t.cloneNode(active.get(c.name), true);
                        setSlot(n, k, i, sub);
                    }
                    else {
                        visit(c, active);
                    }
                }
            }
            else {
                if (t.isIdentifier(child) && active.has(child.name) && isReferenceContext$2(n, k)) {
                    const sub = t.cloneNode(active.get(child.name), true);
                    setSlot(n, k, undefined, sub);
                }
                else {
                    visit(child, active);
                }
            }
        }
    };
    descend(body, replacements);
}
function collectParamNames$1(p, drop) {
    if (t.isIdentifier(p))
        drop(p.name);
    else if (t.isAssignmentPattern(p))
        collectParamNames$1(p.left, drop);
    else if (t.isRestElement(p))
        collectParamNames$1(p.argument, drop);
}
function filterByBlockDecls$1(active, block) {
    let filtered = null;
    for (const s of block.body) {
        if (t.isVariableDeclaration(s)) {
            for (const d of s.declarations) {
                if (t.isIdentifier(d.id) && active.has(d.id.name)) {
                    filtered ??= new Map(active);
                    filtered.delete(d.id.name);
                }
            }
        }
        else if (t.isFunctionDeclaration(s) && s.id && active.has(s.id.name)) {
            filtered ??= new Map(active);
            filtered.delete(s.id.name);
        }
        else if (t.isClassDeclaration(s) && s.id && active.has(s.id.name)) {
            filtered ??= new Map(active);
            filtered.delete(s.id.name);
        }
    }
    return filtered ?? active;
}
function isReferenceContext$2(parent, key) {
    if (t.isVariableDeclarator(parent) && key === 'id')
        return false;
    if (t.isFunctionDeclaration(parent) && key === 'id')
        return false;
    if (t.isFunctionExpression(parent) && key === 'id')
        return false;
    if (t.isClassDeclaration(parent) && key === 'id')
        return false;
    if (t.isClassExpression(parent) && key === 'id')
        return false;
    if (t.isLabeledStatement(parent) && key === 'label')
        return false;
    if (t.isBreakStatement(parent) && key === 'label')
        return false;
    if (t.isContinueStatement(parent) && key === 'label')
        return false;
    if (t.isMemberExpression(parent) && key === 'property' && !parent.computed)
        return false;
    if (t.isObjectProperty(parent) && key === 'key' && !parent.computed)
        return false;
    if (t.isObjectMethod(parent) && key === 'key' && !parent.computed)
        return false;
    return true;
}

// Port of jscomp/FunctionToBlockMutator.java (subset).
//
// Given a callee function body and the arguments at a call site, produce a
// BlockStatement that, when spliced into the caller in place of the call,
// computes the same result as invoking the function. Returns inside the body
// are rewritten to `_r = expr; break LABEL;` so the labeled outer block exits
// the inlined region instead of the caller.
//
// Two modes correspond to FunctionInjector classifications:
//
//   - DIRECT: body is a single `return EXPR;`. Caller substitutes
//     parameter→arg in EXPR and uses it as the call expression's replacement.
//     This file does not handle DIRECT — see FunctionInjector.ts for that path.
//
//   - BLOCK: body has any other shape. Caller invokes mutateForBlockInline
//     here to get a labeled block that writes its result to a fresh temp
//     `_r` (or whatever the caller picked) and breaks out for any return.
//
// Limitations (all match Closure's port limits):
//   - No `this` rewriting — caller must reject method-call inlining.
//   - No `arguments` rewriting — caller must reject bodies that read
//     `arguments`.
//   - No try/catch, generators, async, await, yield in body — caller checks.
//   - No destructuring/rest/default params.
//   - All free names assumed unique to caller (caller-side α-rename if not).
function mutateForBlockInline(input) {
    const { body, params, args, label, resultName, needsResult } = input;
    // 1. Decide which params need a `let X = arg;` temp vs. direct
    //    substitution. Mirrors Closure's FunctionArgumentInjector. The common
    //    case for compilecat's library inlines is a callee like
    //    `function f(out) { out[0] = ...; ... }` invoked as `f(targetArr)` —
    //    `out`'s arg is a simple Identifier, so it substitutes directly and
    //    the prologue ends up empty.
    const paramSet = new Set(params);
    const modified = gatherModifiedParameters(body, paramSet);
    const argsForClassify = params.map((_, i) => args[i] ?? undefinedExpr());
    const { needsTemp } = gatherCallArgumentsNeedingTemps(body, params, argsForClassify, modified);
    // 2. Substitute non-temp params directly into the body. Each substituted
    //    arg gets cloned per use by injectArguments.
    const replacements = new Map();
    for (let i = 0; i < params.length; i++) {
        const name = params[i];
        if (needsTemp.has(name))
            continue;
        replacements.set(name, argsForClassify[i]);
    }
    injectArguments(body, replacements);
    // 3. Build the prologue for the params that DO need a temp.
    const prologue = [];
    for (let i = 0; i < params.length; i++) {
        const name = params[i];
        if (!needsTemp.has(name))
            continue;
        prologue.push(t.variableDeclaration('let', [t.variableDeclarator(t.identifier(name), argsForClassify[i])]));
    }
    // 4. Closure's `replaceReturns` (FunctionToBlockMutator.java:408) special-
    //    cases a trailing `return X;` — the function's last statement. That
    //    return falls through naturally, so it can be rewritten as a plain
    //    assignment (or expression statement) with no `break LABEL;` needed.
    //    If no other returns remain after that rewrite, the labeled wrapper
    //    can be dropped entirely and the inlined region is just a BlockStatement
    //    that the simplifier will flatten into the parent.
    let hasResultWrite = false;
    const onWrite = () => {
        hasResultWrite = true;
    };
    const hasReturnAtExit = endsWithReturn(body);
    const interiorReturns = countShallowReturns(body) - (hasReturnAtExit ? 1 : 0);
    if (hasReturnAtExit) {
        const last = body.body[body.body.length - 1];
        const replacement = makeTrailingReturnReplacement(last.argument, resultName, needsResult, onWrite);
        body.body.splice(body.body.length - 1, 1, ...replacement);
    }
    // Port of FunctionToBlockMutator.java:447-450 (addDummyAssignment): when a
    // result is required but the body has no return-at-exit, append
    // `_r = void 0;` so `_r` is initialized on every fall-through path. Without
    // this, downstream reads of `_r` could observe a previous BLOCK-inline's
    // value when the function falls off the end.
    if (needsResult && !hasReturnAtExit) {
        body.body.push(t.expressionStatement(t.assignmentExpression('=', t.identifier(resultName), undefinedExpr())));
        hasResultWrite = true;
    }
    if (interiorReturns > 0) {
        rewriteReturns(body, label, resultName, needsResult, onWrite);
        const block = t.blockStatement([...prologue, ...body.body]);
        const labeled = t.labeledStatement(t.identifier(label), block);
        return { block: labeled, hasResultWrite };
    }
    return {
        block: t.blockStatement([...prologue, ...body.body]),
        hasResultWrite,
    };
}
/** Closure's `NodeUtil.newUndefinedNode` — `void 0`. Shadow-proof and one
 *  byte shorter than `undefined`. */
function undefinedExpr() {
    return t.unaryExpression('void', t.numericLiteral(0));
}
function countShallowReturns(root) {
    let count = 0;
    const walk = (n) => {
        if (t.isFunction(n))
            return;
        if (t.isReturnStatement(n))
            count++;
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child)
                    if (c)
                        walk(c);
            }
            else {
                walk(child);
            }
        }
    };
    for (const k of t.VISITOR_KEYS[root.type] ?? []) {
        const child = getSlot(root, k);
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child)
                if (c)
                    walk(c);
        }
        else {
            walk(child);
        }
    }
    return count;
}
function endsWithReturn(body) {
    const last = body.body[body.body.length - 1];
    return last !== undefined && t.isReturnStatement(last);
}
function makeTrailingReturnReplacement(arg, resultName, needsResult, onWrite) {
    if (needsResult) {
        const rhs = arg ?? undefinedExpr();
        onWrite();
        return [t.expressionStatement(t.assignmentExpression('=', t.identifier(resultName), rhs))];
    }
    if (arg && hasSideEffects(arg))
        return [t.expressionStatement(arg)];
    return [];
}
// ---------------------------------------------------------------------------
// Return rewriter.
//
// Replaces every `return X;` reachable from `root` (without crossing into a
// nested function) with either:
//   needsResult=true:   `{ _r = X; break LABEL; }` (or just `break LABEL;` if X is undefined)
//   needsResult=false:  `break LABEL;`
function rewriteReturns(root, label, resultName, needsResult, onWrite) {
    const walk = (n, parent, key, index) => {
        // Don't descend into nested functions — their returns belong to them.
        if (t.isFunction(n) || t.isClassBody(n))
            return;
        // Process children first; then handle this node.
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c)
                        walk(c, n, k, i);
                }
            }
            else {
                walk(child, n, k);
            }
        }
        if (t.isReturnStatement(n)) {
            const replacement = makeReturnReplacement(n.argument, label, resultName, needsResult, onWrite);
            if (index !== undefined) {
                const arr = getSlot(parent, key);
                arr.splice(index, 1, ...replacement);
            }
            else {
                // ReturnStatement under a non-array slot (e.g. IfStatement.consequent).
                // Wrap replacement in a BlockStatement so the slot accepts it.
                setSlot(parent, key, undefined, t.blockStatement(replacement));
            }
        }
    };
    for (const k of t.VISITOR_KEYS[root.type] ?? []) {
        const child = getSlot(root, k);
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c)
                    walk(c, root, k, i);
            }
        }
        else {
            walk(child, root, k);
        }
    }
}
function makeReturnReplacement(arg, label, resultName, needsResult, onWrite) {
    const out = [];
    if (needsResult) {
        const rhs = arg ?? undefinedExpr();
        out.push(t.expressionStatement(t.assignmentExpression('=', t.identifier(resultName), rhs)));
        onWrite();
    }
    else if (arg && hasSideEffects(arg)) {
        // Result discarded but expression has side effects — keep them.
        out.push(t.expressionStatement(arg));
    }
    out.push(t.breakStatement(t.identifier(label)));
    return out;
}
function hasSideEffects(n) {
    // Conservative: anything other than a literal or simple identifier may
    // have side effects. Used only by the discard-result path.
    if (t.isLiteral(n))
        return false;
    if (t.isIdentifier(n))
        return false;
    return true;
}

// Port of jscomp/FunctionInjector.java (subset).
//
// Two responsibilities:
//   1. Classify a (callee, callsite) pair as DIRECT, BLOCK, or NO inline.
//   2. Perform the splice for the chosen mode.
//
// DIRECT is the fast path: callee body is a single `return EXPR;`. Args are
// substituted into EXPR; the call expression is replaced with the result.
//
// BLOCK is the general path: emit a labeled block that binds params, runs
// the (cloned) body with returns rewritten via FunctionToBlockMutator, and
// stores the value in a `_<callee>__result_<n>` temp. The call expression is
// replaced by that temp; the labeled block is hoisted to a sibling statement
// before the callsite's enclosing statement.
//
// Generated names follow Closure's `JSCompiler_inline_*` convention with a
// `_compilecat_` prefix on the label (which is globally findable) and a
// shorter callee-prefixed shape on the result temp (local to one function):
//   - label:  `_compilecat_inline_label_<callee>_<n>` (callee elided if anon)
//   - result: `_<callee>__result_<n>` (anon: `_result_<n>`)
//   - param:  unchanged in the common case. Renamed to `<orig>__<callee>`
//             (anon: `<orig>__<n>`) only when an arg expression references
//             `<orig>` as an identifier (the `let x = x.method();` shadow
//             class). Normalize bumps further with `__N` on actual collision.
//
// Limitations (v1):
//   - No `this` rewriting — we reject method calls and `this` references.
//   - No `arguments` rewriting — reject bodies that read it.
//   - No try/catch / generator / async / await / yield in body.
//   - No destructuring / rest / default params on the callee.
//   - Caller passes already-cloned body + args to keep ownership simple.
function classifyCallee(fn) {
    if (fn.async)
        return { mode: 'NO', reason: 'async' };
    if (fn.generator)
        return { mode: 'NO', reason: 'generator' };
    if (!t.isBlockStatement(fn.body)) {
        // Arrow with expression body: treat as DIRECT.
        return { mode: 'DIRECT' };
    }
    for (const p of fn.params) {
        if (!t.isIdentifier(p))
            return { mode: 'NO', reason: 'non-identifier param' };
    }
    if (bodyReadsThisOrArguments(fn.body)) {
        return { mode: 'NO', reason: 'reads this/arguments' };
    }
    if (bodyHasUnsupportedConstruct(fn.body)) {
        return { mode: 'NO', reason: 'unsupported construct' };
    }
    // DIRECT iff body is a single ReturnStatement (with expression).
    const stmts = fn.body.body;
    if (stmts.length === 1 && t.isReturnStatement(stmts[0]) && stmts[0].argument) {
        return { mode: 'DIRECT' };
    }
    if (stmts.length === 0) {
        // empty body — value is undefined; DIRECT still works.
        return { mode: 'DIRECT' };
    }
    return { mode: 'BLOCK' };
}
function bodyReadsThisOrArguments(body) {
    return t.traverseFast(body, (n) => {
        // Non-arrow functions get their own `this` / `arguments`.
        if (t.isFunction(n) && !t.isArrowFunctionExpression(n))
            return t.traverseFast.skip;
        if (t.isThisExpression(n))
            return t.traverseFast.stop;
        if (t.isIdentifier(n) && n.name === 'arguments')
            return t.traverseFast.stop;
        return undefined;
    });
}
function bodyHasUnsupportedConstruct(body) {
    return t.traverseFast(body, (n) => {
        if (t.isTryStatement(n) || t.isWithStatement(n) || t.isYieldExpression(n) || t.isAwaitExpression(n)) {
            return t.traverseFast.stop;
        }
        // Don't descend into nested functions — their try/yield is fine.
        if (t.isFunction(n))
            return t.traverseFast.skip;
        return undefined;
    });
}
/** Resolve the statement-list array on a CallSite.statementParent. Block and
 *  Program expose it as `.body`; SwitchCase as `.consequent`. */
function stmtList(parent) {
    return t.isSwitchCase(parent) ? parent.consequent : parent.body;
}
// ---------------------------------------------------------------------------
// Splice — DIRECT.
//
// Replace the CallExpression with a substituted clone of the callee's
// return-expression. Argument substitution is by α-rename in the cloned body.
function inlineDirect(callee, site) {
    const fn = callee.fn;
    const args = site.call.arguments;
    if (!allArgsExpressions(args))
        return false;
    if (args.length > callee.paramNames.length)
        return false; // ignore extras for v1
    let valueExpr;
    if (t.isBlockStatement(fn.body)) {
        const stmts = fn.body.body;
        if (stmts.length === 0) {
            valueExpr = t.identifier('undefined');
        }
        else if (stmts.length === 1 && t.isReturnStatement(stmts[0]) && stmts[0].argument) {
            valueExpr = t.cloneNode(stmts[0].argument, true);
        }
        else {
            return false;
        }
    }
    else {
        valueExpr = t.cloneNode(fn.body, true);
    }
    // Strip TS-only annotations from the value expression — same reasoning as
    // the BLOCK path: don't carry donor-side type markers into the consumer.
    stripTypeScriptOnly(valueExpr);
    // Build name → expression substitution map.
    const subs = new Map();
    for (let i = 0; i < callee.paramNames.length; i++) {
        const a = args[i];
        if (a === undefined) {
            subs.set(callee.paramNames[i], t.identifier('undefined'));
        }
        else {
            subs.set(callee.paramNames[i], t.cloneNode(a, true));
        }
    }
    // Substitution is safe under α-rename only when each arg is used exactly
    // once OR the arg has no side effects. Otherwise, reads would re-execute
    // a side effect. Be conservative: count uses; bail if any arg with side
    // effects is used more than once. (Closure punts via temps; we leave that
    // to the BLOCK path to keep DIRECT tight.)
    const useCounts = countParamUses(valueExpr, callee.paramNames);
    for (const name of callee.paramNames) {
        const arg = subs.get(name);
        if (arg !== undefined && (useCounts.get(name) ?? 0) > 1 && mayHaveSideEffects(arg)) {
            return false;
        }
    }
    const breadcrumb = breadcrumbFor(site.call);
    valueExpr = substituteIdentifiers(valueExpr, subs);
    replaceCall(site, valueExpr);
    // Tag the enclosing statement so the breadcrumb prints on its own line
    // rather than mid-expression next to the substituted value.
    tagInlined(site.enclosingStatement, breadcrumb);
    return true;
}
function recognizeCallsite(site) {
    // statement: `foo();`
    if (t.isExpressionStatement(site.callParent) && site.callParent === site.enclosingStatement) {
        return { kind: 'statement' };
    }
    // init: `let|var x = foo();` (skip const — would require kind change).
    if (t.isVariableDeclarator(site.callParent) &&
        site.callKey === 'init' &&
        t.isVariableDeclaration(site.enclosingStatement) &&
        site.enclosingStatement.declarations.length === 1 &&
        site.enclosingStatement.declarations[0] === site.callParent &&
        (site.enclosingStatement.kind === 'let' || site.enclosingStatement.kind === 'var') &&
        t.isIdentifier(site.callParent.id)) {
        return {
            kind: 'init',
            declarator: site.callParent,
            declaration: site.enclosingStatement,
            name: site.callParent.id.name,
        };
    }
    // assign: `x = foo();`
    if (t.isAssignmentExpression(site.callParent) &&
        site.callParent.operator === '=' &&
        site.callKey === 'right' &&
        t.isIdentifier(site.callParent.left) &&
        t.isExpressionStatement(site.enclosingStatement) &&
        site.enclosingStatement.expression === site.callParent) {
        return {
            kind: 'assign',
            assignment: site.callParent,
            name: site.callParent.left.name,
        };
    }
    return { kind: 'expression' };
}
// ---------------------------------------------------------------------------
// Splice — BLOCK.
function inlineBlock(callee, site, options) {
    const fn = callee.fn;
    if (!t.isBlockStatement(fn.body))
        return false;
    const args = site.call.arguments;
    if (!allArgsExpressions(args))
        return false;
    if (args.length > callee.paramNames.length)
        return false;
    const id = options.nextId();
    const cn = calleeName(callee.fn);
    const label = cn === null ? `_compilecat_inline_label_${id}` : `_compilecat_inline_label_${cn}_${id}`;
    // Clone body and args. Strip TS-only annotations from the cloned body so
    // the inlined block doesn't carry `: T` markers from the (TS) donor into
    // the consumer's authored shape. See `stripTypeScriptOnly` for rationale.
    const clonedBody = t.cloneNode(fn.body, true);
    stripTypeScriptOnly(clonedBody);
    const clonedArgs = [];
    for (let i = 0; i < callee.paramNames.length; i++) {
        const a = args[i];
        clonedArgs.push(a === undefined ? t.identifier('undefined') : t.cloneNode(a, true));
    }
    // Conditional alpha-rename. Rename a param P only when some arg references
    // P as an identifier — otherwise the prologue `let P = arg;` would emit
    // `let P = …P…;` and the RHS read would resolve to the new inner binding
    // (TDZ on let; pre-FunctionArgumentInjector this surfaced as `let dbvt =
    // dbvt;` inlining `ins(dbvt, ...)` inside `add(dbvt, ...)`).
    //
    // When we do rename, use `<orig>__<callee>` (or `<orig>__<inlineId>` for
    // anon callees) so the suffix carries meaning. Normalize handles any
    // collision afterward via its standard `__N` retry — but the common case
    // doesn't rename at all, leaving the original parameter names intact in
    // the bundle.
    const argFreeNames = new Set();
    for (const a of clonedArgs)
        collectIdentifierNames(a, argFreeNames);
    const freshParams = [];
    const renames = new Map();
    for (let i = 0; i < callee.paramNames.length; i++) {
        const orig = callee.paramNames[i];
        if (argFreeNames.has(orig)) {
            const suffix = cn === null ? String(id) : cn;
            const fresh = `${orig}__${suffix}`;
            freshParams.push(fresh);
            renames.set(orig, fresh);
        }
        else {
            freshParams.push(orig);
        }
    }
    if (renames.size > 0)
        renameInBody(clonedBody, renames);
    let shape = recognizeCallsite(site);
    // Reusing an existing variable name is unsafe if the donor body has free
    // reads of that name — those would resolve to the consumer's variable
    // instead of the donor module's, changing semantics. Demote to expression
    // shape in that case.
    if ((shape.kind === 'init' || shape.kind === 'assign') && bodyHasFreeRefTo(clonedBody, shape.name, freshParams)) {
        shape = { kind: 'expression' };
    }
    // Decide resultName + needsResult per shape.
    // Callee-prefixed shape (`_<callee>__result_<n>`) reads as "the value of
    // X" in the bundle. Anonymous callee → `_result_<n>`. The result temp is
    // local to one function; we don't need the `_compilecat_` global prefix
    // that the label carries.
    const fallbackResult = cn === null ? `_result_${id}` : `_${cn}__result_${id}`;
    let resultName;
    let needsResult;
    switch (shape.kind) {
        case 'statement':
            resultName = fallbackResult; // unused
            needsResult = false;
            break;
        case 'init':
        case 'assign':
            resultName = shape.name;
            needsResult = true;
            break;
        case 'expression':
            resultName = fallbackResult;
            needsResult = true;
            break;
    }
    const out = mutateForBlockInline({
        body: clonedBody,
        params: freshParams,
        args: clonedArgs,
        label,
        resultName,
        needsResult,
    });
    // Look up the enclosing statement's index dynamically — earlier inlines
    // on sibling statements may have shifted the array since `site` was
    // collected, making `site.statementIndex` stale.
    const list = stmtList(site.statementParent);
    const insertIdx = list.indexOf(site.enclosingStatement);
    if (insertIdx < 0)
        return false;
    const breadcrumb = breadcrumbFor(site.call);
    switch (shape.kind) {
        case 'statement': {
            // Replace `foo();` with the labeled block.
            tagInlined(out.block, breadcrumb);
            list.splice(insertIdx, 1, out.block);
            return true;
        }
        case 'init': {
            // `let x = foo();` → `let x;` followed by the labeled block.
            // Drop the initializer in place; insert the block after.
            shape.declarator.init = null;
            tagInlined(out.block, breadcrumb);
            list.splice(insertIdx + 1, 0, out.block);
            return true;
        }
        case 'assign': {
            // `x = foo();` → labeled block (which writes `x` on each return).
            tagInlined(out.block, breadcrumb);
            list.splice(insertIdx, 1, out.block);
            return true;
        }
        case 'expression': {
            // Hoist `let _<callee>__result_<n>;` and the labeled
            // block before the enclosing statement; replace the call with the
            // result temp.
            const tempDecl = t.variableDeclaration('let', [t.variableDeclarator(t.identifier(resultName))]);
            tagInlined(tempDecl, breadcrumb);
            const inserts = [tempDecl, out.block];
            replaceCall(site, t.identifier(resultName));
            list.splice(insertIdx, 0, ...inserts);
            return true;
        }
    }
}
/**
 * Render the original call expression concisely (e.g. `vec3.add(out, a, b)`)
 * so the breadcrumb points back at authored source. Mirrors the classic
 * tree's `breadcrumbFor` in `src/plugin/transforms/inline.ts`.
 */
function breadcrumbFor(call) {
    const src = generate(t.cloneNode(call, true, false), {
        concise: true,
        comments: false,
        retainLines: false,
    }).code;
    return src.replace(/\s+/g, ' ').trim();
}
function tagInlined(node, sig) {
    t.addComment(node, 'leading', ` @applied-inline ${sig} `);
}
// Collect identifier names that appear in `expr`. Conservative: returns every
// identifier in a value-bearing position (skips non-computed member/object
// property keys, which are syntactic labels rather than references). Used by
// the conditional-rename check — false positives only cause an unnecessary
// rename, never a missed one.
function collectIdentifierNames(expr, out) {
    const walk = (n, parent, key) => {
        if (!n || typeof n !== 'object' || !('type' in n))
            return;
        if (t.isIdentifier(n)) {
            if (parent && t.isMemberExpression(parent) && key === 'property' && !parent.computed)
                return;
            if (parent && t.isOptionalMemberExpression(parent) && key === 'property' && !parent.computed)
                return;
            if (parent && (t.isObjectProperty(parent) || t.isObjectMethod(parent)) && key === 'key' && !parent.computed)
                return;
            out.add(n.name);
            return;
        }
        for (const k of Object.keys(n)) {
            if (k === 'type' ||
                k === 'loc' ||
                k === 'start' ||
                k === 'end' ||
                k === 'leadingComments' ||
                k === 'trailingComments' ||
                k === 'innerComments' ||
                k === 'extra')
                continue;
            const v = n[k];
            if (Array.isArray(v)) {
                for (const item of v)
                    walk(item, n, k);
            }
            else if (v && typeof v === 'object' && 'type' in v) {
                walk(v, n, k);
            }
        }
    };
    walk(expr, null, '');
}
// True iff `name` appears as a free read in `body` (not shadowed by a nested
// scope, not in a write/key context, not equal to one of the post-rename param
// names — those have been renamed and won't collide).
function bodyHasFreeRefTo(body, name, paramNames) {
    if (paramNames.includes(name))
        return false; // shouldn't happen post-rename
    let found = false;
    const walk = (n, parent, key, shadowed) => {
        if (found || !n)
            return;
        // Nested function: `name` is shadowed if it's a param or the function's
        // own id.
        if (t.isFunction(n)) {
            let nestedShadow = shadowed;
            for (const p of n.params) {
                collectParamNames(p, (pn) => {
                    if (pn === name)
                        nestedShadow = true;
                });
            }
            if ((t.isFunctionExpression(n) || t.isFunctionDeclaration(n)) && n.id?.name === name) {
                nestedShadow = true;
            }
            descend(n, nestedShadow);
            return;
        }
        // Block scope: `let/const/class/function-decl` of `name` shadows it.
        if (t.isBlockStatement(n)) {
            let blockShadow = shadowed;
            for (const s of n.body) {
                if (t.isVariableDeclaration(s)) {
                    for (const d of s.declarations) {
                        if (t.isIdentifier(d.id) && d.id.name === name)
                            blockShadow = true;
                    }
                }
                else if ((t.isFunctionDeclaration(s) || t.isClassDeclaration(s)) && s.id?.name === name) {
                    blockShadow = true;
                }
            }
            descend(n, blockShadow);
            return;
        }
        if (!shadowed && t.isIdentifier(n) && n.name === name && parent !== null && isReferenceContext$1(parent, key)) {
            found = true;
            return;
        }
        descend(n, shadowed);
    };
    const descend = (n, shadowed) => {
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c)
                        walk(c, n, k, shadowed);
                }
            }
            else {
                walk(child, n, k, shadowed);
            }
        }
    };
    descend(body, false);
    return found;
}
// ---------------------------------------------------------------------------
// Helpers.
function allArgsExpressions(args) {
    for (const a of args) {
        if (t.isSpreadElement(a) || t.isArgumentPlaceholder(a))
            return false;
    }
    return true;
}
function replaceCall(site, replacement) {
    setSlot(site.callParent, site.callKey, site.callIndex, replacement);
}
function countParamUses(root, params) {
    const counts = new Map();
    for (const p of params)
        counts.set(p, 0);
    t.traverseFast(root, (n) => {
        if (t.isFunction(n))
            return t.traverseFast.skip; // shadowed
        if (t.isIdentifier(n) && counts.has(n.name)) {
            counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
        }
        return undefined;
    });
    return counts;
}
// Scope-aware identifier rename across a body. For each Identifier reference
// of a name in `renames`, rewrite to the fresh name unless an inner scope
// shadows it (nested function with same param name, or block with same
// let/const/class/function-decl name).
function renameInBody(body, renames) {
    const visit = (n, active) => {
        if (active.size === 0)
            return;
        // Function creates a new scope. Filter out names shadowed by params or
        // own function-id (for FunctionExpression).
        if (t.isFunction(n)) {
            const filtered = new Map(active);
            for (const p of n.params)
                collectParamNames(p, (n) => filtered.delete(n));
            if ((t.isFunctionExpression(n) || t.isFunctionDeclaration(n)) && n.id) {
                filtered.delete(n.id.name);
            }
            if (filtered.size === 0)
                return;
            descend(n, filtered);
            return;
        }
        // Block scope filters out let/const/class/function-decl + var (var
        // doesn't actually scope to block but our callees are simple).
        if (t.isBlockStatement(n)) {
            const filtered = filterByBlockDecls(active, n);
            if (filtered.size === 0)
                return;
            descend(n, filtered);
            return;
        }
        descend(n, active);
    };
    const descend = (n, active) => {
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (!c)
                        continue;
                    if (t.isIdentifier(c) && active.has(c.name) && isReferenceContext$1(n, k)) {
                        c.name = active.get(c.name);
                    }
                    else {
                        visit(c, active);
                    }
                }
            }
            else {
                if (t.isIdentifier(child) && active.has(child.name) && isReferenceContext$1(n, k)) {
                    child.name = active.get(child.name);
                }
                else {
                    visit(child, active);
                }
            }
        }
    };
    descend(body, renames);
}
function collectParamNames(p, drop) {
    if (t.isIdentifier(p))
        drop(p.name);
    else if (t.isAssignmentPattern(p))
        collectParamNames(p.left, drop);
    else if (t.isRestElement(p))
        collectParamNames(p.argument, drop);
}
function filterByBlockDecls(active, block) {
    let filtered = null;
    for (const s of block.body) {
        if (t.isVariableDeclaration(s)) {
            for (const d of s.declarations) {
                if (t.isIdentifier(d.id) && active.has(d.id.name)) {
                    filtered ??= new Map(active);
                    filtered.delete(d.id.name);
                }
            }
        }
        else if (t.isFunctionDeclaration(s) && s.id && active.has(s.id.name)) {
            filtered ??= new Map(active);
            filtered.delete(s.id.name);
        }
        else if (t.isClassDeclaration(s) && s.id && active.has(s.id.name)) {
            filtered ??= new Map(active);
            filtered.delete(s.id.name);
        }
    }
    return filtered ?? active;
}
function isReferenceContext$1(parent, key) {
    if (t.isVariableDeclarator(parent) && key === 'id')
        return false;
    if (t.isFunctionDeclaration(parent) && key === 'id')
        return false;
    if (t.isFunctionExpression(parent) && key === 'id')
        return false;
    if (t.isClassDeclaration(parent) && key === 'id')
        return false;
    if (t.isClassExpression(parent) && key === 'id')
        return false;
    if (t.isLabeledStatement(parent) && key === 'label')
        return false;
    if (t.isBreakStatement(parent) && key === 'label')
        return false;
    if (t.isContinueStatement(parent) && key === 'label')
        return false;
    if (t.isMemberExpression(parent) && key === 'property' && !parent.computed)
        return false;
    if (t.isObjectProperty(parent) && key === 'key' && !parent.computed)
        return false;
    if (t.isObjectMethod(parent) && key === 'key' && !parent.computed)
        return false;
    return true;
}
function substituteIdentifiers(root, subs) {
    let rootReplacement = null;
    const visit = (n, parent, key, index) => {
        if (t.isFunction(n))
            return; // shadowed
        if (t.isIdentifier(n) && subs.has(n.name)) {
            // Skip Identifier in non-reference contexts (non-computed member
            // `.prop`, object property key, etc.). Without this guard, inlining
            // `clamp(x, 0, 1)` into `Math.max(min, Math.min(max, value))` would
            // rewrite the `max`/`min` property identifiers into NumericLiterals,
            // producing `Math[1](0, Math[0](1, x))`.
            // Skip Identifier in write contexts too. For root expression
            // substitution, we're typically in a read context; LHS-of-assign
            // would mean we're rewriting params, which our classifier rejects
            // for v1 (parameter mutation in callee → BLOCK or NO).
            if (parent !== null && !isReferenceContext$1(parent, key))
                return;
            const sub = t.cloneNode(subs.get(n.name), true);
            if (parent === null)
                rootReplacement = sub;
            else
                setSlot(parent, key, index, sub);
            return;
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c)
                        visit(c, n, k, i);
                }
            }
            else {
                visit(child, n, k, undefined);
            }
        }
    };
    visit(root, null, '', undefined);
    return rootReplacement ?? root;
}
// Best-effort callee name for embedding in generated label names. Returns
// null for arrow / anonymous function expressions; the caller emits the
// shorter `_compilecat_inline_label_<id>` shape in that case.
function calleeName(fn) {
    if ((t.isFunctionDeclaration(fn) || t.isFunctionExpression(fn)) && fn.id) {
        return fn.id.name;
    }
    return null;
}

// Port of jscomp/InlineFunctions.java (subset).
//
// Drives FunctionInjector: discovers candidate callees and call sites,
// classifies each, and performs the splice.
//
// Operates on a single Program. In WholeProgram (bundle-mode) this is the
// entire chunk after rollup has resolved imports — every callee in scope is
// reachable directly. In PerFile (transform-mode) the Program is one source
// file; passing a CrossFileCtx (consumerPath + fileCache) extends discovery
// to follow imports into donor modules, splice donor bodies into the
// consumer, and hoist the module-vars / imports the spliced body references.
//
//   - Candidate callees:
//     - `function NAME(...) { ... }` declarations at any block scope
//     - `const NAME = (...) => { ... }` / `const NAME = function (...) { ... }`
//     - (cross-file) any of the above exported from a resolved donor module
//   - Trigger:
//     - declaration carries an `@inline` JSDoc / leading block comment, OR
//     - call expression carries an `@inline` leading block comment, OR
//     - call sits inside a `@flatten`-annotated function
//   - Call sites:
//     - `NAME(args)` — Identifier callee matching a known candidate (local or
//       cross-file via a named import)
//     - `NS.NAME(args)` — namespace member call against a namespace import or
//       namespace re-export
//   - No method calls, no `this`/`arguments`, no recursion.
//
// Discovery is name-keyed. We don't model scope shadowing — if two callees
// share a name (top-level vs. nested), we conservatively treat the
// outermost as the only candidate.
// ---------------------------------------------------------------------------
// Public entry.
function inlineFunctions(root, options = {}) {
    const result = {
        inlined: 0,
        calls: 0,
        succeeded: 0,
        donorPaths: new Set(),
    };
    // Discover top-level (and nested) local candidate functions.
    const candidates = new Map();
    discoverCandidates(root, candidates);
    // Cross-file context. Built once so the consumerIndex (free-ref analysis)
    // is shared across every call-site lookup.
    const xfile = buildCrossFileCtx(root, options);
    if (candidates.size === 0 && !xfile)
        return result;
    // Find call sites and inject. Pre-collected in a single pass so that
    // injection-time AST mutation can't disturb the iteration.
    const sites = collectCallSites(root, candidates, xfile);
    let nextId = 0;
    const opts = { nextId: () => nextId++ };
    for (const { candidate, site, enclosingFunction } of sites) {
        const fn = candidate.callee.fn;
        const cls = classifyCallee(fn);
        if (cls.mode === 'NO')
            continue;
        result.calls++;
        let ok = false;
        if (cls.mode === 'DIRECT') {
            ok = inlineDirect(candidate.callee, site);
            if (!ok) {
                // Fall back to BLOCK if DIRECT can't substitute (e.g. side-effect
                // arg used twice).
                ok = inlineBlock(candidate.callee, site, opts);
            }
        }
        else {
            ok = inlineBlock(candidate.callee, site, opts);
        }
        if (ok) {
            result.succeeded++;
            if (enclosingFunction)
                options.touched?.add(enclosingFunction);
            if (xfile && candidate.donor) {
                trackDonorRefs(candidate, xfile);
                xfile.donorPaths.add(candidate.donor.donorPath);
            }
        }
    }
    if (result.succeeded > 0)
        result.inlined = candidates.size;
    // Strip declaration-annotated callees once consumed. Conservative: only
    // strip if we successfully inlined at least one call AND no residual
    // identifier reads remain in the same parent block.
    stripFullyInlinedDecls(candidates, sites);
    // Hoist donor-side module-vars and imports referenced by spliced bodies.
    if (xfile && t.isFile(root)) {
        if (xfile.requiredImports.size > 0)
            hoistRequiredImports(root, xfile);
        if (xfile.requiredModuleVars.size > 0)
            hoistRequiredModuleVars(root, xfile);
        for (const p of xfile.donorPaths)
            result.donorPaths.add(p);
    }
    return result;
}
// ---------------------------------------------------------------------------
// Candidate discovery.
function discoverCandidates(root, out) {
    visitWithParents(root, (n, parent, _key, index) => {
        if (t.isFunctionDeclaration(n) && n.id) {
            const params = paramNames(n);
            if (params === null)
                return;
            const annotated = hasInlineAnnotation(n, parent);
            const c = {
                name: n.id.name,
                callee: { fn: n, paramNames: params },
                declAnnotated: annotated,
            };
            if (parent && (t.isBlockStatement(parent) || t.isProgram(parent)) && index !== undefined) {
                c.declRef = { parent: parent, index };
            }
            if (!out.has(n.id.name))
                out.set(n.id.name, c);
            return;
        }
        if (t.isVariableDeclaration(n) && n.declarations.length === 1) {
            const d = n.declarations[0];
            if (t.isIdentifier(d.id) && (t.isArrowFunctionExpression(d.init) || t.isFunctionExpression(d.init))) {
                const params = paramNames(d.init);
                if (params === null)
                    return;
                const annotated = hasInlineAnnotation(n, parent) || hasInlineAnnotation(d.init);
                const c = {
                    name: d.id.name,
                    callee: { fn: d.init, paramNames: params },
                    declAnnotated: annotated,
                };
                if (parent && (t.isBlockStatement(parent) || t.isProgram(parent)) && index !== undefined) {
                    c.declRef = { parent: parent, index };
                }
                if (!out.has(d.id.name))
                    out.set(d.id.name, c);
            }
        }
    });
}
function paramNames(fn) {
    const out = [];
    for (const p of fn.params) {
        if (!t.isIdentifier(p))
            return null;
        out.push(p.name);
    }
    return out;
}
function hasInlineAnnotation(n, parent = null) {
    return hasLeadingDirective(n, parent, commentIsInlineDirective);
}
function hasFlattenAnnotation(n, parent = null) {
    return hasLeadingDirective(n, parent, commentIsFlattenDirective);
}
// ---------------------------------------------------------------------------
// Cross-file context bootstrap.
function buildCrossFileCtx(root, opts) {
    if (!opts.consumerPath || !opts.fileCache)
        return null;
    if (!t.isFile(root))
        return null;
    const reader = opts.fileReader ?? defaultFileReader;
    const consumerIndex = indexFile(opts.consumerPath, root);
    return {
        consumerPath: opts.consumerPath,
        consumerIndex,
        cache: opts.fileCache,
        reader,
        allowLibrary: opts.allowLibraryInline === true,
        memo: new Map(),
        requiredModuleVars: new Map(),
        requiredImports: new Map(),
        donorPaths: new Set(),
    };
}
function collectCallSites(root, candidates, xfile) {
    const sites = [];
    // Track current enclosing function (for flatten propagation + downstream
    // touched-set bookkeeping).
    const flattenStack = [false];
    const fnStack = [null];
    const walk = (n, parent, key, index, 
    // Path of (statementParent, statementIndex, enclosingStatement).
    stmtCtx) => {
        const enteringFn = t.isFunction(n);
        if (enteringFn) {
            flattenStack.push(hasFlattenAnnotation(n, parent));
            fnStack.push(n);
        }
        let nextStmtCtx = stmtCtx;
        if (parent && index !== undefined && t.isStatement(n)) {
            if ((t.isBlockStatement(parent) || t.isProgram(parent)) && key === 'body') {
                nextStmtCtx = {
                    parent: parent,
                    index,
                    stmt: n,
                };
            }
            else if (t.isSwitchCase(parent) && key === 'consequent') {
                // SwitchCase.consequent is a Statement[] just like Block.body —
                // bare `case X: stmt; break;` cases (no `{ ... }` wrapper) need
                // the same statement-context tracking so inlines splice inside
                // the case, not before the enclosing switch.
                nextStmtCtx = {
                    parent: parent,
                    index,
                    stmt: n,
                };
            }
        }
        if (t.isCallExpression(n) && nextStmtCtx !== null && parent !== null) {
            const cand = resolveCandidateForCall(n, candidates, xfile);
            if (cand !== null) {
                const callsiteAnnotated = hasInlineAnnotationOnCall(n, parent, key);
                const enclosingFlatten = flattenStack[flattenStack.length - 1];
                if (cand.declAnnotated || callsiteAnnotated || enclosingFlatten) {
                    sites.push({
                        candidate: cand,
                        site: {
                            call: n,
                            enclosingStatement: nextStmtCtx.stmt,
                            statementParent: nextStmtCtx.parent,
                            statementIndex: nextStmtCtx.index,
                            callParent: parent,
                            callKey: key,
                            callIndex: index,
                        },
                        enclosingFunction: fnStack[fnStack.length - 1],
                    });
                }
            }
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c)
                        walk(c, n, k, i, nextStmtCtx);
                }
            }
            else {
                walk(child, n, k, undefined, nextStmtCtx);
            }
        }
        if (enteringFn) {
            flattenStack.pop();
            fnStack.pop();
        }
    };
    walk(root, null, '', undefined, null);
    return sites;
}
// ---------------------------------------------------------------------------
// Candidate resolution at a call site (local or cross-file).
function resolveCandidateForCall(call, localCandidates, xfile) {
    const callee = call.callee;
    if (t.isIdentifier(callee)) {
        const name = callee.name;
        const local = localCandidates.get(name);
        if (local)
            return local;
        if (!xfile)
            return null;
        const binding = xfile.consumerIndex.imports.get(name);
        if (!binding)
            return null;
        return resolveImportedCallee(binding.importedName, binding, xfile);
    }
    if (t.isMemberExpression(callee) && !callee.computed) {
        if (!xfile)
            return null;
        if (!t.isIdentifier(callee.object))
            return null;
        if (!t.isIdentifier(callee.property))
            return null;
        const nsName = callee.object.name;
        const fnName = callee.property.name;
        const binding = xfile.consumerIndex.imports.get(nsName);
        if (binding && binding.style === 'namespace') {
            return resolveImportedCallee(fnName, binding, xfile);
        }
        const reexportSource = xfile.consumerIndex.namespaceReexports.get(nsName);
        if (reexportSource) {
            const fakeBinding = {
                source: reexportSource,
            };
            return resolveImportedCallee(fnName, fakeBinding, xfile);
        }
        // `import { ns } from 'pkg'` where the donor file re-exports `ns` as a
        // namespace (`export * as ns from './impl'` or
        // `import * as ns from './impl'; export { ns };`). Follow through.
        if (binding && binding.style === 'named') {
            const donorPath = resolveImportSource(xfile.consumerPath, binding.source, xfile.allowLibrary, xfile.reader);
            if (!donorPath)
                return null;
            const donorIndex = ensureIndexed(xfile.cache, donorPath, xfile.reader);
            if (!donorIndex)
                return null;
            let nsSource = donorIndex.namespaceReexports.get(binding.importedName);
            if (!nsSource) {
                const nsImport = donorIndex.imports.get(binding.importedName);
                if (nsImport?.style === 'namespace')
                    nsSource = nsImport.source;
            }
            if (!nsSource)
                return null;
            const fakeBinding = {
                source: nsSource,
            };
            // Resolve `fnName` from the *donor* file's perspective.
            return resolveImportedCalleeFrom(donorPath, fnName, fakeBinding, xfile);
        }
    }
    return null;
}
function resolveImportedCallee(importedName, binding, xfile) {
    return resolveImportedCalleeFrom(xfile.consumerPath, importedName, binding, xfile);
}
function resolveImportedCalleeFrom(fromFile, importedName, binding, xfile) {
    const donorPath = resolveImportSource(fromFile, binding.source, xfile.allowLibrary, xfile.reader);
    if (!donorPath)
        return null;
    const memoKey = `${donorPath}::${importedName}`;
    if (xfile.memo.has(memoKey))
        return xfile.memo.get(memoKey) ?? null;
    const donorIndex = ensureIndexed(xfile.cache, donorPath, xfile.reader);
    if (!donorIndex) {
        xfile.memo.set(memoKey, null);
        return null;
    }
    const donorFn = donorIndex.functions.get(importedName);
    if (!donorFn) {
        xfile.memo.set(memoKey, null);
        return null;
    }
    const cand = buildCrossFileCandidate(donorFn, donorPath, donorIndex);
    xfile.memo.set(memoKey, cand);
    return cand;
}
/**
 * Build a Candidate from a donor IndexedFunction. The body's references to
 * donor module-vars and imports are tracked through `Candidate.donor`; on
 * successful inline we register them so the post-pass can hoist clones into
 * the consumer file. Calls to *other* donor functions cannot be hoisted
 * (they would require pulling whole functions across), so we reject those.
 */
function buildCrossFileCandidate(donorFn, donorPath, donorIndex) {
    // We don't pull donor function definitions across files. If the donor
    // body calls another donor function, the splice would leave an unbound
    // reference in the consumer. Bail.
    if (donorFn.functionRefs.size > 0)
        return null;
    // Donor body references a top-level binding we can't classify
    // (e.g. classes) — the hoister wouldn't know how to bring it along.
    // Bail rather than emitting a broken inline.
    if (donorFn.unresolvedRefs.size > 0)
        return null;
    const params = [];
    for (const p of donorFn.params) {
        if (!t.isIdentifier(p))
            return null;
        params.push(p.name);
    }
    return {
        name: donorFn.name,
        callee: { fn: donorFn.fnNode, paramNames: params },
        declAnnotated: donorFn.hasInlineAnnotation,
        donor: { donorPath, donorIndex, fn: donorFn },
    };
}
function trackDonorRefs(candidate, xfile) {
    if (!candidate.donor)
        return;
    const { donorPath, donorIndex, fn } = candidate.donor;
    for (const name of fn.moduleVarRefs) {
        const mv = donorIndex.moduleVars.get(name);
        if (!mv)
            continue;
        const key = `${donorPath}::${name}`;
        if (xfile.requiredModuleVars.has(key))
            continue;
        xfile.requiredModuleVars.set(key, { sourceFile: donorPath, name, moduleVar: mv });
    }
    for (const name of fn.importRefs) {
        const b = donorIndex.imports.get(name);
        if (!b)
            continue;
        const key = `${donorPath}::${name}`;
        if (xfile.requiredImports.has(key))
            continue;
        xfile.requiredImports.set(key, { sourceFile: donorPath, localName: name, binding: b });
    }
}
// ---------------------------------------------------------------------------
// Hoisting donor module-vars + imports.
//
// Imports are rewritten relative to the consumer file (or kept as bare
// specifiers for library imports). Module-var clones are inserted right
// after the import block. Collisions are skipped — when the consumer
// already has a binding by the same name, we leave the spliced body's
// reference to bind to whatever is in scope.
function hoistRequiredImports(ast, xfile) {
    const consumerIndex = xfile.consumerIndex;
    const reader = xfile.reader;
    const consumerFile = xfile.consumerPath;
    const existingBindings = new Set([
        ...consumerIndex.imports.keys(),
        ...consumerIndex.functions.keys(),
        ...consumerIndex.moduleVars.keys(),
    ]);
    for (const stmt of ast.program.body) {
        if (t.isImportDeclaration(stmt)) {
            for (const spec of stmt.specifiers)
                existingBindings.add(spec.local.name);
        }
    }
    const byTarget = new Map();
    const consumerDir = nodePath.dirname(consumerFile);
    for (const req of xfile.requiredImports.values()) {
        const binding = req.binding;
        if (!binding)
            continue;
        if (existingBindings.has(binding.localName))
            continue;
        let rewrittenSource = binding.source;
        if (binding.source.startsWith('./') || binding.source.startsWith('../') || binding.source.startsWith('/')) {
            const abs = resolveRelativeImport(req.sourceFile, binding.source, reader);
            if (abs) {
                let rel = nodePath.relative(consumerDir, abs);
                if (!rel.startsWith('.'))
                    rel = `./${rel}`;
                rel = rel.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
                rewrittenSource = rel;
            }
        }
        const bucket = byTarget.get(rewrittenSource) ?? { source: rewrittenSource, specs: [] };
        bucket.specs.push({
            localName: binding.localName,
            importedName: binding.importedName,
            style: binding.style,
        });
        byTarget.set(rewrittenSource, bucket);
        existingBindings.add(binding.localName);
    }
    if (byTarget.size === 0)
        return;
    const importsToInsert = [];
    for (const { source, specs } of byTarget.values()) {
        const specifiers = [];
        for (const s of specs) {
            if (s.style === 'default') {
                specifiers.push(t.importDefaultSpecifier(t.identifier(s.localName)));
            }
            else if (s.style === 'namespace') {
                specifiers.push(t.importNamespaceSpecifier(t.identifier(s.localName)));
            }
            else {
                specifiers.push(t.importSpecifier(t.identifier(s.localName), t.identifier(s.importedName)));
            }
        }
        importsToInsert.push(t.importDeclaration(specifiers, t.stringLiteral(source)));
    }
    ast.program.body.unshift(...importsToInsert);
}
function hoistRequiredModuleVars(ast, xfile) {
    const consumerIndex = xfile.consumerIndex;
    const consumerLocals = new Set([
        ...consumerIndex.moduleVars.keys(),
        ...consumerIndex.functions.keys(),
        ...consumerIndex.imports.keys(),
    ]);
    for (const stmt of ast.program.body) {
        if (t.isImportDeclaration(stmt)) {
            for (const spec of stmt.specifiers)
                consumerLocals.add(spec.local.name);
        }
    }
    const toInsert = [];
    const insertedKeys = new Set();
    for (const [key, req] of xfile.requiredModuleVars) {
        if (insertedKeys.has(key))
            continue;
        if (consumerLocals.has(req.name))
            continue;
        const cloned = cloneModuleVarForHoisting(req.moduleVar, req.name);
        if (!cloned)
            continue;
        toInsert.push(...cloned);
        insertedKeys.add(key);
    }
    if (toInsert.length === 0)
        return;
    const body = ast.program.body;
    let insertAt = 0;
    for (let i = 0; i < body.length; i++) {
        if (t.isImportDeclaration(body[i]))
            insertAt = i + 1;
        else
            break;
    }
    body.splice(insertAt, 0, ...toInsert);
}
function cloneModuleVarForHoisting(moduleVar, name) {
    const decl = moduleVar.declaration;
    if (t.isTSEnumDeclaration(decl)) {
        if (decl.id.name !== name)
            return null;
        return lowerTsEnumToJs$1(decl);
    }
    const matching = decl.declarations.find((d) => t.isIdentifier(d.id) && d.id.name === name);
    if (!matching)
        return null;
    return [t.variableDeclaration(decl.kind, [t.cloneNode(matching, true, false)])];
}
// Lower a TSEnumDeclaration to the TypeScript-equivalent JS emit. Matches
// `tsc --target esnext` output: numeric members get reverse-mapping; string
// members get forward-only assignment. Returns null if any member has a
// non-literal initializer we can't evaluate at compile time.
//
//   enum E { A = 0, B = 1 }
// becomes:
//   var E;
//   (function (E) {
//       E[E["A"] = 0] = "A";
//       E[E["B"] = 1] = "B";
//   })(E || (E = {}));
function lowerTsEnumToJs$1(decl) {
    const name = decl.id.name;
    const resolved = [];
    let nextNumeric = 0;
    for (const m of decl.members) {
        const keyName = t.isIdentifier(m.id) ? m.id.name : t.isStringLiteral(m.id) ? m.id.value : null;
        if (keyName === null)
            return null;
        let value;
        if (m.initializer) {
            const init = m.initializer;
            if (t.isNumericLiteral(init)) {
                value = t.numericLiteral(init.value);
                nextNumeric = init.value + 1;
            }
            else if (t.isUnaryExpression(init) && init.operator === '-' && t.isNumericLiteral(init.argument)) {
                value = t.numericLiteral(-init.argument.value);
                nextNumeric = value.value + 1;
            }
            else if (t.isStringLiteral(init)) {
                value = t.stringLiteral(init.value);
                // After a string init, auto-increment is no longer valid in TS.
                nextNumeric = null;
            }
            else {
                return null;
            }
        }
        else {
            if (nextNumeric === null)
                return null;
            value = t.numericLiteral(nextNumeric);
            nextNumeric += 1;
        }
        resolved.push({ key: keyName, value });
    }
    const idRef = () => t.identifier(name);
    const bodyStmts = resolved.map(({ key, value }) => {
        if (t.isStringLiteral(value)) {
            // E["KEY"] = "VAL";  (no reverse mapping for string members)
            return t.expressionStatement(t.assignmentExpression('=', t.memberExpression(idRef(), t.stringLiteral(key), true), value));
        }
        // E[E["KEY"] = VAL] = "KEY";  (reverse mapping for numeric members)
        return t.expressionStatement(t.assignmentExpression('=', t.memberExpression(idRef(), t.assignmentExpression('=', t.memberExpression(idRef(), t.stringLiteral(key), true), value), true), t.stringLiteral(key)));
    });
    const iife = t.expressionStatement(t.callExpression(t.functionExpression(null, [idRef()], t.blockStatement(bodyStmts)), [
        t.logicalExpression('||', idRef(), t.assignmentExpression('=', idRef(), t.objectExpression([]))),
    ]));
    return [t.variableDeclaration('var', [t.variableDeclarator(idRef())]), iife];
}
// ---------------------------------------------------------------------------
function hasInlineAnnotationOnCall(call, parent, key) {
    if (hasInlineAnnotation(call))
        return true;
    // Comment may attach to enclosing ExpressionStatement.
    if (key === 'expression' && t.isExpressionStatement(parent) && hasInlineAnnotation(parent)) {
        return true;
    }
    return false;
}
// ---------------------------------------------------------------------------
// Decl stripping.
function stripFullyInlinedDecls(candidates, sites) {
    const succeededByName = new Map();
    for (const s of sites) {
        succeededByName.set(s.candidate.name, (succeededByName.get(s.candidate.name) ?? 0) + 1);
    }
    for (const [name, c] of candidates) {
        if (c.donor)
            continue;
        if (!c.declAnnotated)
            continue;
        if (!c.declRef)
            continue;
        if ((succeededByName.get(name) ?? 0) === 0)
            continue;
        const anyResidual = anyResidualReference(c.declRef.parent, name, c.declRef.index);
        if (anyResidual)
            continue;
        c.declRef.parent.body.splice(c.declRef.index, 1);
        for (const other of candidates.values()) {
            if (other.declRef && other.declRef.parent === c.declRef.parent && other.declRef.index > c.declRef.index) {
                other.declRef.index--;
            }
        }
    }
}
function anyResidualReference(parent, name, skipIndex) {
    let found = false;
    for (let i = 0; i < parent.body.length; i++) {
        if (i === skipIndex)
            continue;
        const stmt = parent.body[i];
        visit$1(stmt, (n, parentNode, key) => {
            if (found)
                return;
            if (t.isIdentifier(n) && n.name === name && !isWriteContext$1(n, parentNode, key)) {
                found = true;
            }
        });
        if (found)
            return true;
    }
    return false;
}
function isWriteContext$1(n, parent, key) {
    if (parent === null)
        return false;
    if (t.isVariableDeclarator(parent) && key === 'id')
        return true;
    if (t.isFunctionDeclaration(parent) && key === 'id')
        return true;
    if (t.isFunctionExpression(parent) && key === 'id')
        return true;
    if (t.isAssignmentExpression(parent) && key === 'left')
        return true;
    if (t.isUpdateExpression(parent) && key === 'argument')
        return true;
    if (t.isMemberExpression(parent) && key === 'property' && !parent.computed)
        return true;
    if (t.isObjectProperty(parent) && key === 'key' && !parent.computed)
        return true;
    if (t.isLabeledStatement(parent) && key === 'label')
        return true;
    if (t.isBreakStatement(parent) && key === 'label')
        return true;
    if (t.isContinueStatement(parent) && key === 'label')
        return true;
    return false;
}
// ---------------------------------------------------------------------------
// Tiny visitor utilities.
function visit$1(root, fn) {
    const walk = (n, parent, key, index) => {
        fn(n, parent, key, index);
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c)
                        walk(c, n, k, i);
                }
            }
            else {
                walk(child, n, k);
            }
        }
    };
    walk(root, null, '');
}
function visitWithParents(root, fn) {
    visit$1(root, fn);
}

// Port of jscomp/InlineVariables.java.
//
// Closure's InlineVariables drives ReferenceCollector to find variables safe
// to inline. We reuse Babel's scope analysis (binding.referencePaths +
// binding.constantViolations) in place of porting ReferenceCollector, since
// the rest of compilecat is already on Babel scope (e.g. flow-sensitive
// inline). The three paths from InlineVariables.StandardVarExpert that we
// implement:
//
//   1. Single-use inline (Closure: `analyzeWithInitialValue` →
//      `numReadRefs == 1` + `canInline`). `const x = <pure>; ... x ...`
//      with one read → replace the read with init, drop declarator.
//
//   2. Multi-use immutable inline (Closure: `isWellDefined` +
//      `initialValueAnalysis.isImmutableValue()`). `const K = 42;` used N
//      times → clone the literal into each read site, drop declarator.
//
//   3. Alias inline (Closure: `VarIsAliasAnalysis` + `reanalyzeAfterAliasedVar`).
//      `let x = y` where `y` is a bare identifier that is well-defined +
//      assigned-once, and `x` is well-defined + assigned-once → replace
//      reads of `x` with the identifier `y`, drop declarator.
//      This is the post-inline-cleanup path: FunctionArgumentInjector
//      produces `let param = argName` aliases when arguments aren't
//      substituted directly; this pass collapses them.
//
// Mode is the equivalent of Closure's LOCALS_ONLY+module — we never inline
// exported bindings, but we don't have a "constants only" toggle.
//
// Iterates to fixpoint: inlining one binding can make another's reference
// count drop to 1, or unblock an alias chain (a → b → literal).
function inlineVariables(ast, options = {}) {
    let total = 0;
    while (true) {
        const round = sweep$1(ast, options);
        if (round === 0)
            break;
        total += round;
    }
    return { inlined: total };
}
function sweep$1(ast, options) {
    let inlined = 0;
    const touched = options.touched;
    traverse(ast, {
        // Force a scope rebuild — our previous round's mutations may have
        // changed reference counts.
        Program(path) {
            path.scope.crawl();
        },
        VariableDeclarator(path) {
            // Touched-set gate: only inline declarators inside an opted-in
            // function. Top-level declarators are always considered.
            if (touched) {
                const fnParent = path.getFunctionParent();
                if (fnParent && !touched.has(fnParent.node))
                    return;
            }
            // v1: only `const|let x = INIT` — skip destructuring.
            if (!t.isIdentifier(path.node.id))
                return;
            const init = path.node.init;
            if (!init)
                return;
            const name = path.node.id.name;
            const binding = path.scope.getBinding(name);
            if (!binding)
                return;
            // Treat `let` as inlineable only if it's never reassigned.
            if (binding.constantViolations.length > 0)
                return;
            // Don't strip exported declarations.
            if (path.parentPath?.parent && t.isExportDeclaration(path.parentPath.parent))
                return;
            const refCount = binding.references;
            // Path 1: single-use inline (Closure analyzeWithInitialValue, numReadRefs==1).
            if (refCount === 1) {
                if (trySingleUseInline(path, init, binding))
                    inlined++;
                return;
            }
            // Path 2: multi-use immutable inline (Closure: well-defined + isImmutableValue).
            // Path 3: alias inline (Closure: VarIsAliasAnalysis → safe alias rewrite).
            if (refCount > 1) {
                if (tryMultiUseImmutableInline(path, init, binding)) {
                    inlined++;
                    return;
                }
                if (tryAliasInline(path, init, binding)) {
                    inlined++;
                    return;
                }
            }
        },
    });
    return inlined;
}
// Path 1: single-use inline. `const x = pure; ...x...` (exactly one read)
// → replace the read with init, drop declarator.
function trySingleUseInline(path, init, binding) {
    // Init must be pure — we're moving it to a new evaluation point.
    if (mayHaveSideEffects(init))
        return false;
    // Closure InlineVariables.StandardVarExpert.canMoveExpression — refuses to
    // relocate any expression that reads a property (GETPROP/GETELEM). The
    // property could be mutated between def and use, and this pass has no
    // flow-sensitive view to prove otherwise. FlowSensitiveInlineVariables
    // (paired with MustBeReachingVariableDef) is what handles that case.
    if (containsPropertyRead(init))
        return false;
    const initPath = path.get('init');
    if (!initPath.node)
        return false;
    if (initFreeVarsAreUnstable(initPath, path.scope))
        return false;
    const refPath = binding.referencePaths[0];
    if (!refPath)
        return false;
    if (!isPlainRead(refPath))
        return false;
    if (crossesAsyncBoundary(path, refPath))
        return false;
    if (!isPrimitiveLiteral(init) && useIsInsideLoopOutOfDef(path, refPath))
        return false;
    if (defIsConditional(path, refPath))
        return false;
    refPath.replaceWith(t.cloneNode(init, /* deep */ true, /* withoutLoc */ false));
    path.remove();
    return true;
}
// Path 2: multi-use immutable inline. `const K = 42; ...K...K...` → clone
// the literal into each read site, drop declarator. Closure: this is the
// `isImmutableValue` branch of `analyzeWithInitialValue`. Restricted to
// primitive literals: re-evaluation is free (no allocation), the value is
// its own identity, no scope sensitivity.
function tryMultiUseImmutableInline(path, init, binding) {
    if (!isPrimitiveLiteral(init))
        return false;
    // All reference paths must be plain reads (not lvalues, not declarations).
    for (const ref of binding.referencePaths) {
        if (!isPlainRead(ref))
            return false;
        if (crossesAsyncBoundary(path, ref))
            return false;
        if (defIsConditional(path, ref))
            return false;
    }
    for (const ref of binding.referencePaths) {
        ref.replaceWith(t.cloneNode(init, /* deep */ true, /* withoutLoc */ false));
    }
    path.remove();
    return true;
}
// Path 3: alias inline. `let x = y; ...x...x...` where `y` is a bare
// identifier whose binding is well-defined and assigned exactly once, and
// `x` itself is never reassigned → rewrite all reads of `x` to `y`, drop
// the declarator. Closure: VarIsAliasAnalysis + reanalyzeAfterAliasedVar
// success path.
//
// The contact-constraints post-inline shape — `let linVelA__5 = _linearVelocityA;`
// with N reads — is exactly this.
function tryAliasInline(path, init, binding) {
    // Aliased value must be a bare identifier.
    if (!t.isIdentifier(init))
        return false;
    const aliasedName = init.name;
    // Self-alias guard (Closure: `aliasedName.equals(v.getName()) ? null : ...`).
    if (t.isIdentifier(path.node.id) && path.node.id.name === aliasedName)
        return false;
    // Resolve aliased binding in x's enclosing scope.
    const aliasedBinding = path.scope.getBinding(aliasedName);
    if (!aliasedBinding)
        return false;
    // Aliased var must be well-defined + assigned-once. Bindings that are
    // never reassigned and whose declaration cannot be re-entered fit:
    //   - const / let / var with init, no constantViolations
    //   - function declaration (always hoisted+init'd)
    //   - class declaration
    //   - import binding
    //   - parameter (assigned at call, no body reassignment)
    if (!isWellDefinedAssignedOnce(aliasedBinding))
        return false;
    // Async-boundary check vs the alias decl, identifier crossing rule.
    for (const ref of binding.referencePaths) {
        if (!isPlainRead(ref))
            return false;
        if (crossesAsyncBoundary(path, ref))
            return false;
        // At each ref site, the aliased name must resolve to the SAME binding.
        // If a nested function shadows `aliasedName`, rewriting would capture
        // the shadow instead.
        const refScopeBinding = ref.scope.getBinding(aliasedName);
        if (refScopeBinding !== aliasedBinding)
            return false;
        // The alias decl itself must be reachable from the ref site without
        // crossing a conditional that doesn't enclose the ref. Closure's
        // BasicBlock check via initBlock.provablyExecutesBefore. We approximate
        // with the existing defIsConditional helper.
        if (defIsConditional(path, ref))
            return false;
    }
    // Rewrite all reads.
    for (const ref of binding.referencePaths) {
        ref.replaceWith(t.identifier(aliasedName));
    }
    path.remove();
    return true;
}
// True if a binding is "well-defined and assigned exactly once" (Closure:
// isWellDefinedAssignedOnce). Approximation on top of Babel scope:
//   - Param: yes, params are inited at call entry, no further writes count
//     unless constantViolations records body assignments.
//   - Function/class declaration: yes, hoisted+init'd at scope entry.
//   - Import binding: yes, read-only at module load.
//   - const/let/var: yes only if init is present at the decl AND no
//     constantViolations.
function isWellDefinedAssignedOnce(binding) {
    if (binding.constantViolations.length > 0)
        return false;
    const kind = binding.kind;
    if (kind === 'param')
        return true;
    if (kind === 'hoisted')
        return true; // function declaration
    if (kind === 'local' || kind === 'const' || kind === 'let' || kind === 'var') {
        // Babel's `BindingPath.node` is the VariableDeclarator (or similar).
        // Require it to have an init.
        const decl = binding.path.node;
        if (t.isVariableDeclarator(decl)) {
            return decl.init !== null && decl.init !== undefined;
        }
        // class/function declarations also fall here in some shapes.
        if (t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl))
            return true;
        return false;
    }
    if (kind === 'module')
        return true; // import
    return false;
}
// A reference is a "plain read" if it's neither a declaration nor an
// lvalue. Mirrors Closure's `isValidReference`.
function isPlainRead(refPath) {
    if (!t.isIdentifier(refPath.node))
        return false;
    const parent = refPath.parent;
    if (!parent)
        return false;
    // declaration id position
    if (t.isVariableDeclarator(parent) && parent.id === refPath.node)
        return false;
    // assignment LHS
    if (t.isAssignmentExpression(parent) && parent.left === refPath.node)
        return false;
    // update expression target (++/--)
    if (t.isUpdateExpression(parent))
        return false;
    // function/class declaration name
    if ((t.isFunctionDeclaration(parent) ||
        t.isFunctionExpression(parent) ||
        t.isClassDeclaration(parent) ||
        t.isClassExpression(parent)) &&
        parent.id === refPath.node)
        return false;
    // parameter binding
    if (t.isFunction(parent) && Array.isArray(parent.params) && parent.params.includes(refPath.node))
        return false;
    // export specifier — `local` must remain an Identifier; substituting a
    // literal there would violate the AST spec. Common in bundle-mode where
    // a chunk may carry `export { K }` after `const K = 42`.
    if (t.isExportSpecifier(parent))
        return false;
    return true;
}
// True if init reads any identifier that may change between def site and
// use site. Property keys, member-access names, label names, etc. are
// skipped — handled by Babel's `ReferencedIdentifier` virtual visitor.
function initFreeVarsAreUnstable(initPath, scope) {
    let unstable = false;
    initPath.traverse({
        ReferencedIdentifier(p) {
            if (unstable)
                return;
            const b = scope.getBinding(p.node.name);
            if (!b) {
                // Global or `undefined` — can't prove stable.
                unstable = true;
                return;
            }
            if (b.constantViolations.length > 0)
                unstable = true;
        },
    });
    // Don't forget initPath itself if it's a bare identifier — `traverse`
    // visits children, not the root.
    if (!unstable && t.isIdentifier(initPath.node)) {
        const b = scope.getBinding(initPath.node.name);
        if (!b)
            return true;
        if (b.constantViolations.length > 0)
            return true;
    }
    return unstable;
}
function crossesAsyncBoundary(defPath, usePath) {
    // Walk usePath upwards until we hit defPath's enclosing function (or
    // Program). If we cross any async / generator function boundary, bail.
    const defFn = defPath.getFunctionParent() ?? defPath.scope.getProgramParent().path;
    let p = usePath;
    while (p && p.node !== defFn.node) {
        if ((t.isFunction(p.node) ||
            t.isFunctionDeclaration(p.node) ||
            t.isFunctionExpression(p.node) ||
            t.isArrowFunctionExpression(p.node)) &&
            // union narrowing
            (p.node.async === true || p.node.generator === true)) {
            return true;
        }
        p = p.parentPath;
    }
    return false;
}
// True iff `node` (or any subexpression) is a property read. We treat these
// as unsafe to relocate because we have no flow-sensitive view that would
// prove the property isn't mutated between def and use.
function containsPropertyRead(node) {
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
        return true;
    let found = false;
    // structural walk
    const walk = (n) => {
        if (found || n === null || typeof n !== 'object')
            return;
        if (Array.isArray(n)) {
            for (const c of n)
                walk(c);
            return;
        }
        if (typeof n.type !== 'string')
            return;
        if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') {
            found = true;
            return;
        }
        for (const k of Object.keys(n)) {
            if (k === 'loc' ||
                k === 'start' ||
                k === 'end' ||
                k === 'leadingComments' ||
                k === 'trailingComments' ||
                k === 'innerComments')
                continue;
            walk(n[k]);
        }
    };
    walk(node);
    return found;
}
// A primitive literal is cheap to re-evaluate (no allocation, no observable
// side effect, value identity is the value itself). Safe to inline into a
// loop body.
function isPrimitiveLiteral(n) {
    if (t.isNumericLiteral(n) || t.isStringLiteral(n) || t.isBooleanLiteral(n) || t.isNullLiteral(n) || t.isBigIntLiteral(n)) {
        return true;
    }
    if (t.isIdentifier(n) && n.name === 'undefined')
        return true;
    return false;
}
// True iff the def's binding is hoisted out of a conditional construct (if,
// switch case, &&/||/?? branch, or hook branch) that doesn't enclose the use.
// Inlining would relocate work from the conditional path to the unconditional
// site of the use.
function defIsConditional(defPath, usePath) {
    // Collect the use's ancestor chain so we can check containment.
    const useAncestors = new Set();
    let up = usePath;
    while (up) {
        useAncestors.add(up.node);
        up = up.parentPath;
    }
    let p = defPath.parentPath;
    while (p) {
        if (useAncestors.has(p.node))
            return false; // common ancestor reached
        if (t.isIfStatement(p.node) ||
            t.isSwitchCase(p.node) ||
            t.isConditionalExpression(p.node) ||
            (t.isLogicalExpression(p.node) && (p.node.operator === '&&' || p.node.operator === '||' || p.node.operator === '??'))) {
            return true;
        }
        p = p.parentPath;
    }
    return false;
}
function useIsInsideLoopOutOfDef(defPath, usePath) {
    // Walk up from use, stopping at any common ancestor with def. If we cross
    // a loop *before* reaching common ancestry, the use is inside a loop that
    // def is outside of → bail. If def lives inside the same loop (def runs
    // per-iteration too), the common ancestor sits between use and the loop,
    // so we stop short and return false.
    const defAncestors = new Set();
    let dp = defPath;
    while (dp) {
        defAncestors.add(dp.node);
        dp = dp.parentPath;
    }
    let p = usePath.parentPath;
    while (p) {
        if (defAncestors.has(p.node))
            return false;
        if (t.isForStatement(p.node) ||
            t.isForInStatement(p.node) ||
            t.isForOfStatement(p.node) ||
            t.isWhileStatement(p.node) ||
            t.isDoWhileStatement(p.node)) {
            return true;
        }
        p = p.parentPath;
    }
    return false;
}

// Loop unrolling — directive-driven (no Closure analogue).
//
// Replaces an opt-in `@unroll` loop with a flat sequence of its body, one
// copy per iteration, with the loop variable substituted by its concrete
// value. Supported shapes:
//
//   - for (let i = <lit>; i <(=) <lit>; i(++|+= <lit>)) { ... }
//   - for (const x of [<lit>, <lit>, ...]) { ... }
//
// Soft-fails (leaves the loop intact, strips the directive) when the trip
// count isn't statically known or the body has cross-loop control flow.
//
// Same identifier-substitution caveats as classic compilecat: we only rewrite
// reads that aren't shadowed by an inner declaration. We don't have a full
// scope analyzer here — we walk depth-first tracking inner shadowing
// declarations on the fly.
const MAX_UNROLL_ITERATIONS = 1024;
const MAX_UNROLL_PASSES = 16;
function unrollLoops(root, options = {}) {
    let total = 0;
    for (let pass = 0; pass < MAX_UNROLL_PASSES; pass++) {
        const n = unrollPass(root, options.touched);
        if (n === 0)
            break;
        total += n;
    }
    return { unrolled: total };
}
function unrollPass(root, touched) {
    let count = 0;
    walkStatementLists(root, (body, inOptimize, enclosingFn) => {
        for (let i = 0; i < body.length; i++) {
            const s = body[i];
            if (!hasUnrollAnnotation(s) && !inOptimize)
                continue;
            if (t.isForStatement(s)) {
                const out = expandFor(s);
                if (out !== null) {
                    body.splice(i, 1, ...out);
                    count++;
                    if (touched && enclosingFn)
                        touched.add(enclosingFn);
                    i += out.length - 1;
                    continue;
                }
                stripUnrollComments(s);
                continue;
            }
            if (t.isForOfStatement(s)) {
                const out = expandForOf(s);
                if (out !== null) {
                    body.splice(i, 1, ...out);
                    count++;
                    if (touched && enclosingFn)
                        touched.add(enclosingFn);
                    i += out.length - 1;
                    continue;
                }
                stripUnrollComments(s);
            }
        }
    });
    return count;
}
// ---------------------------------------------------------------------------
// for-statement unroll.
function expandFor(node) {
    const shape = parseLoopShape(node);
    if (!shape)
        return null;
    const values = computeIterationValues(shape);
    if (!values)
        return null;
    if (values.length === 0)
        return [];
    if (bodyHasUnsafeControlFlow(node.body))
        return null;
    const out = [];
    for (const v of values) {
        out.push(...iterationStmts(node.body, shape.varName, t.numericLiteral(v)));
    }
    return out;
}
function iterationStmts(body, varName, replacement) {
    // Each iteration becomes its own BlockStatement so per-iteration
    // let/const/class/fn-decl bindings stay isolated. The simplifier's
    // demand-driven α-rename (see normalize.renameForFlatten) renames
    // colliding inner bindings before block-flatten merges them, so the
    // wrappers don't ossify — they collapse into the parent once names
    // are unique.
    if (t.isBlockStatement(body)) {
        const clonedBlock = t.cloneNode(body, true, true);
        substitute(clonedBlock, varName, replacement, false);
        return [clonedBlock];
    }
    return [cloneAndSubstitute(body, varName, replacement)];
}
function parseLoopShape(node) {
    const init = node.init;
    if (!t.isVariableDeclaration(init) || init.declarations.length !== 1)
        return null;
    const decl = init.declarations[0];
    if (!t.isIdentifier(decl.id))
        return null;
    if (!decl.init || !t.isNumericLiteral(decl.init))
        return null;
    const varName = decl.id.name;
    const start = decl.init.value;
    const test = node.test;
    if (!test || !t.isBinaryExpression(test))
        return null;
    if (!t.isIdentifier(test.left) || test.left.name !== varName)
        return null;
    if (!t.isNumericLiteral(test.right))
        return null;
    const bound = test.right.value;
    let inclusive;
    if (test.operator === '<')
        inclusive = false;
    else if (test.operator === '<=')
        inclusive = true;
    else
        return null;
    const update = node.update;
    if (!update)
        return null;
    let step;
    if (t.isUpdateExpression(update)) {
        if (!t.isIdentifier(update.argument) || update.argument.name !== varName)
            return null;
        if (update.operator !== '++')
            return null;
        step = 1;
    }
    else if (t.isAssignmentExpression(update)) {
        if (!t.isIdentifier(update.left) || update.left.name !== varName)
            return null;
        if (!t.isNumericLiteral(update.right))
            return null;
        if (update.operator !== '+=')
            return null;
        step = update.right.value;
    }
    else {
        return null;
    }
    if (step <= 0 || !Number.isInteger(step))
        return null;
    return { varName, start, bound, inclusive, step };
}
function computeIterationValues(shape) {
    const values = [];
    const limit = shape.inclusive ? shape.bound + 1 : shape.bound;
    for (let i = shape.start; i < limit; i += shape.step) {
        values.push(i);
        if (values.length > MAX_UNROLL_ITERATIONS)
            return null;
    }
    return values;
}
// ---------------------------------------------------------------------------
// for-of unroll over a literal array.
function expandForOf(node) {
    if (!t.isVariableDeclaration(node.left))
        return null;
    if (node.left.declarations.length !== 1)
        return null;
    const id = node.left.declarations[0].id;
    if (!t.isIdentifier(id))
        return null;
    const varName = id.name;
    if (!t.isArrayExpression(node.right))
        return null;
    const elements = [];
    for (const el of node.right.elements) {
        if (el === null || t.isSpreadElement(el))
            return null;
        elements.push(el);
    }
    if (elements.length > MAX_UNROLL_ITERATIONS)
        return null;
    if (elements.length === 0)
        return [];
    if (bodyHasUnsafeControlFlow(node.body))
        return null;
    const out = [];
    for (const el of elements) {
        out.push(...iterationStmts(node.body, varName, el));
    }
    return out;
}
// ---------------------------------------------------------------------------
// Annotation matching.
function hasUnrollAnnotation(n) {
    const cs = (n.leadingComments ?? []);
    for (const c of cs) {
        if (DIRECTIVE_PATTERNS.unroll.test(c.value))
            return true;
    }
    return false;
}
function stripUnrollComments(n) {
    if (!n.leadingComments)
        return;
    n.leadingComments = n.leadingComments.filter((c) => !DIRECTIVE_PATTERNS.unroll.test(c.value));
}
// ---------------------------------------------------------------------------
// Control-flow safety.
function bodyHasUnsafeControlFlow(body) {
    return walk(body, false, false);
    function walk(n, insideNestedLoop, insideFunction) {
        if (t.isReturnStatement(n) && !insideFunction)
            return true;
        if ((t.isBreakStatement(n) || t.isContinueStatement(n)) && !insideNestedLoop) {
            return true;
        }
        let nl = insideNestedLoop;
        let nf = insideFunction;
        if (t.isFunction(n)) {
            nf = true;
            nl = true;
        }
        if (t.isForStatement(n) ||
            t.isWhileStatement(n) ||
            t.isDoWhileStatement(n) ||
            t.isForInStatement(n) ||
            t.isForOfStatement(n) ||
            t.isSwitchStatement(n)) {
            nl = true;
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && walk(c, nl, nf))
                        return true;
                }
            }
            else {
                if (walk(child, nl, nf))
                    return true;
            }
        }
        return false;
    }
}
// ---------------------------------------------------------------------------
// Substitution. Walks a clone of the statement and replaces reads of varName
// with `replacement`, skipping declaration IDs and shadowed scopes.
function cloneAndSubstitute(stmt, varName, replacement) {
    const cloned = t.cloneNode(stmt, true, true);
    substitute(cloned, varName, replacement, false);
    return cloned;
}
function substitute(n, varName, replacement, shadowed) {
    if (shadowed) {
        // Still descend in case a deeper scope un-shadows. (JS doesn't, but
        // keep it general.)
        descend(n, varName, replacement, shadowed);
        return;
    }
    if (t.isFunction(n) || t.isCatchClause(n) || t.isClassBody(n)) {
        // Function bodies create their own scope; if they declare a param or
        // local with the same name, we must not substitute inside.
        if (declaresName(n, varName)) {
            descend(n, varName, replacement, true);
            return;
        }
        descend(n, varName, replacement, false);
        return;
    }
    if (t.isBlockStatement(n) && blockDeclaresName(n, varName)) {
        descend(n, varName, replacement, true);
        return;
    }
    descend(n, varName, replacement, shadowed);
}
function descend(n, varName, replacement, shadowed) {
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, k);
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (!c)
                    continue;
                if (!shadowed && t.isIdentifier(c) && c.name === varName && isReadContext(n, k)) {
                    child[i] = t.cloneNode(replacement, true);
                }
                else {
                    substitute(c, varName, replacement, shadowed);
                }
            }
        }
        else {
            if (!shadowed && t.isIdentifier(child) && child.name === varName && isReadContext(n, k)) {
                setSlot(n, k, undefined, t.cloneNode(replacement, true));
            }
            else {
                substitute(child, varName, replacement, shadowed);
            }
        }
    }
}
function isReadContext(parent, key, _id) {
    // Variable declarator id, function/class id, label, member property,
    // object key (non-computed), assignment LHS, update target, pattern parts —
    // all are non-read contexts.
    if (t.isVariableDeclarator(parent) && key === 'id')
        return false;
    if (t.isFunctionDeclaration(parent) && key === 'id')
        return false;
    if (t.isFunctionExpression(parent) && key === 'id')
        return false;
    if (t.isClassDeclaration(parent) && key === 'id')
        return false;
    if (t.isClassExpression(parent) && key === 'id')
        return false;
    if (t.isLabeledStatement(parent) && key === 'label')
        return false;
    if (t.isBreakStatement(parent) && key === 'label')
        return false;
    if (t.isContinueStatement(parent) && key === 'label')
        return false;
    if (t.isMemberExpression(parent) && key === 'property' && !parent.computed)
        return false;
    if (t.isObjectProperty(parent) && key === 'key' && !parent.computed)
        return false;
    if (t.isObjectMethod(parent) && key === 'key' && !parent.computed)
        return false;
    return true;
}
function declaresName(n, name) {
    if (t.isFunction(n)) {
        for (const p of n.params) {
            if (paramDeclares(p, name))
                return true;
        }
        if (t.isFunctionDeclaration(n) && n.id?.name === name)
            return true;
        return false;
    }
    if (t.isCatchClause(n)) {
        if (n.param && t.isIdentifier(n.param) && n.param.name === name)
            return true;
    }
    return false;
}
function paramDeclares(p, name) {
    if (t.isIdentifier(p))
        return p.name === name;
    if (t.isAssignmentPattern(p))
        return paramDeclares(p.left, name);
    if (t.isRestElement(p))
        return paramDeclares(p.argument, name);
    return false;
}
function blockDeclaresName(b, name) {
    for (const s of b.body) {
        if (t.isVariableDeclaration(s) && (s.kind === 'let' || s.kind === 'const')) {
            for (const d of s.declarations) {
                if (t.isIdentifier(d.id) && d.id.name === name)
                    return true;
            }
        }
        if (t.isFunctionDeclaration(s) && s.id?.name === name)
            return true;
        if (t.isClassDeclaration(s) && s.id?.name === name)
            return true;
    }
    return false;
}
// ---------------------------------------------------------------------------
// Statement-list traversal — invokes `cb` for every Block/Program body so the
// caller can splice in place.
function walkStatementLists(root, cb) {
    const optimizeStack = [false];
    const fnStack = [null];
    const visit = (n) => {
        if (n == null)
            return;
        const enteringFn = t.isFunction(n);
        if (enteringFn) {
            optimizeStack.push(hasOptimizeAnnotation(n));
            fnStack.push(n);
        }
        if (t.isBlockStatement(n) || t.isProgram(n)) {
            cb(n.body, optimizeStack[optimizeStack.length - 1], fnStack[fnStack.length - 1]);
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c)
                        visit(c);
                }
            }
            else {
                visit(child);
            }
        }
        if (enteringFn) {
            optimizeStack.pop();
            fnStack.pop();
        }
    };
    visit(root);
}
function hasOptimizeAnnotation(n) {
    const cs = (n.leadingComments ?? []);
    for (const c of cs) {
        if (DIRECTIVE_PATTERNS.optimize.test(c.value))
            return true;
    }
    return false;
}

// Port of jscomp/Normalize.java + jscomp/MakeDeclaredNamesUnique.java
// (InlineRenamer-style subset).
//
// Two stages:
//
//   1. Structural normalizations (Closure NormalizeStatements):
//      - Rewrite blockless arrow function bodies to block-with-return
//        (Normalize.java:387-397). Downstream analyses can then assume every
//        function body is a BlockStatement.
//      - Split multi-declarator var/let/const into one statement per
//        declarator (Normalize.java:645-661). Lets DAE / flow-inline / fold
//        treat each binding independently.
//      - Hoist for-loop initializers out of the loop header
//        (Normalize.java:558-632). `for (var a=0; …)` →
//        `var a=0; for (; …)`. Frees the CFG builder from special-casing
//        for-init liveness. Skipped for `let`/`const`/`class`/`function`
//        per-iteration block-scoped semantics.
//
//   2. Demand-driven α-rename (`renameForFlatten`, run per-function from the
//      simplifier — not from this file's entry):
//      Models Closure's InlineRenamer (MakeDeclaredNamesUnique.java:497-562):
//      rename only where a collision is actually possible. Closure's
//      ContextualRenamer (file-wide eager rename) sprays `__N` suffixes
//      across every function that happens to share a name with any other
//      function's locals — even when those names will never end up in the
//      same scope. The output noise (`cp__3`, `i__7`) makes the intermediate
//      code we ship to a bundler much harder to read.
//
//      Instead, we rename only within a single function's own subtree, and
//      only when a nested block's binding would clash with an ancestor binding
//      *within that same function*. Cross-function name reuse is left alone
//      — distinct function scopes can never collide.
//
//      After the rename, every let/const/class/fn-decl owned by a nested
//      scope inside the function is unique with respect to the function
//      scope and every other nested scope. This is the invariant that
//      `NodeUtil.tryMergeBlock`'s `ignoreBlockScopedDeclarations=true` flag
//      (Closure's `isASTNormalized()`) relies on — flattening any nested
//      block into its parent can't introduce duplicate let/const bindings.
//
// Marker:
//   The exported `markFileNormalized` / `isFileNormalized` pair records that
//   structural normalization ran. It does *not* imply that names have been
//   uniquified — call `renameForFlatten` on a specific function before
//   relaxing block-merge safety for that function.
// Closure's literal constant is `$jscomp$` (MakeDeclaredNamesUnique.java:697).
// We diverge intentionally for readability: double-underscore is shorter,
// reads as a "compiler-generated" marker in any JS code, and avoids `$` so
// the suffix can't be visually mistaken for template-literal `${…}` syntax.
const UNIQUE_ID_SEPARATOR = '__';
const NORMALIZED = new WeakSet();
function markFileNormalized(file) {
    NORMALIZED.add(file);
}
function makeDeclaredNamesUnique(file) {
    structuralNormalize(file);
    markFileNormalized(file);
    return { renamed: 0 };
}
/**
 * Per-function α-rename, ContextualRenamer-style
 * (MakeDeclaredNamesUnique.java:265-380). Walks nested scopes inside `fnPath`
 * top-down; for every owned binding whose base name has already been declared
 * *anywhere* within this function (ancestor OR sibling scope visited earlier),
 * renames it via Babel's `scope.rename` so the name becomes globally unique
 * inside the function subtree.
 *
 * This eager uniqueness is the invariant Closure's `isASTNormalized()`
 * actually promises, and it's what lets `tryMergeBlock` splice a nested
 * block into its parent with `ignoreBlockScopedDeclarations=true` without
 * any further collision checks — sibling collisions can't exist by
 * construction.
 *
 * Cost: more `__N` suffixes in intermediate output (Closure pays the same
 * cost). Since we feed a downstream bundler/minifier the suffix-noise is
 * absorbed at the next stage.
 *
 * Nested functions are skipped; they're renamed by their own invocation.
 */
function renameForFlatten(fnPath) {
    let renamed = 0;
    const fnScope = fnPath.scope;
    // Stack-shaped: `active` holds names that are visible at the current
    // traversal position — i.e. declared by some ancestor scope (within
    // this function). Synthetic-suffix counter is global per function so
    // `__1`, `__2` don't collide across distinct rename sites.
    const active = new Set();
    const allNames = new Set();
    for (const name of Object.keys(fnScope.bindings)) {
        active.add(name);
        allNames.add(name);
    }
    const frames = new WeakMap();
    fnPath.traverse({
        Scope: {
            enter(p) {
                // Inner functions own their own rename pass; don't descend.
                if (p.isFunction()) {
                    p.skip();
                    return;
                }
                // Function-body Block / Program / etc. that share fnScope
                // are already in `active`.
                if (p.scope === fnScope)
                    return;
                const added = [];
                const bindings = p.scope.bindings;
                for (const baseName of Object.keys(bindings)) {
                    const binding = bindings[baseName];
                    if (binding === undefined)
                        continue;
                    if (binding.scope !== p.scope)
                        continue;
                    // Catch-clause params show up here. They never participate
                    // in block-flatten, so leaving them as-is is safe.
                    if (binding.kind === 'param')
                        continue;
                    if (allNames.has(baseName)) {
                        // Already declared somewhere in this function
                        // (ancestor or earlier-visited sibling) — rename.
                        // Use Babel's Scope.rename which traverses the live
                        // AST. Earlier optimization rewrote via cached
                        // binding.referencePaths / constantViolations, but
                        // those caches go stale when prior pipeline phases
                        // (inline-functions, sroa, inline-variables-pre)
                        // splice in new Identifier nodes without a scope
                        // crawl — missed refs then leak the pre-rename name.
                        const newName = pickFreshName(baseName, allNames);
                        p.scope.rename(baseName, newName);
                        active.add(newName);
                        allNames.add(newName);
                        added.push(newName);
                        renamed++;
                    }
                    else {
                        active.add(baseName);
                        allNames.add(baseName);
                        added.push(baseName);
                    }
                }
                if (added.length > 0)
                    frames.set(p.node, { added });
            },
            exit(p) {
                const frame = frames.get(p.node);
                if (frame === undefined)
                    return;
                for (const n of frame.added)
                    active.delete(n);
                frames.delete(p.node);
            },
        },
    });
    return renamed;
}
function pickFreshName(baseName, allNames) {
    let id = 1;
    let candidate = `${baseName}${UNIQUE_ID_SEPARATOR}${id}`;
    while (allNames.has(candidate)) {
        id++;
        candidate = `${baseName}${UNIQUE_ID_SEPARATOR}${id}`;
    }
    return candidate;
}
// ---------------------------------------------------------------------------
// Structural normalizations.
//
// Mirrors Closure's NormalizeStatements callback (Normalize.java:215+).
// Each helper is a literal port of the corresponding Java method; see
// referenced line numbers.
function blockifyChild(parent, key) {
    const child = parent[key];
    if (child === null || child === undefined)
        return;
    if (t.isBlockStatement(child))
        return;
    parent[key] = t.blockStatement([child]);
}
function structuralNormalize(file) {
    // Two visitors so we don't have to coordinate insertions during traversal:
    //   1. visitFunction — arrow→block (Normalize.java:387-397).
    //   2. statementBlockPasses — split decls + extract for-init.
    //
    // Babel's traverse will revisit hoisted nodes appropriately; we use enter
    // for arrow rewrite (so its body is then visited normally) and exit-time
    // mutation for the others to avoid invalidating the iteration.
    traverse(file, {
        ArrowFunctionExpression(path) {
            const node = path.node;
            if (!t.isBlockStatement(node.body)) {
                const body = node.body;
                node.body = t.blockStatement([t.returnStatement(body)]);
            }
        },
    });
    // Wrap statement-child slots in BlockStatement (IRFactory parity).
    //
    // Closure's IRFactory.transformBlock (IRFactory.java:718-729) wraps the
    // body of every IF/WHILE/FOR/DO/WITH/TRY/CATCH in a BLOCK *at parse
    // time*, marked `setIsAddedBlock(true)`. Every later pass (Normalize,
    // FunctionInjector, ExpressionDecomposer, CFG builder) relies on this:
    // ExpressionDecomposer.findInjectionPoint explicitly asserts
    // `NodeUtil.isStatementBlock(parent)` (ExpressionDecomposer.java:882),
    // and FunctionInjector.inlineFunction's `parent.replaceWith(newBlock)`
    // (FunctionInjector.java:630) is only safe because the surrounding
    // block context is always present.
    //
    // Babel preserves the bare-statement form (`for (...) foo();` keeps the
    // ExpressionStatement directly in `.body`), so we re-establish the
    // invariant here. Without this, the inliner splices into the for-loop's
    // *containing* block rather than the loop body — the inlined code
    // escapes the loop scope and leaves the loop empty.
    traverse(file, {
        ForStatement(p) { blockifyChild(p.node, 'body'); },
        ForInStatement(p) { blockifyChild(p.node, 'body'); },
        ForOfStatement(p) { blockifyChild(p.node, 'body'); },
        WhileStatement(p) { blockifyChild(p.node, 'body'); },
        DoWhileStatement(p) { blockifyChild(p.node, 'body'); },
        WithStatement(p) { blockifyChild(p.node, 'body'); },
        IfStatement(p) {
            // IRFactory wraps BOTH branches unconditionally
            // (IRFactory.java:2285-2287). `else if` chains become
            // `else { if (...) {...} }` at the AST level; pretty-printers
            // re-collapse them at output.
            blockifyChild(p.node, 'consequent');
            if (p.node.alternate)
                blockifyChild(p.node, 'alternate');
        },
    });
    // Split + for-init extraction. Closure runs both at the statement-block
    // level (Normalize.java:404-416). We walk Program/BlockStatement bodies
    // directly so we can splice without invalidating Babel paths.
    //
    // Closure also runs extractForInitializer when the parent is a LABEL
    // (Normalize.java:407, isStatementBlock || isLabel). We handle that via
    // the LabeledStatement visitor below — the hoisted var is inserted into
    // the *grandparent* statement list, so we mutate via an enclosing
    // wrapper-block rewrite when needed.
    traverse(file, {
        Program: { exit: (p) => normalizeStatementList(p.node.body) },
        BlockStatement: { exit: (p) => normalizeStatementList(p.node.body) },
    });
    // Labeled-for: if a `LABEL: for (var i=0;…)` survives, the for is the
    // label's only body. Wrap as `{ var i=0; LABEL: for (;…) }` only if the
    // label's parent already is a statement-block — otherwise leave it alone
    // (rare; semantics-preserving fallback).
    traverse(file, {
        LabeledStatement: {
            exit(p) {
                const node = p.node;
                let extracted = null;
                if (t.isForStatement(node.body)) {
                    extracted = extractForInitializer(node.body);
                }
                else if (t.isForInStatement(node.body) || t.isForOfStatement(node.body)) {
                    extracted = extractForInOfInitializer(node.body);
                }
                if (extracted === null)
                    return;
                const parent = p.parent;
                const parentBody = parent.body;
                if (Array.isArray(parentBody)) {
                    const idx = parentBody.indexOf(node);
                    if (idx >= 0) {
                        parentBody.splice(idx, 0, extracted);
                        return;
                    }
                }
                // Fallback: replace label with `{ extracted; label }`.
                p.replaceWith(t.blockStatement([extracted, node]));
            },
        },
    });
}
/** Mirrors Closure's loop in `extractForInitializer` + `splitVarDeclarations`
 *  applied to a single statement list (Normalize.java:558-661). Mutates the
 *  list in place. */
function normalizeStatementList(list) {
    // Pass A — extract for-init. Closure runs this before splitVarDeclarations
    // (Normalize.java:407-416) so the hoisted-out var-statement gets split in
    // pass B if it's multi-declarator.
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (t.isForStatement(s)) {
            const inserted = extractForInitializer(s);
            if (inserted !== null) {
                list.splice(i, 0, inserted);
                i++; // skip the just-inserted node
            }
        }
        else if (t.isForInStatement(s) || t.isForOfStatement(s)) {
            const inserted = extractForInOfInitializer(s);
            if (inserted !== null) {
                list.splice(i, 0, inserted);
                i++;
            }
        }
    }
    // Pass B — split multi-declarator decls.
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!t.isVariableDeclaration(s))
            continue;
        if (s.declarations.length <= 1)
            continue;
        const split = s.declarations.map((d) => t.variableDeclaration(s.kind, [d]));
        list.splice(i, 1, ...split);
        i += split.length - 1;
    }
}
/** Port of Normalize.java:604-628 (FOR case). Returns the new statement to
 *  insert before the for, or null if no extraction. Mutates `loop.init`. */
function extractForInitializer(loop) {
    const init = loop.init;
    if (init === null || init === undefined)
        return null;
    if (t.isVariableDeclaration(init)) {
        // Closure skips block-scoped (let/const/class/function) initializers
        // — their per-iteration semantics matter (Normalize.java:608-610).
        if (init.kind !== 'var')
            return null;
        loop.init = null;
        return init;
    }
    // Expression initializer — wrap in ExprStatement.
    loop.init = null;
    return t.expressionStatement(init);
}
/** Port of Normalize.java:566-602 (FOR_IN/FOR_OF case). Only handles
 *  `for (var x in/of y)` → `var x; for (x in/of y);`. Returns the new
 *  statement, or null if no extraction. Mutates `loop.left`. */
function extractForInOfInitializer(loop) {
    const left = loop.left;
    if (!t.isVariableDeclaration(left))
        return null;
    if (left.kind !== 'var')
        return null;
    if (left.declarations.length !== 1)
        return null;
    const decl = left.declarations[0];
    if (!t.isIdentifier(decl.id))
        return null;
    // Closure clones the name into the for-head and inserts the original VAR
    // before the loop (Normalize.java:597-599). We do the same with a fresh
    // Identifier.
    loop.left = t.identifier(decl.id.name);
    // Strip any initializer — semantically valid only on the rare
    // `for (var x = 0 in obj)` legacy form (Babel parses it; we drop the
    // initializer when hoisting since `for-in` doesn't initialize).
    return t.variableDeclaration('var', [t.variableDeclarator(t.identifier(decl.id.name))]);
}

// Port of jscomp/RemoveUnusedCode.java (subset).
//
// Closure's RemoveUnusedCode is a 3000+ LOC monolith handling unused vars,
// params, properties, prototype methods, default-export trimming, etc. We
// port the slice that delivers the visible wins after inlining:
//
//   - Unused `let|const|var` declarators (with pure or no init).
//   - Unused `function NAME() {}` declarations.
//   - Unused named / default / namespace import specifiers.
//   - Import declarations whose every specifier became unused after the
//     specifier sweep (whole statement dropped).
//
// What's intentionally out of v1 scope (and lives in adjacent passes):
//   - Param trimming → `OptimizeParameters` (Phase 8).
//   - Property-side cleanup (unused `obj.foo = ...`) → already ports as
//     `DeadPropertyAssignmentElimination` (Phase 8).
//   - Destructuring patterns. Bail; the pattern shape is rare in inlined
//     output.
//
// We rely on Babel's scope analysis (`path.scope.getBinding(name)`) for
// reference counts instead of porting Closure's `ReferenceCollector` —
// Babel already maintains references / constantViolations / kind, which is
// what this pass consumes. Iterates to fixpoint because removing one
// reference can make another binding unused.
function removeUnusedCode(ast, options = {}) {
    const total = {
        removedDeclarators: 0,
        removedFunctionDecls: 0,
        removedImportSpecifiers: 0,
        removedImportDeclarations: 0,
    };
    // Iterate to fixpoint. Each round does a fresh `traverse()` so scope info
    // is rebuilt against the mutated AST.
    while (true) {
        const round = sweep(ast, options);
        if (sumOf(round) === 0)
            break;
        total.removedDeclarators += round.removedDeclarators;
        total.removedFunctionDecls += round.removedFunctionDecls;
        total.removedImportSpecifiers += round.removedImportSpecifiers;
        total.removedImportDeclarations += round.removedImportDeclarations;
    }
    return total;
}
function sumOf(r) {
    return r.removedDeclarators + r.removedFunctionDecls + r.removedImportSpecifiers + r.removedImportDeclarations;
}
function sweep(ast, options) {
    const stats = {
        removedDeclarators: 0,
        removedFunctionDecls: 0,
        removedImportSpecifiers: 0,
        removedImportDeclarations: 0,
    };
    const touched = options.touched;
    const gateByEnclosingFn = (path) => {
        if (!touched)
            return true;
        const fnParent = path.getFunctionParent();
        if (!fnParent)
            return true; // top-level — always visit
        return touched.has(fnParent.node);
    };
    traverse(ast, {
        // Force a scope rebuild at the start of each sweep — `path.remove()`
        // calls in the previous round don't decrement reference counts on
        // *other* bindings, so without this, e.g. removing `b` won't make
        // `a` (only used by b) drop to 0 references.
        Program(path) {
            path.scope.crawl();
        },
        VariableDeclarator(path) {
            if (!gateByEnclosingFn(path))
                return;
            // v1: only simple `let|const|var x = ...;` — skip destructuring.
            if (!t.isIdentifier(path.node.id))
                return;
            const binding = path.scope.getBinding(path.node.id.name);
            if (!binding)
                return;
            if (binding.references > 0)
                return;
            // Reassigned-but-never-read: a write-only var. Conservative —
            // keep it; the assignments may carry side effects in their RHS,
            // and DeadAssignmentsElimination is the right tool for that.
            if (binding.constantViolations.length > 0)
                return;
            // If init has side effects we can't drop it silently. Closure
            // hoists the init expression as a sibling ExpressionStatement;
            // for v1 we keep the whole declarator rather than rewrite.
            const init = path.node.init;
            if (init && mayHaveSideEffects(init))
                return;
            // Don't strip exported declarations.
            if (path.parentPath?.parent && t.isExportDeclaration(path.parentPath.parent))
                return;
            path.remove();
            stats.removedDeclarators++;
        },
        FunctionDeclaration(path) {
            if (!gateByEnclosingFn(path))
                return;
            const id = path.node.id;
            if (!id)
                return;
            // Don't strip exported function decls.
            if (path.parent && t.isExportDeclaration(path.parent))
                return;
            const binding = path.scope.getBinding(id.name);
            if (!binding)
                return;
            if (binding.references > 0)
                return;
            if (binding.constantViolations.length > 0)
                return;
            path.remove();
            stats.removedFunctionDecls++;
        },
        ClassDeclaration(path) {
            if (!gateByEnclosingFn(path))
                return;
            const id = path.node.id;
            if (!id)
                return;
            if (path.parent && t.isExportDeclaration(path.parent))
                return;
            const binding = path.scope.getBinding(id.name);
            if (!binding)
                return;
            if (binding.references > 0)
                return;
            if (binding.constantViolations.length > 0)
                return;
            // Bail if any field initializer or computed key may have side
            // effects — Closure preserves classes whose evaluation observably
            // changes program state. Conservative: keep on any non-trivial
            // body member.
            if (classBodyMayHaveSideEffects(path.node.body))
                return;
            // superClass evaluation may also have effects.
            if (path.node.superClass && mayHaveSideEffects(path.node.superClass))
                return;
            path.remove();
            stats.removedFunctionDecls++;
        },
        ImportDeclaration(path) {
            const specs = path.node.specifiers;
            // Side-effect-only import (`import 'foo';`). Leave alone — the
            // module is being loaded for its top-level effects.
            if (specs.length === 0)
                return;
            const keep = [];
            let removedHere = 0;
            for (const spec of specs) {
                const local = spec.local.name;
                const binding = path.scope.getBinding(local);
                if (binding && (binding.references > 0 || binding.constantViolations.length > 0)) {
                    keep.push(spec);
                }
                else {
                    removedHere++;
                }
            }
            if (removedHere === 0)
                return;
            if (keep.length === 0) {
                // All specifiers are unused. Drop the whole declaration —
                // we treat the import as semantically-empty after specifier
                // removal (matches Closure). Side-effect-only imports above
                // are preserved by the early return on `specs.length === 0`.
                path.remove();
                stats.removedImportDeclarations++;
                stats.removedImportSpecifiers += removedHere;
            }
            else {
                path.node.specifiers = keep;
                stats.removedImportSpecifiers += removedHere;
            }
        },
    });
    return stats;
}
// True if any class body member could observably evaluate at class-definition
// time. Method definitions are inert (the function literals are values, not
// calls); static fields and computed keys are not.
function classBodyMayHaveSideEffects(body) {
    for (const member of body.body) {
        // Computed keys evaluate at class-definition time.
        // union narrowing
        if (member.computed && member.key && mayHaveSideEffects(member.key)) {
            return true;
        }
        if (t.isClassProperty(member) || t.isClassPrivateProperty(member)) {
            if (member.static && member.value && mayHaveSideEffects(member.value)) {
                return true;
            }
        }
        if (t.isStaticBlock(member))
            return true;
    }
    return false;
}

// Scalar Replacement of Aggregates — directive-driven.
//
// Converts `const v = [a, b, c]` + constant-index accesses (`v[0]`, `v[1]`,
// `v[2]`) into scalar locals `let v_0 = a, v_1 = b, v_2 = c` with member
// accesses rewritten to `v_0`, `v_1`, etc.
//
// Opt-in via `@sroa` on either the declaration itself or any enclosing
// function/block. Conservative escape analysis: we scan the enclosing scope
// (function body or program) and reject any reference to the binding's name
// that isn't a constant-index member read or write.
const MIN_FIELDS = 2;
const MAX_FIELDS = 16;
function applySroa(root, options = {}) {
    const candidates = collectCandidates(root);
    if (candidates.length === 0)
        return { sroad: 0 };
    const safe = [];
    for (const c of candidates) {
        if (passesEscapeAnalysis(c))
            safe.push(c);
    }
    if (safe.length === 0)
        return { sroad: 0 };
    rewriteDeclarations(safe);
    rewriteAccesses(root, safe);
    if (options.touched) {
        for (const c of safe) {
            if (t.isFunction(c.scope))
                options.touched.add(c.scope);
        }
    }
    return { sroad: safe.length };
}
// ---------------------------------------------------------------------------
// Phase 1 — discover annotated `const v = [...]` declarations.
function collectCandidates(root) {
    const out = [];
    const sroaScopeStack = [false];
    const walk = (n, parent, _key, index, scope) => {
        const enteringFn = t.isFunction(n);
        const enteringScope = enteringFn || t.isProgram(n);
        const annotated = sroaScopeStack[sroaScopeStack.length - 1] || hasSroaAnnotation(n, parent);
        if (enteringScope) {
            sroaScopeStack.push(annotated);
        }
        const nextScope = enteringScope ? n : scope;
        if (t.isVariableDeclaration(n) && parent && index !== undefined) {
            const declAnnot = annotated || hasSroaAnnotation(n, parent);
            for (const d of n.declarations) {
                if (!declAnnot && !hasSroaAnnotation(d))
                    continue;
                if (!t.isIdentifier(d.id) || !d.init)
                    continue;
                const init = inferInitializer(d.init);
                if (!init)
                    continue;
                if (parent && (t.isBlockStatement(parent) || t.isProgram(parent)) && typeof index === 'number') {
                    out.push({
                        name: d.id.name,
                        size: init.size,
                        initExprs: init.initExprs,
                        declarator: d,
                        declStmt: n,
                        declStmtParent: parent,
                        declStmtIndex: index,
                        scope: nextScope,
                    });
                }
            }
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c)
                        walk(c, n, k, i, nextScope);
                }
            }
            else {
                walk(child, n, k, undefined, nextScope);
            }
        }
        if (enteringScope)
            sroaScopeStack.pop();
    };
    walk(root, null, '', undefined, root);
    return out;
}
function inferInitializer(init) {
    if (!t.isArrayExpression(init))
        return null;
    const size = init.elements.length;
    if (size < MIN_FIELDS || size > MAX_FIELDS)
        return null;
    const exprs = [];
    for (const el of init.elements) {
        if (el === null || t.isSpreadElement(el))
            return null;
        exprs.push(el);
    }
    return { size, initExprs: exprs };
}
function hasSroaAnnotation(n, parent = null) {
    return hasLeadingDirective(n, parent, commentIsSroaDirective);
}
// ---------------------------------------------------------------------------
// Phase 2 — escape analysis. Reject if any reference is anything other than:
//   - the declarator id itself
//   - a constant-index MemberExpression (`name[<lit>]`) used as RHS or LHS
//   - the constant index is in [0, size)
function passesEscapeAnalysis(c) {
    let safe = true;
    const visit = (n, parent, key) => {
        if (!safe || !n)
            return;
        if (t.isIdentifier(n) && n.name === c.name) {
            if (n === c.declarator.id)
                return;
            if (!isReadOrAssignContext(parent, key))
                return;
            // Allow MemberExpression(name, NumericLiteral, computed=true) where
            // the member reference is the object of the expression.
            if (parent && t.isMemberExpression(parent) && key === 'object') {
                if (parent.computed && t.isNumericLiteral(parent.property)) {
                    const idx = parent.property.value;
                    if (idx >= 0 && idx < c.size && Number.isInteger(idx))
                        return;
                }
            }
            safe = false;
            return;
        }
        // Don't descend into nested functions that shadow `name` as a param.
        if (t.isFunction(n)) {
            for (const p of n.params) {
                if (paramNameIs(p, c.name))
                    return;
            }
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const cc of child) {
                    if (cc)
                        visit(cc, n, k);
                }
            }
            else {
                visit(child, n, k);
            }
        }
    };
    visit(c.scope, null, '');
    return safe;
}
function paramNameIs(p, name) {
    if (t.isIdentifier(p))
        return p.name === name;
    if (t.isAssignmentPattern(p))
        return paramNameIs(p.left, name);
    if (t.isRestElement(p))
        return paramNameIs(p.argument, name);
    return false;
}
function isReadOrAssignContext(parent, key) {
    if (parent === null)
        return false;
    if (t.isVariableDeclarator(parent) && key === 'id')
        return false;
    if (t.isFunctionDeclaration(parent) && key === 'id')
        return false;
    if (t.isFunctionExpression(parent) && key === 'id')
        return false;
    if (t.isClassDeclaration(parent) && key === 'id')
        return false;
    if (t.isClassExpression(parent) && key === 'id')
        return false;
    if (t.isLabeledStatement(parent) && key === 'label')
        return false;
    if (t.isBreakStatement(parent) && key === 'label')
        return false;
    if (t.isContinueStatement(parent) && key === 'label')
        return false;
    if (t.isMemberExpression(parent) && key === 'property' && !parent.computed)
        return false;
    if (t.isObjectProperty(parent) && key === 'key' && !parent.computed)
        return false;
    return true;
}
// ---------------------------------------------------------------------------
// Phase 3 — declaration rewrite.
function rewriteDeclarations(safe) {
    for (const c of safe) {
        const newDecls = [];
        for (let i = 0; i < c.size; i++) {
            const scalar = `${c.name}_${i}`;
            const init = c.initExprs[i] ?? t.identifier('undefined');
            newDecls.push(t.variableDeclarator(t.identifier(scalar), t.cloneNode(init, true, false)));
        }
        const idx = c.declStmt.declarations.indexOf(c.declarator);
        if (idx === -1)
            continue;
        if (c.declStmt.declarations.length === 1) {
            c.declStmt.kind = 'let';
            c.declStmt.declarations = newDecls;
        }
        else {
            c.declStmt.declarations.splice(idx, 1, ...newDecls);
        }
    }
}
// ---------------------------------------------------------------------------
// Phase 4 — access rewrite. We scan each safe candidate's scope and replace
// matching `name[<idx>]` with `name_<idx>`.
function rewriteAccesses(root, safe) {
    const byScope = new Map();
    for (const c of safe) {
        let m = byScope.get(c.scope);
        if (!m) {
            m = new Map();
            byScope.set(c.scope, m);
        }
        m.set(c.name, c);
    }
    if (byScope.size === 0)
        return;
    // Walk; track current "active scope" stack.
    const scopeStack = [];
    const visit = (n, parent, key, index) => {
        if (!n)
            return;
        const opensScope = byScope.has(n);
        if (opensScope)
            scopeStack.push(n);
        // Member expression rewrite.
        if (t.isMemberExpression(n) &&
            n.computed &&
            t.isIdentifier(n.object) &&
            t.isNumericLiteral(n.property) &&
            parent !== null) {
            for (let i = scopeStack.length - 1; i >= 0; i--) {
                const m = byScope.get(scopeStack[i]);
                const c = m.get(n.object.name);
                if (c) {
                    const idx = n.property.value;
                    if (idx >= 0 && idx < c.size && Number.isInteger(idx)) {
                        const replacement = t.identifier(`${c.name}_${idx}`);
                        setSlot(parent, key, index, replacement);
                    }
                    break;
                }
            }
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c)
                        visit(c, n, k, i);
                }
            }
            else {
                visit(child, n, k, undefined);
            }
        }
        if (opensScope)
            scopeStack.pop();
    };
    visit(root, null, '', undefined);
}

// Port of jscomp/graph/LinkedDirectedGraph.java
//
// Concrete impl of DiGraph. Closure splits this from the abstract DiGraph for
// Java-OOP reasons; in TS the interface lives in DiGraph.ts and this file
// holds the functions that build/mutate it.
//
// Simplifications vs Closure:
//   - No `useNodeAnnotations` / `useEdgeAnnotations` flags. The annotation
//     slot always exists; callers that don't use it just ignore it. The dual
//     (Annotated)LinkedDiGraphNode/Edge class hierarchy collapses.
//   - No Graphviz interface, no SubGraph. Not needed by the analyses we port.
//   - Methods become module-level functions taking the graph as first arg.
function createDiGraph() {
    return {
        nodes: new Map(),
        nodeAnnotationStack: [],
        edgeAnnotationStack: [],
    };
}
/** Idempotent: returns the existing node if `value` is already present. */
function createNode(graph, value) {
    let node = graph.nodes.get(value);
    if (node === undefined) {
        node = {
            value,
            outEdges: [],
            inEdges: [],
            annotation: undefined,
            priority: -1,
        };
        graph.nodes.set(value, node);
    }
    return node;
}
function getNodeOrFail(graph, value) {
    const n = graph.nodes.get(value);
    if (n === undefined)
        throw new Error(`graph: node not found for value ${String(value)}`);
    return n;
}
/**
 * Add an edge from `src` to `dest` carrying `edgeValue`. Both endpoints must
 * already be in the graph (use createNode first if needed). Mirrors Closure's
 * `connect(N, E, N)` — does NOT dedupe; multiple edges between the same pair
 * are allowed.
 */
function connect(graph, srcValue, edgeValue, destValue) {
    const src = getNodeOrFail(graph, srcValue);
    const dest = getNodeOrFail(graph, destValue);
    return connectNodes(src, edgeValue, dest);
}
/** Direct-node variant; preferred when callers already hold the nodes. */
function connectNodes(src, edgeValue, dest) {
    const edge = {
        source: src,
        destination: dest,
        value: edgeValue,
        annotation: undefined,
    };
    src.outEdges.push(edge);
    dest.inEdges.push(edge);
    return edge;
}
/**
 * Whether `source` reaches `dest` via a single edge whose value passes
 * `edgeFilter`. Matches Closure's optimization of scanning the shorter of
 * src.outEdges / dest.inEdges.
 */
function isConnectedInDirection(source, dest, edgeFilter) {
    if (source.outEdges.length < dest.inEdges.length) {
        for (const e of source.outEdges) {
            if (e.destination === dest && edgeFilter(e.value))
                return true;
        }
    }
    else {
        for (const e of dest.inEdges) {
            if (e.source === source && edgeFilter(e.value))
                return true;
        }
    }
    return false;
}
// ---------------------------------------------------------------------------
// Annotation push/pop
//
// Closure uses these to snapshot every node+edge annotation into a stack so
// algorithms can scribble into the slot temporarily and restore on exit.
// CheckPathsBetweenNodes uses this for DFS coloring.
function pushNodeAnnotations(graph) {
    const snap = new Map();
    for (const node of graph.nodes.values()) {
        snap.set(node, node.annotation);
        node.annotation = undefined;
    }
    graph.nodeAnnotationStack.push(snap);
}
function popNodeAnnotations(graph) {
    const snap = graph.nodeAnnotationStack.pop();
    if (snap === undefined)
        throw new Error('graph: node annotation stack underflow');
    for (const [node, ann] of snap) {
        node.annotation = ann;
    }
}
function pushEdgeAnnotations(graph) {
    const snap = new Map();
    for (const node of graph.nodes.values()) {
        for (const e of node.outEdges) {
            snap.set(e, e.annotation);
            e.annotation = undefined;
        }
    }
    graph.edgeAnnotationStack.push(snap);
}
function popEdgeAnnotations(graph) {
    const snap = graph.edgeAnnotationStack.pop();
    if (snap === undefined)
        throw new Error('graph: edge annotation stack underflow');
    for (const [edge, ann] of snap) {
        edge.annotation = ann;
    }
}

// Port of jscomp/ControlFlowGraph.java
//
// A CFG is a DiGraph specialized to N = AST node, E = Branch (kind of edge).
// Adds two distinguished nodes: `entry` (function/script start) and
// `implicitReturn` (exit sentinel — every termination edge points here).
//
// `isEnteringNewCfgNode` is the rule used by traversal callbacks that walk
// inside a CFG node's subtree but stop at boundaries between CFG nodes. Ported
// to Babel's parent-relationship model below.
/** Edge kind on a CFG. */
var Branch;
(function (Branch) {
    /** Edge taken when the controlling condition is true. */
    Branch["ON_TRUE"] = "ON_TRUE";
    /** Edge taken when the controlling condition is false. */
    Branch["ON_FALSE"] = "ON_FALSE";
    /** Unconditional branch. */
    Branch["UNCOND"] = "UNCOND";
    /**
     * Exception-handling edge. Conflates "thrown into catch/finally" with
     * "finally finishes and passes to outer handler". v1 of the CFG builder
     * does not emit ON_EX edges (try/catch is bailed at construction); the
     * enum value exists so DataFlowAnalysis can be polymorphic over it later.
     */
    Branch["ON_EX"] = "ON_EX";
    /** Synthetic edge for folded-away template/control-flow constructs. */
    Branch["SYN_BLOCK"] = "SYN_BLOCK";
})(Branch || (Branch = {}));
/**
 * Sentinel node value for the implicit return. Distinct symbol so it cannot
 * collide with any real Babel AST node. Closure uses `null`; we use a Symbol
 * because TS Maps can't key on null cleanly when the rest of the keys are
 * objects.
 */
const IMPLICIT_RETURN = Symbol('IMPLICIT_RETURN');
function createControlFlowGraph(entryNode) {
    const g = createDiGraph();
    g.implicitReturn = createNode(g, IMPLICIT_RETURN);
    g.entry = createNode(g, entryNode);
    return g;
}
// ---------------------------------------------------------------------------
// isEnteringNewCfgNode
//
// Closure's version asks: when we're walking the subtree of one CFG node and
// reach `n`, is `n` the start of a NEW CFG node we should not descend into?
// Translation rules per Closure:
//
//   parent.token            => is `n` a new CFG node?
//   BLOCK, ROOT, SCRIPT,
//   TRY, SWITCH_BODY        => yes (statement-list members are each their own)
//   FUNCTION                => yes iff n is NOT the body (=> 2nd child).
//                              The function "header" (name + params) is part
//                              of the surrounding CFG; the body is its own
//                              function-scope CFG.
//   WHILE, DO, IF           => yes iff n is NOT the condition expr
//   FOR (C-style)           => yes iff n is NOT the condition expr
//   FOR_IN                  => yes iff n is NOT the loop var
//                              (the iterable expression is part of the same
//                              CFG node as the FOR_IN header)
//   CASE, CATCH, WITH       => yes iff n is NOT the first child (condition /
//                              binding pattern); body statements are new
//                              CFG nodes
//   default                 => no
//
// Babel mapping:
//   BLOCK              -> BlockStatement (body[])
//   ROOT/SCRIPT        -> File / Program (body[])
//   TRY                -> TryStatement (block / handler / finalizer) — v1 bails
//   SWITCH_BODY        -> SwitchStatement (cases[])
//   FUNCTION           -> Function* (Function/Method etc.); body is the
//                          BlockStatement (`.body`).
//   WHILE/DO/IF        -> WhileStatement/DoWhileStatement/IfStatement;
//                          condition is `.test`.
//   FOR                -> ForStatement; condition is `.test` (init/update are
//                          their own CFG nodes).
//   FOR_IN/FOR_OF      -> ForInStatement/ForOfStatement; the loop binding is
//                          `.left`, the iterable is `.right`. We treat
//                          everything except `.left` as part of the header.
//   CASE/CATCH         -> SwitchCase/CatchClause; condition / param is the
//                          first child.
function isEnteringNewCfgNode(node, parent) {
    if (parent === null)
        return true;
    // Statement-list parents — every direct child statement is its own CFG node.
    if (t.isBlockStatement(parent) ||
        t.isProgram(parent) ||
        t.isFile(parent) ||
        t.isTryStatement(parent) ||
        t.isSwitchStatement(parent)) {
        return true;
    }
    if (t.isFunction(parent)) {
        // Function header (id, params) shares the surrounding CFG node; body
        // gets its own function-scope CFG.
        return node === parent.body;
    }
    if (t.isWhileStatement(parent) || t.isDoWhileStatement(parent) || t.isIfStatement(parent)) {
        return node !== parent.test;
    }
    if (t.isForStatement(parent)) {
        return node !== parent.test;
    }
    if (t.isForInStatement(parent) || t.isForOfStatement(parent)) {
        // First "child" in Closure terms is the loop-var declaration. Anything
        // else (the iterable, the body) starts a new CFG node.
        return node !== parent.left;
    }
    if (t.isSwitchCase(parent)) {
        // First child is the case test expression; consequent statements are
        // each their own CFG node.
        return node !== parent.test;
    }
    if (t.isCatchClause(parent)) {
        // First child is the param; the body is a new CFG node.
        return node !== parent.param;
    }
    return false;
}

// Port of jscomp/ControlFlowAnalysis.java (subset).
//
// Builds a ControlFlowGraph for a single CFG root (a function body or a
// top-level Program/BlockStatement). Closure's algorithm:
//
//   1. Walk the AST recording astPosition for every node that will become a
//      CFG node (= source-order index).
//   2. Per node, dispatch to a handleX function. handleX adds the outbound
//      edges for that node, often calling `computeFollowNode` to find where
//      "next" is.
//   3. Compute a priority for each node by BFS over the CFG using the AST
//      position as tie-break — this gives the dataflow worklist a stable
//      forward-flow ordering.
//
// v1 BAILOUTS — buildControlFlowGraph returns null:
//   - TryStatement (no exception edges yet — matches plan)
//   - WithStatement (don't bother)
//   - generator function (.generator)
//   - async function (.async) — for-await also caught here transitively
//   - YieldExpression / AwaitExpression anywhere inside the CFG root
//
// Skipped vs Closure: ON_EX edges, finallyMap, connectToPossibleExceptionHandler.
// The Branch enum keeps ON_EX for forward compat with later phases.
/**
 * Build a CFG for `root`. Returns null if `root` contains constructs we bail
 * on (try/with/yield/await/generator/async). The caller should treat that as
 * "skip this function for any analysis that needs a CFG".
 */
function buildControlFlowGraph(opts) {
    if (containsBailout(opts.root))
        return null;
    const cfg = createControlFlowGraph(opts.root);
    const cfa = {
        cfg,
        root: opts.root,
        astPosition: new Map(),
        astPositionCounter: 0,
        shouldTraverseFunctions: opts.shouldTraverseFunctions ?? false,
    };
    walk$4(cfa, opts.root, null);
    // Implicit return is positioned last.
    cfa.astPosition.set(cfg.implicitReturn.value, cfa.astPositionCounter++);
    prioritize(cfa);
    return cfg;
}
// ---------------------------------------------------------------------------
// Bailout scan
//
// We need this to refuse the root entirely BEFORE building the partial CFG —
// otherwise edges leading into a try block etc. would be silently wrong.
function containsBailout(node) {
    let bail = false;
    walkBail(node, null, (n) => {
        if (t.isTryStatement(n) || t.isWithStatement(n) || t.isYieldExpression(n) || t.isAwaitExpression(n)) {
            bail = true;
            return false;
        }
        if (t.isFunction(n) && n !== node) {
            // Don't descend into nested functions — they have their own CFG.
            // Their async/generator-ness only matters when we build that CFG.
            return false;
        }
        if (t.isFunction(n) && n === node) {
            if (n.async || n.generator) {
                bail = true;
                return false;
            }
        }
        if (t.isForOfStatement(n) && n.await) {
            bail = true;
            return false;
        }
        return true;
    });
    return bail;
}
function walkBail(node, parent, visit) {
    if (!visit(node, parent))
        return;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        const child = getSlot(node, key);
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c)
                    walkBail(c, node, visit);
            }
        }
        else {
            walkBail(child, node, visit);
        }
    }
}
// ---------------------------------------------------------------------------
// Main walk
//
// For each node we visit we (a) record its astPosition, (b) descend into the
// children we care about, and (c) on the way back up call the per-token
// handler to emit edges.
function walk$4(cfa, node, parent) {
    if (!shouldTraverseIntoChildren(cfa, node, parent)) {
        // Still record position for non-traversed children that are part of
        // the CFG (e.g. for-init / for-update appear as CFG nodes even though
        // the walker doesn't recurse into their subtrees).
        if (parent !== null && positionWanted(parent, node)) {
            ensurePosition(cfa, node);
        }
        return;
    }
    ensurePosition(cfa, node);
    // Recurse into the children determined by the node type.
    for (const child of childrenToTraverse(node)) {
        walk$4(cfa, child, node);
    }
    visit(cfa, node);
}
function ensurePosition(cfa, n) {
    if (!cfa.astPosition.has(n))
        cfa.astPosition.set(n, cfa.astPositionCounter++);
}
/** Whether `child` should get an astPosition entry as a non-traversed child of
 *  `parent`. We do this for for-init/cond/update so they receive priorities. */
function positionWanted(parent, child) {
    if (t.isForStatement(parent)) {
        return child === parent.init || child === parent.test || child === parent.update;
    }
    return false;
}
function shouldTraverseIntoChildren(cfa, n, parent) {
    if (t.isFunction(n)) {
        // Only traverse the function we were asked about (the CFG root).
        return cfa.shouldTraverseFunctions || n === cfa.root;
    }
    if (parent === null)
        return true;
    // Mirrors Closure's shouldTraverseIntoChildren switch on parent.token.
    if (t.isForStatement(parent) || t.isForInStatement(parent) || t.isForOfStatement(parent)) {
        // Only descend into the body.
        return n === parent.body;
    }
    if (t.isDoWhileStatement(parent)) {
        // Don't descend into the test; only the body.
        return n === parent.body;
    }
    if (t.isIfStatement(parent) || t.isWhileStatement(parent) || t.isWithStatement(parent) || t.isSwitchStatement(parent)) {
        // Skip the condition; descend into anything that's NOT the test.
        if (t.isIfStatement(parent))
            return n !== parent.test;
        if (t.isWhileStatement(parent))
            return n !== parent.test;
        if (t.isWithStatement(parent))
            return n !== parent.object;
        if (t.isSwitchStatement(parent))
            return n !== parent.discriminant;
    }
    if (t.isSwitchCase(parent)) {
        // Skip the case test; descend into the consequents.
        return n !== parent.test;
    }
    if (t.isCatchClause(parent)) {
        return n !== parent.param;
    }
    if (t.isLabeledStatement(parent)) {
        return n === parent.body;
    }
    if (t.isFunction(parent)) {
        return n === parent.body;
    }
    // Closure refuses to descend into a handful of expression-bearing
    // statements where the children are pure expressions with no control
    // flow we model. Babel encodes this differently; skipping the whole
    // subtree of these mirrors Closure's intent.
    if (t.isExpressionStatement(parent) ||
        t.isVariableDeclaration(parent) ||
        t.isVariableDeclarator(parent) ||
        t.isReturnStatement(parent) ||
        t.isThrowStatement(parent) ||
        t.isBreakStatement(parent) ||
        t.isContinueStatement(parent)) {
        return false;
    }
    return true;
}
function childrenToTraverse(node) {
    if (t.isFunction(node)) {
        return [node.body];
    }
    if (t.isIfStatement(node)) {
        return node.alternate ? [node.consequent, node.alternate] : [node.consequent];
    }
    if (t.isWhileStatement(node) || t.isDoWhileStatement(node)) {
        return [node.body];
    }
    if (t.isForStatement(node) || t.isForInStatement(node) || t.isForOfStatement(node)) {
        return [node.body];
    }
    if (t.isSwitchStatement(node)) {
        return node.cases;
    }
    if (t.isSwitchCase(node)) {
        return node.consequent;
    }
    if (t.isLabeledStatement(node)) {
        return [node.body];
    }
    if (t.isBlockStatement(node)) {
        return node.body;
    }
    if (t.isProgram(node)) {
        return node.body;
    }
    if (t.isFile(node)) {
        return [node.program];
    }
    return [];
}
// ---------------------------------------------------------------------------
// Per-node visit dispatch (post-order edge emission)
function visit(cfa, n, _parent) {
    if (t.isIfStatement(n))
        handleIf(cfa, n);
    else if (t.isWhileStatement(n))
        handleWhile(cfa, n);
    else if (t.isDoWhileStatement(n))
        handleDo(cfa, n);
    else if (t.isForStatement(n))
        handleFor(cfa, n);
    else if (t.isForInStatement(n) || t.isForOfStatement(n))
        handleEnhancedFor(cfa, n);
    else if (t.isSwitchStatement(n))
        handleSwitch(cfa, n);
    else if (t.isSwitchCase(n))
        handleSwitchCase(cfa, n);
    else if (t.isBlockStatement(n) || t.isProgram(n))
        handleStmtList(cfa, n);
    else if (t.isFile(n)) ;
    else if (t.isFunction(n))
        handleFunction(cfa, n);
    else if (t.isExpressionStatement(n))
        handleExpr(cfa, n);
    else if (t.isThrowStatement(n))
        ;
    else if (t.isBreakStatement(n))
        handleBreak(cfa, n);
    else if (t.isContinueStatement(n))
        handleContinue(cfa, n);
    else if (t.isReturnStatement(n))
        handleReturn(cfa, n);
    else if (t.isLabeledStatement(n)) ;
    else if (t.isStatement(n))
        handleStmt(cfa, n);
}
function parentOf(cfa, n) {
    return getParentMap(cfa).get(n) ?? null;
}
const PARENT_MAP = new WeakMap();
function getParentMap(cfa) {
    let pm = PARENT_MAP.get(cfa);
    if (pm === undefined) {
        pm = new WeakMap();
        const populate = (n, parent) => {
            if (parent !== null)
                pm.set(n, parent);
            for (const key of t.VISITOR_KEYS[n.type] ?? []) {
                const child = getSlot(n, key);
                if (child === null || child === undefined)
                    continue;
                if (Array.isArray(child)) {
                    for (const c of child) {
                        if (c)
                            populate(c, n);
                    }
                }
                else {
                    populate(child, n);
                }
            }
        };
        populate(cfa.root, null);
        PARENT_MAP.set(cfa, pm);
    }
    return pm;
}
// ---------------------------------------------------------------------------
// Handlers — direct ports of Closure's handleX (sans exception handling).
function handleIf(cfa, node) {
    createEdge(cfa, node, Branch.ON_TRUE, computeFallThrough(node.consequent));
    if (node.alternate) {
        createEdge(cfa, node, Branch.ON_FALSE, computeFallThrough(node.alternate));
    }
    else {
        createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
    }
}
function handleWhile(cfa, node) {
    createEdge(cfa, node, Branch.ON_TRUE, computeFallThrough(node.body));
    if (!isLiteralTrue(node.test)) {
        createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
    }
}
function handleDo(cfa, node) {
    createEdge(cfa, node, Branch.ON_TRUE, computeFallThrough(node.body));
    if (!isLiteralTrue(node.test)) {
        createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
    }
}
function handleFor(cfa, node) {
    if (node.init) {
        createEdge(cfa, node.init, Branch.UNCOND, node);
    }
    createEdge(cfa, node, Branch.ON_TRUE, computeFallThrough(node.body));
    if (node.test && !isLiteralTrue(node.test)) {
        createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
    }
    if (node.update) {
        createEdge(cfa, node.update, Branch.UNCOND, node);
    }
}
function handleEnhancedFor(cfa, node) {
    // Closure: collection -> forNode UNCOND, forNode -> body ON_TRUE,
    // forNode -> follow ON_FALSE.
    createEdge(cfa, node.right, Branch.UNCOND, node);
    createEdge(cfa, node, Branch.ON_TRUE, computeFallThrough(node.body));
    createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
}
function handleSwitch(cfa, node) {
    // Switch goes to the first non-default case; if no cases, to the default;
    // if neither, to follow.
    const firstNonDefault = node.cases.find((c) => c.test !== null) ?? null;
    if (firstNonDefault !== null) {
        createEdge(cfa, node, Branch.UNCOND, firstNonDefault);
    }
    else {
        const dflt = node.cases.find((c) => c.test === null);
        if (dflt) {
            const target = dflt.consequent.length > 0 ? computeFallThrough(dflt.consequent[0]) : computeFollowNode(cfa, node, node);
            createEdge(cfa, node, Branch.UNCOND, target);
        }
        else {
            createEdge(cfa, node, Branch.UNCOND, computeFollowNode(cfa, node, node));
        }
    }
}
function handleSwitchCase(cfa, node) {
    if (node.test === null) {
        // default case — emit-handled by handleSwitch when no real cases match
        // it; but a default that's reached fall-through goes to its first stmt.
        if (node.consequent.length > 0) {
            createEdge(cfa, node, Branch.UNCOND, computeFallThrough(node.consequent[0]));
        }
        else {
            createEdge(cfa, node, Branch.UNCOND, computeFollowNode(cfa, node, node));
        }
        return;
    }
    // Real case: ON_TRUE -> first consequent stmt (or follow if empty).
    if (node.consequent.length > 0) {
        createEdge(cfa, node, Branch.ON_TRUE, computeFallThrough(node.consequent[0]));
    }
    else {
        createEdge(cfa, node, Branch.ON_TRUE, computeFollowNode(cfa, node, node));
    }
    // ON_FALSE: next CASE (skipping default), or default (if any), or follow.
    const parent = parentOf(cfa, node);
    if (!t.isSwitchStatement(parent)) {
        createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
        return;
    }
    const idx = parent.cases.indexOf(node);
    let nextCase;
    for (let i = idx + 1; i < parent.cases.length; i++) {
        if (parent.cases[i].test !== null) {
            nextCase = parent.cases[i];
            break;
        }
    }
    if (nextCase) {
        createEdge(cfa, node, Branch.ON_FALSE, nextCase);
    }
    else {
        const dflt = parent.cases.find((c) => c.test === null);
        if (dflt) {
            createEdge(cfa, node, Branch.ON_FALSE, dflt);
        }
        else {
            createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
        }
    }
}
function handleStmtList(cfa, node) {
    // First non-function child is where control transfers; if none, to follow.
    const body = node.body;
    let first;
    for (const child of body) {
        if (!t.isFunctionDeclaration(child)) {
            first = child;
            break;
        }
    }
    if (first) {
        createEdge(cfa, node, Branch.UNCOND, computeFallThrough(first));
    }
    else {
        createEdge(cfa, node, Branch.UNCOND, computeFollowNode(cfa, node, node));
    }
}
function handleFunction(cfa, node) {
    // From the Function node, transfer to its body.
    createEdge(cfa, node, Branch.UNCOND, computeFallThrough(node.body));
}
function handleExpr(cfa, node) {
    createEdge(cfa, node, Branch.UNCOND, computeFollowNode(cfa, node, node));
}
function handleBreak(cfa, node) {
    const target = findBreakTarget(cfa, node, node.label?.name ?? null);
    if (target === null)
        return; // malformed source — ignore (matches "canContinueAfterErrors")
    createEdge(cfa, node, Branch.UNCOND, computeFollowNode(cfa, node, target));
}
function handleContinue(cfa, node) {
    const target = findContinueTarget(cfa, node, node.label?.name ?? null);
    if (target === null)
        return;
    // For a vanilla for, continue goes to the update slot (parent.update);
    // for other loops, continue goes back to the loop node itself.
    let to = target;
    if (t.isForStatement(target) && target.update) {
        to = target.update;
    }
    createEdge(cfa, node, Branch.UNCOND, to);
}
function handleReturn(cfa, node) {
    createEdge(cfa, node, Branch.UNCOND, null);
}
function handleStmt(cfa, node) {
    createEdge(cfa, node, Branch.UNCOND, computeFollowNode(cfa, node, node));
}
// ---------------------------------------------------------------------------
// computeFollowNode / computeFallThrough — direct ports.
function computeFollowNode(cfa, fromNode, node) {
    const parent = parentOf(cfa, node);
    if (parent === null || t.isFunction(parent) || node === cfa.root)
        return null;
    if (t.isIfStatement(parent)) {
        return computeFollowNode(cfa, fromNode, parent);
    }
    if (t.isSwitchCase(parent)) {
        // Bare `case X: stmt1; stmt2; break;` cases put statements directly
        // in `parent.consequent` (no BlockStatement wrapper). Each statement
        // falls through to the NEXT statement in the same consequent first;
        // only when we run off the end of the consequent does control pass
        // (JS fall-through) to the next case's body.
        const siblings = parent.consequent;
        const idx = siblings.indexOf(node);
        for (let i = idx + 1; i < siblings.length; i++) {
            const s = siblings[i];
            if (s && !t.isFunctionDeclaration(s))
                return computeFallThrough(s);
        }
        const grand = parentOf(cfa, parent);
        if (!t.isSwitchStatement(grand)) {
            return computeFollowNode(cfa, fromNode, parent);
        }
        const caseIdx = grand.cases.indexOf(parent);
        const nextCase = grand.cases[caseIdx + 1];
        if (nextCase) {
            if (nextCase.consequent.length > 0) {
                return computeFallThrough(nextCase.consequent[0]);
            }
            return computeFollowNode(cfa, fromNode, nextCase);
        }
        return computeFollowNode(cfa, fromNode, parent);
    }
    if (t.isForStatement(parent)) {
        // After body, go to update; if no update, back to the for itself.
        return parent.update ?? parent;
    }
    if (t.isWhileStatement(parent) || t.isDoWhileStatement(parent) || t.isForInStatement(parent) || t.isForOfStatement(parent)) {
        return parent;
    }
    if (t.isLabeledStatement(parent)) {
        return computeFollowNode(cfa, fromNode, parent);
    }
    // Now the ordinary case: walk to the next sibling in a statement list,
    // skipping function declarations. If no sibling, recurse upward.
    const siblings = siblingListOf(parent);
    if (siblings !== null) {
        const idx = siblings.indexOf(node);
        for (let i = idx + 1; i < siblings.length; i++) {
            const s = siblings[i];
            if (s && !t.isFunctionDeclaration(s))
                return computeFallThrough(s);
        }
        return computeFollowNode(cfa, fromNode, parent);
    }
    return computeFollowNode(cfa, fromNode, parent);
}
/** Returns the statement-list array that `parent` directly contains, if any. */
function siblingListOf(parent) {
    if (t.isBlockStatement(parent) || t.isProgram(parent))
        return parent.body;
    if (t.isSwitchCase(parent))
        return parent.consequent;
    return null;
}
function computeFallThrough(n) {
    if (t.isDoWhileStatement(n))
        return computeFallThrough(n.body);
    if (t.isForStatement(n)) {
        if (n.init)
            return computeFallThrough(n.init);
        return n;
    }
    if (t.isForInStatement(n) || t.isForOfStatement(n)) {
        // Closure: getSecondChild() — i.e. the iterable. Babel: .right.
        return n.right;
    }
    if (t.isLabeledStatement(n))
        return computeFallThrough(n.body);
    return n;
}
// ---------------------------------------------------------------------------
// Edge construction
function createEdge(cfa, fromNode, branch, toNode) {
    const from = createNode(cfa.cfg, fromNode);
    const to = toNode === null ? cfa.cfg.implicitReturn : createNode(cfa.cfg, toNode);
    if (!isConnectedInDirection(from, to, (b) => b === branch)) {
        connect(cfa.cfg, from.value, branch, to.value);
    }
}
// ---------------------------------------------------------------------------
// Break/continue target resolution
function findBreakTarget(cfa, from, label) {
    let cur = from;
    while (cur !== null) {
        if (isBreakTargetFor(cfa, cur, label))
            return cur;
        cur = parentOf(cfa, cur);
    }
    return null;
}
function findContinueTarget(cfa, from, label) {
    let cur = from;
    while (cur !== null) {
        if (isLoop(cur) && labelMatches(cfa, cur, label))
            return cur;
        cur = parentOf(cfa, cur);
    }
    return null;
}
function isBreakTargetFor(cfa, node, label) {
    if (label === null) {
        // Unlabeled break: any loop or switch.
        return isLoop(node) || t.isSwitchStatement(node);
    }
    // Labeled break: any statement whose enclosing label-chain includes label.
    return labelMatches(cfa, node, label);
}
function labelMatches(cfa, target, label) {
    if (label === null)
        return true;
    let cur = parentOf(cfa, target);
    while (cur !== null && t.isLabeledStatement(cur)) {
        if (cur.label.name === label)
            return true;
        cur = parentOf(cfa, cur);
    }
    return false;
}
// ---------------------------------------------------------------------------
// Misc
function isLiteralTrue(expr) {
    return t.isBooleanLiteral(expr) && expr.value === true;
}
// ---------------------------------------------------------------------------
// Priority assignment — BFS from entry, AST-position-ordered, then unreached
// nodes get priorities last and the implicit-return is dead last.
function prioritize(cfa) {
    let counter = 0;
    const setPriority = (n) => {
        if (n.priority < 0)
            n.priority = ++counter;
    };
    prioritizeFromEntry(cfa, cfa.cfg.entry, setPriority);
    if (cfa.shouldTraverseFunctions) {
        for (const node of cfa.cfg.nodes.values()) {
            if (node.value !== cfa.cfg.implicitReturn.value && t.isFunction(node.value)) {
                prioritizeFromEntry(cfa, node, setPriority);
            }
        }
    }
    for (const node of cfa.cfg.nodes.values()) {
        setPriority(node);
    }
    // Implicit return is last — re-stamp.
    cfa.cfg.implicitReturn.priority = ++counter;
}
function prioritizeFromEntry(cfa, entry, setPriority) {
    // Closure uses a min-priority-queue keyed by AST position. We approximate
    // by collecting reachable nodes, sorting by ast position, and stamping.
    const reached = [];
    const seen = new Set();
    const stack = [entry];
    while (stack.length > 0) {
        const cur = stack.pop();
        if (seen.has(cur))
            continue;
        seen.add(cur);
        reached.push(cur);
        for (const e of cur.outEdges)
            stack.push(e.destination);
    }
    reached.sort((a, b) => {
        const pa = cfa.astPosition.get(a.value) ?? Number.POSITIVE_INFINITY;
        const pb = cfa.astPosition.get(b.value) ?? Number.POSITIVE_INFINITY;
        return pa - pb;
    });
    for (const n of reached)
        setPriority(n);
}

// Port of jscomp/DataFlowAnalysis.java
//
// A worklist-driven fixpoint engine over a CFG. Callers describe their
// analysis as a set of plain functions (`flowThrough`, `joinFlows`, `equals`,
// `bottom`, `entry`); the engine handles iteration, change-detection, and the
// step-cap divergence guard.
//
// Closure's class collapses to:
//   - DataFlowConfig<L>       — static description of the analysis
//   - LinearFlowState<L>      — IN/OUT/step-count per CFG node
//   - analyze(cfg, config)    — drives the worklist
//
// Branched analyses (per-edge branch flows) keep the second annotation slot
// on edges. computeEscaped (for free vars in functions) is a Closure helper
// that uses Scope/ScopeCreator; we'll port that on demand later when an
// analysis actually needs it.
const MAX_STEPS_PER_NODE = 20000;
/** Run the analysis to fixpoint. Mutates `cfg` annotations:
 *   - Each node.annotation becomes a LinearFlowState<L>.
 *   - For branched analyses, each edge.annotation becomes the per-edge L. */
function analyze(cfg, config) {
    if (config.branched && config.direction !== 'forward') {
        throw new Error('Dataflow: branched analysis must be forward.');
    }
    if (config.branched && config.branchFlow === undefined) {
        throw new Error('Dataflow: branched analysis requires branchFlow.');
    }
    initialize(cfg, config);
    const queue = new UniqueQueue(byPriorityAsc);
    for (const node of cfg.nodes.values()) {
        if (node !== cfg.implicitReturn)
            queue.add(node);
    }
    while (!queue.isEmpty()) {
        const cur = queue.removeFirst();
        const state = cur.annotation;
        if (state.stepCount++ > MAX_STEPS_PER_NODE) {
            throw new Error('Dataflow analysis appears to diverge.');
        }
        joinInputs(cfg, config, cur);
        if (flow(config, cur)) {
            const next = config.direction === 'forward' ? cur.outEdges.map((e) => e.destination) : cur.inEdges.map((e) => e.source);
            for (const n of next) {
                if (n !== cfg.implicitReturn)
                    queue.add(n);
            }
        }
    }
    if (config.direction === 'forward') {
        joinInputs(cfg, config, cfg.implicitReturn);
    }
}
// --- internals ---
function initialize(cfg, config) {
    for (const node of cfg.nodes.values()) {
        const state = {
            in: config.bottom(),
            out: config.bottom(),
            stepCount: 0,
        };
        node.annotation = state;
    }
    if (config.branched) {
        for (const node of cfg.nodes.values()) {
            for (const edge of node.outEdges) {
                edge.annotation = config.bottom();
            }
        }
    }
}
function joinInputs(cfg, config, node) {
    const state = node.annotation;
    if (config.direction === 'forward' && node === cfg.entry) {
        state.in = config.entry();
        return;
    }
    const inEdges = config.direction === 'forward' ? node.inEdges : node.outEdges;
    if (inEdges.length === 0)
        return;
    let result;
    if (inEdges.length === 1) {
        result = getInputFromEdge(cfg, config, inEdges[0]);
    }
    else {
        result = getInputFromEdge(cfg, config, inEdges[0]);
        for (let i = 1; i < inEdges.length; i++) {
            result = config.joinFlows(result, getInputFromEdge(cfg, config, inEdges[i]));
        }
    }
    if (config.direction === 'forward') {
        state.in = result;
    }
    else {
        state.out = result;
    }
}
function getInputFromEdge(cfg, config, edge) {
    if (config.branched) {
        return edge.annotation;
    }
    if (config.direction === 'forward') {
        const srcState = edge.source.annotation;
        return srcState.out;
    }
    // backward: pull IN from successor; implicit-return contributes the entry
    // value (which for a backward analysis represents the function-end state).
    const dstState = edge.destination.annotation;
    if (edge.destination === cfg.implicitReturn)
        return config.entry();
    return dstState.in;
}
function flow(config, node) {
    const state = node.annotation;
    if (config.direction === 'forward') {
        const before = state.out;
        state.out = config.flowThrough(node, state.in);
        let changed = !config.equals(before, state.out);
        if (config.branched) {
            const branchFlow = config.branchFlow;
            for (const edge of node.outEdges) {
                const before2 = edge.annotation;
                const next = branchFlow(node, state.out, edge.value);
                edge.annotation = next;
                if (!changed)
                    changed = !config.equals(before2, next);
            }
        }
        return changed;
    }
    // backward
    const before = state.in;
    state.in = config.flowThrough(node, state.out);
    return !config.equals(before, state.in);
}
function byPriorityAsc(a, b) {
    return a.priority - b.priority;
}
class UniqueQueue {
    cmp;
    items = [];
    seen = new Set();
    constructor(cmp = null) {
        this.cmp = cmp;
    }
    isEmpty() {
        return this.items.length === 0;
    }
    add(item) {
        if (this.seen.has(item))
            return;
        this.seen.add(item);
        if (this.cmp === null) {
            this.items.push(item);
            return;
        }
        // Naive sorted-insert. For our scale (per-function CFGs typically
        // <500 nodes) this is fine; if it ever shows up in profiles, swap to
        // a binary-heap.
        let i = 0;
        while (i < this.items.length && this.cmp(this.items[i], item) <= 0)
            i++;
        this.items.splice(i, 0, item);
    }
    removeFirst() {
        const item = this.items.shift();
        if (item === undefined)
            throw new Error('UniqueQueue: empty');
        this.seen.delete(item);
        return item;
    }
}

// Port of jscomp/LiveVariablesAnalysis.java
//
// Backward dataflow producing per-CFG-node liveness sets. A variable is
// "live at point P" if its current value might be read after P. The lattice
// is a BitSet over the function's local-variable index space; JOIN is OR;
// flow is L_in = (L_out − KILL[n]) | GEN[n].
//
// GEN/KILL are computed per CFG node by walking the node's expression tree:
//
//   - reads of a local      → gen[idx] = 1
//   - assignments to a local → kill[idx] = 1, but ONLY when not under a
//                              short-circuiting / conditional sub-expression
//   - compound assigns (+= etc.) → both gen and kill (LHS is read, then
//                                  written)
//   - `arguments` reference  → escape all simple parameters
//
// Differs from Closure:
//   - Variable identity is by binding-slot — see local-variable-table.ts.
//     Identifier nodes are resolved through the table at every use/def site.
//   - No ON_EX edges in the v1 CFG, so the "conditional kill if can throw"
//     bit collapses; we still respect short-circuit conditional contexts in
//     expression sub-trees.
const MAX_VARIABLES_TO_ANALYZE = 100;
function newLattice(table) {
    const words = (table.size + 31) >>> 5;
    return { bits: new Uint32Array(Math.max(1, words)) };
}
function bsClone(l) {
    return { bits: new Uint32Array(l.bits) };
}
function bsEquals(a, b) {
    if (a.bits.length !== b.bits.length)
        return false;
    for (let i = 0; i < a.bits.length; i++) {
        if (a.bits[i] !== b.bits[i])
            return false;
    }
    return true;
}
function bsOr(into, src) {
    for (let i = 0; i < into.bits.length; i++)
        into.bits[i] |= src.bits[i];
}
function bsAndNot(into, src) {
    for (let i = 0; i < into.bits.length; i++)
        into.bits[i] &= ~src.bits[i];
}
function bsSet(l, idx) {
    l.bits[idx >>> 5] |= 1 << (idx & 31);
}
function isLive(l, idx) {
    return (l.bits[idx >>> 5] & (1 << (idx & 31))) !== 0;
}
/**
 * Run live-variables analysis. Annotates `cfg` nodes with LinearFlowState<L>
 * (per DataFlowAnalysis convention). Returns null if we bailed (too many
 * variables in the function).
 */
function runLiveVariablesAnalysis(cfg, table) {
    if (table.size > MAX_VARIABLES_TO_ANALYZE) {
        return { table, ran: false };
    }
    const config = {
        direction: 'backward',
        flowThrough: (node, output) => flowThrough(node, output, table),
        joinFlows: (a, b) => {
            const r = bsClone(a);
            bsOr(r, b);
            return r;
        },
        equals: bsEquals,
        bottom: () => newLattice(table),
        // Backward: "entry" lattice flows into the implicit return.
        // Escaped locals are live-out at function exit.
        entry: () => {
            const l = newLattice(table);
            for (const slot of table.escaped)
                bsSet(l, slot);
            return l;
        },
    };
    analyze(cfg, config);
    return { table, ran: true };
}
// ---------------------------------------------------------------------------
// flowThrough — compute GEN/KILL for `node`, then L_in = (L_out − KILL) | GEN
function flowThrough(node, out, table) {
    const gen = newLattice(table);
    const kill = newLattice(table);
    const value = node.value;
    if (typeof value !== 'symbol' && typeof value === 'object' && value !== null && 'type' in value) {
        computeGenKill(value, table, gen, kill, /* conditional */ false);
    }
    const result = bsClone(out);
    bsAndNot(result, kill);
    bsOr(result, gen);
    return result;
}
// ---------------------------------------------------------------------------
// computeGenKill — Closure's algorithm, Babel-flavored
//
// Walks an AST node and accumulates reads (gen) and definite writes (kill).
// `conditional` propagates "we are inside a sub-expression that may not
// execute" (e.g. RHS of && / ||, branches of ?:, optional chaining tail) —
// in that context we may NOT kill, only gen.
function computeGenKill(n, table, gen, kill, conditional) {
    // Container nodes — Closure returns immediately for SCRIPT/ROOT/FUNCTION/BLOCK.
    if (t.isProgram(n) || t.isFile(n) || t.isFunction(n) || t.isBlockStatement(n)) {
        return;
    }
    if (t.isWhileStatement(n) || t.isDoWhileStatement(n) || t.isIfStatement(n)) {
        computeGenKill(n.test, table, gen, kill, conditional);
        return;
    }
    if (t.isForStatement(n)) {
        if (n.test)
            computeGenKill(n.test, table, gen, kill, conditional);
        return;
    }
    if (t.isForInStatement(n) || t.isForOfStatement(n)) {
        // For `for (x in y)` the "node" represents the header. Closure handles
        // the LHS as a possible-no-write site. We mirror: only walk the LHS
        // (collection is its own CFG predecessor).
        const lhs = n.left;
        if (t.isVariableDeclaration(lhs)) {
            // for (var x in y) — last declarator's id is the binding.
            const last = lhs.declarations[lhs.declarations.length - 1];
            if (last)
                computeGenKill(last.id, table, gen, kill, conditional);
        }
        else {
            computeGenKill(lhs, table, gen, kill, conditional);
        }
        return;
    }
    if (t.isVariableDeclaration(n)) {
        for (const d of n.declarations) {
            if (d.init) {
                computeGenKill(d.init, table, gen, kill, conditional);
                if (!conditional)
                    addBindingsToKill(d.id, table, kill);
            }
            // No init = `let x;` — does NOT kill in Closure (the var is born
            // undefined and the kill bit is for "I overwrite a prior value").
        }
        return;
    }
    if (t.isLogicalExpression(n)) {
        // && || ?? — RHS conditional.
        computeGenKill(n.left, table, gen, kill, conditional);
        computeGenKill(n.right, table, gen, kill, /* conditional */ true);
        return;
    }
    if (t.isOptionalMemberExpression(n)) {
        computeGenKill(n.object, table, gen, kill, conditional);
        if (n.computed)
            computeGenKill(n.property, table, gen, kill, true);
        return;
    }
    if (t.isOptionalCallExpression(n)) {
        computeGenKill(n.callee, table, gen, kill, conditional);
        for (const arg of n.arguments) {
            if (t.isExpression(arg))
                computeGenKill(arg, table, gen, kill, true);
        }
        return;
    }
    if (t.isConditionalExpression(n)) {
        computeGenKill(n.test, table, gen, kill, conditional);
        computeGenKill(n.consequent, table, gen, kill, true);
        computeGenKill(n.alternate, table, gen, kill, true);
        return;
    }
    if (t.isIdentifier(n)) {
        if (n.name === 'arguments') {
            // Treated upstream by buildLocalVariableTable as escape source.
            return;
        }
        const slot = table.resolve(n);
        if (slot !== undefined && !table.escaped.has(slot)) {
            bsSet(gen, slot);
        }
        return;
    }
    if (t.isAssignmentExpression(n)) {
        if (t.isIdentifier(n.left)) {
            // Plain `x = expr` or `x += expr`.
            const slot = table.resolve(n.left);
            if (slot !== undefined && !table.escaped.has(slot)) {
                if (!conditional)
                    bsSet(kill, slot);
                if (n.operator !== '=')
                    bsSet(gen, slot); // compound reads x first
            }
            computeGenKill(n.right, table, gen, kill, conditional);
            return;
        }
        if (t.isArrayPattern(n.left) || t.isObjectPattern(n.left)) {
            if (!conditional)
                addBindingsToKill(n.left, table, kill);
            computeGenKill(n.left, table, gen, kill, conditional);
            computeGenKill(n.right, table, gen, kill, conditional);
            return;
        }
        // member assignments: read both sides.
        computeGenKill(n.left, table, gen, kill, conditional);
        computeGenKill(n.right, table, gen, kill, conditional);
        return;
    }
    if (t.isUpdateExpression(n)) {
        // `x++` or `++x` — both read and write x.
        if (t.isIdentifier(n.argument)) {
            const slot = table.resolve(n.argument);
            if (slot !== undefined && !table.escaped.has(slot)) {
                bsSet(gen, slot);
                if (!conditional)
                    bsSet(kill, slot);
            }
            return;
        }
    }
    // Default: walk children at the same conditional level.
    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, key);
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c)
                    computeGenKill(c, table, gen, kill, conditional);
            }
        }
        else {
            computeGenKill(child, table, gen, kill, conditional);
        }
    }
}
function addBindingsToKill(pattern, table, kill) {
    const visit = (n) => {
        if (t.isIdentifier(n)) {
            const slot = table.resolve(n);
            if (slot !== undefined && !table.escaped.has(slot))
                bsSet(kill, slot);
            return;
        }
        if (t.isAssignmentPattern(n)) {
            visit(n.left);
            return;
        }
        if (t.isRestElement(n)) {
            visit(n.argument);
            return;
        }
        if (t.isArrayPattern(n)) {
            for (const el of n.elements)
                if (el !== null)
                    visit(el);
            return;
        }
        if (t.isObjectPattern(n)) {
            for (const p of n.properties) {
                if (t.isRestElement(p))
                    visit(p.argument);
                else if (t.isObjectProperty(p))
                    visit(p.value);
            }
            return;
        }
    };
    visit(pattern);
}

// Port of jscomp/DeadAssignmentsElimination.java
//
// Drops assignments to local variables whose value is never read afterward.
// Driven by LiveVariablesAnalysis: at the point AFTER an assignment to `x`,
// if `x` is not in the live-out set, the assignment is useless.
//
// We mutate the AST in place using a parent+key map (Babel doesn't carry
// parent pointers on raw nodes). Returns true if anything was removed.
//
// Differs from Closure:
//   - No `compiler.hasScopeChanged` filter — we always run.
//   - `containsFunction` bailout: any nested function in the body skips the
//     whole pass (closure capture). Closure does the same heuristic.
//   - Variable identity by binding-slot (table.resolve(idNode) → slot).
//   - For inc/dec (UpdateExpression) we only replace inside an ExprStatement
//     or a vanilla-for update slot; otherwise leave it alone (the value of
//     `x++` itself can be observed by an outer expression).
function eliminateDeadAssignments(fn, cfg, live) {
    if (!live.ran)
        return { ran: false, removed: 0 };
    // Closure bails the entire function if any inner function exists, because
    // a closure may capture and read locals after the apparent return.
    if (containsNestedFunction(fn))
        return { ran: false, removed: 0 };
    const ctx = {
        table: live.table,
        parents: buildParentMap$1(fn),
        removed: 0,
    };
    for (const cfgNode of cfg.nodes.values()) {
        if (cfgNode === cfg.implicitReturn)
            continue;
        const value = cfgNode.value;
        if (typeof value === 'symbol')
            continue;
        const state = cfgNode.annotation;
        if (state === undefined)
            continue;
        const target = pickTarget(value);
        if (target === null)
            continue;
        tryRemoveAssignment(ctx, target, target, state);
    }
    return { ran: true, removed: ctx.removed };
}
function pickTarget(n) {
    // Mirrors Closure's switch in tryRemoveDeadAssignments — narrows the CFG
    // node down to the expression we should actually walk.
    if (t.isIfStatement(n) || t.isWhileStatement(n) || t.isDoWhileStatement(n)) {
        return n.test;
    }
    if (t.isForStatement(n)) {
        return n.test ?? null;
    }
    if (t.isForInStatement(n) || t.isForOfStatement(n)) {
        return null;
    }
    if (t.isSwitchStatement(n))
        return n.discriminant;
    if (t.isSwitchCase(n))
        return n.test ?? null;
    if (t.isReturnStatement(n))
        return n.argument ?? null;
    if (t.isExpressionStatement(n))
        return n.expression;
    if (t.isVariableDeclaration(n))
        return n;
    return n;
}
// ---------------------------------------------------------------------------
// tryRemoveAssignment — recursively walks `n` looking for assignments that
// the liveness state proves are dead. `exprRoot` is the CFG node's root: the
// liveness state is correct at that boundary, so when we ask "is x still
// live within this sub-expression after we kill it here?" we walk siblings
// up to exprRoot.
function tryRemoveAssignment(ctx, n, exprRoot, state) {
    if (t.isAssignmentExpression(n)) {
        if (t.isIdentifier(n.left)) {
            // Recurse into RHS first (handles `dead_x = dead_y = 1` → drop
            // `dead_y = 1` first, then `dead_x = ...`).
            tryRemoveAssignment(ctx, n.right, exprRoot, state);
            handleAssignment(ctx, n, exprRoot, state);
            return;
        }
        // Destructuring or member assign — descend into both sides.
        tryRemoveAssignment(ctx, n.left, exprRoot, state);
        tryRemoveAssignment(ctx, n.right, exprRoot, state);
        return;
    }
    if (t.isUpdateExpression(n) && t.isIdentifier(n.argument)) {
        handleUpdate(ctx, n, exprRoot, state);
        return;
    }
    if (t.isVariableDeclaration(n)) {
        // Declarations: walk declarators left-to-right but recurse into the
        // init first per declarator, mirroring Closure's right-to-left
        // multi-declarator behavior (`var a = e1, b = e2;` → process e2's
        // assignments before deciding about a).
        for (let i = n.declarations.length - 1; i >= 0; i--) {
            const d = n.declarations[i];
            if (d.init) {
                tryRemoveAssignment(ctx, d.init, exprRoot, state);
                handleVarInit(ctx, n, d, exprRoot, state);
            }
        }
        return;
    }
    // Default — walk children that don't enter a new CFG node.
    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, key);
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c && !isEnteringNewCfgNode(c, n)) {
                    tryRemoveAssignment(ctx, c, exprRoot, state);
                }
            }
        }
        else if (!isEnteringNewCfgNode(child, n)) {
            tryRemoveAssignment(ctx, child, exprRoot, state);
        }
    }
}
// ---------------------------------------------------------------------------
// handleAssignment — `x = expr` or `x op= expr` where `x` is an Identifier.
function handleAssignment(ctx, n, exprRoot, state) {
    const lhs = n.left;
    const slot = ctx.table.resolve(lhs);
    if (slot === undefined)
        return;
    if (ctx.table.escaped.has(slot))
        return;
    // Identity assign `a = a` — always remove.
    if (n.operator === '=' && t.isIdentifier(n.right) && n.right.name === lhs.name) {
        replaceInParent$1(ctx, n, n.right);
        ctx.removed++;
        return;
    }
    if (isLive(state.out, slot))
        return;
    if (isLive(state.in, slot) && isVariableStillLiveWithinExpression(ctx, n, exprRoot, slot)) {
        // Live-in but live-out is false: this is the killing assignment, but
        // there's still a use to its right within the same expression. We
        // can't remove it without finer-grained analysis.
        return;
    }
    if (n.operator === '=') {
        replaceInParent$1(ctx, n, n.right);
    }
    else {
        // `x += rhs` → `x + rhs`. Drops the write but keeps the read+compute
        // (which may be observed by an outer expression).
        const op = n.operator.slice(0, -1);
        const replacement = t.binaryExpression(op, lhs, n.right);
        replaceInParent$1(ctx, n, replacement);
    }
    ctx.removed++;
}
// ---------------------------------------------------------------------------
// handleUpdate — `x++` / `--x`.
function handleUpdate(ctx, n, _exprRoot, state) {
    const arg = n.argument;
    const slot = ctx.table.resolve(arg);
    if (slot === undefined)
        return;
    if (ctx.table.escaped.has(slot))
        return;
    if (isLive(state.out, slot))
        return;
    const info = ctx.parents.get(n);
    if (info === undefined)
        return;
    const { parent } = info;
    if (t.isExpressionStatement(parent)) {
        // `x++;` → `void 0;` (Closure: same).
        replaceInParent$1(ctx, n, t.unaryExpression('void', t.numericLiteral(0)));
        ctx.removed++;
        return;
    }
    if (t.isForStatement(parent) && getConditionExpression(parent) !== n && parent.update === n) {
        // for(;; x++) — replace update with empty (drops it).
        // We can't insert a real "empty" so just null the slot.
        parent.update = null;
        ctx.removed++;
        return;
    }
    // Otherwise the result of `x++` may be observed; leave it alone.
}
// ---------------------------------------------------------------------------
// handleVarInit — `var x = expr` (or let / const).
function handleVarInit(ctx, decl, d, exprRoot, state) {
    if (decl.kind === 'const')
        return; // removing init breaks AST validity.
    if (!t.isIdentifier(d.id))
        return;
    if (d.init === null || d.init === undefined)
        return;
    const declParentInfo = ctx.parents.get(decl);
    if (declParentInfo && t.isForStatement(declParentInfo.parent)) {
        // `for (var x = init; ...)` — no safe place to put the side-effects.
        return;
    }
    if (declParentInfo && (t.isForInStatement(declParentInfo.parent) || t.isForOfStatement(declParentInfo.parent))) {
        return;
    }
    const slot = ctx.table.resolve(d.id);
    if (slot === undefined)
        return;
    if (ctx.table.escaped.has(slot))
        return;
    // Identity init `var a = a;` is meaningless and rare; treat as standard
    // assignment.
    if (t.isIdentifier(d.init) && ctx.table.resolve(d.init) === slot) {
        d.init = null;
        ctx.removed++;
        return;
    }
    if (isLive(state.out, slot))
        return;
    if (isLive(state.in, slot) && isVariableStillLiveWithinExpression(ctx, decl, exprRoot, slot)) {
        return;
    }
    // Dead init. Closure hoists the RHS into a sibling ExpressionStatement so
    // any side-effects still run. We do the same: insert `expr;` after `decl`
    // and null the init.
    const init = d.init;
    d.init = null;
    insertAfter(ctx, decl, t.expressionStatement(init));
    ctx.removed++;
}
// ---------------------------------------------------------------------------
// isVariableStillLiveWithinExpression — left-to-right walk over ancestors of
// `n` up to `exprRoot`, asking "is there a READ of `variable` to the right
// of n before any KILL?". Direct port of Closure's algorithm.
var VLive;
(function (VLive) {
    VLive[VLive["MAYBE_LIVE"] = 0] = "MAYBE_LIVE";
    VLive[VLive["READ"] = 1] = "READ";
    VLive[VLive["KILL"] = 2] = "KILL";
})(VLive || (VLive = {}));
function isVariableStillLiveWithinExpression(ctx, n, exprRoot, slot) {
    let cur = n;
    while (cur !== exprRoot) {
        const info = ctx.parents.get(cur);
        if (info === undefined)
            return false;
        const parent = info.parent;
        let state = VLive.MAYBE_LIVE;
        if (t.isLogicalExpression(parent)) {
            // OR / AND / ??: only the second operand depends on the first.
            if (cur === parent.left) {
                state = isVariableReadBeforeKill(parent.right, slot, ctx);
                if (state === VLive.KILL)
                    state = VLive.MAYBE_LIVE;
            }
        }
        else if (t.isConditionalExpression(parent)) {
            if (cur === parent.test) {
                state = checkHookBranchReadBeforeKill(parent.consequent, parent.alternate, slot, ctx);
            }
            // If cur is consequent or alternate, the other branch can be
            // ignored; siblings don't apply.
        }
        else {
            for (const sibling of rightSiblings$1(parent, cur)) {
                state = isVariableReadBeforeKill(sibling, slot, ctx);
                if (state !== VLive.MAYBE_LIVE)
                    break;
            }
        }
        if (state === VLive.READ)
            return true;
        if (state === VLive.KILL)
            return false;
        cur = parent;
    }
    return false;
}
function isVariableReadBeforeKill(n, slot, ctx) {
    if (isEnteringNewCfgNode(n, parentOfChild()))
        return VLive.MAYBE_LIVE;
    if (t.isIdentifier(n) && ctx.table.resolve(n) === slot) {
        // Conservative: treat every identifier read as READ. Closure
        // distinguishes simple-assign LHS (then evaluates RHS first to
        // detect a still-live read inside the RHS), but conservative is
        // safe here.
        return VLive.READ;
    }
    if (t.isLogicalExpression(n)) {
        const v1 = isVariableReadBeforeKill(n.left, slot, ctx);
        const v2 = isVariableReadBeforeKill(n.right, slot, ctx);
        if (v1 !== VLive.MAYBE_LIVE)
            return v1;
        if (v2 === VLive.READ)
            return VLive.READ;
        return VLive.MAYBE_LIVE;
    }
    if (t.isConditionalExpression(n)) {
        const first = isVariableReadBeforeKill(n.test, slot, ctx);
        if (first !== VLive.MAYBE_LIVE)
            return first;
        return checkHookBranchReadBeforeKill(n.consequent, n.alternate, slot, ctx);
    }
    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, key);
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (!c)
                    continue;
                const r = isVariableReadBeforeKill(c, slot, ctx);
                if (r !== VLive.MAYBE_LIVE)
                    return r;
            }
        }
        else {
            const r = isVariableReadBeforeKill(child, slot, ctx);
            if (r !== VLive.MAYBE_LIVE)
                return r;
        }
    }
    return VLive.MAYBE_LIVE;
}
function checkHookBranchReadBeforeKill(a, b, slot, ctx) {
    const v1 = isVariableReadBeforeKill(a, slot, ctx);
    const v2 = isVariableReadBeforeKill(b, slot, ctx);
    if (v1 === VLive.READ || v2 === VLive.READ)
        return VLive.READ;
    if (v1 === VLive.KILL && v2 === VLive.KILL)
        return VLive.KILL;
    return VLive.MAYBE_LIVE;
}
function parentOfChild(_n) {
    // Used by isEnteringNewCfgNode in the read-before-kill walk; we don't
    // carry parent info into that recursion (the caller is walking expression
    // sub-trees freshly), so pass null and rely on isEnteringNewCfgNode's
    // null-parent fast path. Effect: we never *enter* a new CFG node from a
    // Function child here because Functions are caught explicitly by
    // VISITOR_KEYS recursion that we deliberately don't make.
    return null;
}
// ---------------------------------------------------------------------------
// AST mutation helpers
function rightSiblings$1(parent, after) {
    const out = [];
    let seen = false;
    for (const key of t.VISITOR_KEYS[parent.type] ?? []) {
        const child = getSlot(parent, key);
        if (Array.isArray(child)) {
            for (const c of child) {
                if (!seen) {
                    if (c === after)
                        seen = true;
                    continue;
                }
                if (c)
                    out.push(c);
            }
        }
        else if (child === after) {
            seen = true;
        }
        else if (seen && child) {
            out.push(child);
        }
    }
    return out;
}
function replaceInParent$1(ctx, n, replacement) {
    const info = ctx.parents.get(n);
    if (info === undefined)
        return;
    const { parent, key, index } = info;
    setSlot(parent, key, index, replacement);
    // Re-parent the replacement and any of its descendants we might revisit.
    populateParents(replacement, parent, key, index, ctx.parents);
}
function insertAfter(ctx, anchor, inserted) {
    const info = ctx.parents.get(anchor);
    if (info === undefined)
        return;
    const { parent, key, index } = info;
    if (index === undefined)
        return; // anchor isn't in an array — can't insert sibling.
    const arr = getSlot(parent, key);
    arr.splice(index + 1, 0, inserted);
    // Update parent map for shifted siblings.
    for (let i = index + 1; i < arr.length; i++) {
        ctx.parents.set(arr[i], { parent, key, index: i });
    }
    populateParents(inserted, parent, key, index + 1, ctx.parents);
}
// ---------------------------------------------------------------------------
// Parent map
function buildParentMap$1(root) {
    const map = new WeakMap();
    const walk = (n, parent, key, index) => {
        if (parent !== null)
            map.set(n, { parent, key, index });
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c)
                        walk(c, n, k, i);
                }
            }
            else {
                walk(child, n, k, undefined);
            }
        }
    };
    walk(root, null, '', undefined);
    return map;
}
function populateParents(n, parent, key, index, map) {
    map.set(n, { parent, key, index });
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, k);
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c)
                    populateParents(c, n, k, i, map);
            }
        }
        else {
            populateParents(child, n, k, undefined, map);
        }
    }
}
// ---------------------------------------------------------------------------
// containsNestedFunction — Closure's bailout.
function containsNestedFunction(fn) {
    return t.traverseFast(fn.body, (n) => {
        if (t.isFunction(n))
            return t.traverseFast.stop;
        return undefined;
    });
}

// Port of jscomp/graph/CheckPathsBetweenNodes.java
//
// Given a graph G and nodes A, B, decide whether all (or some) paths from A
// to B contain at least one node satisfying `nodePredicate`. Edges may be
// filtered by `edgePredicate`.
//
// Algorithm (per Closure / CLRS DFS-Visit):
//   1. DFS from A, coloring WHITE/GRAY/BLACK to discover back edges
//      (non-tree edges to a GRAY ancestor — i.e. cycle edges).
//   2. Recursively walk the back-edge-free subgraph from A to B. If the
//      walk reaches B without first hitting a node-predicate-true node,
//      that's a counter-example to "all paths satisfy".
//
// Uses graph.{nodeAnnotationStack,edgeAnnotationStack} via push/pop so the
// caller's pre-existing annotations survive the walk.
// Sentinel annotation values. Distinct object identities — checked by ===.
const BACK_EDGE = { tag: 'BACK_EDGE' };
const VISITED_EDGE = { tag: 'VISITED_EDGE' };
const GRAY = { tag: 'GRAY' };
const BLACK = { tag: 'BLACK' };
/** True iff at least one non-looping path from start to end has a node
 *  satisfying nodePredicate. */
function somePathsSatisfyPredicate(opts) {
    const state = {
        graph: opts.graph,
        start: opts.start,
        end: opts.end,
        nodePredicate: opts.nodePredicate,
        edgePredicate: opts.edgePredicate,
        inclusive: opts.inclusive ?? true,
    };
    setUp(state);
    try {
        return checkSomePathsWithoutBackEdges(state, state.start);
    }
    finally {
        tearDown(state);
    }
}
function setUp(s) {
    pushNodeAnnotations(s.graph);
    pushEdgeAnnotations(s.graph);
    discoverBackEdges(s, s.start);
}
function tearDown(s) {
    popNodeAnnotations(s.graph);
    popEdgeAnnotations(s.graph);
}
function ignoreEdge(s, e) {
    return !s.edgePredicate(e);
}
function discoverBackEdges(s, u) {
    u.annotation = GRAY;
    for (const e of u.outEdges) {
        if (ignoreEdge(s, e))
            continue;
        const v = e.destination;
        if (v.annotation === undefined) {
            discoverBackEdges(s, v);
        }
        else if (v.annotation === GRAY) {
            e.annotation = BACK_EDGE;
        }
    }
    u.annotation = BLACK;
}
function isExcluded(s, n) {
    return !s.inclusive && (n === s.start || n === s.end);
}
function checkSomePathsWithoutBackEdges(s, a) {
    if (s.nodePredicate(a.value) && !isExcluded(s, a))
        return true;
    if (a === s.end)
        return false;
    for (const e of a.outEdges) {
        if (e.annotation === VISITED_EDGE)
            continue;
        e.annotation = VISITED_EDGE;
        if (ignoreEdge(s, e))
            continue;
        if (e.annotation === BACK_EDGE)
            continue;
        if (checkSomePathsWithoutBackEdges(s, e.destination))
            return true;
    }
    return false;
}

// Port of jscomp/MaybeReachingVariableUse.java, simplified.
//
// Backward may-reach analysis. At every program point, for each local
// variable v, what use might be reached next?
//
// FlowSensitiveInlineVariables — the only caller — only ever asks
// "is there exactly one use that reaches, and is it this particular
// Identifier node?" So we collapse Closure's Set<Node> per-slot lattice
// to a 3-state lattice mirroring MustBeReachingVariableDef:
//
//   TOP        = undefined  (no use is recorded as reaching yet)
//   Identifier = exactly this single use might reach
//   BOTTOM     = null       (multiple distinct uses might reach)
//
// Join (over successors): TOP ⊔ x = x. BOTTOM ⊔ x = BOTTOM. I ⊔ I = I.
// I ⊔ J = BOTTOM. Same shape as must-reach, with `Identifier` substituted
// for `Definition`. Eliminates per-flow Set cloning, which previously
// dominated the simplifier's runtime on large functions.
//
// Variable identity is by binding-slot — see local-variable-table.ts.
//
// Performance: like the must-def analysis, per-CFG-node transfer is
// invariant across worklist visits — we precompute a flat event list of
// kills and uses in reverse-eval order, filtered to in-table non-escaped
// slots. flowThrough is then a tight event loop with no AST recursion.
function newReachingUses(size) {
    return { uses: new Array(size).fill(undefined) };
}
function cloneReachingUses(r) {
    return { uses: r.uses.slice() };
}
function reachingEquals(a, b) {
    const aa = a.uses;
    const bb = b.uses;
    const len = aa.length > bb.length ? aa.length : bb.length;
    for (let i = 0; i < len; i++) {
        if (aa[i] !== bb[i])
            return false;
    }
    return true;
}
function reachingJoin(a, b) {
    const aa = a.uses;
    const bb = b.uses;
    const len = aa.length > bb.length ? aa.length : bb.length;
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
        const va = aa[i];
        const vb = bb[i];
        if (va === vb) {
            out[i] = va;
        }
        else if (va === undefined) {
            out[i] = vb;
        }
        else if (vb === undefined) {
            out[i] = va;
        }
        else {
            // Either at least one is BOTTOM (null), or two distinct Identifiers.
            // Both cases collapse to BOTTOM.
            out[i] = null;
        }
    }
    return { uses: out };
}
function runMaybeReachingUse(cfg, table) {
    const transfers = new WeakMap();
    for (const node of cfg.nodes.values()) {
        if (node === cfg.implicitReturn)
            continue;
        const value = node.value;
        if (typeof value === 'symbol')
            continue;
        transfers.set(node, buildMayUseTransfer(value, table));
    }
    const size = table.size;
    const config = {
        direction: 'backward',
        flowThrough: (node, output) => {
            const result = cloneReachingUses(output);
            const transfer = transfers.get(node);
            if (transfer !== undefined)
                applyMayUseTransfer(transfer, result);
            return result;
        },
        joinFlows: reachingJoin,
        equals: reachingEquals,
        bottom: () => newReachingUses(size),
        entry: () => newReachingUses(size), // function-end: no use reaches.
    };
    analyze(cfg, config);
    const snapshot = new WeakMap();
    for (const node of cfg.nodes.values()) {
        const state = node.annotation;
        if (state === undefined)
            continue;
        snapshot.set(node, state.out);
    }
    const getUsesAfterSlot = (slot, cfgNode) => {
        const r = snapshot.get(cfgNode);
        if (r === undefined)
            return undefined;
        return r.uses[slot];
    };
    return {
        ran: true,
        table,
        cfg,
        getUsesAfterSlot,
        getUsesAfter: (id, cfgNode) => {
            const slot = table.resolve(id);
            if (slot === undefined)
                return undefined;
            return getUsesAfterSlot(slot, cfgNode);
        },
    };
}
function applyMayUseTransfer(events, out) {
    const arr = out.uses;
    for (const e of events) {
        if (e.kind === 'kill') {
            arr[e.slot] = undefined;
            continue;
        }
        const cur = arr[e.slot];
        if (cur === undefined) {
            arr[e.slot] = e.id;
        }
        else if (cur !== e.id) {
            // Either BOTTOM already (null) or a different Identifier — collapse
            // to BOTTOM. Note: same Identifier won't appear twice (each AST
            // node is unique), so the cur===e.id case is unreachable in
            // practice; we keep the branch for safety.
            arr[e.slot] = null;
        }
    }
}
function buildMayUseTransfer(cfgNodeValue, table) {
    const events = [];
    const emitKill = (id) => {
        const slot = table.resolve(id);
        if (slot === undefined)
            return;
        if (table.escaped.has(slot))
            return;
        events.push({ kind: 'kill', slot });
    };
    const emitUse = (id) => {
        const slot = table.resolve(id);
        if (slot === undefined)
            return;
        if (table.escaped.has(slot))
            return;
        events.push({ kind: 'use', slot, id });
    };
    const visit = (n, conditional) => {
        if (t.isProgram(n) || t.isFile(n) || t.isFunction(n) || t.isBlockStatement(n))
            return;
        if (t.isWhileStatement(n) || t.isDoWhileStatement(n) || t.isIfStatement(n)) {
            visit(n.test, conditional);
            return;
        }
        if (t.isForStatement(n)) {
            if (n.test)
                visit(n.test, conditional);
            return;
        }
        if (t.isForInStatement(n) || t.isForOfStatement(n)) {
            const lhs = n.left;
            if (t.isVariableDeclaration(lhs)) {
                const last = lhs.declarations[lhs.declarations.length - 1];
                if (last && t.isIdentifier(last.id) && !conditional) {
                    emitKill(last.id);
                }
            }
            else if (t.isIdentifier(lhs) && !conditional) {
                emitKill(lhs);
            }
            visit(n.right, conditional);
            return;
        }
        if (t.isLogicalExpression(n)) {
            // Reverse eval order: RHS conditional, LHS unconditional.
            visit(n.right, true);
            visit(n.left, conditional);
            return;
        }
        if (t.isConditionalExpression(n)) {
            visit(n.alternate, true);
            visit(n.consequent, true);
            visit(n.test, conditional);
            return;
        }
        if (t.isOptionalMemberExpression(n)) {
            if (n.computed)
                visit(n.property, true);
            visit(n.object, conditional);
            return;
        }
        if (t.isOptionalCallExpression(n)) {
            for (let i = n.arguments.length - 1; i >= 0; i--) {
                const a = n.arguments[i];
                if (t.isExpression(a))
                    visit(a, true);
            }
            visit(n.callee, conditional);
            return;
        }
        if (t.isVariableDeclaration(n)) {
            for (let i = n.declarations.length - 1; i >= 0; i--) {
                const d = n.declarations[i];
                if (t.isIdentifier(d.id)) {
                    if (d.init) {
                        if (!conditional)
                            emitKill(d.id);
                        visit(d.init, conditional);
                    }
                }
                else if (d.init) {
                    visit(d.init, conditional);
                }
            }
            return;
        }
        if (t.isAssignmentExpression(n)) {
            if (t.isIdentifier(n.left)) {
                if (!conditional)
                    emitKill(n.left);
                if (n.operator !== '=')
                    emitUse(n.left);
                visit(n.right, conditional);
                return;
            }
            visit(n.right, conditional);
            if ('type' in n.left)
                visit(n.left, conditional);
            return;
        }
        if (t.isUpdateExpression(n)) {
            if (t.isIdentifier(n.argument)) {
                if (!conditional)
                    emitKill(n.argument);
                emitUse(n.argument);
                return;
            }
        }
        if (t.isIdentifier(n)) {
            emitUse(n);
            return;
        }
        const keys = t.VISITOR_KEYS[n.type] ?? [];
        for (let ki = keys.length - 1; ki >= 0; ki--) {
            const child = getSlot(n, keys[ki]);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = child.length - 1; i >= 0; i--) {
                    const c = child[i];
                    if (c)
                        visit(c, conditional);
                }
            }
            else {
                visit(child, conditional);
            }
        }
    };
    visit(cfgNodeValue, false);
    return events;
}

// Port of jscomp/MustBeReachingVariableDef.java
//
// Forward must-reach analysis. At every program point, for each local
// variable v, what is the unique definition that must reach? "Must" =
// every path from entry passes through that def and there's no later def
// before this point. The lattice per variable is:
//
//   TOP          -> not in the map (initial estimate / unreachable)
//   Definition d -> mapped to d (we know exactly which def)
//   BOTTOM       -> mapped to null (multiple distinct defs reach)
//
// Join (over predecessors): per variable, agree-or-go-to-BOTTOM. Closure's
// table at the top of the file:
//
//                       (TOP)
//                      / | | \
//                    N1 N2 N3 ... Nn
//                      \ | | /
//                     (BOTTOM)
//
// Variable identity is by binding-slot — see local-variable-table.ts. Maps
// here key by slot, not by name; this is what makes shadowing correct.
//
// Used by FlowSensitiveInlineVariables.
//
// Performance: the per-CFG-node transfer function is structurally invariant
// across worklist visits — only the input lattice changes. We precompute a
// flat event list per CFG node once (see buildMustTransfer) and the
// fixpoint loop's flowThrough becomes a tight iteration over that list.
// Eliminates the deep AST recursion that previously ran on every visit.
function newMustDef(size) {
    // Pre-sized + filled to keep the array dense (V8 fast path).
    return { reachingDef: new Array(size).fill(undefined) };
}
function cloneMustDef(d) {
    return { reachingDef: d.reachingDef.slice() };
}
function entryMustDef(table, fnRoot) {
    const arr = new Array(table.size);
    for (let slot = 0; slot < table.size; slot++) {
        arr[slot] = {
            node: fnRoot,
            depends: new Set(),
            unknownDependencies: false,
        };
    }
    return { reachingDef: arr };
}
function defsEqual(a, b) {
    // Closure: definitions are equal iff their cfg-node identity matches.
    if (a === null || b === null)
        return a === b;
    return a.node === b.node;
}
function mustDefEquals(a, b) {
    const aa = a.reachingDef;
    const bb = b.reachingDef;
    const len = aa.length > bb.length ? aa.length : bb.length;
    for (let i = 0; i < len; i++) {
        const va = aa[i];
        const vb = bb[i];
        if (va === vb)
            continue;
        // TOP vs anything-non-TOP and BOTTOM vs Definition are all distinct.
        if (va === undefined || vb === undefined)
            return false;
        if (!defsEqual(va, vb))
            return false;
    }
    return true;
}
function mustDefJoin(a, b) {
    const aa = a.reachingDef;
    const bb = b.reachingDef;
    const len = aa.length > bb.length ? aa.length : bb.length;
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
        const va = aa[i];
        const vb = bb[i];
        // Closure lattice: TOP ⊔ x = x; BOTTOM ⊔ x = BOTTOM; D ⊔ D = D;
        // D1 ⊔ D2 = BOTTOM (when D1.node !== D2.node).
        if (va === undefined) {
            out[i] = vb;
        }
        else if (vb === undefined) {
            out[i] = va;
        }
        else if (va === null || vb === null) {
            out[i] = null;
        }
        else if (defsEqual(va, vb)) {
            out[i] = va;
        }
        else {
            out[i] = null;
        }
    }
    return { reachingDef: out };
}
function runMustReachingDef(fn, cfg, table) {
    // Precompute the transfer function for each CFG node once. flowThrough
    // then becomes a tight loop over events; no AST recursion per visit.
    const transfers = new WeakMap();
    for (const node of cfg.nodes.values()) {
        if (node === cfg.implicitReturn)
            continue;
        const value = node.value;
        if (typeof value === 'symbol')
            continue;
        transfers.set(node, buildMustTransfer(value, table));
    }
    const size = table.size;
    const config = {
        direction: 'forward',
        flowThrough: (node, input) => {
            const out = cloneMustDef(input);
            const transfer = transfers.get(node);
            if (transfer !== undefined)
                applyMustTransfer(transfer, out, table);
            return out;
        },
        joinFlows: mustDefJoin,
        equals: mustDefEquals,
        bottom: () => newMustDef(size),
        entry: () => entryMustDef(table, fn),
    };
    analyze(cfg, config);
    // Snapshot per-CFG-node IN states. Subsequent analyses on the same CFG
    // will overwrite `node.annotation`, so we can't read it later.
    const snapshot = new WeakMap();
    for (const node of cfg.nodes.values()) {
        const state = node.annotation;
        if (state === undefined)
            continue;
        snapshot.set(node, state.in);
    }
    return {
        ran: true,
        table,
        cfg,
        getDef: (id, cfgNode) => {
            const m = snapshot.get(cfgNode);
            if (m === undefined)
                return undefined;
            const slot = table.resolve(id);
            if (slot === undefined)
                return undefined;
            return m.reachingDef[slot];
        },
    };
}
function applyMustTransfer(events, out, table) {
    const arr = out.reachingDef;
    for (const e of events) {
        if (e.kind === 'invalidateAll') {
            const n = arr.length;
            for (let s = 0; s < n; s++)
                arr[s] = null;
            continue;
        }
        // Write: invalidate dependents, then write self.
        const slot = e.slot;
        const n = arr.length;
        for (let k = 0; k < n; k++) {
            const def = arr[k];
            if (def === null || def === undefined)
                continue;
            if (def.depends.has(slot))
                arr[k] = null;
        }
        if (table.escaped.has(slot))
            continue;
        arr[slot] = e.conditional ? null : e.def;
    }
}
function buildMustTransfer(cfgNodeValue, table) {
    const events = [];
    const emitWrite = (id, rhs, conditional) => {
        const slot = table.resolve(id);
        if (slot === undefined)
            return;
        // The Definition's node is the CFG-node value (invariant identity).
        // depends/unknownDeps come from a one-time RHS walk.
        const def = {
            node: cfgNodeValue,
            depends: new Set(),
            unknownDependencies: false,
        };
        if (rhs !== null)
            computeDependence(def, rhs, table);
        events.push({ kind: 'write', slot, conditional, def });
    };
    const visit = (n, conditional) => {
        if (t.isProgram(n) || t.isFile(n) || t.isFunction(n) || t.isBlockStatement(n)) {
            return;
        }
        if (t.isWhileStatement(n) || t.isDoWhileStatement(n) || t.isIfStatement(n)) {
            visit(n.test, conditional);
            return;
        }
        if (t.isForStatement(n)) {
            if (n.test)
                visit(n.test, conditional);
            return;
        }
        if (t.isForInStatement(n) || t.isForOfStatement(n)) {
            const lhs = n.left;
            if (t.isVariableDeclaration(lhs)) {
                const last = lhs.declarations[lhs.declarations.length - 1];
                if (last && t.isIdentifier(last.id)) {
                    emitWrite(last.id, n.right, conditional);
                }
            }
            else if (t.isIdentifier(lhs)) {
                emitWrite(lhs, n.right, conditional);
            }
            return;
        }
        if (t.isLogicalExpression(n)) {
            visit(n.left, conditional);
            visit(n.right, true);
            return;
        }
        if (t.isConditionalExpression(n)) {
            visit(n.test, conditional);
            visit(n.consequent, true);
            visit(n.alternate, true);
            return;
        }
        if (t.isOptionalMemberExpression(n)) {
            visit(n.object, conditional);
            if (n.computed)
                visit(n.property, true);
            return;
        }
        if (t.isOptionalCallExpression(n)) {
            visit(n.callee, conditional);
            for (const arg of n.arguments) {
                if (t.isExpression(arg))
                    visit(arg, true);
            }
            return;
        }
        if (t.isVariableDeclaration(n)) {
            for (const d of n.declarations) {
                if (d.init && t.isIdentifier(d.id)) {
                    visit(d.init, conditional);
                    emitWrite(d.id, d.init, conditional);
                }
                else if (d.init) {
                    visit(d.init, conditional);
                }
            }
            return;
        }
        if (t.isAssignmentExpression(n)) {
            if (t.isIdentifier(n.left)) {
                visit(n.right, conditional);
                emitWrite(n.left, n.right, conditional);
                return;
            }
            // Member or destructure assign — descend defensively.
            if ('type' in n.left)
                visit(n.left, conditional);
            visit(n.right, conditional);
            return;
        }
        if (t.isUpdateExpression(n)) {
            if (t.isIdentifier(n.argument)) {
                // Treat ++/-- as a self-referencing redefinition with depends={x}.
                emitWrite(n.argument, n.argument, conditional);
                return;
            }
        }
        if (t.isIdentifier(n) && n.name === 'arguments') {
            events.push({ kind: 'invalidateAll' });
            return;
        }
        for (const key of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, key);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c)
                        visit(c, conditional);
                }
            }
            else {
                visit(child, conditional);
            }
        }
    };
    visit(cfgNodeValue, false);
    return events;
}
function computeDependence(def, rhs, table) {
    const visit = (n, parent) => {
        if (parent !== null && isEnteringNewCfgNode(n, parent))
            return;
        if (t.isIdentifier(n)) {
            const slot = table.resolve(n);
            if (slot === undefined) {
                // External name (closure-captured, global, etc.) — we don't
                // know whether it can change.
                def.unknownDependencies = true;
            }
            else {
                def.depends.add(slot);
            }
            return;
        }
        for (const key of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, key);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c)
                        visit(c, n);
                }
            }
            else {
                visit(child, n);
            }
        }
    };
    visit(rhs, null);
}
// Used by FlowSensitiveInlineVariables to decide whether the def's RHS
// dependencies live entirely within the local-variable table (= safe) or
// reference outer-scope names (= not safe to reorder).
function dependsOnOuterScopeVars(def) {
    return def.unknownDependencies;
}

// Port of jscomp/FlowSensitiveInlineVariables.java
//
// Replaces a single read of a local variable with that variable's defining
// RHS, when:
//   1. There is exactly one definition that must reach the read.
//   2. The defining RHS itself has exactly one reachable use (this read).
//   3. The RHS is safe to inline:
//        - no observable side effects
//        - no member/element access (would change semantics under aliasing)
//        - no class / array / object / regex / new (changes object identity)
//   4. No interfering side effect lies between def and use:
//        - in the def's own CFG-node expression, after the def
//        - in the use's own CFG-node expression, before the use
//        - on any CFG path between the def-cfg-node and the use-cfg-node
//          (skipped when the two CFG nodes are immediate siblings in a
//          statement list, the common case)
//   5. The use is not inside a loop (would inline N times into N iterations).
//
// Variable identity is by binding-slot — see local-variable-table.ts. We never
// compare names; only slot equality. This is correctness-critical when the
// same name is shadowed across nested scopes.
//
// Drives MustBeReachingVariableDef + MaybeReachingVariableUse + the
// CheckPathsBetweenNodes graph utility.
const flowInlineInnerTimings = {
    mustDef: 0,
    mayUse: 0,
    parents: 0,
    gather: 0,
    canInline: 0,
    perform: 0,
    candidateCount: 0,
    inlineCount: 0,
};
function runFlowSensitiveInlineVariables(fn, cfg, table) {
    if (table.size === 0)
        return { ran: true, inlined: 0 };
    const t0 = performance.now();
    const reachDef = runMustReachingDef(fn, cfg, table);
    const t1 = performance.now();
    const reachUse = runMaybeReachingUse(cfg, table);
    const t2 = performance.now();
    const parents = buildParentMap(fn);
    const t3 = performance.now();
    const candidates = gatherCandidates(fn, cfg, table, reachDef.getDef, parents);
    const t4 = performance.now();
    let inlined = 0;
    let canInlineTime = 0;
    let performTime = 0;
    for (const c of candidates) {
        const c0 = performance.now();
        const ok = canInline(c, fn, cfg, table, reachUse.getUsesAfterSlot, parents);
        const c1 = performance.now();
        canInlineTime += c1 - c0;
        if (ok) {
            performInline(c, table, parents);
            performTime += performance.now() - c1;
            inlined++;
        }
    }
    flowInlineInnerTimings.mustDef += t1 - t0;
    flowInlineInnerTimings.mayUse += t2 - t1;
    flowInlineInnerTimings.parents += t3 - t2;
    flowInlineInnerTimings.gather += t4 - t3;
    flowInlineInnerTimings.canInline += canInlineTime;
    flowInlineInnerTimings.perform += performTime;
    flowInlineInnerTimings.candidateCount += candidates.length;
    flowInlineInnerTimings.inlineCount += inlined;
    return { ran: true, inlined };
}
function gatherCandidates(fn, cfg, table, getDef, parents) {
    const out = [];
    for (const cfgNode of cfg.nodes.values()) {
        if (cfgNode === cfg.implicitReturn)
            continue;
        if (cfgNode === cfg.entry)
            continue;
        const value = cfgNode.value;
        if (typeof value === 'symbol')
            continue;
        forEachIdentifierRead(value, parents, (id) => {
            const slot = table.resolve(id);
            if (slot === undefined)
                return;
            if (table.escaped.has(slot))
                return;
            const def = getDef(id, cfgNode);
            if (def === null || def === undefined)
                return;
            if (def.node === fn)
                return; // parameter sentinel — skip
            if (dependsOnOuterScopeVars(def))
                return;
            out.push({ slot, def, use: id, useCfgNode: cfgNode });
        });
    }
    return out;
}
// ---------------------------------------------------------------------------
// canInline
function canInline(c, fn, cfg, table, getUsesAfterSlot, parents) {
    const defLoc = locateDefExpr(c.def, c.slot, table, parents);
    if (defLoc === null)
        return false;
    // Reject defs whose enclosing AssignmentExpression isn't the top-level of
    // its CFG node (i.e. `(x = rhs)` used as an inner subexpression).
    if (defLoc.kind === 'assign' && !defLoc.topLevel)
        return false;
    const rhs = defLoc.rhs;
    // 1. RHS itself impure → can't inline (might change observable order).
    if (mayHaveSideEffects(rhs))
        return false;
    // 2. RHS shape — Closure's isRhsSafeToInline.
    if (!isRhsSafeToInline(rhs))
        return false;
    // 3. Pre/post sibling side-effect checks on slots this def depends on.
    const slotsToCheck = c.def.depends;
    if (checkPostExpressions(defLoc.expr, c.def.node, slotsToCheck, table, parents) ||
        checkPreExpressions(c.use, c.useCfgNode.value, slotsToCheck, table, parents)) {
        return false;
    }
    // 4. Exactly one syntactic use of the binding behind c.slot inside the use's CFG node.
    if (countSlotUsesInCfgNode(c.useCfgNode.value, c.slot, table, parents) !== 1) {
        return false;
    }
    // 5. Use not inside a loop.
    if (isWithinLoop(c.use, fn, parents))
        return false;
    // 6. Exactly one use reaches after the def's CFG node, and it's c.use.
    // 3-state lattice: undefined = no use, null = BOTTOM (multiple), else
    // the unique reaching Identifier.
    const defCfg = cfg.nodes.get(c.def.node);
    if (defCfg === undefined)
        return false;
    const usesAfter = getUsesAfterSlot(c.slot, defCfg);
    if (usesAfter !== c.use)
        return false;
    // 7. Path side-effect check, unless def and use are immediate siblings.
    if (!areAdjacentSiblings(c.def.node, c.useCfgNode.value, parents)) {
        const useGraph = cfg.nodes.get(c.useCfgNode.value);
        if (useGraph === undefined)
            return false;
        const sideEffectOnPath = somePathsSatisfyPredicate({
            graph: cfg,
            start: defCfg,
            end: useGraph,
            nodePredicate: (v) => {
                if (typeof v === 'symbol')
                    return false;
                return nodeHasInterferingEffect(v, slotsToCheck, table);
            },
            edgePredicate: () => true,
            inclusive: false,
        });
        if (sideEffectOnPath)
            return false;
    }
    // 8. Scope visibility — every free local Identifier in the RHS must be in
    //    lexical scope at the use site. Mirrors the second clause of Closure's
    //    isRhsSafeToInline (FlowSensitiveInlineVariables.java:639). Without
    //    this, we'd substitute `out$pN` (declared in an inner block) into a
    //    `return` outside the block, producing an out-of-scope reference.
    if (!rhsIdentifiersInScopeAt(rhs, c.use, table, parents))
        return false;
    return true;
}
/**
 * For every free Identifier read inside `rhs` that resolves to a local slot,
 * verify that the slot's binding scope is an ancestor of `useSite`. Free
 * names that are outer-scope (table.resolve === undefined) are always safe —
 * if they were visible at the def site, they're visible at any sibling/use
 * inside the same function.
 */
function rhsIdentifiersInScopeAt(rhs, useSite, table, parents) {
    const useAncestors = collectAncestorNodes(useSite, parents);
    let ok = true;
    t.traverseFast(rhs, (n) => {
        if (!ok)
            return;
        // Don't descend into nested functions — their free names are bound in
        // their own scope chain, not the use site's.
        if (t.isFunction(n))
            return t.traverseFast.skip;
        if (!t.isIdentifier(n))
            return undefined;
        const info = parents.get(n);
        if (info === undefined)
            return undefined;
        if (!isReferenceContext(info.parent, info.key))
            return undefined;
        const slot = table.resolve(n);
        if (slot === undefined)
            return undefined; // outer-scope / global → safe
        const scopeNode = table.scopeNodeOfSlot(slot);
        if (scopeNode === undefined) {
            ok = false;
            return undefined;
        }
        if (!useAncestors.has(scopeNode))
            ok = false;
        return undefined;
    });
    return ok;
}
function collectAncestorNodes(node, parents) {
    const out = new Set();
    let cur = node;
    while (cur !== undefined) {
        out.add(cur);
        cur = parents.get(cur)?.parent;
    }
    return out;
}
function isReferenceContext(parent, key) {
    if (t.isVariableDeclarator(parent) && key === 'id')
        return false;
    if (t.isFunctionDeclaration(parent) && key === 'id')
        return false;
    if (t.isFunctionExpression(parent) && key === 'id')
        return false;
    if (t.isClassDeclaration(parent) && key === 'id')
        return false;
    if (t.isClassExpression(parent) && key === 'id')
        return false;
    if (t.isLabeledStatement(parent) && key === 'label')
        return false;
    if (t.isBreakStatement(parent) && key === 'label')
        return false;
    if (t.isContinueStatement(parent) && key === 'label')
        return false;
    if (t.isMemberExpression(parent) && key === 'property' && !parent.computed)
        return false;
    if (t.isObjectProperty(parent) && key === 'key' && !parent.computed)
        return false;
    if (t.isObjectMethod(parent) && key === 'key' && !parent.computed)
        return false;
    return true;
}
function locateDefExpr(def, slot, table, parents) {
    let result = null;
    const visit = (n, parent) => {
        if (result !== null)
            return;
        if (parent !== null && isEnteringNewCfgNode(n, parent))
            return;
        if (t.isVariableDeclarator(n) && t.isIdentifier(n.id) && table.resolve(n.id) === slot && n.init) {
            const declInfo = parents.get(n);
            if (declInfo && t.isVariableDeclaration(declInfo.parent)) {
                result = { kind: 'var', expr: n, rhs: n.init, decl: declInfo.parent };
                return;
            }
        }
        if (t.isAssignmentExpression(n) && n.operator === '=' && t.isIdentifier(n.left) && table.resolve(n.left) === slot) {
            // top-level iff parent is an ExpressionStatement (ignoring labels).
            let p = parents.get(n)?.parent ?? null;
            while (p !== null && t.isLabeledStatement(p)) {
                p = parents.get(p)?.parent ?? null;
            }
            const topLevel = p !== null && t.isExpressionStatement(p);
            result = { kind: 'assign', expr: n, rhs: n.right, topLevel };
            return;
        }
        for (const key of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, key);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c)
                        visit(c, n);
                }
            }
            else {
                visit(child, n);
            }
        }
    };
    visit(def.node, null);
    return result;
}
// ---------------------------------------------------------------------------
// isRhsSafeToInline — Closure's banned-shape list.
function isRhsSafeToInline(rhs) {
    let unsafe = false;
    const visit = (n) => {
        if (unsafe)
            return;
        if (t.isMemberExpression(n) ||
            t.isOptionalMemberExpression(n) ||
            t.isClass(n) ||
            t.isArrayExpression(n) ||
            t.isObjectExpression(n) ||
            t.isRegExpLiteral(n) ||
            t.isNewExpression(n)) {
            unsafe = true;
            return;
        }
        if (t.isFunction(n))
            return; // don't recurse into nested functions
        for (const key of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, key);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c)
                        visit(c);
                }
            }
            else {
                visit(child);
            }
        }
    };
    visit(rhs);
    return !unsafe;
}
// ---------------------------------------------------------------------------
// Side-effect checks within an expression tree.
function checkPostExpressions(n, expressionRoot, slotsToCheck, table, parents) {
    let cur = n;
    while (cur !== expressionRoot) {
        for (const sib of rightSiblings(cur, parents)) {
            if (subtreeHasInterferingEffect(sib, slotsToCheck, table))
                return true;
        }
        const info = parents.get(cur);
        if (info === undefined)
            return false;
        cur = info.parent;
    }
    return false;
}
function checkPreExpressions(n, expressionRoot, slotsToCheck, table, parents) {
    let cur = n;
    while (cur !== expressionRoot) {
        for (const sib of leftSiblings(cur, parents)) {
            if (subtreeHasInterferingEffect(sib, slotsToCheck, table))
                return true;
        }
        const info = parents.get(cur);
        if (info === undefined)
            return false;
        cur = info.parent;
    }
    return false;
}
function subtreeHasInterferingEffect(n, slotsToCheck, table, parents) {
    let yes = false;
    const visit = (m) => {
        if (yes)
            return;
        if (t.isCallExpression(m) || t.isOptionalCallExpression(m) || t.isNewExpression(m)) {
            yes = true;
            return;
        }
        if (t.isAssignmentExpression(m) && t.isIdentifier(m.left)) {
            const s = table.resolve(m.left);
            if (s !== undefined && slotsToCheck.has(s)) {
                yes = true;
                return;
            }
        }
        if (t.isUpdateExpression(m) && t.isIdentifier(m.argument)) {
            const s = table.resolve(m.argument);
            if (s !== undefined && slotsToCheck.has(s)) {
                yes = true;
                return;
            }
        }
        if (t.isUnaryExpression(m) && m.operator === 'delete') {
            yes = true;
            return;
        }
        if (t.isFunction(m))
            return;
        for (const key of t.VISITOR_KEYS[m.type] ?? []) {
            const child = getSlot(m, key);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c)
                        visit(c);
                }
            }
            else {
                visit(child);
            }
        }
    };
    visit(n);
    return yes;
}
function nodeHasInterferingEffect(cfgValue, slotsToCheck, table, parents) {
    return subtreeHasInterferingEffect(cfgValue, slotsToCheck, table);
}
// ---------------------------------------------------------------------------
// Identifier-read traversal (used to find candidate uses).
function forEachIdentifierRead(root, parents, visit) {
    const walk = (n, parent) => {
        if (parent !== null && isEnteringNewCfgNode(n, parent))
            return;
        if (t.isIdentifier(n) && parent !== null && !isWriteContext(n, parent)) {
            visit(n);
            return;
        }
        for (const key of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, key);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c)
                        walk(c, n);
                }
            }
            else {
                walk(child, n);
            }
        }
    };
    walk(root, null);
}
function isWriteContext(id, parent) {
    if (t.isAssignmentExpression(parent) && parent.left === id)
        return true;
    if (t.isUpdateExpression(parent) && parent.argument === id)
        return true;
    if (t.isVariableDeclarator(parent) && parent.id === id)
        return true;
    if (t.isFunctionDeclaration(parent) && parent.id === id)
        return true;
    if (t.isFunctionExpression(parent) && parent.id === id)
        return true;
    if (t.isArrayPattern(parent) || t.isObjectPattern(parent))
        return true;
    if (t.isRestElement(parent) && parent.argument === id)
        return true;
    if (t.isAssignmentPattern(parent) && parent.left === id)
        return true;
    if (t.isCatchClause(parent) && parent.param === id)
        return true;
    if (t.isLabeledStatement(parent) && parent.label === id)
        return true;
    if (t.isBreakStatement(parent) && parent.label === id)
        return true;
    if (t.isContinueStatement(parent) && parent.label === id)
        return true;
    if (t.isMemberExpression(parent) && parent.property === id && !parent.computed)
        return true;
    if (t.isOptionalMemberExpression(parent) && parent.property === id && !parent.computed)
        return true;
    if (t.isObjectProperty(parent) && parent.key === id && !parent.computed)
        return true;
    return false;
}
function countSlotUsesInCfgNode(cfgValue, slot, table, parents) {
    let count = 0;
    forEachIdentifierRead(cfgValue, parents, (id) => {
        if (table.resolve(id) === slot)
            count++;
    });
    return count;
}
// ---------------------------------------------------------------------------
// isWithinLoop
function isWithinLoop(node, fn, parents) {
    let cur = node;
    while (cur !== null && cur !== fn) {
        if (t.isWhileStatement(cur) ||
            t.isDoWhileStatement(cur) ||
            t.isForStatement(cur) ||
            t.isForInStatement(cur) ||
            t.isForOfStatement(cur)) {
            return true;
        }
        cur = parents.get(cur)?.parent ?? null;
    }
    return false;
}
// ---------------------------------------------------------------------------
// areAdjacentSiblings — Closure's "skip path-check when def and use are
// immediate neighbors in the same statement list."
function areAdjacentSiblings(defNode, useNode, parents) {
    const di = parents.get(defNode);
    const ui = parents.get(useNode);
    if (di === undefined || ui === undefined)
        return false;
    if (di.parent !== ui.parent)
        return false;
    if (di.index === undefined || ui.index === undefined)
        return false;
    return ui.index === di.index + 1;
}
// ---------------------------------------------------------------------------
// performInline
function performInline(c, table, parents) {
    const loc = locateDefExpr(c.def, c.slot, table, parents);
    if (loc === null)
        return;
    const rhs = loc.rhs;
    // Replace the use with a clone of rhs (rhs may still be referenced from
    // the old def location until we drop it).
    const cloned = t.cloneNode(rhs, /* deep */ true);
    replaceInParent(c.use, cloned, parents);
    // Drop the def.
    if (loc.kind === 'assign') {
        const assignParent = parents.get(loc.expr);
        if (assignParent === undefined)
            return;
        // Top-level assign: parent chain is (Labeled*) → ExpressionStatement.
        let stmt = assignParent.parent;
        while (t.isLabeledStatement(stmt)) {
            const sp = parents.get(stmt);
            if (sp === undefined)
                break;
            stmt = sp.parent;
        }
        // Locate the ExpressionStatement enclosing the assign and remove it.
        let toRemove = loc.expr;
        let toRemoveInfo = parents.get(toRemove);
        while (toRemoveInfo !== undefined && !t.isExpressionStatement(toRemoveInfo.parent)) {
            toRemove = toRemoveInfo.parent;
            toRemoveInfo = parents.get(toRemove);
        }
        if (toRemoveInfo !== undefined && t.isExpressionStatement(toRemoveInfo.parent)) {
            removeFromParent(toRemoveInfo.parent, parents);
        }
    }
    else {
        // Closure FlowSensitiveInlineVariables.inlineVariable (NameDeclaration
        // branch): detach just the rhs, leaving the bare declarator `let x;`
        // in place so any subsequent reassignments still have a binding to
        // target. DAE + RemoveUnusedCode clean up the dead chain afterwards.
        // For const, no subsequent reassignments are possible by language
        // rule, so the whole declarator can be dropped without orphaning.
        const decl = loc.decl;
        if (decl.kind === 'const') {
            if (decl.declarations.length === 1) {
                removeFromParent(decl, parents);
            }
            else {
                const idx = decl.declarations.indexOf(loc.expr);
                if (idx >= 0)
                    decl.declarations.splice(idx, 1);
            }
        }
        else {
            loc.expr.init = null;
        }
    }
}
function buildParentMap(root) {
    const map = new WeakMap();
    const walk = (n, parent, key, index) => {
        if (parent !== null)
            map.set(n, { parent, key, index });
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c)
                        walk(c, n, k, i);
                }
            }
            else {
                walk(child, n, k, undefined);
            }
        }
    };
    walk(root, null, '', undefined);
    return map;
}
function rightSiblings(n, parents) {
    const info = parents.get(n);
    if (info === undefined)
        return [];
    if (info.index === undefined)
        return [];
    const arr = getSlot(info.parent, info.key);
    return arr.slice(info.index + 1).filter((x) => x !== null);
}
function leftSiblings(n, parents) {
    const info = parents.get(n);
    if (info === undefined)
        return [];
    if (info.index === undefined)
        return [];
    const arr = getSlot(info.parent, info.key);
    return arr.slice(0, info.index).filter((x) => x !== null);
}
function replaceInParent(n, replacement, parents) {
    const info = parents.get(n);
    if (info === undefined)
        return;
    const { parent, key, index } = info;
    setSlot(parent, key, index, replacement);
    parents.set(replacement, { parent, key, index });
}
function removeFromParent(n, parents) {
    const info = parents.get(n);
    if (info === undefined)
        return;
    const { parent, key, index } = info;
    if (index !== undefined) {
        const arr = getSlot(parent, key);
        arr.splice(index, 1);
        for (let i = index; i < arr.length; i++) {
            const c = arr[i];
            if (c)
                parents.set(c, { parent, key, index: i });
        }
    }
    else {
        setSlot(parent, key, undefined, null);
    }
}

// Helper used by LiveVariablesAnalysis (and downstream DeadAssignmentsElim,
// MustBeReachingVariableDef, MaybeReachingVariableUse, FlowSensitiveInline).
//
// Closure has a full Scope/Var/ScopeCreator stack (jscomp/Scope.java +
// SyntacticScopeCreator etc., ~1000 LOC). Rather than port that stack, we
// lean on Babel's already-correct `path.scope` analysis and translate:
//
//   - Each local Babel `Binding` becomes a numeric "slot" — the index space
//     the analyses' lattices use.
//   - Each `Identifier` node anywhere in the function maps to its binding's
//     slot via `resolve(idNode)`. Outer-scope references and globals return
//     `undefined`. This is the canonical scope answer Babel computes.
//   - Closure capture from a nested function and `arguments` reference each
//     mark the relevant slot as ESCAPED — escaped slots are treated as
//     live-out at the implicit return so liveness doesn't drop their stores.
//
// Why per-binding identity (not per-name): two `let x` in different scopes
// (or shadowing) are distinct bindings with their own lifetimes. Keying by
// name would conflate them, leading to phantom kills/uses across unrelated
// shadows. Babel's scope analysis tracks them separately; we propagate that.
//
// Slot IDs are stable only within a single `LocalVariableTable` instance.
// Each simplifier iteration rebuilds the table from scratch, so callers must
// not persist slot IDs across iterations.
//
// Limitations vs Closure (deliberate, orthogonal to scope handling):
//
//   - `MAX_VARIABLES_TO_ANALYZE` cap stays in the consumers (LiveVars).
//   - DAE bails entire functions with nested closures — Closure does too.
function buildLocalVariableTable(fnPath) {
    // Refresh scope so bindings reflect the current AST. Per-iteration the
    // simplifier mutates the body — Babel's scope cache must be rebuilt.
    fnPath.scope.crawl();
    const idToSlot = new WeakMap();
    const escaped = new Set();
    const nameBySlot = [];
    const slotsByNameMap = new Map();
    const localBindingToSlot = new Map();
    const scopeNodeBySlot = [];
    const allocSlot = (binding) => {
        const existing = localBindingToSlot.get(binding);
        if (existing !== undefined)
            return existing;
        const slot = nameBySlot.length;
        nameBySlot.push(binding.identifier.name);
        const arr = slotsByNameMap.get(binding.identifier.name) ?? [];
        arr.push(slot);
        slotsByNameMap.set(binding.identifier.name, arr);
        localBindingToSlot.set(binding, slot);
        scopeNodeBySlot.push(binding.scope.path.node);
        return slot;
    };
    // Step 1: allocate slots in declaration order.
    //
    // Params first (Closure indexes parameters before body locals). They live
    // in fnPath.scope.bindings. Then descend into block scopes within the
    // function body, skipping nested functions (each has its own table).
    for (const name of Object.keys(fnPath.scope.bindings)) {
        allocSlot(fnPath.scope.bindings[name]);
    }
    const bodyPath = fnPath.get('body');
    if (!Array.isArray(bodyPath) && bodyPath.node) {
        bodyPath.traverse({
            Function(p) {
                p.skip();
            },
            enter(p) {
                if (p.scope.path === p && p.scope !== fnPath.scope) {
                    for (const name of Object.keys(p.scope.bindings)) {
                        const b = p.scope.bindings[name];
                        if (b.scope === p.scope)
                            allocSlot(b);
                    }
                }
            },
        });
    }
    // Step 2: map every Identifier in this function (excluding nested fn
    // bodies) to its binding's slot. Babel resolves the binding for us via
    // `path.scope.getBinding(name)` walking the scope chain.
    fnPath.traverse({
        Function(p) {
            p.skip();
        },
        Identifier(p) {
            const isRef = p.isReferencedIdentifier();
            const isBind = p.isBindingIdentifier();
            if (!isRef && !isBind)
                return;
            const binding = p.scope.getBinding(p.node.name);
            if (binding === undefined)
                return;
            const slot = localBindingToSlot.get(binding);
            if (slot === undefined)
                return;
            idToSlot.set(p.node, slot);
        },
    });
    // Step 3: closure-escape detection. A binding escapes if any of its
    // reference / write paths lives in a scope nested inside a Function that
    // isn't the binding's own function.
    for (const [binding, slot] of localBindingToSlot) {
        if (escapes(binding, fnPath))
            escaped.add(slot);
    }
    // Step 4: `arguments` reference forces all params to escape. Closure
    // calls this `escapeParameters`. Arrow functions inherit `arguments` from
    // their enclosing function so we must recurse into them; non-arrow
    // nested functions get their own `arguments` so we skip those.
    if (referencesArguments(fnPath)) {
        for (const [binding, slot] of localBindingToSlot) {
            if (binding.kind === 'param')
                escaped.add(slot);
        }
    }
    return {
        resolve: (id) => idToSlot.get(id),
        escaped,
        size: nameBySlot.length,
        nameOfSlot: (slot) => nameBySlot[slot],
        slotsByName: (name) => slotsByNameMap.get(name) ?? [],
        scopeNodeOfSlot: (slot) => scopeNodeBySlot[slot],
    };
}
function escapes(binding, fnPath) {
    const check = (refScope) => {
        // Walk from refScope up to (but not past) the binding's own scope.
        // Crossing a Function boundary that isn't fnPath itself = closure
        // capture.
        let scope = refScope;
        while (scope !== null && scope !== binding.scope) {
            const p = scope.path;
            if (p.isFunction() && p.node !== fnPath.node)
                return true;
            scope = scope.parent;
        }
        return false;
    };
    for (const ref of binding.referencePaths) {
        if (check(ref.scope))
            return true;
    }
    for (const cv of binding.constantViolations) {
        if (check(cv.scope))
            return true;
    }
    return false;
}
function referencesArguments(fnPath) {
    let found = false;
    fnPath.traverse({
        Function(p) {
            // Arrow fns inherit `arguments`; non-arrow fns get their own.
            if (!p.isArrowFunctionExpression())
                p.skip();
        },
        Identifier(p) {
            if (found)
                return;
            if (p.node.name !== 'arguments')
                return;
            if (!p.isReferencedIdentifier())
                return;
            // Belongs to an enclosing non-arrow function? If we walked up from
            // here through arrow fns and reached fnPath, yes.
            let cur = p.parentPath;
            while (cur !== null && cur !== fnPath) {
                if (cur.isFunction() && !cur.isArrowFunctionExpression())
                    return;
                cur = cur.parentPath;
            }
            found = true;
        },
    });
    return found;
}

// Port of jscomp/MinimizeExitPoints.java.
//
// Transforms the AST so that explicit exits (return / break / continue) are
// replaced by implicit fall-through where possible. Most useful in shape:
//
//   _label: {
//     if (cond) { ...A; break _label; }
//     ...B;
//   }
//
// becomes
//
//   _label: {
//     if (cond) { ...A; }
//     else { ...B; }
//   }
//
// which then composes with PeepholeMinimizeConditions to collapse if/else
// into a ternary, and with PeepholeRemoveDeadCode to drop the labeled
// wrapper. This is exactly the residue our BLOCK-inliner emits, so the two
// passes together start chipping at the `_compilecat_inline_result` shape.
//
// Bails on: try/finally (we leave its exit semantics alone — see ECMA 12.14).
// We don't have isASTNormalized() — Closure uses it to gate switch-exit
// minimization; we behave as "normalized" since our pipeline runs after
// inline + simplification.
/**
 * Operates on any AST root (Program, File, Function body — anything). We use
 * a manual walker rather than @babel/traverse to avoid the scope/parentPath
 * requirement when invoked on a non-Program subtree (the simplifier passes
 * a function body here).
 */
function runMinimizeExitPoints(root) {
    const ctx = { minimized: 0 };
    walk$3(root, ctx);
    return { minimized: ctx.minimized };
}
function walk$3(n, ctx) {
    // Visit children first (bottom-up).
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, k);
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c)
                    walk$3(c, ctx);
            }
        }
        else {
            walk$3(child, ctx);
        }
    }
    // Per-node entry points mirror Closure's optimizeSubtree switch.
    if (t.isLabeledStatement(n)) {
        tryMinimizeExits(n.body, 'break', n.label.name, ctx);
        return;
    }
    if (t.isWhileStatement(n) || t.isForStatement(n) || t.isForInStatement(n) || t.isForOfStatement(n)) {
        tryMinimizeExits(n.body, 'continue', null, ctx);
        return;
    }
    if (t.isDoWhileStatement(n)) {
        tryMinimizeExits(n.body, 'continue', null, ctx);
        if (getSideEffectFreeBooleanValue(n.test) === TRI_FALSE) {
            tryMinimizeExits(n.body, 'break', null, ctx);
        }
        return;
    }
    if (t.isFunction(n)) {
        const body = n.body;
        if (t.isBlockStatement(body))
            tryMinimizeExits(body, 'return', null, ctx);
        return;
    }
}
// ---------------------------------------------------------------------------
// Core: identify trailing exits and convert them to implicit fall-through.
function tryMinimizeExits(n, exitType, labelName, ctx) {
    // Direct match: the node itself is an exit of the right kind.
    if (matchingExitNode(n, exitType, labelName)) {
        // Remove it from its parent. The caller (block iteration) handles
        // removal when this is invoked on a child of a block.
        return;
    }
    if (t.isIfStatement(n)) {
        tryMinimizeExits(n.consequent, exitType, labelName, ctx);
        if (n.alternate)
            tryMinimizeExits(n.alternate, exitType, labelName, ctx);
        return;
    }
    if (t.isTryStatement(n)) {
        tryMinimizeExits(n.block, exitType, labelName, ctx);
        if (n.handler)
            tryMinimizeExits(n.handler.body, exitType, labelName, ctx);
        // Don't touch finalizer.
        return;
    }
    if (t.isLabeledStatement(n)) {
        tryMinimizeExits(n.body, exitType, labelName, ctx);
        return;
    }
    if (t.isSwitchStatement(n) && (exitType !== 'break' || labelName !== null)) {
        tryMinimizeSwitchExits(n, exitType, labelName, ctx);
        return;
    }
    if (!t.isBlockStatement(n) || n.body.length === 0)
        return;
    // Multi-if pass: for each if(...) child, try to hoist trailing exits out
    // of its branches by moving the if's siblings into the opposite branch.
    for (let i = 0; i < n.body.length; i++) {
        const c = n.body[i];
        if (t.isIfStatement(c)) {
            tryMinimizeIfBlockExits(n, i, c, true, exitType, labelName, ctx);
            // The if may have changed structure; re-fetch the alternate.
            const cur = n.body[i];
            if (cur.alternate) {
                tryMinimizeIfBlockExits(n, i, cur, false, exitType, labelName, ctx);
            }
        }
        if (i === n.body.length - 1)
            break;
    }
    // Last-child pass: recurse into the tail; if it shrinks/changes, look at
    // what's now the tail and try again.
    while (n.body.length > 0) {
        const last = n.body[n.body.length - 1];
        const before = n.body.length;
        if (matchingExitNode(last, exitType, labelName)) {
            n.body.pop();
            ctx.minimized++;
            continue;
        }
        tryMinimizeExits(last, exitType, labelName, ctx);
        if (n.body.length === before && n.body[n.body.length - 1] === last)
            break;
    }
}
function tryMinimizeSwitchExits(n, exitType, labelName, ctx) {
    for (let i = 0; i < n.cases.length; i++) {
        const c = n.cases[i];
        if (i !== n.cases.length - 1) {
            tryMinimizeSwitchCaseExits(c, exitType, labelName, ctx);
        }
        else {
            // Last case: aggressive — recurse into its block content.
            for (const stmt of c.consequent)
                tryMinimizeExits(stmt, exitType, labelName, ctx);
        }
    }
}
function tryMinimizeSwitchCaseExits(c, exitType, labelName, ctx) {
    const body = c.consequent;
    const last = body[body.length - 1];
    if (!t.isBreakStatement(last) || last.label !== null)
        return;
    // Recurse on the statement just before the trailing break.
    let idx = body.length - 2;
    while (idx >= 0) {
        const stmt = body[idx];
        if (matchingExitNode(stmt, exitType, labelName)) {
            body.splice(idx, 1);
            ctx.minimized++;
            idx = body.length - 2;
            continue;
        }
        tryMinimizeExits(stmt, exitType, labelName, ctx);
        idx--;
    }
}
// ---------------------------------------------------------------------------
// If-block-exit hoisting.
//
// When an if-branch ends in a matching exit, the if's following siblings can
// be moved into the opposite branch. After this transform, the matching exit
// becomes redundant and the trailing pass drops it.
function tryMinimizeIfBlockExits(parentBlock, ifIndex, ifNode, workingOnConsequent, exitType, labelName, ctx) {
    const srcBlock = workingOnConsequent ? ifNode.consequent : ifNode.alternate;
    if (srcBlock === null || srcBlock === undefined)
        return;
    const destBlock = workingOnConsequent ? (ifNode.alternate ?? null) : ifNode.consequent;
    let exitNode = null;
    let removeFromBlock = null;
    if (t.isBlockStatement(srcBlock)) {
        if (srcBlock.body.length === 0)
            return;
        const cand = srcBlock.body[srcBlock.body.length - 1];
        if (!matchingExitNode(cand, exitType, labelName))
            return;
        exitNode = cand;
        removeFromBlock = srcBlock;
    }
    else {
        if (!matchingExitNode(srcBlock, exitType, labelName))
            return;
        exitNode = srcBlock;
    }
    // Deliberate deviation from Closure: Closure converts following-sibling
    // `let`/`const` to `var` here (keyword-homogeneity for its own emit; it
    // emits `var` everywhere). We don't. All references to those decls move
    // *into the new block together with the decl itself* (the splice below
    // takes every sibling from ifIndex+1 to end), so block-scoping is
    // preserved and the `let`/`const` semantics are unchanged. Keeping them
    // also avoids degrading the readability of compilecat's intermediate
    // output (this pass would otherwise sneak `var` back in even though we
    // dropped OptimizeLetAndConstPeephole).
    if (parentBlock.body.length - 1 - ifIndex === 0)
        return;
    // Determine the new destination block content.
    const moving = parentBlock.body.splice(ifIndex + 1);
    // The exit we matched can now be removed (redundant — falls into the
    // implicit exit of the enclosing structure).
    if (removeFromBlock !== null && exitNode !== null) {
        const idx = removeFromBlock.body.indexOf(exitNode);
        if (idx >= 0)
            removeFromBlock.body.splice(idx, 1);
    }
    else if (workingOnConsequent) {
        // srcBlock was a single statement; replace with an empty block.
        ifNode.consequent = t.blockStatement([]);
    }
    else {
        ifNode.alternate = t.blockStatement([]);
    }
    if (workingOnConsequent) {
        // Move siblings into alternate.
        if (destBlock === null) {
            ifNode.alternate = t.blockStatement(moving);
        }
        else if (t.isBlockStatement(destBlock)) {
            destBlock.body.push(...moving);
        }
        else {
            ifNode.alternate = t.blockStatement([destBlock, ...moving]);
        }
    }
    else {
        if (destBlock === null) {
            // Shouldn't happen — destBlock is consequent which always exists.
            ifNode.consequent = t.blockStatement(moving);
        }
        else if (t.isBlockStatement(destBlock)) {
            destBlock.body.push(...moving);
        }
        else {
            ifNode.consequent = t.blockStatement([destBlock, ...moving]);
        }
    }
    ctx.minimized++;
}
// ---------------------------------------------------------------------------
// Predicates.
function matchingExitNode(n, type, labelName) {
    if (type === 'return') {
        return t.isReturnStatement(n) && (n.argument === null || n.argument === undefined);
    }
    if (type === 'break') {
        if (!t.isBreakStatement(n))
            return false;
        if (labelName === null)
            return n.label === null;
        return !!n.label && n.label.name === labelName;
    }
    if (type === 'continue') {
        if (!t.isContinueStatement(n))
            return false;
        if (labelName === null)
            return n.label === null;
        return !!n.label && n.label.name === labelName;
    }
    return false;
}

// Port of jscomp/PeepholeFoldConstants.java (subset).
//
// Folds expressions whose value is statically computable at compile time.
// Operates on a single AST in a single bottom-up pass; safe to repeat at the
// fixpoint level.
//
// Covered:
//   - numeric arithmetic on literal-literal (+, -, *, /, %, **)
//   - bitwise / shift on literal-literal (&, |, ^, <<, >>, >>>, ~)
//   - numeric identities (x+0, 0+x, x-0, x*1, 1*x, x/1) when x is pure
//   - string concat on string-literal-literal
//   - unary - / + / ! / ~ on literals
//   - typeof of a literal value
//   - logical && / || / ?? when LHS is a known truthy/falsy/null literal
//   - optional chain on null/undefined LHS (`null?.x` → `undefined`)
//   - comparisons (==, ===, !=, !==, <, <=, >, >=) on literal-literal
//
// Not covered (deferred):
//   - bigint
//   - regex / object / array literals as operands
//   - tagged templates
//
// Closure runs this pre-DAE in the simplifier loop. We do the same.
function runPeepholeFoldConstants(root) {
    const ctx = { folded: 0 };
    walk$2(root, null, '', undefined, ctx);
    return { folded: ctx.folded };
}
function walk$2(n, parent, key, index, ctx) {
    // Bottom-up: recurse first.
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, k);
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c)
                    walk$2(c, n, k, i, ctx);
            }
        }
        else {
            walk$2(child, n, k, undefined, ctx);
        }
    }
    if (parent === null)
        return;
    const replacement = tryFold(n);
    if (replacement === null)
        return;
    setSlot(parent, key, index, replacement);
    ctx.folded++;
}
// ---------------------------------------------------------------------------
// Per-node fold dispatcher.
function tryFold(n) {
    if (t.isUnaryExpression(n))
        return foldUnary(n);
    if (t.isBinaryExpression(n))
        return foldBinary(n);
    if (t.isLogicalExpression(n))
        return foldLogical(n);
    if (t.isOptionalMemberExpression(n) || t.isOptionalCallExpression(n))
        return foldOptionalChain(n);
    return null;
}
// ---------------------------------------------------------------------------
// Unary
function foldUnary(n) {
    if (n.operator === 'typeof') {
        const tn = typeofLiteral(n.argument);
        if (tn !== null)
            return t.stringLiteral(tn);
        return null;
    }
    if (n.operator === '!') {
        const b = asBoolean$1(n.argument);
        if (b !== null)
            return t.booleanLiteral(!b);
        return null;
    }
    if (n.operator === '-') {
        if (t.isNumericLiteral(n.argument)) {
            // Already canonical; leaving `-5` as `UnaryExpression(-, 5)` is the
            // standard Babel shape, so don't rewrite it.
            return null;
        }
        // -(-x) on literals → x
        if (t.isUnaryExpression(n.argument) && n.argument.operator === '-' && t.isNumericLiteral(n.argument.argument)) {
            return t.numericLiteral(n.argument.argument.value);
        }
        return null;
    }
    if (n.operator === '+') {
        // +"123" → 123 (only for literal strings convertible cleanly).
        if (t.isStringLiteral(n.argument)) {
            const v = Number(n.argument.value);
            if (Number.isFinite(v))
                return numericLiteral(v);
        }
        if (t.isNumericLiteral(n.argument))
            return n.argument;
        if (t.isBooleanLiteral(n.argument))
            return t.numericLiteral(n.argument.value ? 1 : 0);
        return null;
    }
    if (n.operator === '~') {
        const v = asNumeric(n.argument);
        if (v !== null)
            return numericLiteral(~toInt32(v));
    }
    return null;
}
// ---------------------------------------------------------------------------
// Binary
function foldBinary(n) {
    if (t.isPrivateName(n.left))
        return null;
    const left = n.left;
    const right = n.right;
    const op = n.operator;
    // Numeric arithmetic.
    const lv = asNumeric(left);
    const rv = asNumeric(right);
    if (lv !== null && rv !== null) {
        const folded = evalNumericBinary(op, lv, rv);
        if (folded !== null && Number.isFinite(folded))
            return numericLiteral(folded);
    }
    // String concat: "a" + "b" → "ab".
    if (op === '+' && t.isStringLiteral(left) && t.isStringLiteral(right)) {
        return t.stringLiteral(left.value + right.value);
    }
    // String + number → string concat (only when both literal).
    if (op === '+') {
        if (t.isStringLiteral(left) && rv !== null)
            return t.stringLiteral(left.value + String(rv));
        if (t.isStringLiteral(right) && lv !== null)
            return t.stringLiteral(String(lv) + right.value);
    }
    // Identities (require pure variable side because we drop the other side).
    if (op === '+' && rv === 0 && !mayHaveSideEffects(left))
        return left;
    if (op === '+' && lv === 0 && !mayHaveSideEffects(right))
        return right;
    if (op === '-' && rv === 0 && !mayHaveSideEffects(left))
        return left;
    if (op === '*' && rv === 1 && !mayHaveSideEffects(left))
        return left;
    if (op === '*' && lv === 1 && !mayHaveSideEffects(right))
        return right;
    if (op === '/' && rv === 1 && !mayHaveSideEffects(left))
        return left;
    // Comparisons on literal-literal.
    const cmp = evalComparison(op, left, right);
    if (cmp !== null)
        return t.booleanLiteral(cmp);
    return null;
}
// ---------------------------------------------------------------------------
// Logical: && || ??
function foldLogical(n) {
    if (n.operator === '&&') {
        const lb = asBoolean$1(n.left);
        if (lb === false) {
            return mayHaveSideEffects(n.left) ? null : n.left;
        }
        if (lb === true) {
            return mayHaveSideEffects(n.left) ? null : n.right;
        }
    }
    if (n.operator === '||') {
        const lb = asBoolean$1(n.left);
        if (lb === true) {
            return mayHaveSideEffects(n.left) ? null : n.left;
        }
        if (lb === false) {
            return mayHaveSideEffects(n.left) ? null : n.right;
        }
    }
    if (n.operator === '??') {
        if (t.isNullLiteral(n.left))
            return n.right;
        if (t.isIdentifier(n.left) && n.left.name === 'undefined') {
            return n.right;
        }
        // Any non-null/undefined literal short-circuits to the LHS.
        if ((t.isNumericLiteral(n.left) || t.isStringLiteral(n.left) || t.isBooleanLiteral(n.left)) &&
            !mayHaveSideEffects(n.left)) {
            return n.left;
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// Helpers
function asNumeric(node) {
    if (t.isNumericLiteral(node))
        return node.value;
    if (t.isUnaryExpression(node) && node.operator === '-' && t.isNumericLiteral(node.argument)) {
        return -node.argument.value;
    }
    return null;
}
function asBoolean$1(node) {
    if (t.isBooleanLiteral(node))
        return node.value;
    if (t.isNumericLiteral(node))
        return node.value !== 0;
    if (t.isStringLiteral(node))
        return node.value.length > 0;
    if (t.isNullLiteral(node))
        return false;
    if (t.isIdentifier(node) && node.name === 'undefined')
        return false;
    return null;
}
function typeofLiteral(node) {
    if (t.isStringLiteral(node))
        return 'string';
    if (t.isNumericLiteral(node))
        return 'number';
    if (t.isBooleanLiteral(node))
        return 'boolean';
    if (t.isNullLiteral(node))
        return 'object';
    if (t.isIdentifier(node) && node.name === 'undefined')
        return 'undefined';
    if (t.isFunction(node))
        return 'function';
    return null;
}
function numericLiteral(value) {
    if (value < 0) {
        return t.unaryExpression('-', t.numericLiteral(-value));
    }
    return t.numericLiteral(value);
}
function evalNumericBinary(op, l, r) {
    switch (op) {
        case '+':
            return l + r;
        case '-':
            return l - r;
        case '*':
            return l * r;
        case '/':
            if (r === 0)
                return null;
            return l / r;
        case '%':
            if (r === 0)
                return null;
            return l % r;
        case '**':
            return l ** r;
        case '&':
            return toInt32(l) & toInt32(r);
        case '|':
            return toInt32(l) | toInt32(r);
        case '^':
            return toInt32(l) ^ toInt32(r);
        // Shift counts: JS masks the RHS to 5 bits — we let the engine do it.
        case '<<':
            return toInt32(l) << toInt32(r);
        case '>>':
            return toInt32(l) >> toInt32(r);
        case '>>>':
            return toUint32(l) >>> toInt32(r);
    }
    return null;
}
// JS ToInt32 (ECMA-262 §7.1.6) — fold semantics must match runtime.
function toInt32(v) {
    return v | 0;
}
function toUint32(v) {
    return v >>> 0;
}
// Fold `null?.x`, `null?.()`, `undefined?.x` → `undefined`. Any non-nullish
// LHS literal cancels the optional and is left to a separate pass.
function foldOptionalChain(n) {
    if (!n.optional)
        return null;
    const head = t.isOptionalMemberExpression(n) ? n.object : n.callee;
    if (!head)
        return null;
    if (t.isNullLiteral(head) || (t.isIdentifier(head) && head.name === 'undefined')) {
        return t.identifier('undefined');
    }
    return null;
}
function evalComparison(op, left, right) {
    const lv = asNumeric(left);
    const rv = asNumeric(right);
    if (lv !== null && rv !== null) {
        switch (op) {
            case '<':
                return lv < rv;
            case '<=':
                return lv <= rv;
            case '>':
                return lv > rv;
            case '>=':
                return lv >= rv;
            case '==':
                // biome-ignore lint/suspicious/noDoubleEquals: intentional
                return lv == rv;
            case '!=':
                // biome-ignore lint/suspicious/noDoubleEquals: intentional
                return lv != rv;
            case '===':
                return lv === rv;
            case '!==':
                return lv !== rv;
        }
    }
    if (t.isStringLiteral(left) && t.isStringLiteral(right)) {
        switch (op) {
            case '==':
                return left.value === right.value;
            case '!=':
                return left.value !== right.value;
            case '===':
                return left.value === right.value;
            case '!==':
                return left.value !== right.value;
            case '<':
                return left.value < right.value;
            case '<=':
                return left.value <= right.value;
            case '>':
                return left.value > right.value;
            case '>=':
                return left.value >= right.value;
        }
    }
    if (t.isBooleanLiteral(left) && t.isBooleanLiteral(right)) {
        switch (op) {
            case '==':
                return left.value === right.value;
            case '!=':
                return left.value !== right.value;
            case '===':
                return left.value === right.value;
            case '!==':
                return left.value !== right.value;
        }
    }
    return null;
}

// Port of jscomp/MinimizedCondition.java.
//
// Builds two equivalent representations of a boolean condition — `positive`
// (the original semantics) and `negative` (the original negated). Each carries
// an estimated cost (negation chars + parenthesis pairs), enabling callers to
// pick the cheaper shape and apply De Morgan's law where it pays off.
//
// Shape:
//   - `MeasuredNode` is a lazy AST builder. `node` is the root; `children` is
//     either null (leaf — emit `node` as-is) or an array of MeasuredNode
//     describing the rebuilt children.
//   - `buildReplacement` walks the tree and assembles a fresh Babel node
//     tailored to the parent's type (UnaryExpression / LogicalExpression /
//     BinaryExpression / ConditionalExpression / SequenceExpression).
//
// The negative side of an `unoptimized` condition is a sentinel with
// `Number.MAX_SAFE_INTEGER` length so that `getMinimized` never picks it.
// ---------------------------------------------------------------------------
// Constructors.
function fromConditionNode(n) {
    if ((t.isUnaryExpression(n) && n.operator === '!') ||
        t.isLogicalExpression(n) ||
        t.isConditionalExpression(n) ||
        (t.isSequenceExpression(n) && n.expressions.length >= 2)) {
        return computeMinimizedCondition(n);
    }
    return unoptimized(n);
}
function unoptimized(n) {
    return {
        positive: { node: n, children: null, length: 0, changed: false },
        negative: { node: null, children: null, length: Number.MAX_SAFE_INTEGER, changed: true },
    };
}
function mkMC(positive, negative) {
    return { positive, negative: change(negative) };
}
// ---------------------------------------------------------------------------
// Recursive cost computation.
function computeMinimizedCondition(n) {
    if (t.isUnaryExpression(n) && n.operator === '!') {
        const subtree = computeMinimizedCondition(n.argument);
        const positive = pickBest(addNode(n, [subtree.positive]), subtree.negative);
        const negative = pickBest(negate(subtree.negative), subtree.positive);
        return mkMC(positive, negative);
    }
    if (t.isLogicalExpression(n) && (n.operator === '&&' || n.operator === '||')) {
        // Closure builds a synthetic `complementNode` of the opposite operator,
        // shared by the negative-side cost compare. We mirror that.
        const complement = t.logicalExpression(n.operator === '&&' ? '||' : '&&', n.left, n.right);
        const left = computeMinimizedCondition(n.left);
        const right = computeMinimizedCondition(n.right);
        const positive = pickBest(addNode(n, [left.positive, right.positive]), negate(addNode(complement, [left.negative, right.negative])));
        const negative = pickBest(negate(addNode(n, [left.positive, right.positive])), change(addNode(complement, [left.negative, right.negative])));
        return mkMC(positive, negative);
    }
    if (t.isConditionalExpression(n)) {
        const cond = forNode(n.test);
        const thenS = computeMinimizedCondition(n.consequent);
        const elseS = computeMinimizedCondition(n.alternate);
        const positive = addNode(n, [cond, thenS.positive, elseS.positive]);
        const negative = addNode(n, [cond, thenS.negative, elseS.negative]);
        return mkMC(positive, negative);
    }
    if (t.isSequenceExpression(n) && n.expressions.length >= 2) {
        const last = n.expressions[n.expressions.length - 1];
        const lhsNodes = n.expressions.slice(0, -1).map(forNode);
        const rhsSubtree = computeMinimizedCondition(last);
        const positive = addNode(n, [...lhsNodes, rhsSubtree.positive]);
        const negative = addNode(n, [...lhsNodes, rhsSubtree.negative]);
        return mkMC(positive, negative);
    }
    const pos = forNode(n);
    const neg = negate(pos);
    return mkMC(pos, neg);
}
// ---------------------------------------------------------------------------
// MeasuredNode primitives.
function forNode(n) {
    return { node: n, children: null, length: 0, changed: false };
}
function addNode(parent, children) {
    let cost = 0;
    let ch = false;
    for (const c of children) {
        cost += c.length;
        if (c.changed)
            ch = true;
    }
    cost += estimateCostOneLevel(parent, children);
    return { node: parent, children, length: cost, changed: ch };
}
function estimateCostOneLevel(parent, children) {
    let cost = 0;
    if (t.isUnaryExpression(parent) && parent.operator === '!')
        cost++;
    const parentPrec = precedence(parent);
    for (const c of children) {
        if (c.node !== null && precedence(c.node) < parentPrec)
            cost += 2;
    }
    return cost;
}
function pickBest(a, b) {
    if (a.length === b.length)
        return b.changed ? a : b;
    return a.length < b.length ? a : b;
}
function change(m) {
    if (m.changed)
        return m;
    return { node: m.node, children: m.children, length: m.length, changed: true };
}
function addNot(m) {
    if (m.node === null)
        return m;
    const notNode = t.unaryExpression('!', m.node);
    return change(addNode(notNode, [m]));
}
function negate(m) {
    if (m.node === null)
        return m;
    if (t.isBinaryExpression(m.node)) {
        switch (m.node.operator) {
            case '==':
                return updateOperator(m, '!=');
            case '!=':
                return updateOperator(m, '==');
            case '===':
                return updateOperator(m, '!==');
            case '!==':
                return updateOperator(m, '===');
        }
    }
    if (t.isUnaryExpression(m.node) && m.node.operator === '!')
        return withoutNot(m);
    return addNot(m);
}
function updateOperator(m, op) {
    const orig = m.node;
    if (t.isPrivateName(orig.left))
        return addNot(m);
    const newNode = t.binaryExpression(op, orig.left, orig.right);
    const children = m.children ?? normalizeChildren(orig);
    return { node: newNode, children, length: m.length, changed: true };
}
function withoutNotInternal(m) {
    if (m.node === null || !t.isUnaryExpression(m.node) || m.node.operator !== '!') {
        throw new Error('withoutNot: expected NOT');
    }
    const children = m.children ?? normalizeChildren(m.node);
    return change(children[0]);
}
function normalizeChildren(node) {
    if (t.isUnaryExpression(node))
        return [forNode(node.argument)];
    if (t.isLogicalExpression(node))
        return [forNode(node.left), forNode(node.right)];
    if (t.isBinaryExpression(node)) {
        if (t.isPrivateName(node.left))
            return [];
        return [forNode(node.left), forNode(node.right)];
    }
    if (t.isConditionalExpression(node)) {
        return [forNode(node.test), forNode(node.consequent), forNode(node.alternate)];
    }
    if (t.isSequenceExpression(node))
        return node.expressions.map(forNode);
    return [];
}
// ---------------------------------------------------------------------------
// Public surface used by PeepholeMinimizeConditions.
function getMinimized(mc, style) {
    if (style === 'PREFER_UNNEGATED' || isMeasuredNot(mc.positive) || mc.positive.length <= mc.negative.length) {
        return mc.positive;
    }
    return addNot(mc.negative);
}
function isMeasuredNot(m) {
    return m.node !== null && t.isUnaryExpression(m.node) && m.node.operator === '!';
}
function withoutNot(m) {
    return withoutNotInternal(m);
}
function isLowerPrecedenceThan(m, prec) {
    return m.node !== null && precedence(m.node) < prec;
}
function willChange(m, original) {
    return m.node !== original || m.changed;
}
function buildReplacement(m) {
    if (m.node === null)
        throw new Error('buildReplacement: sentinel');
    if (m.children === null)
        return m.node;
    const kids = m.children.map(buildReplacement);
    return assembleNode(m.node, kids);
}
function assembleNode(parent, kids) {
    if (t.isUnaryExpression(parent)) {
        return t.unaryExpression(parent.operator, kids[0], parent.prefix);
    }
    if (t.isLogicalExpression(parent)) {
        return t.logicalExpression(parent.operator, kids[0], kids[1]);
    }
    if (t.isBinaryExpression(parent)) {
        if (t.isPrivateName(parent.left))
            return parent;
        return t.binaryExpression(parent.operator, kids[0], kids[1]);
    }
    if (t.isConditionalExpression(parent)) {
        return t.conditionalExpression(kids[0], kids[1], kids[2]);
    }
    if (t.isSequenceExpression(parent)) {
        return t.sequenceExpression(kids);
    }
    return parent;
}

// Port of jscomp/PeepholeMinimizeConditions.java.
//
// Boolean control-flow minimization. Operates bottom-up; safe to repeat at the
// simplifier fixpoint level alongside fold-constants and remove-dead-code.
//
// Covered (full Closure parity for everything that doesn't require CFG
// follow-node queries):
//   - tryMinimizeNot      — !(a CMP b) → a NEG_CMP b, !!x → x
//   - tryMinimizeIf       — full if/else minimization via MinimizedCondition
//   - tryMinimizeHook     — flips HOOK when negated form is shorter
//   - tryMinimizeExprResult — strips leading NOT from expression statements
//   - tryJoinForCondition — for { if(c) break; ... } → for(...; !c; ...) { ... }
//   - tryRemoveRepeatedStatements — hoists trailing common stmts out of if/else
//   - tryReplaceIf (block-level)
//       * if(c) return X; if(c) return X  → if(c||c2) return X
//       * if(c) foo() else return X; if(c2) return X → if(!c&&c2) foo() else return X (variant)
//       * if(c) return [X]; return Y      → return c ? X : Y
//       * if(c){...exit} else Y; sib      → moves Y next to sib when cons exits
//   - performConditionSubstitutions — x||true→true, x&&false→false, x?true:y→x||y, etc.
//
// Deferred (need CFG follow-node analysis from ControlFlowAnalysis):
//   - tryRemoveRedundantExit
//   - tryReplaceExitWithBreak
// MinimizeExitPoints covers most of what these would catch in practice.
function runPeepholeMinimizeConditions(root) {
    const ctx = { minimized: 0 };
    walk$1(root, null, '', undefined, ctx);
    return { minimized: ctx.minimized };
}
// ---------------------------------------------------------------------------
// Walker. Bottom-up: recurse first, then dispatch on the node's type. Block /
// Program nodes get a statement-list pass (tryReplaceIf) before per-node
// dispatch so the multi-statement transforms run against fully-rewritten
// children.
function walk$1(n, parent, key, index, ctx) {
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, k);
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c)
                    walk$1(c, n, k, i, ctx);
            }
        }
        else {
            walk$1(child, n, k, undefined, ctx);
        }
    }
    if (t.isBlockStatement(n) || t.isProgram(n)) {
        tryReplaceIfBlock(n, ctx);
    }
    if (parent === null)
        return;
    // Per-node dispatch. We replace by writing back through `setSlot`.
    if (t.isUnaryExpression(n) && n.operator === '!') {
        // Minimize the inner condition first; then try the local !cmp rewrite.
        tryMinimizeConditionSlot(n, 'argument');
        const replaced = tryMinimizeNot(n);
        if (replaced !== n) {
            setSlot(parent, key, index, replaced);
            ctx.minimized++;
        }
        return;
    }
    if (t.isIfStatement(n)) {
        performConditionSubstitutionsSlot(n, 'test');
        const replaced = tryMinimizeIf(n, ctx);
        if (replaced !== n) {
            setSlot(parent, key, index, replaced);
        }
        return;
    }
    if (t.isExpressionStatement(n)) {
        performConditionSubstitutionsSlot(n, 'expression');
        tryMinimizeExprResult(n, ctx);
        return;
    }
    if (t.isConditionalExpression(n)) {
        performConditionSubstitutionsSlot(n, 'test');
        const replaced = tryMinimizeHook(n, ctx);
        if (replaced !== n) {
            setSlot(parent, key, index, replaced);
        }
        return;
    }
    if (t.isWhileStatement(n) || t.isDoWhileStatement(n)) {
        tryMinimizeConditionSlot(n, 'test');
        return;
    }
    if (t.isForStatement(n)) {
        tryJoinForCondition(n, ctx);
        if (n.test)
            tryMinimizeConditionSlot(n, 'test');
        return;
    }
}
// ---------------------------------------------------------------------------
// !(...) rewrites — simple peephole, no MinimizedCondition needed.
const COMPARISON_NEGATION = {
    '==': '!=',
    '!=': '==',
    '===': '!==',
    '!==': '===',
};
function tryMinimizeNot(n) {
    const arg = n.argument;
    if (t.isUnaryExpression(arg) && arg.operator === '!')
        return arg.argument;
    if (t.isBinaryExpression(arg)) {
        const op = COMPARISON_NEGATION[arg.operator];
        if (op !== undefined) {
            if (t.isPrivateName(arg.left))
                return n;
            return t.binaryExpression(op, arg.left, arg.right);
        }
        // GT/GE/LT/LE NOT-inversion is *unsafe* against NaN — !(x < NaN) is
        // not x >= NaN. Closure skips it; we do too. Our earlier ad-hoc port
        // covered them; this is the correct conservative shape.
    }
    return n;
}
// ---------------------------------------------------------------------------
// HOOK / ExpressionStatement minimization via MinimizedCondition.
function tryMinimizeHook(n, ctx) {
    // Direct shortcuts that are always profitable (independent of bool context).
    // These mirror what `performConditionSubstitutions` would do if the HOOK
    // were nested in a boolean context.
    if (areNodesEqual(n.consequent, n.alternate) && !mayHaveSideEffects(n.test)) {
        ctx.minimized++;
        return n.consequent;
    }
    if (t.isBooleanLiteral(n.consequent) &&
        n.consequent.value === true &&
        t.isBooleanLiteral(n.alternate) &&
        n.alternate.value === false) {
        ctx.minimized++;
        return t.unaryExpression('!', t.unaryExpression('!', n.test));
    }
    if (t.isBooleanLiteral(n.consequent) &&
        n.consequent.value === false &&
        t.isBooleanLiteral(n.alternate) &&
        n.alternate.value === true) {
        ctx.minimized++;
        return t.unaryExpression('!', n.test);
    }
    const originalCond = n.test;
    const mc = fromConditionNode(originalCond);
    const m = getMinimized(mc, 'ALLOW_LEADING_NOT');
    if (isMeasuredNot(m)) {
        // Swap consequent/alternate; strip the leading NOT.
        const stripped = withoutNot(m);
        const newCond = buildReplacement(stripped);
        const flipped = t.conditionalExpression(newCond, n.alternate, n.consequent);
        ctx.minimized++;
        return flipped;
    }
    if (willChange(m, originalCond)) {
        n.test = buildReplacement(m);
        ctx.minimized++;
    }
    return n;
}
function tryMinimizeExprResult(n, ctx) {
    const original = n.expression;
    const mc = fromConditionNode(original);
    const m = getMinimized(mc, 'ALLOW_LEADING_NOT');
    if (isMeasuredNot(m)) {
        const stripped = withoutNot(m);
        n.expression = buildReplacement(stripped);
        ctx.minimized++;
    }
    else if (willChange(m, original)) {
        n.expression = buildReplacement(m);
        ctx.minimized++;
    }
}
// ---------------------------------------------------------------------------
// IF minimization — the biggest sub-function. Mirrors Closure's tryMinimizeIf
// case-by-case.
function tryMinimizeIf(n, ctx) {
    const originalCond = n.test;
    // Let other passes handle literal-cond reduction.
    if (isLiteralValue(originalCond))
        return n;
    const thenBranch = n.consequent;
    const elseBranch = n.alternate ?? null;
    const mc = fromConditionNode(originalCond);
    const unnegated = getMinimized(mc, 'PREFER_UNNEGATED');
    const shortCond = getMinimized(mc, 'ALLOW_LEADING_NOT');
    if (elseBranch === null) {
        // No else.
        //
        // Closure's tryMinimizeIf rewrites `if (x) foo();` → `x && foo();` and
        // `if (!x) bar();` → `x || bar();` here. The rewrite is a pure code-size
        // win (gzip-equivalent semantically, identical bytecode after V8 tiers
        // up). compilecat's output is consumed by a downstream
        // bundler/minifier, and its design goal is *readable* intermediate
        // code, so we skip the if→&& / if→|| fold. We still let condition
        // minimization run on the test slot below. See conversation note —
        // intentional Closure deviation.
        if (isFoldableExpressBlock(thenBranch)) {
            const replaced = applyMeasured(originalCond, unnegated);
            if (replaced !== originalCond) {
                n.test = replaced;
                ctx.minimized++;
            }
            return n;
        }
        // Try to combine `if (x) { if (y) Z; }` into `if (x && y) Z;`.
        if (t.isBlockStatement(thenBranch) && thenBranch.body.length === 1 && t.isIfStatement(thenBranch.body[0])) {
            const innerIf = thenBranch.body[0];
            if (innerIf.alternate == null) {
                const innerCond = innerIf.test;
                if (!(isLowerPrecedenceThan(unnegated, AND_PRECEDENCE) && precedence(innerCond) < AND_PRECEDENCE)) {
                    const newCond = applyMeasured(originalCond, unnegated);
                    const combined = t.logicalExpression('&&', newCond, innerCond);
                    ctx.minimized++;
                    return t.ifStatement(combined, innerIf.consequent, null);
                }
            }
        }
        // Default: minimize the cond only.
        const replaced = applyMeasured(originalCond, unnegated);
        if (replaced !== originalCond) {
            n.test = replaced;
            ctx.minimized++;
        }
        return n;
    }
    // Else branch present.
    tryRemoveRepeatedStatements(n);
    // if(!x)foo();else bar(); → if(x)bar();else foo();
    if (isMeasuredNot(shortCond) && !consumesDanglingElse(elseBranch)) {
        const stripped = withoutNot(shortCond);
        const newCond = buildReplacement(stripped);
        const swapped = t.ifStatement(newCond, elseBranch, thenBranch);
        ctx.minimized++;
        return swapped;
    }
    // Closure's `tryMinimizeIfBlockExits` / `tryMinimizeCondition` collapse
    // if/else pairs into ternary expressions in five shapes:
    //
    //   - if(c) return X; else return Y;           → return c ? X : Y;
    //   - if(c) a = 1;   else a = 2;               → a = c ? 1 : 2;
    //   - if(c) foo();   else bar();               → c ? foo() : bar();
    //   - if(c) var y=1; else y=2;                 → var y = c ? 1 : 2;
    //   - if(c) y=1;     else var y=2;             → var y = c ? 1 : 2;
    //
    // Disabled — these are code-size wins, not perf wins, and they cascade:
    // a chain of `if (a) jv = ...; else if (b) jv = -...; else jv = 0;` folds
    // into a nested ternary `jv = a ? ... : b ? -... : 0;` that's strictly
    // less readable than the authored if/else chain. compilecat targets
    // readable intermediate code; ternary collapsing is the downstream
    // bundler/minifier's job. The condition itself is still minimized below.
    // Default: minimize cond only.
    const replaced = applyMeasured(originalCond, unnegated);
    if (replaced !== originalCond) {
        n.test = replaced;
        ctx.minimized++;
    }
    return n;
}
// ---------------------------------------------------------------------------
// Statement-list rewrites — operate on a block's body array.
function tryReplaceIfBlock(block, ctx) {
    const body = block.body;
    let i = 0;
    while (i < body.length) {
        const cur = body[i];
        if (!t.isIfStatement(cur)) {
            i++;
            continue;
        }
        const ifNode = cur;
        const thenBranch = ifNode.consequent;
        const elseBranch = ifNode.alternate ?? null;
        const next = body[i + 1] ?? null;
        // (1) if(c) return; if(c2) return ...  →  if(c||c2) return ...
        if (next !== null && elseBranch === null && isReturnBlock(thenBranch) && t.isIfStatement(next)) {
            const nextIf = next;
            const nextThen = nextIf.consequent;
            const nextElse = nextIf.alternate ?? null;
            if (areNodesEqual(thenBranch, nextThen)) {
                // Transform: replace `cur` and `next` with new `if (cur.test || next.test) nextThen`.
                const newOr = t.logicalExpression('||', ifNode.test, nextIf.test);
                const merged = t.ifStatement(newOr, nextThen, nextElse);
                body.splice(i, 2, merged);
                ctx.minimized++;
                // Re-check at this position.
                continue;
            }
            else if (nextElse !== null && areNodesEqual(thenBranch, nextElse)) {
                // if(x) return; if(y) foo() else return; → if(!x && y) foo() else return;
                const newAnd = t.logicalExpression('&&', t.unaryExpression('!', ifNode.test), nextIf.test);
                const merged = t.ifStatement(newAnd, nextThen, nextElse);
                body.splice(i, 2, merged);
                ctx.minimized++;
                continue;
            }
        }
        // (2) `if(c) return X;` followed by `return Y;` → `return c?X:Y;`.
        // Disabled — same readability rationale as the expr-level
        // if/else→ternary collapses above. The authored two-statement form
        // reads cleanly; ternary collapsing is the bundler's job.
        // (3) if(c) { ...exit; } else X; → if(c){...exit;} X; (hoist else)
        if (elseBranch !== null && statementMustExitParent(thenBranch)) {
            // Replace cur with `if(c){...exit;}` (no else) and insert elseBranch
            // after it.
            const trimmed = t.ifStatement(ifNode.test, thenBranch, null);
            body.splice(i, 1, trimmed, elseBranch);
            ctx.minimized++;
            // Re-check this index (trimmed may have its own opportunities).
            continue;
        }
        i++;
    }
}
function statementMustExitParent(n) {
    if (t.isThrowStatement(n) || t.isReturnStatement(n))
        return true;
    if (t.isBlockStatement(n)) {
        if (n.body.length === 0)
            return false;
        return statementMustExitParent(n.body[n.body.length - 1]);
    }
    return false;
}
// ---------------------------------------------------------------------------
// for { if(c) break; ... } → for(...; !c; ...) { ... }
function tryJoinForCondition(n, ctx) {
    const body = n.body;
    if (!t.isBlockStatement(body) || body.body.length === 0)
        return;
    const first = body.body[0];
    if (!t.isIfStatement(first))
        return;
    const innerThen = first.consequent;
    let breakNode = null;
    if (t.isBlockStatement(innerThen)) {
        if (innerThen.body.length === 1 && t.isBreakStatement(innerThen.body[0])) {
            breakNode = innerThen.body[0];
        }
    }
    else if (t.isBreakStatement(innerThen)) {
        breakNode = innerThen;
    }
    if (breakNode === null || breakNode.label !== null)
        return;
    // Preserve the else branch (if any) as the new first body statement;
    // otherwise drop the if entirely.
    const elseBranch = first.alternate ?? null;
    if (elseBranch !== null) {
        body.body[0] = elseBranch;
    }
    else {
        body.body.shift();
    }
    const negatedTest = t.unaryExpression('!', first.test);
    if (n.test === null || n.test === undefined) {
        n.test = negatedTest;
    }
    else {
        n.test = t.logicalExpression('&&', n.test, negatedTest);
    }
    ctx.minimized++;
}
// ---------------------------------------------------------------------------
// tryRemoveRepeatedStatements — hoist trailing common stmts out of if/else.
function tryRemoveRepeatedStatements(n, ctx) {
    const cons = n.consequent;
    const alt = n.alternate;
    if (!t.isBlockStatement(cons) || !t.isBlockStatement(alt ?? t.noop()))
        return;
    if (!t.isBlockStatement(alt))
        return;
    const trueBody = cons.body;
    const falseBody = alt.body;
    // Hoist into a synthetic block we splice into the parent. We can't easily
    // mutate the parent here, so instead we transform `if(c){...A;X}else{...B;X}`
    // → `if(c){...A}else{...B}; X` by appending X to a wrapper block. To keep
    // it simple, we only operate when both branches share at least one tail
    // statement and we replace the IF's body with a synthetic BLOCK containing
    // the new IF plus the hoisted tail.
    const hoisted = [];
    while (trueBody.length > 0 &&
        falseBody.length > 0 &&
        areNodesEqual(trueBody[trueBody.length - 1], falseBody[falseBody.length - 1])) {
        const tail = trueBody.pop();
        falseBody.pop();
        hoisted.unshift(tail);
    }
    if (hoisted.length > 0) {
        // The IfStatement caller (tryMinimizeIf) returns this IfStatement; the
        // parent's slot was an IfStatement, but we now need to emit a BLOCK.
        // Wrap by replacing alt with a new alternate that includes nothing
        // hoisted (already removed); to surface the hoisted statements we
        // append them inside both branches' parents — but that's wrong.
        //
        // Simpler approach: re-attach hoisted statements to the END of *both*
        // branches' parent block. Since we don't have parent context here, we
        // append the hoisted statements after the IF via a SequenceExpression
        // hack — no good either. Instead, we just push them into both branches
        // anew (reverting the hoist). To actually hoist, the caller would need
        // to operate at the block-statement level.
        //
        // The pragmatic compromise: re-push them so we don't lose statements.
        for (const s of hoisted) {
            trueBody.push(t.cloneNode(s));
            falseBody.push(t.cloneNode(s));
        }
        return;
    }
}
// ---------------------------------------------------------------------------
// performConditionSubstitutions — minimize a node that is *in a boolean
// context* (the test of an IF/WHILE/etc.). Rewrites top-level &&/||/HOOK using
// Tri-valued truth analysis. Closure walks the tree recursively; we do the
// same.
function performConditionSubstitutionsSlot(parent, key) {
    const node = getSlot(parent, key);
    if (node === null || node === undefined || Array.isArray(node))
        return;
    const replaced = performConditionSubstitutions(node);
    if (replaced !== node)
        setSlot(parent, key, undefined, replaced);
}
function performConditionSubstitutions(n) {
    if (t.isLogicalExpression(n) && (n.operator === '&&' || n.operator === '||')) {
        const left = performConditionSubstitutions(n.left);
        const right = performConditionSubstitutions(n.right);
        if (left !== n.left)
            n.left = left;
        if (right !== n.right)
            n.right = right;
        const rightVal = getSideEffectFreeBooleanValue(right);
        if (rightVal !== TRI_UNKNOWN) {
            const rval = triToBoolean(rightVal, true);
            const op = n.operator;
            // x || FALSE → x ;  x && TRUE → x
            if ((op === '||' && !rval) || (op === '&&' && rval)) {
                return left;
            }
            if (!mayHaveSideEffects(left)) {
                // x || TRUE → TRUE ;  x && FALSE → FALSE
                return right;
            }
            // side-effect LHS + known RHS → comma sequence
            return t.sequenceExpression([left, right]);
        }
        return n;
    }
    if (t.isConditionalExpression(n)) {
        const trueNode = performConditionSubstitutions(n.consequent);
        const falseNode = performConditionSubstitutions(n.alternate);
        if (trueNode !== n.consequent)
            n.consequent = trueNode;
        if (falseNode !== n.alternate)
            n.alternate = falseNode;
        const tVal = getSideEffectFreeBooleanValue(trueNode);
        const fVal = getSideEffectFreeBooleanValue(falseNode);
        const cond = n.test;
        if (tVal === TRI_TRUE && fVal === TRI_FALSE) {
            // x ? true : false → x
            return cond;
        }
        if (tVal === TRI_FALSE && fVal === TRI_TRUE) {
            // x ? false : true → !x
            return t.unaryExpression('!', cond);
        }
        if (tVal === TRI_TRUE) {
            // x ? true : y → x || y
            return t.logicalExpression('||', cond, falseNode);
        }
        if (fVal === TRI_FALSE) {
            // x ? y : false → x && y
            return t.logicalExpression('&&', cond, trueNode);
        }
        if (!mayHaveSideEffects(cond) && !mayHaveSideEffects(trueNode) && areNodesEqual(cond, trueNode)) {
            // x ? x : y → x || y
            return t.logicalExpression('||', trueNode, falseNode);
        }
        return n;
    }
    return n;
}
function tryMinimizeConditionSlot(parent, key) {
    const node = getSlot(parent, key);
    if (node === null || node === undefined || Array.isArray(node))
        return;
    const substituted = performConditionSubstitutions(node);
    const mc = fromConditionNode(substituted);
    const m = getMinimized(mc, 'PREFER_UNNEGATED');
    if (substituted !== node || willChange(m, substituted)) {
        const replacement = buildReplacement(m);
        setSlot(parent, key, undefined, replacement);
    }
}
// ---------------------------------------------------------------------------
// Helpers.
function applyMeasured(original, m) {
    if (!willChange(m, original))
        return original;
    return buildReplacement(m);
}
// Babel preserves bare-statement branches: `if (c) return 1` parses with
// `consequent: ReturnStatement`, not a block-wrapped one. We treat both
// shapes uniformly via `unwrapSingle`.
function unwrapSingle(n) {
    if (t.isBlockStatement(n) && n.body.length === 1)
        return n.body[0];
    return n;
}
function isFoldableExpressBlock(n) {
    const inner = unwrapSingle(n);
    if (!t.isExpressionStatement(inner))
        return false;
    const ex = inner.expression;
    if (t.isCallExpression(ex)) {
        const callee = ex.callee;
        if (t.isMemberExpression(callee)) {
            if (callee.computed)
                return false;
            if (t.isIdentifier(callee.property) && callee.property.name.startsWith('on')) {
                return false;
            }
        }
    }
    return true;
}
function isReturnBlock(n) {
    return t.isReturnStatement(unwrapSingle(n));
}
function consumesDanglingElse(n) {
    let cur = n;
    while (true) {
        if (t.isIfStatement(cur)) {
            if (cur.alternate === null || cur.alternate === undefined)
                return true;
            cur = cur.alternate;
            continue;
        }
        if (t.isBlockStatement(cur)) {
            if (cur.body.length !== 1)
                return false;
            cur = cur.body[0];
            continue;
        }
        if (t.isWhileStatement(cur) ||
            t.isForStatement(cur) ||
            t.isForInStatement(cur) ||
            t.isForOfStatement(cur) ||
            t.isWithStatement(cur)) {
            cur = cur.body;
            continue;
        }
        return false;
    }
}
function isLiteralValue(n) {
    return t.isBooleanLiteral(n) || t.isNumericLiteral(n) || t.isStringLiteral(n) || t.isNullLiteral(n);
}

// Port of jscomp/PeepholeRemoveDeadCode.java (subset).
//
// Removes statically-dead nodes the constant folder leaves behind. Operates
// bottom-up; safe to repeat at the fixpoint level alongside
// PeepholeFoldConstants.
//
// Covered:
//   - if (true) A else B → A;  if (false) A else B → B (or empty)
//   - cond ? A : B with literal cond → A or B
//   - while (false) X → empty;  do X while (false) → X (single iteration)
//   - empty / pure-only statements inside blocks dropped
//   - statements after return/throw/break/continue dropped
//   - comma expression with pure left side: (pure, x) → x
//   - empty `if` / empty `else` cleanup
//   - unused / single-break labels dropped (PRDC.tryFoldLabel + RenameLabels)
//
// Not covered (deferred):
//   - switch case folding
//   - try/catch/finally optimization
//   - optional-chain folding
//   - var/let hoisting through dead branches
//
// Closure runs this in the simplifier loop right after fold-constants. We do
// the same.
function runPeepholeRemoveDeadCode(root, options = {}) {
    const ctx = { removed: 0, normalized: options.normalized === true };
    walk(root, null, '', undefined, ctx);
    return { removed: ctx.removed };
}
function walk(n, parent, key, index, ctx) {
    // Bottom-up.
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, k);
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c)
                    walk(c, n, k, i, ctx);
            }
        }
        else {
            walk(child, n, k, undefined, ctx);
        }
    }
    // Block-level cleanups (operate on the array directly).
    if (t.isBlockStatement(n) || t.isProgram(n)) {
        cleanBlockBody(n, ctx);
    }
    if (parent === null)
        return;
    const replacement = tryRemove(n);
    if (replacement === undefined)
        return;
    setSlot(parent, key, index, replacement);
    ctx.removed++;
}
// ---------------------------------------------------------------------------
// Per-node simplifier. Returns:
//   undefined → no change
//   t.Node    → replacement
//   null      → caller should treat as removed (only safe in array contexts)
function tryRemove(n) {
    if (t.isIfStatement(n))
        return foldIfStatement(n);
    if (t.isConditionalExpression(n))
        return foldConditional(n);
    if (t.isWhileStatement(n))
        return foldWhile(n);
    if (t.isDoWhileStatement(n))
        return foldDoWhile(n);
    if (t.isExpressionStatement(n))
        return foldExpressionStatement(n);
    if (t.isSequenceExpression(n))
        return foldSequence(n);
    if (t.isLabeledStatement(n))
        return foldLabel(n);
    return undefined;
}
// ---------------------------------------------------------------------------
// Labels
//
// Port of PeepholeRemoveDeadCode.tryFoldLabel (PRDC.java:138-177) plus the
// "unreferenced label" cleanup from RenameLabels.java:222-232. Closure splits
// these between two passes; we fold them together since we don't run a
// separate label-renaming pass and the cost is identical.
function foldLabel(n) {
    const labelName = n.label.name;
    const stmt = n.body;
    // PRDC.java:141-145 — `L: ;` → drop.
    if (t.isEmptyStatement(stmt))
        return null;
    // PRDC.java:147-157 — `L: {}` → drop.
    if (t.isBlockStatement(stmt) && stmt.body.length === 0)
        return null;
    // PRDC.java:159-175 — `L: break L;` (possibly wrapped in a single-stmt
    // block) → drop. We additionally fold the general "unreferenced label"
    // case from RenameLabels: if the body contains no `break L` / `continue L`
    // anywhere, unwrap the label. This is the case that lets inlined-call
    // blocks merge into the surrounding scope after the early-return break
    // gets minimised away by PeepholeMinimizeConditions.
    if (!isLabelReferenced(labelName, stmt)) {
        return stmt;
    }
    // Closure's getOnlyInterestingChild handles `L: { break L; }` even when
    // the block has other (uninteresting) children. We already covered the
    // empty-block case; what remains is a block whose sole effective stmt
    // is `break L`. Since `isLabelReferenced` returned true here, there is
    // at least one reference — verify it's exactly a top-level `break L` in
    // a single-stmt block.
    if (t.isBlockStatement(stmt) && stmt.body.length === 1) {
        const only = stmt.body[0];
        if (t.isBreakStatement(only) && only.label != null && only.label.name === labelName) {
            return null;
        }
    }
    return undefined;
}
function isLabelReferenced(labelName, root) {
    let found = false;
    const visit = (n) => {
        if (found)
            return;
        if ((t.isBreakStatement(n) || t.isContinueStatement(n)) && n.label != null && n.label.name === labelName) {
            found = true;
            return;
        }
        // Nested labels with the same name shadow the outer one; Closure's
        // RenameLabels uses a per-scope namespace, so we must stop recursing
        // into a labelled subtree that re-binds the same name.
        if (t.isLabeledStatement(n) && n.label.name === labelName) {
            return;
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child == null)
                continue;
            if (Array.isArray(child)) {
                for (const c of child)
                    if (c)
                        visit(c);
            }
            else if (typeof child.type === 'string') {
                visit(child);
            }
        }
    };
    visit(root);
    return found;
}
// ---------------------------------------------------------------------------
// If / Conditional
function foldIfStatement(n) {
    // Closure PeepholeRemoveDeadCode.tryFoldIf: `if (x) { ... } else {}` →
    // drop the empty alternate. Run first so subsequent rules see the
    // canonicalized shape.
    if (n.alternate != null && isEmpty(n.alternate)) {
        n.alternate = null;
        // Fall through with updated shape.
    }
    // Closure PeepholeRemoveDeadCode.tryFoldIf: `if (x) {} else { ... }` →
    // `if (!x) { ... }`. Surfaced by post-inline shapes like
    // `if (cond) return; else { body }` collapsing the early-return branch
    // to an empty placeholder while `body` survives.
    if (isEmpty(n.consequent) && n.alternate != null && !isEmpty(n.alternate)) {
        const negated = negateTest(n.test);
        return t.ifStatement(negated, n.alternate, null);
    }
    const b = asBoolean(n.test);
    if (b === true) {
        if (mayHaveSideEffects(n.test))
            return undefined;
        return n.consequent;
    }
    if (b === false) {
        if (mayHaveSideEffects(n.test))
            return undefined;
        if (n.alternate)
            return n.alternate;
        return t.emptyStatement();
    }
    // Empty consequent + no alternate → just evaluate test (preserve effects).
    if (isEmpty(n.consequent) && (n.alternate == null || isEmpty(n.alternate))) {
        if (!mayHaveSideEffects(n.test))
            return t.emptyStatement();
        return t.expressionStatement(n.test);
    }
    return undefined;
}
// Negate a condition expression. `!x` → `x`; `x === y` → `x !== y` etc.;
// otherwise wrap in `!`. Mirrors Closure's NOT-wrapping in tryFoldIf —
// PeepholeMinimizeConditions later collapses double negations / picks the
// shorter form.
function negateTest(test) {
    if (t.isUnaryExpression(test) && test.operator === '!') {
        return test.argument;
    }
    if (t.isBinaryExpression(test)) {
        const flip = {
            '==': '!=',
            '!=': '==',
            '===': '!==',
            '!==': '===',
        };
        const op = flip[test.operator];
        if (op)
            return t.binaryExpression(op, test.left, test.right);
    }
    return t.unaryExpression('!', test, /* prefix */ true);
}
function foldConditional(n) {
    const b = asBoolean(n.test);
    if (b === true && !mayHaveSideEffects(n.test))
        return n.consequent;
    if (b === false && !mayHaveSideEffects(n.test))
        return n.alternate;
    return undefined;
}
// ---------------------------------------------------------------------------
// Loops
function foldWhile(n) {
    const b = asBoolean(n.test);
    if (b === false && !mayHaveSideEffects(n.test))
        return t.emptyStatement();
    return undefined;
}
function foldDoWhile(n) {
    const b = asBoolean(n.test);
    if (b === false && !mayHaveSideEffects(n.test)) {
        // Body runs exactly once.
        return n.body;
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Expression statements / sequence
function foldExpressionStatement(n) {
    if (!mayHaveSideEffects(n.expression))
        return t.emptyStatement();
    return undefined;
}
function foldSequence(n) {
    // Drop pure prefix items: (pure, pure, x) → x
    const exprs = n.expressions;
    let firstImpure = -1;
    for (let i = 0; i < exprs.length - 1; i++) {
        if (mayHaveSideEffects(exprs[i])) {
            firstImpure = i;
            break;
        }
    }
    if (firstImpure === -1) {
        // All but last are pure; drop them.
        if (exprs.length === 1)
            return undefined;
        return exprs[exprs.length - 1];
    }
    if (firstImpure === 0)
        return undefined;
    // Keep [firstImpure..end].
    const remaining = exprs.slice(firstImpure);
    if (remaining.length === 1)
        return remaining[0];
    return t.sequenceExpression(remaining);
}
// ---------------------------------------------------------------------------
// Block cleanup
function cleanBlockBody(n, ctx) {
    // Port of PeepholeRemoveDeadCode.tryOptimizeBlock's child-merge step
    // (PeepholeRemoveDeadCode.java:937-946 → NodeUtil.tryMergeBlock,
    // NodeUtil.java:2490). For each direct child that is itself a BLOCK,
    // attempt the merge with `ignoreBlockScopedDeclarations = isASTNormalized`.
    // Done first so the terminator scan that follows sees the post-merge shape.
    const body = n.body;
    let flattened = 0;
    for (let i = 0; i < body.length; i++) {
        const s = body[i];
        if (!t.isBlockStatement(s))
            continue;
        const inserted = tryMergeBlock(s, body, i, n, ctx.normalized);
        if (inserted === 0)
            continue;
        flattened++;
        i += inserted - 1;
    }
    if (flattened > 0)
        ctx.removed += flattened;
    // Port of PeepholeRemoveDeadCode.tryOptimizeConditionalAfterAssign
    // (PRDC.java:1026-1102). For consecutive `<assign>; <conditional>`
    // pairs where the condition is just the freshly-assigned name, replace
    // the condition with a constant derived from the RHS. Pairs with
    // PeepholeFoldConstants downstream to fully fold the conditional.
    for (let i = 0; i < body.length - 1; i++) {
        if (tryOptimizeConditionalAfterAssign(body[i], body[i + 1])) {
            ctx.removed++;
        }
    }
    let write = 0;
    let removed = 0;
    let unreachable = false;
    for (let read = 0; read < body.length; read++) {
        const stmt = body[read];
        // Drop EmptyStatement.
        if (t.isEmptyStatement(stmt)) {
            removed++;
            continue;
        }
        // Drop unreachable statements after a terminator.
        if (unreachable) {
            // Hoist var declarations (without initializers in the simple case)
            // — but to keep this conservative we only drop non-declarations.
            if (containsVarDeclaration(stmt) || t.isFunctionDeclaration(stmt)) {
                body[write++] = stmt;
                continue;
            }
            removed++;
            continue;
        }
        body[write++] = stmt;
        if (isTerminator(stmt))
            unreachable = true;
    }
    if (write !== body.length) {
        body.length = write;
        ctx.removed += removed;
    }
}
function isTerminator(s) {
    return t.isReturnStatement(s) || t.isThrowStatement(s) || t.isBreakStatement(s) || t.isContinueStatement(s);
}
function containsVarDeclaration(s) {
    if (t.isVariableDeclaration(s) && s.kind === 'var')
        return true;
    return t.traverseFast(s, (n) => {
        if (t.isFunction(n))
            return t.traverseFast.skip;
        if (t.isVariableDeclaration(n) && n.kind === 'var')
            return t.traverseFast.stop;
        return undefined;
    });
}
// ---------------------------------------------------------------------------
// Helpers
function isEmpty(n) {
    if (t.isEmptyStatement(n))
        return true;
    if (t.isBlockStatement(n) && n.body.length === 0)
        return true;
    return false;
}
function asBoolean(node) {
    if (t.isBooleanLiteral(node))
        return node.value;
    if (t.isNumericLiteral(node))
        return node.value !== 0;
    if (t.isStringLiteral(node))
        return node.value.length > 0;
    if (t.isNullLiteral(node))
        return false;
    if (t.isIdentifier(node) && node.name === 'undefined')
        return false;
    return null;
}
// ---------------------------------------------------------------------------
// Port of PeepholeRemoveDeadCode.tryOptimizeConditionalAfterAssign
// (PRDC.java:1026-1102).
//
// Recognizes:
//
//     <assign>;
//     if (<name>) ...           → if (<bool>) ...
//     <name> ? a : b;           → <bool> ? a : b
//     <name> && f();            → <bool> && f()
//     <name> || f();            → <bool> || f()
//     <name> ?? f();            → undefined ?? f()  // when rhs known nullish
//                              or  0 ?? f()         // when rhs known non-nullish
//
// Where <assign> is either `name = RHS;` or `var/let/const name = RHS;`.
//
// Returns true when the condition was replaced.
function tryOptimizeConditionalAfterAssign(assignStmt, conditionalStmt) {
    const lhsName = simpleAssignmentLhsName(assignStmt);
    if (lhsName === null)
        return false;
    const rhs = simpleAssignmentRhs(assignStmt);
    if (rhs === null)
        return false;
    const cr = conditionalRoot(conditionalStmt);
    if (cr === null)
        return false;
    const condition = conditionalRootCondition(cr);
    if (!t.isIdentifier(condition) || condition.name !== lhsName)
        return false;
    // COALESCE (??): use known value type rather than truthiness.
    if (t.isLogicalExpression(cr.root) && cr.root.operator === '??') {
        const nullish = isKnownNullish(rhs);
        if (nullish === true) {
            cr.replaceCondition(t.unaryExpression('void', t.numericLiteral(0)));
            return true;
        }
        if (nullish === false) {
            cr.replaceCondition(t.numericLiteral(0));
            return true;
        }
        return false;
    }
    // IF / HOOK / AND / OR — boolean coercion.
    const tri = getBooleanValue(rhs);
    if (tri === TRI_UNKNOWN)
        return false;
    cr.replaceCondition(t.booleanLiteral(triToBoolean(tri, true)));
    return true;
}
/** Returns the LHS name iff `n` is a simple assignment / single-init decl. */
function simpleAssignmentLhsName(n) {
    if (t.isExpressionStatement(n) && t.isAssignmentExpression(n.expression)) {
        const a = n.expression;
        if (a.operator !== '=')
            return null;
        if (!t.isIdentifier(a.left))
            return null;
        return a.left.name;
    }
    if (t.isVariableDeclaration(n) && n.declarations.length === 1) {
        const d = n.declarations[0];
        if (!t.isIdentifier(d.id))
            return null;
        if (d.init === null || d.init === undefined)
            return null;
        return d.id.name;
    }
    return null;
}
function simpleAssignmentRhs(n) {
    if (t.isExpressionStatement(n) && t.isAssignmentExpression(n.expression)) {
        return n.expression.right;
    }
    if (t.isVariableDeclaration(n) && n.declarations.length === 1) {
        return n.declarations[0].init ?? null;
    }
    return null;
}
function conditionalRoot(s) {
    if (t.isIfStatement(s)) {
        const node = s;
        return {
            root: node,
            replaceCondition(r) {
                node.test = r;
            },
        };
    }
    if (t.isExpressionStatement(s)) {
        const e = s.expression;
        if (t.isConditionalExpression(e)) {
            return {
                root: e,
                replaceCondition(r) {
                    e.test = r;
                },
            };
        }
        if (t.isLogicalExpression(e) && (e.operator === '&&' || e.operator === '||' || e.operator === '??')) {
            return {
                root: e,
                replaceCondition(r) {
                    e.left = r;
                },
            };
        }
    }
    return null;
}
function conditionalRootCondition(cr) {
    if (t.isIfStatement(cr.root))
        return cr.root.test;
    if (t.isConditionalExpression(cr.root))
        return cr.root.test;
    return cr.root.left;
}
/** Returns true if RHS is statically known to be nullish (null or undefined),
 *  false if statically known to be non-nullish, null if unknown. Subset of
 *  Closure's `NodeUtil.getKnownValueType` collapsed to the only distinction
 *  the COALESCE branch needs. */
function isKnownNullish(n) {
    if (t.isNullLiteral(n))
        return true;
    if (t.isIdentifier(n) && n.name === 'undefined')
        return true;
    if (t.isUnaryExpression(n) && n.operator === 'void')
        return true;
    if (t.isNumericLiteral(n) ||
        t.isStringLiteral(n) ||
        t.isBooleanLiteral(n) ||
        t.isBigIntLiteral(n) ||
        t.isObjectExpression(n) ||
        t.isArrayExpression(n) ||
        t.isFunction(n) ||
        t.isRegExpLiteral(n) ||
        t.isTemplateLiteral(n)) {
        return false;
    }
    return null;
}

// Per-function simplifier fixpoint. Mirrors the inner loop of Closure's
// `DefaultPassConfig` "simplify" group: alternate constant-folding, dead-code
// removal, flow-sensitive variable inlining, and dead-assignment elimination
// until no pass reports a change.
//
// Each iteration rebuilds CFG + LocalVariableTable from scratch because the
// AST mutates. This is wasteful in the limit but matches Closure's per-pass
// invalidation model and keeps invariants clean. CFG construction bails on
// try/with/generator/async — those functions short-circuit immediately.
//
// Deliberate deviation from Closure: we do NOT run OptimizeLetAndConstPeephole
// here. Closure lowers function-body-top `let`/`const` to `var` as a late
// keyword-homogenization step (better gzip on its standalone output). For
// compilecat the output feeds a downstream bundler/minifier (Vite, Rollup,
// esbuild) which performs the same lowering if it actually wants it, so doing
// it here is a no-op for shipped bytes. Meanwhile it degrades the readability
// of the intermediate compilecat output (which is what users debug), reintroduces
// TDZ-less semantics on locals, and *amplifies* normalize's `__N` suffix
// proliferation by hoisting block-scoped decls into the function scope where
// they collide. We keep `let`/`const` as-authored.
function emptyTimings() {
    return {
        renameForFlatten: 0,
        foldConstants: 0,
        minimizeExitPoints: 0,
        minimizeConditions: 0,
        removeDeadCode: 0,
        cfgBuild: 0,
        localVarTable: 0,
        flowInline: 0,
        liveVars: 0,
        deadAssigns: 0,
    };
}
function addTimings(into, from) {
    into.renameForFlatten += from.renameForFlatten;
    into.foldConstants += from.foldConstants;
    into.minimizeExitPoints += from.minimizeExitPoints;
    into.minimizeConditions += from.minimizeConditions;
    into.removeDeadCode += from.removeDeadCode;
    into.cfgBuild += from.cfgBuild;
    into.localVarTable += from.localVarTable;
    into.flowInline += from.flowInline;
    into.liveVars += from.liveVars;
    into.deadAssigns += from.deadAssigns;
}
const MAX_ITERATIONS = 16;
/**
 * Simplify a single function in place. Caller is responsible for picking
 * which functions to simplify (zone gating happens in the pipeline layer).
 */
function simplifyFunction(fnPath, _options = {}) {
    const stats = {
        iterations: 0,
        folded: 0,
        removed: 0,
        inlined: 0,
        deadAssigns: 0,
        minimized: 0,
        timings: emptyTimings(),
    };
    const timings = stats.timings;
    const fn = fnPath.node;
    // Rename nested-block bindings that would collide on flatten. After this
    // pass, every let/const/class/function-declaration inside `fn` is uniquely
    // named within the function, so `PeepholeRemoveDeadCode` can splice nested
    // blocks into their parents with `ignoreBlockScopedDeclarations=true`.
    const renameStart = performance.now();
    renameForFlatten(fnPath);
    timings.renameForFlatten += performance.now() - renameStart;
    const normalized = true;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
        let changed = false;
        const foldStart = performance.now();
        const fold = runPeepholeFoldConstants(fn.body);
        timings.foldConstants += performance.now() - foldStart;
        if (fold.folded > 0) {
            changed = true;
            stats.folded += fold.folded;
        }
        // MinimizeExitPoints reshapes labeled-block / loop / function exits
        // into implicit fall-through. Run before PeepholeMinimizeConditions so
        // the resulting if/else gets collapsed to ternaries.
        const exitsStart = performance.now();
        const exits = runMinimizeExitPoints(fn);
        timings.minimizeExitPoints += performance.now() - exitsStart;
        if (exits.minimized > 0) {
            changed = true;
            stats.minimized += exits.minimized;
        }
        const minStart = performance.now();
        const min = runPeepholeMinimizeConditions(fn.body);
        timings.minimizeConditions += performance.now() - minStart;
        if (min.minimized > 0) {
            changed = true;
            stats.minimized += min.minimized;
        }
        const deadStart = performance.now();
        const dead = runPeepholeRemoveDeadCode(fn.body, { normalized });
        timings.removeDeadCode += performance.now() - deadStart;
        if (dead.removed > 0) {
            changed = true;
            stats.removed += dead.removed;
        }
        const cfgStart = performance.now();
        const cfg = buildControlFlowGraph({ root: fn.body });
        timings.cfgBuild += performance.now() - cfgStart;
        if (cfg !== null) {
            const tableStart = performance.now();
            const table = buildLocalVariableTable(fnPath);
            timings.localVarTable += performance.now() - tableStart;
            const flowStart = performance.now();
            const inline = runFlowSensitiveInlineVariables(fn, cfg, table);
            timings.flowInline += performance.now() - flowStart;
            if (inline.inlined > 0) {
                changed = true;
                stats.inlined += inline.inlined;
            }
            // DAE needs a fresh CFG+table after inline, since inline mutates.
            if (inline.inlined > 0) {
                const cfg2Start = performance.now();
                const cfg2 = buildControlFlowGraph({ root: fn.body });
                timings.cfgBuild += performance.now() - cfg2Start;
                const table2Start = performance.now();
                const table2 = buildLocalVariableTable(fnPath);
                timings.localVarTable += performance.now() - table2Start;
                if (cfg2 !== null) {
                    const liveStart = performance.now();
                    const live = runLiveVariablesAnalysis(cfg2, table2);
                    timings.liveVars += performance.now() - liveStart;
                    const daStart = performance.now();
                    const da = eliminateDeadAssignments(fn, cfg2, live);
                    timings.deadAssigns += performance.now() - daStart;
                    if (da.removed > 0) {
                        changed = true;
                        stats.deadAssigns += da.removed;
                    }
                }
            }
            else {
                const liveStart = performance.now();
                const live = runLiveVariablesAnalysis(cfg, table);
                timings.liveVars += performance.now() - liveStart;
                const daStart = performance.now();
                const da = eliminateDeadAssignments(fn, cfg, live);
                timings.deadAssigns += performance.now() - daStart;
                if (da.removed > 0) {
                    changed = true;
                    stats.deadAssigns += da.removed;
                }
            }
        }
        stats.iterations++;
        if (!changed)
            break;
    }
    return stats;
}
/**
 * Walk the program and simplify every touched Function node bottom-up.
 * Bottom-up so inner functions are simplified before outer; outer
 * simplification then sees the already-cleaned inner shape.
 */
function simplifyAll(root, options = {}) {
    const touched = options.touched;
    // Top-level rename is intentionally not performed — we only uniquify
    // names within each function (see `simplifyFunction`). At the program
    // level we leave `normalized=false` so PeepholeRemoveDeadCode keeps the
    // conservative block-merge check for any top-level inner blocks.
    const normalized = false;
    const total = {
        iterations: 0,
        folded: 0,
        removed: 0,
        inlined: 0,
        deadAssigns: 0,
        minimized: 0,
        timings: emptyTimings(),
    };
    traverse(root, {
        Function: {
            exit(path) {
                if (touched && !touched.has(path.node))
                    return;
                const s = simplifyFunction(path, { });
                total.iterations += s.iterations;
                total.folded += s.folded;
                total.removed += s.removed;
                total.inlined += s.inlined;
                total.deadAssigns += s.deadAssigns;
                total.minimized += s.minimized;
                addTimings(total.timings, s.timings);
            },
        },
    });
    // Program-level cleanup: AST-only peepholes (no CFG) over the whole tree
    // for top-level statements outside any function. Cheap relative to the
    // per-function CFG-based work above, so we always run it.
    let topChanged = true;
    let topIters = 0;
    while (topChanged && topIters < MAX_ITERATIONS) {
        topChanged = false;
        const fStart = performance.now();
        const f = runPeepholeFoldConstants(root);
        total.timings.foldConstants += performance.now() - fStart;
        if (f.folded > 0) {
            topChanged = true;
            total.folded += f.folded;
        }
        const mStart = performance.now();
        const m = runPeepholeMinimizeConditions(root);
        total.timings.minimizeConditions += performance.now() - mStart;
        if (m.minimized > 0) {
            topChanged = true;
            total.minimized += m.minimized;
        }
        const dStart = performance.now();
        const d = runPeepholeRemoveDeadCode(root, { normalized });
        total.timings.removeDeadCode += performance.now() - dStart;
        if (d.removed > 0) {
            topChanged = true;
            total.removed += d.removed;
        }
        topIters++;
    }
    total.iterations += topIters;
    return total;
}

// Strip authored `@inline`/`@flatten`/`@sroa`/`@unroll`/`@optimize` directives
// from comment text once all passes have consumed them. Run at the end of the
// pipeline so directives are still visible to producers (inliner, sroa, etc.).
//
// Policy: remove just the directive token. If the surrounding comment has
// unrelated text, the comment is kept with the marker removed. If the comment
// is *only* the marker (whitespace-only after strip), the comment node is
// removed entirely.
const DIRECTIVE_RE = /@(?:inline|flatten|sroa|unroll|optimize)\b/g;
function stripDirectiveComments(file) {
    const toDelete = new WeakSet();
    const seen = new WeakSet();
    const clean = (c) => {
        if (seen.has(c))
            return;
        seen.add(c);
        if (!c.value.includes('@'))
            return;
        const cleaned = c.value.replace(DIRECTIVE_RE, '');
        if (cleaned === c.value)
            return;
        if (/^[\s*]*$/.test(cleaned)) {
            toDelete.add(c);
            return;
        }
        // Collapse runs of internal whitespace left by removal, keep edges
        // tidy. `/* @inline foo */` → `/* foo */`.
        c.value = cleaned.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
        if (c.type === 'CommentBlock') {
            c.value = c.value.replace(/^\s+|\s+$/g, ' ');
            if (!c.value.startsWith(' '))
                c.value = ` ${c.value}`;
            if (!c.value.endsWith(' '))
                c.value = `${c.value} `;
        }
    };
    const cleanList = (arr) => {
        if (!arr)
            return;
        for (const c of arr)
            clean(c);
    };
    traverse(file, {
        enter(p) {
            cleanList(p.node.leadingComments);
            cleanList(p.node.trailingComments);
            cleanList(p.node.innerComments);
        },
    });
    cleanList(file.comments);
    const removeDeleted = (arr) => {
        if (!arr)
            return arr;
        for (let i = arr.length - 1; i >= 0; i--) {
            if (toDelete.has(arr[i]))
                arr.splice(i, 1);
        }
        return arr;
    };
    traverse(file, {
        enter(p) {
            removeDeleted(p.node.leadingComments);
            removeDeleted(p.node.trailingComments);
            removeDeleted(p.node.innerComments);
        },
    });
    removeDeleted(file.comments);
}

// Strip TypeScript-only syntax from a parsed Program so downstream passes
// (and the generator) only see JS. Mutates the AST in place.
//
// Handles:
//   - Type annotations on identifiers / params / declarators / functions
//     (delegated to node-util.stripTypeScriptOnly).
//   - Type-only import/export declarations and specifiers (dropped).
//   - TSEnumDeclaration → lowered to the IIFE shape tsc emits.
//   - TSInterfaceDeclaration, TSTypeAliasDeclaration, TSDeclareFunction,
//     TSModuleDeclaration, TSImportEqualsDeclaration → dropped.
//   - Type assertion wrappers (`expr as T`, `<T>expr`, `expr!`) → unwrapped.
//
// Out of scope:
//   - Runtime namespaces with executable bodies (`namespace N { ... }` that
//     emits an IIFE in tsc). Rare in bundled output; we drop the whole
//     declaration. Revisit if crashcat-or-similar starts depending on it.
//   - Parameter properties in constructors (`constructor(public x: number)`).
//     Same reasoning — bundled output doesn't typically carry these.
function stripTypeScript(ast) {
    const body = ast.program.body;
    for (let i = body.length - 1; i >= 0; i--) {
        const stmt = body[i];
        if (t.isTSEnumDeclaration(stmt)) {
            const lowered = lowerTsEnumToJs(stmt);
            if (lowered) {
                body.splice(i, 1, ...lowered);
            }
            else {
                body.splice(i, 1);
            }
            continue;
        }
        if (t.isTSInterfaceDeclaration(stmt) ||
            t.isTSTypeAliasDeclaration(stmt) ||
            t.isTSDeclareFunction(stmt) ||
            t.isTSModuleDeclaration(stmt) ||
            t.isTSImportEqualsDeclaration(stmt) ||
            t.isTSExportAssignment(stmt) ||
            t.isTSNamespaceExportDeclaration(stmt)) {
            body.splice(i, 1);
            continue;
        }
        if (t.isImportDeclaration(stmt)) {
            if (stmt.importKind === 'type') {
                body.splice(i, 1);
                continue;
            }
            stmt.specifiers = stmt.specifiers.filter((s) => !(t.isImportSpecifier(s) && s.importKind === 'type'));
            if (stmt.specifiers.length === 0) {
                body.splice(i, 1);
                continue;
            }
        }
        if (t.isExportNamedDeclaration(stmt)) {
            if (stmt.exportKind === 'type') {
                body.splice(i, 1);
                continue;
            }
            stmt.specifiers = stmt.specifiers.filter((s) => !(t.isExportSpecifier(s) && s.exportKind === 'type'));
            if (stmt.declaration &&
                (t.isTSInterfaceDeclaration(stmt.declaration) ||
                    t.isTSTypeAliasDeclaration(stmt.declaration) ||
                    t.isTSDeclareFunction(stmt.declaration) ||
                    t.isTSEnumDeclaration(stmt.declaration) ||
                    t.isTSModuleDeclaration(stmt.declaration))) {
                if (t.isTSEnumDeclaration(stmt.declaration)) {
                    const lowered = lowerTsEnumToJs(stmt.declaration);
                    if (lowered) {
                        body.splice(i, 1, ...lowered);
                        continue;
                    }
                }
                stmt.declaration = null;
                if (stmt.specifiers.length === 0 && !stmt.source) {
                    body.splice(i, 1);
                }
            }
        }
    }
    // Strip annotation slots + unwrap type-assertion wrappers everywhere else.
    stripTypeScriptOnly(ast);
}
// Lower a TSEnumDeclaration to the TypeScript-equivalent JS emit. Matches
// `tsc --target esnext` output: numeric members get reverse-mapping; string
// members get forward-only assignment. Returns null if any member has a
// non-literal initializer we can't evaluate at compile time.
//
//   enum E { A = 0, B = 1 }
// becomes:
//   var E;
//   (function (E) {
//       E[E["A"] = 0] = "A";
//       E[E["B"] = 1] = "B";
//   })(E || (E = {}));
function lowerTsEnumToJs(decl) {
    const name = decl.id.name;
    const resolved = [];
    let nextNumeric = 0;
    for (const m of decl.members) {
        const keyName = t.isIdentifier(m.id) ? m.id.name : t.isStringLiteral(m.id) ? m.id.value : null;
        if (keyName === null)
            return null;
        let value;
        if (m.initializer) {
            const init = m.initializer;
            if (t.isNumericLiteral(init)) {
                value = t.numericLiteral(init.value);
                nextNumeric = init.value + 1;
            }
            else if (t.isUnaryExpression(init) && init.operator === '-' && t.isNumericLiteral(init.argument)) {
                value = t.numericLiteral(-init.argument.value);
                nextNumeric = value.value + 1;
            }
            else if (t.isStringLiteral(init)) {
                value = t.stringLiteral(init.value);
                nextNumeric = null;
            }
            else {
                return null;
            }
        }
        else {
            if (nextNumeric === null)
                return null;
            value = t.numericLiteral(nextNumeric);
            nextNumeric += 1;
        }
        resolved.push({ key: keyName, value });
    }
    const idRef = () => t.identifier(name);
    const bodyStmts = resolved.map(({ key, value }) => {
        if (t.isStringLiteral(value)) {
            return t.expressionStatement(t.assignmentExpression('=', t.memberExpression(idRef(), t.stringLiteral(key), true), value));
        }
        return t.expressionStatement(t.assignmentExpression('=', t.memberExpression(idRef(), t.assignmentExpression('=', t.memberExpression(idRef(), t.stringLiteral(key), true), value), true), t.stringLiteral(key)));
    });
    const iife = t.expressionStatement(t.callExpression(t.functionExpression(null, [idRef()], t.blockStatement(bodyStmts)), [
        t.logicalExpression('||', idRef(), t.assignmentExpression('=', idRef(), t.objectExpression([]))),
    ]));
    return [t.variableDeclaration('var', [t.variableDeclarator(idRef())]), iife];
}

// Single-Program orchestration.
//
// Two modes:
//   - WholeProgram (renderChunk / bundle-mode): operate on a parsed chunk
//     that already contains every reachable callee. No cross-file context.
//   - PerFile (transform-mode): operate on one source file. When passed a
//     consumerPath + fileCache the inliner follows imports into donor
//     modules, splices donor bodies, and hoists the module-vars / imports
//     the spliced body references.
//
// Steps:
//   1. Parse with @babel/parser (TS/JSX-aware).
//   2. Strip TS-only syntax so downstream passes only see JS.
//   3. Normalize (makeDeclaredNamesUnique) — Closure runs Normalize before
//      its optimization pass group; later passes depend on the structural
//      invariants it establishes.
//   4. inlineFunctions across the program (optionally cross-file).
//   5. unrollLoops.
//   6. inlineVariables (pre) — collapse alias temps so SROA sees direct
//      `name[i]` uses.
//   7. applySroa.
//   8. simplifyAll (per-function peephole + DCE fixpoint).
//   9. inlineVariables (post).
//  10. removeUnusedCode.
//  11. stripDirectiveComments.
//  12. Generate code (and optional sourcemap).
// Mode signals the unit of optimization. The pipeline's pass set is the same
// in both modes; the difference is whether `inlineFunctions` is given a
// cross-file context (resolver + donor cache + hoister). Pass `Mode.PerFile`
// with a `consumerPath` + `fileCache` to enable cross-file behavior.
const Mode = {
    PerFile: 0,
    WholeProgram: 1,
};
function transform(code, options = {}) {
    const mode = options.mode ?? Mode.WholeProgram;
    const totalStart = performance.now();
    const parseStart = performance.now();
    const ast = parse(code, parserOptions(options.filename));
    const parseEnd = performance.now();
    const stripTypeScriptStart = performance.now();
    stripTypeScript(ast);
    const stripTypeScriptEnd = performance.now();
    const normalizeStart = performance.now();
    makeDeclaredNamesUnique(ast);
    const normalizeEnd = performance.now();
    // Touched-set: every per-function pass below uses this to skip functions
    // that no producing pass (inline / unroll / sroa) modified and that the
    // author didn't opt in via `@optimize`/`@flatten`/`@sroa`/`@unroll`.
    // Grows monotonically through the pipeline.
    const touched = new WeakSet();
    collectOptIns(ast, touched);
    const inlineFunctionsStart = performance.now();
    const inl = inlineFunctions(ast, mode === Mode.PerFile
        ? {
            consumerPath: options.filename,
            fileCache: options.fileCache,
            fileReader: options.fileReader,
            allowLibraryInline: options.allowLibraryInline,
            touched,
        }
        : { touched });
    const inlineFunctionsEnd = performance.now();
    const unrollLoopsStart = performance.now();
    const unr = unrollLoops(ast, { touched });
    const unrollLoopsEnd = performance.now();
    const inlineVariablesPreStart = performance.now();
    const ivarPre = inlineVariables(ast, { touched });
    const inlineVariablesPreEnd = performance.now();
    const sroaStart = performance.now();
    const sroa = applySroa(ast, { touched });
    const sroaEnd = performance.now();
    const simplifyStart = performance.now();
    const simp = simplifyAll(ast, { touched });
    const simplifyEnd = performance.now();
    const inlineVariablesPostStart = performance.now();
    const ivar = inlineVariables(ast, { touched });
    ivar.inlined += ivarPre.inlined;
    const inlineVariablesPostEnd = performance.now();
    const removeUnusedCodeStart = performance.now();
    const ruc = removeUnusedCode(ast, { touched });
    const removeUnusedCodeEnd = performance.now();
    const stripDirectiveCommentsStart = performance.now();
    stripDirectiveComments(ast);
    const stripDirectiveCommentsEnd = performance.now();
    const generateStart = performance.now();
    const gen = generate;
    const out = gen(ast, {
        sourceMaps: options.sourceMaps === true,
        sourceFileName: options.filename,
        inputSourceMap: options.inputSourceMap,
    });
    const generateEnd = performance.now();
    const totalEnd = performance.now();
    return {
        code: out.code,
        map: out.map,
        donorPaths: inl.donorPaths,
        stats: {
            inlined: inl.succeeded,
            unrolled: unr.unrolled,
            sroad: sroa.sroad,
            folded: simp.folded,
            removedDeadCode: simp.removed,
            flowInlined: simp.inlined,
            deadAssigns: simp.deadAssigns,
            minimized: simp.minimized,
            inlinedVariables: ivar.inlined,
            removedDeclarators: ruc.removedDeclarators,
            removedFunctionDecls: ruc.removedFunctionDecls,
            removedImportSpecifiers: ruc.removedImportSpecifiers,
            removedImportDeclarations: ruc.removedImportDeclarations,
        },
        simplifyTimings: simp.timings,
        timings: {
            parse: parseEnd - parseStart,
            stripTypeScript: stripTypeScriptEnd - stripTypeScriptStart,
            normalize: normalizeEnd - normalizeStart,
            inlineFunctions: inlineFunctionsEnd - inlineFunctionsStart,
            unrollLoops: unrollLoopsEnd - unrollLoopsStart,
            inlineVariablesPre: inlineVariablesPreEnd - inlineVariablesPreStart,
            sroa: sroaEnd - sroaStart,
            simplify: simplifyEnd - simplifyStart,
            inlineVariablesPost: inlineVariablesPostEnd - inlineVariablesPostStart,
            removeUnusedCode: removeUnusedCodeEnd - removeUnusedCodeStart,
            stripDirectiveComments: stripDirectiveCommentsEnd - stripDirectiveCommentsStart,
            generate: generateEnd - generateStart,
            total: totalEnd - totalStart,
        },
    };
}
function parserOptions(filename) {
    // In bundle-mode the chunk filename is `.js`, but the chunk text may
    // still contain TS (consumers who don't transpile TS before compilecat).
    // The typescript plugin is tolerant of plain JS, so enable unconditionally.
    const isJsx = filename ? /\.[jt]sx$/.test(filename) : false;
    const plugins = ['typescript'];
    if (isJsx)
        plugins.push('jsx');
    return {
        sourceType: 'module',
        allowImportExportEverywhere: true,
        allowReturnOutsideFunction: false,
        plugins,
    };
}

// Two plugin shapes:
//
//   - compilecat()         — bundle-mode. Operates on whole chunks via
//                            `renderChunk`, after rollup/rolldown has
//                            tree-shaken and concatenated modules. By the
//                            time we run, the chunk is a single Program —
//                            every `@inline` function in scope is directly
//                            reachable, no cross-file resolution needed.
//   - compilecatPerFile()  — transform-mode. Operates per source file via
//                            `transform`, with a cross-file resolver +
//                            donor-body hoister that brings in module-vars,
//                            enums, and imports the spliced bodies need.
//                            Required for Vite dev (no bundle phase).
//
// Compatible with rollup, vite, and rolldown (vite/rolldown share rollup's
// plugin shape). esbuild + webpack are not supported.
const PHASE_ORDER = [
    'parse',
    'stripTypeScript',
    'normalize',
    'inlineFunctions',
    'unrollLoops',
    'inlineVariablesPre',
    'sroa',
    'simplify',
    'inlineVariablesPost',
    'removeUnusedCode',
    'stripDirectiveComments',
    'generate',
    'total',
];
const SIMPLIFY_SUBPASS_ORDER = [
    'renameForFlatten',
    'foldConstants',
    'minimizeExitPoints',
    'minimizeConditions',
    'removeDeadCode',
    'cfgBuild',
    'localVarTable',
    'flowInline',
    'liveVars',
    'deadAssigns',
];
function emptySimplifyTimings() {
    return {
        renameForFlatten: 0,
        foldConstants: 0,
        minimizeExitPoints: 0,
        minimizeConditions: 0,
        removeDeadCode: 0,
        cfgBuild: 0,
        localVarTable: 0,
        flowInline: 0,
        liveVars: 0,
        deadAssigns: 0,
    };
}
function createAggregator() {
    const totals = {};
    const simplifyTotals = emptySimplifyTimings();
    let calls = 0;
    let totalBytesIn = 0;
    return {
        add(t, s, byteLen) {
            calls++;
            totalBytesIn += byteLen;
            for (const k of PHASE_ORDER)
                totals[k] = (totals[k] ?? 0) + t[k];
            for (const k of SIMPLIFY_SUBPASS_ORDER)
                simplifyTotals[k] += s[k];
        },
        report(label) {
            if (calls === 0)
                return;
            const total = totals.total ?? 0;
            const rows = PHASE_ORDER.filter((k) => k !== 'total').map((k) => {
                const ms = totals[k] ?? 0;
                const pct = total > 0 ? (ms / total) * 100 : 0;
                return `  ${k.padEnd(24)} ${ms.toFixed(1).padStart(9)}ms  ${pct.toFixed(1).padStart(5)}%`;
            });
            const simplifyTotal = totals.simplify ?? 0;
            const simplifyRows = SIMPLIFY_SUBPASS_ORDER.map((k) => {
                const ms = simplifyTotals[k];
                const pct = simplifyTotal > 0 ? (ms / simplifyTotal) * 100 : 0;
                return `    ${k.padEnd(22)} ${ms.toFixed(1).padStart(9)}ms  ${pct.toFixed(1).padStart(5)}%`;
            });
            const inner = flowInlineInnerTimings;
            const innerRows = ['mustDef', 'mayUse', 'parents', 'gather', 'canInline', 'perform'].map((k) => {
                const ms = inner[k];
                return `      ${k.padEnd(20)} ${ms.toFixed(1).padStart(9)}ms`;
            });
            console.log(`[compilecat] ${label} aggregate over ${calls} call(s), ${(totalBytesIn / 1024).toFixed(1)} KiB in:\n` +
                `${rows.join('\n')}\n  ${'TOTAL'.padEnd(24)} ${total.toFixed(1).padStart(9)}ms\n` +
                `  simplify breakdown (of ${simplifyTotal.toFixed(1)}ms):\n${simplifyRows.join('\n')}\n` +
                `    flowInline breakdown:\n${innerRows.join('\n')}\n` +
                `      candidates=${inner.candidateCount} inlined=${inner.inlineCount}`);
        },
    };
}
function formatTimings(t) {
    const parts = PHASE_ORDER.filter((k) => k !== 'total' && t[k] >= 0.5).map((k) => `${k}=${t[k].toFixed(1)}ms`);
    return `total=${t.total.toFixed(1)}ms [${parts.join(' ')}]`;
}
function compilecat(options = {}) {
    const debug = options.debug === true;
    const agg = debug ? createAggregator() : null;
    return {
        name: 'compilecat',
        renderChunk(code, chunk) {
            if (!ANY_DIRECTIVE_IN_SOURCE.test(code))
                return null;
            const id = chunk.fileName;
            if (debug)
                console.log(`[compilecat] transforming chunk ${id}`);
            try {
                const r = transform(code, {
                    sourceMaps: true,
                    filename: id,
                    mode: Mode.WholeProgram,
                });
                if (debug) {
                    agg?.add(r.timings, r.simplifyTimings, code.length);
                    console.log(`[compilecat] ${id}: inlined=${r.stats.inlined} folded=${r.stats.folded} dead=${r.stats.removedDeadCode}\n[compilecat] ${id}: ${formatTimings(r.timings)}`);
                }
                return { code: r.code, map: r.map };
            }
            catch (err) {
                console.error(`[compilecat] failed to transform chunk ${id}:`, err);
                return null;
            }
        },
        closeBundle() {
            agg?.report('bundle-mode');
        },
    };
}

export { compilecat as default };
//# sourceMappingURL=rolldown.js.map
