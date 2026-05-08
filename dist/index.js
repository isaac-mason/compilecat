import { createUnplugin } from 'unplugin';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import _generate from '@babel/generator';

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
    return (DIRECTIVE_PATTERNS.inline.test(value) ||
        DIRECTIVE_PATTERNS.flatten.test(value) ||
        DIRECTIVE_PATTERNS.optimize.test(value));
}
function commentIsFlattenDirective(value) {
    return DIRECTIVE_PATTERNS.flatten.test(value) || DIRECTIVE_PATTERNS.optimize.test(value);
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
// biome-ignore lint/suspicious/noExplicitAny: babel CJS interop
const traverse$2 = _traverse.default ?? _traverse;
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
    const topLevelNames = new Set([
        ...functions.keys(),
        ...moduleVars.keys(),
        ...imports.keys(),
    ]);
    for (const fn of functions.values()) {
        analyzeFreeRefs(fn, topLevelNames, functions, moduleVars, imports, ast);
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
function analyzeFreeRefs(fn, topLevelNames, functions, moduleVars, imports, ast) {
    let rootPath = null;
    traverse$2(ast, {
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
    safePath.traverse({
        Identifier(innerPath) {
            const name = innerPath.node.name;
            if (!topLevelNames.has(name))
                return;
            if (!innerPath.isReferencedIdentifier())
                return;
            const scopeBinding = innerPath.scope.getBinding(name);
            if (!scopeBinding)
                return;
            if (scopeBinding.scope.block.type !== 'Program')
                return;
            if (functions.has(name))
                fn.functionRefs.add(name);
            else if (moduleVars.has(name))
                fn.moduleVarRefs.add(name);
            else if (imports.has(name))
                fn.importRefs.add(name);
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
function createFileCache() {
    return { entries: new Map() };
}
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
    if (t.isIfStatement(node) ||
        t.isWhileStatement(node) ||
        t.isDoWhileStatement(node) ||
        t.isConditionalExpression(node)) {
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
 * Closure's `isLiteralValue` — recognises primitive literal nodes used by
 * dataflow / fold passes. The `includeFunctions` flag matches Closure's
 * second-arg convention.
 */
function isLiteralValue(node, includeFunctions) {
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
        return isLiteralValue(node.argument);
    }
    if (t.isFunction(node))
        return true;
    return false;
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
//   - member access (might trigger a getter)
//   - yield / await / throw
//   - tagged templates
//   - everything we don't recognise — Closure errs on the side of "may have
//     side effects" and we follow.
function mayHaveSideEffects(node) {
    return !isPure(node);
}
function isPure(node) {
    if (isLiteralValue(node))
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
    return false;
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
    // 1. Build the parameter-binding prologue. We bind each param to its arg
    //    via a `let` declaration. Closure does scalar substitution where safe;
    //    we punt and always bind, leaving redundant binds for the simplifier
    //    to clean up.
    const prologue = [];
    for (let i = 0; i < params.length; i++) {
        const arg = args[i] ?? t.identifier('undefined');
        prologue.push(t.variableDeclaration('let', [t.variableDeclarator(t.identifier(params[i]), arg)]));
    }
    // 2. Rewrite returns inside the cloned body.
    let hasResultWrite = false;
    rewriteReturns(body, label, resultName, needsResult, () => {
        hasResultWrite = true;
    });
    // 3. Wrap [...prologue, ...body.body] in a block, then label it.
    const block = t.blockStatement([...prologue, ...body.body]);
    const labeled = t.labeledStatement(t.identifier(label), block);
    return { block: labeled, hasResultWrite };
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
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c && typeof c === 'object' && 'type' in c) {
                        walk(c, n, k, i);
                    }
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                walk(child, n, k);
            }
        }
        if (t.isReturnStatement(n)) {
            const replacement = makeReturnReplacement(n.argument, label, resultName, needsResult, onWrite);
            if (index !== undefined) {
                // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
                const arr = parent[key];
                arr.splice(index, 1, ...replacement);
            }
            else {
                // ReturnStatement under a non-array slot (e.g. IfStatement.consequent).
                // Wrap replacement in a BlockStatement so the slot accepts it.
                // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
                parent[key] = t.blockStatement(replacement);
            }
        }
    };
    for (const k of t.VISITOR_KEYS[root.type] ?? []) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const child = root[k];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c && typeof c === 'object' && 'type' in c)
                    walk(c, root, k, i);
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
            walk(child, root, k);
        }
    }
}
function makeReturnReplacement(arg, label, resultName, needsResult, onWrite) {
    const out = [];
    if (needsResult) {
        const rhs = arg ?? t.identifier('undefined');
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
// stores the value in a `_r_<n>` temp. The call expression is replaced by
// `_r_<n>`; the labeled block is hoisted to a sibling statement before the
// callsite's enclosing statement.
//
// Limitations (v1):
//   - No `this` rewriting — we reject method calls and `this` references.
//   - No `arguments` rewriting — reject bodies that read it.
//   - No try/catch / generator / async / await / yield in body.
//   - No destructuring / rest / default params on the callee.
//   - Caller passes already-cloned body + args to keep ownership simple.
// Babel CJS default-export interop.
// biome-ignore lint/suspicious/noExplicitAny: interop shim
const generate$1 = _generate.default ?? _generate;
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
    let found = false;
    const visit = (n) => {
        if (found || !n)
            return;
        if (t.isFunction(n) && !t.isArrowFunctionExpression(n))
            return; // own this
        if (t.isThisExpression(n)) {
            found = true;
            return;
        }
        if (t.isIdentifier(n) && n.name === 'arguments') {
            found = true;
            return;
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                visit(child);
            }
        }
    };
    visit(body);
    return found;
}
function bodyHasUnsupportedConstruct(body) {
    let found = false;
    const visit = (n) => {
        if (found || !n)
            return;
        if (t.isTryStatement(n) ||
            t.isWithStatement(n) ||
            t.isYieldExpression(n) ||
            t.isAwaitExpression(n)) {
            found = true;
            return;
        }
        // Don't descend into nested functions — their try/yield is fine.
        if (t.isFunction(n))
            return;
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                visit(child);
            }
        }
    };
    visit(body);
    return found;
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
    if (t.isExpressionStatement(site.callParent) &&
        site.callParent === site.enclosingStatement) {
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
    const label = `_inline_${id}`;
    // Clone body and args.
    const clonedBody = t.cloneNode(fn.body, true);
    const clonedArgs = [];
    for (let i = 0; i < callee.paramNames.length; i++) {
        const a = args[i];
        clonedArgs.push(a === undefined
            ? t.identifier('undefined')
            : t.cloneNode(a, true));
    }
    // Alpha-rename params to fresh names so they can never collide with outer-scope
    // free vars referenced in args. Without this, inlining `insertLeaf(dbvt, ...)`
    // inside `add(dbvt, ...)` emits `let dbvt = dbvt;` (TDZ + later DAE strips the
    // init, leaving `let dbvt;` shadowing the outer dbvt with undefined).
    const freshParams = [];
    const renames = new Map();
    for (let i = 0; i < callee.paramNames.length; i++) {
        const orig = callee.paramNames[i];
        const fresh = `${orig}$p${id}_${i}`;
        freshParams.push(fresh);
        renames.set(orig, fresh);
    }
    if (renames.size > 0)
        renameInBody(clonedBody, renames);
    let shape = recognizeCallsite(site);
    // Reusing an existing variable name is unsafe if the donor body has free
    // reads of that name — those would resolve to the consumer's variable
    // instead of the donor module's, changing semantics. Demote to expression
    // shape in that case.
    if ((shape.kind === 'init' || shape.kind === 'assign') &&
        bodyHasFreeRefTo(clonedBody, shape.name, freshParams)) {
        shape = { kind: 'expression' };
    }
    // Decide resultName + needsResult per shape.
    let resultName;
    let needsResult;
    switch (shape.kind) {
        case 'statement':
            resultName = `_r_${id}`; // unused
            needsResult = false;
            break;
        case 'init':
        case 'assign':
            resultName = shape.name;
            needsResult = true;
            break;
        case 'expression':
            resultName = `_r_${id}`;
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
    const insertIdx = site.statementParent.body.indexOf(site.enclosingStatement);
    if (insertIdx < 0)
        return false;
    const breadcrumb = breadcrumbFor(site.call);
    switch (shape.kind) {
        case 'statement': {
            // Replace `foo();` with the labeled block.
            tagInlined(out.block, breadcrumb);
            site.statementParent.body.splice(insertIdx, 1, out.block);
            return true;
        }
        case 'init': {
            // `let x = foo();` → `let x;` followed by the labeled block.
            // Drop the initializer in place; insert the block after.
            shape.declarator.init = null;
            tagInlined(out.block, breadcrumb);
            site.statementParent.body.splice(insertIdx + 1, 0, out.block);
            return true;
        }
        case 'assign': {
            // `x = foo();` → labeled block (which writes `x` on each return).
            tagInlined(out.block, breadcrumb);
            site.statementParent.body.splice(insertIdx, 1, out.block);
            return true;
        }
        case 'expression': {
            // Hoist `let _r_<n>;` and the labeled block before the enclosing
            // statement; replace the call with `_r_<n>`.
            const tempDecl = t.variableDeclaration('let', [
                t.variableDeclarator(t.identifier(resultName)),
            ]);
            tagInlined(tempDecl, breadcrumb);
            const inserts = [tempDecl, out.block];
            replaceCall(site, t.identifier(resultName));
            site.statementParent.body.splice(insertIdx, 0, ...inserts);
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
    const src = generate$1(t.cloneNode(call, true, false), {
        concise: true,
        comments: false,
        retainLines: false,
    }).code;
    return src.replace(/\s+/g, ' ').trim();
}
function tagInlined(node, sig) {
    t.addComment(node, 'leading', ` @applied-inline ${sig} `);
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
                else if ((t.isFunctionDeclaration(s) || t.isClassDeclaration(s)) &&
                    s.id?.name === name) {
                    blockShadow = true;
                }
            }
            descend(n, blockShadow);
            return;
        }
        if (!shadowed &&
            t.isIdentifier(n) &&
            n.name === name &&
            parent !== null &&
            isReferenceContext(parent, key)) {
            found = true;
            return;
        }
        descend(n, shadowed);
    };
    const descend = (n, shadowed) => {
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        walk(c, n, k, shadowed);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
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
    if (site.callIndex !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const arr = site.callParent[site.callKey];
        arr[site.callIndex] = replacement;
    }
    else {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        site.callParent[site.callKey] = replacement;
    }
}
function countParamUses(root, params) {
    const counts = new Map();
    for (const p of params)
        counts.set(p, 0);
    const visit = (n) => {
        if (!n)
            return;
        if (t.isFunction(n))
            return; // shadowed
        if (t.isIdentifier(n) && counts.has(n.name)) {
            counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                visit(child);
            }
        }
    };
    visit(root);
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
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c && typeof c === 'object' && 'type' in c) {
                        if (t.isIdentifier(c) &&
                            active.has(c.name) &&
                            isReferenceContext(n, k)) {
                            c.name = active.get(c.name);
                        }
                        else {
                            visit(c, active);
                        }
                    }
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                if (t.isIdentifier(child) &&
                    active.has(child.name) &&
                    isReferenceContext(n, k)) {
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
function substituteIdentifiers(root, subs) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
    const visit = (n, parent, key, index) => {
        if (!n || typeof n !== 'object')
            return;
        if (t.isFunction(n))
            return; // shadowed
        if (t.isIdentifier(n) && subs.has(n.name)) {
            // Skip Identifier in write contexts. For root expression
            // substitution, we're typically in a read context; LHS-of-assign
            // would mean we're rewriting params, which our classifier rejects
            // for v1 (parameter mutation in callee → BLOCK or NO).
            const sub = t.cloneNode(subs.get(n.name), true);
            if (parent !== null) {
                if (index !== undefined)
                    parent[key][index] = sub;
                else
                    parent[key] = sub;
            }
            return;
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c, n, k, i);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                visit(child, n, k);
            }
        }
    };
    // Wrap root in a holder so we can substitute it directly.
    const holder = { value: root };
    visit(holder.value, holder, 'value');
    return holder.value;
}

// Port of jscomp/InlineFunctions.java (subset).
//
// Drives FunctionInjector: discovers candidate callees and call sites within
// a single program, classifies each, and performs the splice.
//
// v1 scope (same-file only):
//   - Candidate callees:
//     - `function NAME(...) { ... }` declarations at any block scope
//     - `const NAME = (...) => { ... }` / `const NAME = function (...) { ... }`
//   - Trigger:
//     - declaration carries an `@inline` JSDoc / leading block comment, OR
//     - call expression carries an `@inline` leading block comment
//   - Call sites:
//     - `NAME(args)` — Identifier callee matching a known candidate
//   - No method calls, no `this`/`arguments`, no recursion, no cross-file.
//
// Discovery is name-keyed. We don't model scope shadowing — if two callees
// share a name (top-level vs. nested), we conservatively treat the
// outermost as the only candidate. Cross-file inlining lives in the
// classic tree's `inline.ts` and is out of scope for v1 of the gcc port.
// ---------------------------------------------------------------------------
// Public entry.
function inlineFunctions(root, options = {}) {
    const result = { inlined: 0, calls: 0, succeeded: 0 };
    // Discover top-level (and nested) candidate functions.
    const candidates = new Map();
    discoverCandidates(root, candidates);
    // Cross-file context. Built once so the consumerIndex (free-ref analysis)
    // is shared across every call-site lookup.
    const xfile = buildCrossFileCtx(root, options);
    if (candidates.size === 0 && !xfile)
        return result;
    // Find call sites and inject. We pre-collect sites in a single pass so
    // that injection-time AST mutation can't disturb the iteration.
    const sites = collectCallSites(root, candidates, xfile);
    let nextId = 0;
    const opts = { nextId: () => nextId++ };
    for (const { candidate, site } of sites) {
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
            if (xfile && candidate.donor)
                trackDonorRefs(candidate, xfile);
        }
    }
    if (result.succeeded > 0)
        result.inlined = candidates.size;
    // Strip declaration-annotated callees once consumed. Conservative: only
    // strip if we successfully inlined at least one call. We don't yet track
    // per-candidate consumption, so we leave the declaration in place if any
    // identifier remains referencing it.
    stripFullyInlinedDecls(root, candidates, sites);
    // Hoist donor-side module-vars and imports referenced by spliced bodies.
    if (xfile && t.isFile(root)) {
        if (xfile.requiredImports.size > 0) {
            hoistRequiredImports(root, xfile);
        }
        if (xfile.requiredModuleVars.size > 0) {
            hoistRequiredModuleVars(root, xfile);
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// Candidate discovery.
function discoverCandidates(root, out) {
    const flattenInside = new Set();
    // Pass 1: detect @flatten functions — every call inside their body
    // becomes a candidate trigger even without explicit @inline.
    visit$1(root, (n) => {
        if (t.isFunction(n) && hasFlattenAnnotation(n))
            flattenInside.add(n);
    });
    // Pass 2: register candidates.
    visitWithParents(root, (n, parent, _key, index) => {
        if (t.isFunctionDeclaration(n) && n.id) {
            const params = paramNames(n);
            if (params === null)
                return;
            const annotated = hasInlineAnnotation(n);
            const c = {
                name: n.id.name,
                callee: { fn: n, paramNames: params },
                declAnnotated: annotated,
            };
            if ((parent && (t.isBlockStatement(parent) || t.isProgram(parent))) &&
                index !== undefined) {
                c.declRef = { parent: parent, index };
            }
            if (!out.has(n.id.name))
                out.set(n.id.name, c);
            return;
        }
        if (t.isVariableDeclaration(n) && n.declarations.length === 1) {
            const d = n.declarations[0];
            if (t.isIdentifier(d.id) &&
                (t.isArrowFunctionExpression(d.init) || t.isFunctionExpression(d.init))) {
                const params = paramNames(d.init);
                if (params === null)
                    return;
                const annotated = hasInlineAnnotation(n) || hasInlineAnnotation(d.init);
                const c = {
                    name: d.id.name,
                    callee: { fn: d.init, paramNames: params },
                    declAnnotated: annotated,
                };
                if ((parent && (t.isBlockStatement(parent) || t.isProgram(parent))) &&
                    index !== undefined) {
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
function hasInlineAnnotation(n) {
    const cs = (n.leadingComments ?? []);
    for (const c of cs) {
        if (c.type === 'CommentBlock' && commentIsInlineDirective(c.value))
            return true;
        if (c.type === 'CommentLine' && commentIsInlineDirective(c.value))
            return true;
    }
    return false;
}
function hasFlattenAnnotation(n) {
    const cs = (n.leadingComments ?? []);
    for (const c of cs) {
        if (c.type === 'CommentBlock' && commentIsFlattenDirective(c.value))
            return true;
        if (c.type === 'CommentLine' && commentIsFlattenDirective(c.value))
            return true;
    }
    return false;
}
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
    };
}
function collectCallSites(root, candidates, xfile) {
    const sites = [];
    // Track current enclosing function (for flatten propagation).
    const flattenStack = [false];
    const walk = (n, parent, key, index, 
    // Path of (statementParent, statementIndex, enclosingStatement).
    stmtCtx) => {
        const enteringFn = t.isFunction(n);
        if (enteringFn) {
            flattenStack.push(hasFlattenAnnotation(n));
        }
        // If this is a Statement child of a Block/Program, update stmtCtx.
        let nextStmtCtx = stmtCtx;
        if (parent &&
            (t.isBlockStatement(parent) || t.isProgram(parent)) &&
            key === 'body' &&
            index !== undefined &&
            t.isStatement(n)) {
            nextStmtCtx = {
                parent: parent,
                index,
                stmt: n,
            };
        }
        // Detect call site.
        if (t.isCallExpression(n) &&
            nextStmtCtx !== null &&
            parent !== null) {
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
                    });
                }
            }
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c && typeof c === 'object' && 'type' in c) {
                        walk(c, n, k, i, nextStmtCtx);
                    }
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                walk(child, n, k, undefined, nextStmtCtx);
            }
        }
        if (enteringFn)
            flattenStack.pop();
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
        xfile.requiredImports.set(key, {
            sourceFile: donorPath,
            localName: name,
            binding: b,
        });
    }
}
// ---------------------------------------------------------------------------
// Hoisting donor module-vars + imports.
//
// Mirrors classic's logic: imports are rewritten relative to the consumer
// file (or kept as bare specifiers for library imports). Module-var clones
// are inserted right after the import block. Collisions are skipped — when
// the consumer already has a binding by the same name, we leave the spliced
// body's reference to bind to whatever is in scope (matching classic).
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
        if (binding.source.startsWith('./') ||
            binding.source.startsWith('../') ||
            binding.source.startsWith('/')) {
            const abs = resolveRelativeImport(req.sourceFile, binding.source, reader);
            if (abs) {
                let rel = nodePath.relative(consumerDir, abs);
                if (!rel.startsWith('.'))
                    rel = `./${rel}`;
                rel = rel.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
                rewrittenSource = rel;
            }
        }
        const bucket = byTarget.get(rewrittenSource) ?? {
            source: rewrittenSource,
            specs: [],
        };
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
        toInsert.push(cloned);
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
    const matching = moduleVar.declaration.declarations.find((d) => t.isIdentifier(d.id) && d.id.name === name);
    if (!matching)
        return null;
    return t.variableDeclaration(moduleVar.declaration.kind, [
        t.cloneNode(matching, true, false),
    ]);
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
function stripFullyInlinedDecls(root, candidates, sites) {
    // Remove declarations that are decl-annotated and have at least one
    // successful site, and have no surviving identifier reads outside the
    // declaration itself. We approximate "no surviving reads" by re-scanning
    // the AST and counting identifier reads of each candidate name.
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
        // We don't currently re-scan for residual reads; conservatively do so.
        // (Cheap.) Skip strip if any identifier read of `name` remains.
        const anyResidual = anyResidualReference(c.declRef.parent, name, c.declRef.index);
        if (anyResidual)
            continue;
        c.declRef.parent.body.splice(c.declRef.index, 1);
        // Adjust later candidate indices in the same parent.
        for (const other of candidates.values()) {
            if (other.declRef &&
                other.declRef.parent === c.declRef.parent &&
                other.declRef.index > c.declRef.index) {
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
            if (t.isIdentifier(n) &&
                n.name === name &&
                !isWriteContext$1(n, parentNode, key)) {
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
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c && typeof c === 'object' && 'type' in c)
                        walk(c, n, k, i);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                walk(child, n, k);
            }
        }
    };
    walk(root, null, '');
}
function visitWithParents(root, fn) {
    visit$1(root, fn);
}

// Port of jscomp/InlineVariables.java (subset).
//
// Closure's InlineVariables is a 1000+ LOC pass driving ReferenceCollector
// to find variables safe to inline. We port the subset that complements
// flow-sensitive-inline-variables.ts (which handles intra-function flow):
//
//   - `const|let x = <pure>;` declared once, read exactly once → replace
//     the read with the init and drop the declarator.
//   - Works at any scope (module, function, block) — handy at module level
//     where flow-sensitive bails by design.
//
// What's intentionally out of scope for v1:
//   - Alias inlining (`const a = b; ...a...` where `b` is impure but `a`
//     is a clean alias). Closure has a dedicated `VarExpert` for this; we
//     skip it because most aliases evaporate via flow-sensitive inline.
//   - Multi-use inlining of literals. Useful but requires a cost model
//     (size impact) — `peephole-fold-constants` already covers many cases.
//   - CONSTANTS_ONLY / LOCALS_ONLY / ALL mode toggles. We always operate
//     in the equivalent of LOCALS_ONLY+module behavior.
//
// We rely on Babel's scope analysis — `path.scope.getBinding(name)` —
// instead of porting `ReferenceCollector`. Iterates to fixpoint because
// inlining one variable can make another's reference count drop to 1.
// biome-ignore lint/suspicious/noExplicitAny: babel CJS interop
const traverse$1 = _traverse.default ?? _traverse;
function inlineVariables(ast) {
    let total = 0;
    while (true) {
        const round = sweep$1(ast);
        if (round === 0)
            break;
        total += round;
    }
    return { inlined: total };
}
function sweep$1(ast) {
    let inlined = 0;
    traverse$1(ast, {
        // Force a scope rebuild — our previous round's mutations may have
        // changed reference counts.
        Program(path) {
            path.scope.crawl();
        },
        VariableDeclarator(path) {
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
            if (binding.references !== 1)
                return;
            // Don't strip exported declarations.
            if (path.parentPath?.parent && t.isExportDeclaration(path.parentPath.parent))
                return;
            // Init must be pure — we're moving it to a new evaluation point.
            if (mayHaveSideEffects(init))
                return;
            // Free identifiers in init must reference bindings that are
            // never written. Otherwise relocating the read may observe a
            // different value.
            const initPath = path.get('init');
            if (!initPath.node)
                return;
            if (initFreeVarsAreUnstable(initPath, path.scope))
                return;
            const refPath = binding.referencePaths[0];
            if (!refPath)
                return;
            // Don't inline across async/generator/yield boundaries — a
            // suspended frame may observe a different world at resume.
            if (crossesAsyncBoundary(path, refPath))
                return;
            // Don't inline into a loop body when the def sits outside it —
            // would re-evaluate `init` once per iteration. Exception: a
            // primitive literal is free to re-evaluate, so allow it.
            if (!isPrimitiveLiteral(init) && useIsInsideLoopOutOfDef(path, refPath))
                return;
            // Don't inline a var hoisted from a conditional — the def may
            // not have executed before the use.
            if (defIsConditional(path, refPath))
                return;
            // Replace the read with a clone of init, then drop the declarator.
            refPath.replaceWith(t.cloneNode(init, /* deep */ true, /* withoutLoc */ false));
            path.remove();
            inlined++;
        },
    });
    return inlined;
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
        if ((t.isFunction(p.node) || t.isFunctionDeclaration(p.node) || t.isFunctionExpression(p.node) || t.isArrowFunctionExpression(p.node)) &&
            // biome-ignore lint/suspicious/noExplicitAny: union narrowing
            (p.node.async === true || p.node.generator === true)) {
            return true;
        }
        p = p.parentPath;
    }
    return false;
}
// A primitive literal is cheap to re-evaluate (no allocation, no observable
// side effect, value identity is the value itself). Safe to inline into a
// loop body.
function isPrimitiveLiteral(n) {
    if (t.isNumericLiteral(n) ||
        t.isStringLiteral(n) ||
        t.isBooleanLiteral(n) ||
        t.isNullLiteral(n) ||
        t.isBigIntLiteral(n)) {
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
    let p = usePath.parentPath;
    while (p && p.node !== defPath.node) {
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

// Loop unrolling — directive-driven (no Closure analogue, but a natural fit
// alongside the simplifier's other directives).
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
function unrollLoops(root) {
    let total = 0;
    for (let pass = 0; pass < MAX_UNROLL_PASSES; pass++) {
        const n = unrollPass(root);
        if (n === 0)
            break;
        total += n;
    }
    return { unrolled: total };
}
function unrollPass(root) {
    let count = 0;
    walkStatementLists(root, (body, inOptimize) => {
        for (let i = 0; i < body.length; i++) {
            const s = body[i];
            if (!hasUnrollAnnotation(s) && !inOptimize)
                continue;
            if (t.isForStatement(s)) {
                const out = expandFor(s);
                if (out !== null) {
                    body.splice(i, 1, ...out);
                    count++;
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
                    i += out.length - 1;
                    continue;
                }
                stripUnrollComments(s);
                continue;
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
    if (t.isBlockStatement(body)) {
        const clonedBlock = t.cloneNode(body, true, true);
        substitute(clonedBlock, varName, replacement, false);
        return clonedBlock.body;
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
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c) {
                        if (walk(c, nl, nf))
                            return true;
                    }
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
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
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const child = n[k];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c && typeof c === 'object' && 'type' in c) {
                    if (!shadowed &&
                        t.isIdentifier(c) &&
                        c.name === varName &&
                        isReadContext(n, k)) {
                        child[i] = t.cloneNode(replacement, true);
                    }
                    else {
                        substitute(c, varName, replacement, shadowed);
                    }
                }
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
            if (!shadowed &&
                t.isIdentifier(child) &&
                child.name === varName &&
                isReadContext(n, k)) {
                // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
                n[k] = t.cloneNode(replacement, true);
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
    const visit = (n) => {
        if (n == null)
            return;
        const enteringFn = t.isFunction(n);
        if (enteringFn) {
            optimizeStack.push(hasOptimizeAnnotation(n));
        }
        if (t.isBlockStatement(n) || t.isProgram(n)) {
            cb(n.body, optimizeStack[optimizeStack.length - 1]);
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                visit(child);
            }
        }
        if (enteringFn)
            optimizeStack.pop();
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
// biome-ignore lint/suspicious/noExplicitAny: babel CJS interop
const traverse = _traverse.default ?? _traverse;
function removeUnusedCode(ast) {
    const total = {
        removedDeclarators: 0,
        removedFunctionDecls: 0,
        removedImportSpecifiers: 0,
        removedImportDeclarations: 0,
    };
    // Iterate to fixpoint. Each round does a fresh `traverse()` so scope info
    // is rebuilt against the mutated AST.
    while (true) {
        const round = sweep(ast);
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
    return (r.removedDeclarators +
        r.removedFunctionDecls +
        r.removedImportSpecifiers +
        r.removedImportDeclarations);
}
function sweep(ast) {
    const stats = {
        removedDeclarators: 0,
        removedFunctionDecls: 0,
        removedImportSpecifiers: 0,
        removedImportDeclarations: 0,
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
        // biome-ignore lint/suspicious/noExplicitAny: union narrowing
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
function applySroa(root) {
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
        const annotated = sroaScopeStack[sroaScopeStack.length - 1] || hasSroaAnnotation(n);
        if (enteringScope) {
            sroaScopeStack.push(annotated);
        }
        const nextScope = enteringScope ? n : scope;
        if (t.isVariableDeclaration(n) && parent && index !== undefined) {
            const declAnnot = annotated || hasSroaAnnotation(n);
            for (const d of n.declarations) {
                if (!declAnnot && !hasSroaAnnotation(d))
                    continue;
                if (!t.isIdentifier(d.id) || !d.init)
                    continue;
                const init = inferInitializer(d.init);
                if (!init)
                    continue;
                if (parent &&
                    (t.isBlockStatement(parent) || t.isProgram(parent)) &&
                    typeof index === 'number') {
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
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c && typeof c === 'object' && 'type' in c) {
                        walk(c, n, k, i, nextScope);
                    }
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
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
function hasSroaAnnotation(n) {
    const cs = (n.leadingComments ?? []);
    for (const c of cs) {
        if (DIRECTIVE_PATTERNS.sroa.test(c.value))
            return true;
        if (DIRECTIVE_PATTERNS.optimize.test(c.value))
            return true;
    }
    return false;
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
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const cc of child) {
                    if (cc && typeof cc === 'object' && 'type' in cc) {
                        visit(cc, n, k);
                    }
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
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
                        if (index !== undefined) {
                            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
                            const arr = parent[key];
                            arr[index] = replacement;
                        }
                        else {
                            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
                            parent[key] = replacement;
                        }
                    }
                    break;
                }
            }
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c && typeof c === 'object' && 'type' in c) {
                        visit(c, n, k, i);
                    }
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
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
    walk$3(cfa, opts.root, null);
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
        if (t.isTryStatement(n) ||
            t.isWithStatement(n) ||
            t.isYieldExpression(n) ||
            t.isAwaitExpression(n)) {
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
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST access
        const child = node[key];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c && typeof c === 'object' && 'type' in c)
                    walkBail(c, node, visit);
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
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
function walk$3(cfa, node, parent) {
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
        walk$3(cfa, child, node);
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
    if (t.isForStatement(parent) ||
        t.isForInStatement(parent) ||
        t.isForOfStatement(parent)) {
        // Only descend into the body.
        return n === parent.body;
    }
    if (t.isDoWhileStatement(parent)) {
        // Don't descend into the test; only the body.
        return n === parent.body;
    }
    if (t.isIfStatement(parent) ||
        t.isWhileStatement(parent) ||
        t.isWithStatement(parent) ||
        t.isSwitchStatement(parent)) {
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
                // biome-ignore lint/suspicious/noExplicitAny: dynamic AST access
                const child = n[key];
                if (child === null || child === undefined)
                    continue;
                if (Array.isArray(child)) {
                    for (const c of child) {
                        if (c && typeof c === 'object' && 'type' in c)
                            populate(c, n);
                    }
                }
                else if (typeof child === 'object' && 'type' in child) {
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
            const target = dflt.consequent.length > 0
                ? computeFallThrough(dflt.consequent[0])
                : computeFollowNode(cfa, node, node);
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
        // After a case body, control passes to the next case's body
        // (fall-through) — case condition is skipped.
        const grand = parentOf(cfa, parent);
        if (!t.isSwitchStatement(grand)) {
            return computeFollowNode(cfa, fromNode, parent);
        }
        const idx = grand.cases.indexOf(parent);
        const nextCase = grand.cases[idx + 1];
        if (nextCase) {
            if (nextCase.consequent.length > 0) {
                return computeFallThrough(nextCase.consequent[0]);
            }
            // Empty case — fall through again.
            return computeFollowNode(cfa, fromNode, nextCase);
        }
        return computeFollowNode(cfa, fromNode, parent);
    }
    if (t.isForStatement(parent)) {
        // After body, go to update; if no update, back to the for itself.
        return parent.update ?? parent;
    }
    if (t.isWhileStatement(parent) ||
        t.isDoWhileStatement(parent) ||
        t.isForInStatement(parent) ||
        t.isForOfStatement(parent)) {
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
    const to = toNode === null
        ? cfa.cfg.implicitReturn
        : createNode(cfa.cfg, toNode);
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
            const next = config.direction === 'forward'
                ? cur.outEdges.map((e) => e.destination)
                : cur.inEdges.map((e) => e.source);
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
//   - Variable identity is by NAME (we don't have Closure's Var with scope
//     resolution). See LocalVariableTable.ts for the limitations.
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
        flowThrough: (node, output) => flowThrough$2(node, output, table),
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
            for (const name of table.escaped) {
                const idx = table.indexByName.get(name);
                if (idx !== undefined)
                    bsSet(l, idx);
            }
            return l;
        },
    };
    analyze(cfg, config);
    return { table, ran: true };
}
// ---------------------------------------------------------------------------
// flowThrough — compute GEN/KILL for `node`, then L_in = (L_out − KILL) | GEN
function flowThrough$2(node, out, table) {
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
    if (t.isProgram(n) ||
        t.isFile(n) ||
        t.isFunction(n) ||
        t.isBlockStatement(n)) {
        return;
    }
    if (t.isWhileStatement(n) ||
        t.isDoWhileStatement(n) ||
        t.isIfStatement(n)) {
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
        const idx = table.indexByName.get(n.name);
        if (idx !== undefined && !table.escaped.has(n.name)) {
            bsSet(gen, idx);
        }
        return;
    }
    if (t.isAssignmentExpression(n)) {
        if (t.isIdentifier(n.left)) {
            // Plain `x = expr` or `x += expr`.
            if (!conditional) {
                const idx = table.indexByName.get(n.left.name);
                if (idx !== undefined && !table.escaped.has(n.left.name))
                    bsSet(kill, idx);
            }
            if (n.operator !== '=') {
                // Compound assign reads x first.
                const idx = table.indexByName.get(n.left.name);
                if (idx !== undefined && !table.escaped.has(n.left.name))
                    bsSet(gen, idx);
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
            const idx = table.indexByName.get(n.argument.name);
            if (idx !== undefined && !table.escaped.has(n.argument.name)) {
                bsSet(gen, idx);
                if (!conditional)
                    bsSet(kill, idx);
            }
            return;
        }
    }
    // Default: walk children at the same conditional level.
    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const child = n[key];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c && typeof c === 'object' && 'type' in c) {
                    computeGenKill(c, table, gen, kill, conditional);
                }
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
            computeGenKill(child, table, gen, kill, conditional);
        }
    }
}
function addBindingsToKill(pattern, table, kill) {
    const visit = (n) => {
        if (t.isIdentifier(n)) {
            const idx = table.indexByName.get(n.name);
            if (idx !== undefined && !table.escaped.has(n.name))
                bsSet(kill, idx);
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
//   - Variable identity by NAME (matches our LocalVariableTable).
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
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST access
        const child = n[key];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c &&
                    typeof c === 'object' &&
                    'type' in c &&
                    !isEnteringNewCfgNode(c, n)) {
                    tryRemoveAssignment(ctx, c, exprRoot, state);
                }
            }
        }
        else if (typeof child === 'object' &&
            'type' in child &&
            !isEnteringNewCfgNode(child, n)) {
            tryRemoveAssignment(ctx, child, exprRoot, state);
        }
    }
}
// ---------------------------------------------------------------------------
// handleAssignment — `x = expr` or `x op= expr` where `x` is an Identifier.
function handleAssignment(ctx, n, exprRoot, state) {
    const lhs = n.left;
    const idx = ctx.table.indexByName.get(lhs.name);
    if (idx === undefined)
        return;
    if (ctx.table.escaped.has(lhs.name))
        return;
    // Identity assign `a = a` — always remove.
    if (n.operator === '=' &&
        t.isIdentifier(n.right) &&
        n.right.name === lhs.name) {
        replaceInParent$1(ctx, n, n.right);
        ctx.removed++;
        return;
    }
    if (isLive(state.out, idx))
        return;
    if (isLive(state.in, idx) &&
        isVariableStillLiveWithinExpression(ctx, n, exprRoot, lhs.name)) {
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
    const idx = ctx.table.indexByName.get(arg.name);
    if (idx === undefined)
        return;
    if (ctx.table.escaped.has(arg.name))
        return;
    if (isLive(state.out, idx))
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
    if (t.isForStatement(parent) &&
        getConditionExpression(parent) !== n &&
        parent.update === n) {
        // for(;; x++) — replace update with empty (drops it).
        // We can't insert a real "empty" so just null the slot.
        // biome-ignore lint/suspicious/noExplicitAny: ForStatement.update is nullable
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
    if (declParentInfo &&
        (t.isForInStatement(declParentInfo.parent) || t.isForOfStatement(declParentInfo.parent))) {
        return;
    }
    const name = d.id.name;
    const idx = ctx.table.indexByName.get(name);
    if (idx === undefined)
        return;
    if (ctx.table.escaped.has(name))
        return;
    // Identity init `var a = a;` is meaningless and rare; treat as standard
    // assignment.
    if (t.isIdentifier(d.init) && d.init.name === name) {
        d.init = null;
        ctx.removed++;
        return;
    }
    if (isLive(state.out, idx))
        return;
    if (isLive(state.in, idx) &&
        isVariableStillLiveWithinExpression(ctx, decl, exprRoot, name)) {
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
function isVariableStillLiveWithinExpression(ctx, n, exprRoot, variable) {
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
                state = isVariableReadBeforeKill(parent.right, variable);
                if (state === VLive.KILL)
                    state = VLive.MAYBE_LIVE;
            }
        }
        else if (t.isConditionalExpression(parent)) {
            if (cur === parent.test) {
                state = checkHookBranchReadBeforeKill(parent.consequent, parent.alternate, variable);
            }
            // If cur is consequent or alternate, the other branch can be
            // ignored; siblings don't apply.
        }
        else {
            for (const sibling of rightSiblings$1(parent, cur)) {
                state = isVariableReadBeforeKill(sibling, variable);
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
function isVariableReadBeforeKill(n, variable) {
    if (isEnteringNewCfgNode(n, parentOfChild()))
        return VLive.MAYBE_LIVE;
    if (t.isIdentifier(n) && n.name === variable) {
        // We need to know whether this name is the LHS of an assign. The
        // caller's iteration pattern feeds us nodes whose parent we don't
        // have a generic way to inspect here without the parent map. We
        // accept the slight conservatism: treat every identifier read as
        // READ. Closure distinguishes simple-assign LHS (then evaluates RHS
        // first to detect a still-live read inside the RHS), but in our v1
        // we'd need to thread the parent map through; conservative is safe.
        return VLive.READ;
    }
    if (t.isLogicalExpression(n)) {
        const v1 = isVariableReadBeforeKill(n.left, variable);
        const v2 = isVariableReadBeforeKill(n.right, variable);
        if (v1 !== VLive.MAYBE_LIVE)
            return v1;
        if (v2 === VLive.READ)
            return VLive.READ;
        return VLive.MAYBE_LIVE;
    }
    if (t.isConditionalExpression(n)) {
        const first = isVariableReadBeforeKill(n.test, variable);
        if (first !== VLive.MAYBE_LIVE)
            return first;
        return checkHookBranchReadBeforeKill(n.consequent, n.alternate, variable);
    }
    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST access
        const child = n[key];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c && typeof c === 'object' && 'type' in c) {
                    const r = isVariableReadBeforeKill(c, variable);
                    if (r !== VLive.MAYBE_LIVE)
                        return r;
                }
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
            const r = isVariableReadBeforeKill(child, variable);
            if (r !== VLive.MAYBE_LIVE)
                return r;
        }
    }
    return VLive.MAYBE_LIVE;
}
function checkHookBranchReadBeforeKill(a, b, variable) {
    const v1 = isVariableReadBeforeKill(a, variable);
    const v2 = isVariableReadBeforeKill(b, variable);
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
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST access
        const child = parent[key];
        if (Array.isArray(child)) {
            for (const c of child) {
                if (!seen) {
                    if (c === after)
                        seen = true;
                    continue;
                }
                if (c && typeof c === 'object' && 'type' in c)
                    out.push(c);
            }
        }
        else if (child === after) {
            seen = true;
        }
        else if (seen && child && typeof child === 'object' && 'type' in child) {
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
    if (index !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST access
        const arr = parent[key];
        arr[index] = replacement;
    }
    else {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST access
        parent[key] = replacement;
    }
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
    // biome-ignore lint/suspicious/noExplicitAny: dynamic AST access
    const arr = parent[key];
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
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST access
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c && typeof c === 'object' && 'type' in c)
                        walk(c, n, k, i);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
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
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST access
        const child = n[k];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c && typeof c === 'object' && 'type' in c) {
                    populateParents(c, n, k, i, map);
                }
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
            populateParents(child, n, k, undefined, map);
        }
    }
}
// ---------------------------------------------------------------------------
// containsNestedFunction — Closure's bailout.
function containsNestedFunction(fn) {
    let found = false;
    const walk = (n, atRoot) => {
        if (found)
            return;
        if (!atRoot && t.isFunction(n)) {
            found = true;
            return;
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST access
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        walk(c, false);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                walk(child, false);
            }
        }
    };
    walk(fn, true);
    return found;
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

// Port of jscomp/MaybeReachingVariableUse.java
//
// Backward may-reach analysis. At every program point, for each local
// variable v, what is the set of "upward exposed" use sites that might
// read v's current value? Use sites are Identifier nodes.
//
// Lattice per variable: a Set<Node>. Bigger = "more uses might reach".
// Join (over multiple successors) = union. Kill = an unconditional write to
// v removes v's set entirely (the prior value can no longer reach those uses
// from this point). Reads add to the set.
//
// Used by FlowSensitiveInlineVariables to check the "exactly one use of this
// def" condition.
function newReachingUses() {
    return { uses: new Map() };
}
function cloneReachingUses(r) {
    const out = newReachingUses();
    for (const [k, set] of r.uses)
        out.uses.set(k, new Set(set));
    return out;
}
function reachingEquals(a, b) {
    if (a.uses.size !== b.uses.size)
        return false;
    for (const [k, sa] of a.uses) {
        const sb = b.uses.get(k);
        if (sb === undefined)
            return false;
        if (sa.size !== sb.size)
            return false;
        for (const node of sa)
            if (!sb.has(node))
                return false;
    }
    return true;
}
function reachingJoin(a, b) {
    const out = cloneReachingUses(a);
    for (const [k, sb] of b.uses) {
        const dst = out.uses.get(k);
        if (dst === undefined)
            out.uses.set(k, new Set(sb));
        else
            for (const n of sb)
                dst.add(n);
    }
    return out;
}
function runMaybeReachingUse(cfg, table) {
    const config = {
        direction: 'backward',
        flowThrough: (node, output) => flowThrough$1(node, output, table),
        joinFlows: reachingJoin,
        equals: reachingEquals,
        bottom: newReachingUses,
        entry: newReachingUses, // function-end: no use is reached.
    };
    analyze(cfg, config);
    const snapshot = new WeakMap();
    for (const node of cfg.nodes.values()) {
        const state = node.annotation;
        if (state === undefined)
            continue;
        snapshot.set(node, state.out);
    }
    return {
        ran: true,
        table,
        cfg,
        getUsesAfter: (name, cfgNode) => {
            const r = snapshot.get(cfgNode);
            if (r === undefined)
                return new Set();
            return r.uses.get(name) ?? new Set();
        },
    };
}
// ---------------------------------------------------------------------------
// flowThrough — compute IN from OUT by walking the node's expression. We
// process in reverse evaluation order so writes (that kill) and reads (that
// add) land in their correct relative order.
function flowThrough$1(cfgNode, out, table) {
    const result = cloneReachingUses(out);
    const value = cfgNode.value;
    if (typeof value !== 'symbol') {
        computeMayUse(value, result, /* conditional */ false, table);
    }
    return result;
}
function computeMayUse(n, out, conditional, table) {
    if (t.isProgram(n) || t.isFile(n) || t.isFunction(n) || t.isBlockStatement(n))
        return;
    if (t.isWhileStatement(n) || t.isDoWhileStatement(n) || t.isIfStatement(n)) {
        computeMayUse(n.test, out, conditional, table);
        return;
    }
    if (t.isForStatement(n)) {
        if (n.test)
            computeMayUse(n.test, out, conditional, table);
        return;
    }
    if (t.isForInStatement(n) || t.isForOfStatement(n)) {
        const lhs = n.left;
        if (t.isVariableDeclaration(lhs)) {
            const last = lhs.declarations[lhs.declarations.length - 1];
            if (last && t.isIdentifier(last.id) && !conditional) {
                killUse(last.id.name, out, table);
            }
        }
        else if (t.isIdentifier(lhs) && !conditional) {
            killUse(lhs.name, out, table);
        }
        computeMayUse(n.right, out, conditional, table);
        return;
    }
    if (t.isLogicalExpression(n)) {
        // Reverse eval order: RHS conditional, LHS unconditional.
        computeMayUse(n.right, out, /* conditional */ true, table);
        computeMayUse(n.left, out, conditional, table);
        return;
    }
    if (t.isConditionalExpression(n)) {
        computeMayUse(n.alternate, out, true, table);
        computeMayUse(n.consequent, out, true, table);
        computeMayUse(n.test, out, conditional, table);
        return;
    }
    if (t.isOptionalMemberExpression(n)) {
        if (n.computed)
            computeMayUse(n.property, out, true, table);
        computeMayUse(n.object, out, conditional, table);
        return;
    }
    if (t.isOptionalCallExpression(n)) {
        for (let i = n.arguments.length - 1; i >= 0; i--) {
            const a = n.arguments[i];
            if (t.isExpression(a))
                computeMayUse(a, out, true, table);
        }
        computeMayUse(n.callee, out, conditional, table);
        return;
    }
    if (t.isVariableDeclaration(n)) {
        for (let i = n.declarations.length - 1; i >= 0; i--) {
            const d = n.declarations[i];
            if (t.isIdentifier(d.id)) {
                if (d.init) {
                    if (!conditional)
                        killUse(d.id.name, out, table);
                    computeMayUse(d.init, out, conditional, table);
                }
            }
            else if (d.init) {
                computeMayUse(d.init, out, conditional, table);
            }
        }
        return;
    }
    if (t.isAssignmentExpression(n)) {
        if (t.isIdentifier(n.left)) {
            if (!conditional)
                killUse(n.left.name, out, table);
            // Compound assign reads x first.
            if (n.operator !== '=')
                addUse(n.left.name, n.left, out, table);
            computeMayUse(n.right, out, conditional, table);
            return;
        }
        // Member or destructure — descend.
        computeMayUse(n.right, out, conditional, table);
        if ('type' in n.left)
            computeMayUse(n.left, out, conditional, table);
        return;
    }
    if (t.isUpdateExpression(n)) {
        if (t.isIdentifier(n.argument)) {
            if (!conditional)
                killUse(n.argument.name, out, table);
            addUse(n.argument.name, n.argument, out, table);
            return;
        }
    }
    if (t.isIdentifier(n)) {
        addUse(n.name, n, out, table);
        return;
    }
    // Default: walk children in reverse order.
    const keys = t.VISITOR_KEYS[n.type] ?? [];
    for (let ki = keys.length - 1; ki >= 0; ki--) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const child = n[keys[ki]];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = child.length - 1; i >= 0; i--) {
                const c = child[i];
                if (c && typeof c === 'object' && 'type' in c) {
                    computeMayUse(c, out, conditional, table);
                }
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
            computeMayUse(child, out, conditional, table);
        }
    }
}
function addUse(name, node, out, table) {
    if (!table.indexByName.has(name))
        return;
    if (table.escaped.has(name))
        return;
    let set = out.uses.get(name);
    if (set === undefined) {
        set = new Set();
        out.uses.set(name, set);
    }
    set.add(node);
}
function killUse(name, out, table) {
    if (!table.indexByName.has(name))
        return;
    if (table.escaped.has(name))
        return;
    out.uses.delete(name);
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
// Used by FlowSensitiveInlineVariables.
function newMustDef() {
    return { reachingDef: new Map() };
}
function cloneMustDef(d) {
    return { reachingDef: new Map(d.reachingDef) };
}
function entryMustDef(table, fnRoot) {
    const m = newMustDef();
    for (const name of table.indexByName.keys()) {
        m.reachingDef.set(name, {
            node: fnRoot,
            depends: new Set(),
            unknownDependencies: false,
        });
    }
    return m;
}
function defsEqual(a, b) {
    // Closure: definitions are equal iff their cfg-node identity matches.
    if (a === null || b === null)
        return a === b;
    return a.node === b.node;
}
function mustDefEquals(a, b) {
    if (a.reachingDef.size !== b.reachingDef.size)
        return false;
    for (const [k, va] of a.reachingDef) {
        if (!b.reachingDef.has(k))
            return false;
        if (!defsEqual(va, b.reachingDef.get(k) ?? null))
            return false;
    }
    return true;
}
function mustDefJoin(a, b) {
    const result = newMustDef();
    const merge = (input) => {
        for (const [k, vIn] of input.reachingDef) {
            if (vIn === null) {
                result.reachingDef.set(k, null);
                continue;
            }
            if (!result.reachingDef.has(k)) {
                result.reachingDef.set(k, vIn);
                continue;
            }
            const cur = result.reachingDef.get(k);
            if (defsEqual(cur, vIn))
                continue;
            result.reachingDef.set(k, null);
        }
    };
    merge(a);
    merge(b);
    return result;
}
function runMustReachingDef(fn, cfg, table) {
    const config = {
        direction: 'forward',
        flowThrough: (node, input) => flowThrough(fn, node, input, table),
        joinFlows: mustDefJoin,
        equals: mustDefEquals,
        bottom: newMustDef,
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
        getDef: (name, cfgNode) => {
            const m = snapshot.get(cfgNode);
            if (m === undefined)
                return undefined;
            return m.reachingDef.get(name);
        },
    };
}
// ---------------------------------------------------------------------------
// flowThrough
function flowThrough(fn, cfgNode, input, table) {
    const output = cloneMustDef(input);
    const value = cfgNode.value;
    if (typeof value !== 'symbol') {
        computeMustDef(fn, value, value, output, false, table);
    }
    return output;
}
function computeMustDef(fn, n, cfgNode, out, conditional, table) {
    if (t.isProgram(n) || t.isFile(n) || t.isFunction(n) || t.isBlockStatement(n)) {
        return;
    }
    if (t.isWhileStatement(n) || t.isDoWhileStatement(n) || t.isIfStatement(n)) {
        computeMustDef(fn, n.test, cfgNode, out, conditional, table);
        return;
    }
    if (t.isForStatement(n)) {
        if (n.test)
            computeMustDef(fn, n.test, cfgNode, out, conditional, table);
        return;
    }
    if (t.isForInStatement(n) || t.isForOfStatement(n)) {
        const lhs = n.left;
        if (t.isVariableDeclaration(lhs)) {
            const last = lhs.declarations[lhs.declarations.length - 1];
            if (last && t.isIdentifier(last.id)) {
                addToDefIfLocal(last.id.name, conditional ? null : cfgNode, n.right, out, table);
            }
        }
        else if (t.isIdentifier(lhs)) {
            addToDefIfLocal(lhs.name, conditional ? null : cfgNode, n.right, out, table);
        }
        return;
    }
    if (t.isLogicalExpression(n)) {
        computeMustDef(fn, n.left, cfgNode, out, conditional, table);
        computeMustDef(fn, n.right, cfgNode, out, /* conditional */ true, table);
        return;
    }
    if (t.isConditionalExpression(n)) {
        computeMustDef(fn, n.test, cfgNode, out, conditional, table);
        computeMustDef(fn, n.consequent, cfgNode, out, true, table);
        computeMustDef(fn, n.alternate, cfgNode, out, true, table);
        return;
    }
    if (t.isOptionalMemberExpression(n)) {
        computeMustDef(fn, n.object, cfgNode, out, conditional, table);
        if (n.computed)
            computeMustDef(fn, n.property, cfgNode, out, true, table);
        return;
    }
    if (t.isOptionalCallExpression(n)) {
        computeMustDef(fn, n.callee, cfgNode, out, conditional, table);
        for (const arg of n.arguments) {
            if (t.isExpression(arg))
                computeMustDef(fn, arg, cfgNode, out, true, table);
        }
        return;
    }
    if (t.isVariableDeclaration(n)) {
        for (const d of n.declarations) {
            if (d.init && t.isIdentifier(d.id)) {
                computeMustDef(fn, d.init, cfgNode, out, conditional, table);
                addToDefIfLocal(d.id.name, conditional ? null : cfgNode, d.init, out, table);
            }
            else if (d.init) {
                computeMustDef(fn, d.init, cfgNode, out, conditional, table);
            }
        }
        return;
    }
    if (t.isAssignmentExpression(n)) {
        if (t.isIdentifier(n.left)) {
            computeMustDef(fn, n.right, cfgNode, out, conditional, table);
            addToDefIfLocal(n.left.name, conditional ? null : cfgNode, n.right, out, table);
            return;
        }
        // Member or destructure assign — descend defensively.
        if ('type' in n.left)
            computeMustDef(fn, n.left, cfgNode, out, conditional, table);
        computeMustDef(fn, n.right, cfgNode, out, conditional, table);
        return;
    }
    if (t.isUpdateExpression(n)) {
        if (t.isIdentifier(n.argument)) {
            // Treat ++/-- as a self-referencing redefinition with depends={x}.
            addToDefIfLocal(n.argument.name, conditional ? null : cfgNode, n.argument, out, table);
            return;
        }
    }
    if (t.isIdentifier(n) && n.name === 'arguments') {
        // Closure's escapeParameters: lose all parameter knowledge.
        for (const param of fn.params) {
            for (const name of bindingIdNames(param)) {
                if (table.indexByName.has(name))
                    out.reachingDef.set(name, null);
            }
        }
        return;
    }
    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const child = n[key];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c && typeof c === 'object' && 'type' in c) {
                    computeMustDef(fn, c, cfgNode, out, conditional, table);
                }
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
            computeMustDef(fn, child, cfgNode, out, conditional, table);
        }
    }
}
function addToDefIfLocal(name, cfgNode, rhs, out, table) {
    if (!table.indexByName.has(name))
        return;
    // Invalidate any existing def that depends on `name` (we just rebound it).
    for (const [k, def] of out.reachingDef) {
        if (def === null)
            continue;
        if (def.depends.has(name))
            out.reachingDef.set(k, null);
    }
    if (table.escaped.has(name))
        return;
    if (cfgNode === null) {
        out.reachingDef.set(name, null);
        return;
    }
    const def = {
        node: cfgNode,
        depends: new Set(),
        unknownDependencies: false,
    };
    if (rhs !== null)
        computeDependence(def, rhs, table);
    out.reachingDef.set(name, def);
}
function computeDependence(def, rhs, table) {
    const visit = (n, parent) => {
        if (parent !== null && isEnteringNewCfgNode(n, parent))
            return;
        if (t.isIdentifier(n)) {
            if (!table.indexByName.has(n.name)) {
                // External name (closure-captured, global, etc.) — we don't
                // know whether it can change.
                def.unknownDependencies = true;
            }
            else {
                def.depends.add(n.name);
            }
            return;
        }
        for (const key of t.VISITOR_KEYS[n.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[key];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c, n);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                visit(child, n);
            }
        }
    };
    visit(rhs, null);
}
function bindingIdNames(node) {
    const out = [];
    const visit = (n) => {
        if (t.isIdentifier(n)) {
            out.push(n.name);
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
                else if (t.isObjectProperty(p) && 'type' in p.value)
                    visit(p.value);
            }
            return;
        }
    };
    visit(node);
    return out;
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
// Drives MustBeReachingVariableDef + MaybeReachingVariableUse + the
// CheckPathsBetweenNodes graph utility.
function runFlowSensitiveInlineVariables(fn, cfg, table) {
    if (table.size === 0)
        return { ran: true, inlined: 0 };
    const reachDef = runMustReachingDef(fn, cfg, table);
    const reachUse = runMaybeReachingUse(cfg, table);
    const parents = buildParentMap(fn);
    const candidates = gatherCandidates(fn, cfg, table, reachDef.getDef, parents);
    let inlined = 0;
    for (const c of candidates) {
        if (canInline(c, fn, cfg, table, reachUse.getUsesAfter, parents)) {
            performInline(c, parents);
            inlined++;
        }
    }
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
            const name = id.name;
            if (!table.indexByName.has(name))
                return;
            if (table.escaped.has(name))
                return;
            const def = getDef(name, cfgNode);
            if (def === null || def === undefined)
                return;
            if (def.node === fn)
                return; // parameter sentinel — skip
            if (dependsOnOuterScopeVars(def))
                return;
            out.push({ name, def, use: id, useCfgNode: cfgNode });
        });
    }
    return out;
}
// ---------------------------------------------------------------------------
// canInline
function canInline(c, fn, cfg, table, getUsesAfter, parents) {
    const defLoc = locateDefExpr(c.def, c.name, parents);
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
    // 3. Pre/post sibling side-effect checks on names this def depends on.
    const namesToCheck = c.def.depends;
    if (checkPostExpressions(defLoc.expr, c.def.node, namesToCheck, parents) ||
        checkPreExpressions(c.use, c.useCfgNode.value, namesToCheck, parents)) {
        return false;
    }
    // 4. Exactly one syntactic use of `name` inside the use's CFG node.
    if (countNameUsesInCfgNode(c.useCfgNode.value, c.name, parents) !== 1) {
        return false;
    }
    // 5. Use not inside a loop.
    if (isWithinLoop(c.use, fn, parents))
        return false;
    // 6. Reaching-use set at the def's CFG node has exactly one element.
    const defCfg = cfg.nodes.get(c.def.node);
    if (defCfg === undefined)
        return false;
    const usesAfter = getUsesAfter(c.name, defCfg);
    if (usesAfter.size !== 1)
        return false;
    if (!usesAfter.has(c.use))
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
                return nodeHasInterferingEffect(v, namesToCheck);
            },
            edgePredicate: () => true,
            inclusive: false,
        });
        if (sideEffectOnPath)
            return false;
    }
    return true;
}
function locateDefExpr(def, name, parents) {
    let result = null;
    const visit = (n, parent) => {
        if (result !== null)
            return;
        if (parent !== null && isEnteringNewCfgNode(n, parent))
            return;
        if (t.isVariableDeclarator(n) &&
            t.isIdentifier(n.id) &&
            n.id.name === name &&
            n.init &&
            // Walk up to confirm parent is a VariableDeclaration we can mutate.
            true) {
            const declInfo = parents.get(n);
            if (declInfo && t.isVariableDeclaration(declInfo.parent)) {
                result = { kind: 'var', expr: n, rhs: n.init, decl: declInfo.parent };
                return;
            }
        }
        if (t.isAssignmentExpression(n) &&
            n.operator === '=' &&
            t.isIdentifier(n.left) &&
            n.left.name === name) {
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
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[key];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c, n);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
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
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[key];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                visit(child);
            }
        }
    };
    visit(rhs);
    return !unsafe;
}
// ---------------------------------------------------------------------------
// Side-effect checks within an expression tree.
function checkPostExpressions(n, expressionRoot, namesToCheck, parents) {
    let cur = n;
    while (cur !== expressionRoot) {
        for (const sib of rightSiblings(cur, parents)) {
            if (subtreeHasInterferingEffect(sib, namesToCheck))
                return true;
        }
        const info = parents.get(cur);
        if (info === undefined)
            return false;
        cur = info.parent;
    }
    return false;
}
function checkPreExpressions(n, expressionRoot, namesToCheck, parents) {
    let cur = n;
    while (cur !== expressionRoot) {
        for (const sib of leftSiblings(cur, parents)) {
            if (subtreeHasInterferingEffect(sib, namesToCheck))
                return true;
        }
        const info = parents.get(cur);
        if (info === undefined)
            return false;
        cur = info.parent;
    }
    return false;
}
function subtreeHasInterferingEffect(n, namesToCheck, parents) {
    let yes = false;
    const visit = (m) => {
        if (yes)
            return;
        if (t.isCallExpression(m) ||
            t.isOptionalCallExpression(m) ||
            t.isNewExpression(m)) {
            yes = true;
            return;
        }
        if (t.isAssignmentExpression(m) &&
            t.isIdentifier(m.left) &&
            namesToCheck.has(m.left.name)) {
            yes = true;
            return;
        }
        if (t.isUpdateExpression(m) && t.isIdentifier(m.argument) && namesToCheck.has(m.argument.name)) {
            yes = true;
            return;
        }
        if (t.isUnaryExpression(m) && m.operator === 'delete') {
            yes = true;
            return;
        }
        if (t.isFunction(m))
            return;
        for (const key of t.VISITOR_KEYS[m.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = m[key];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                visit(child);
            }
        }
    };
    visit(n);
    return yes;
}
function nodeHasInterferingEffect(cfgValue, namesToCheck, parents) {
    return subtreeHasInterferingEffect(cfgValue, namesToCheck);
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
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[key];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        walk(c, n);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
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
    if (t.isOptionalMemberExpression(parent) &&
        parent.property === id &&
        !parent.computed)
        return true;
    if (t.isObjectProperty(parent) && parent.key === id && !parent.computed)
        return true;
    return false;
}
function countNameUsesInCfgNode(cfgValue, name, parents) {
    let count = 0;
    forEachIdentifierRead(cfgValue, parents, (id) => {
        if (id.name === name)
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
function performInline(c, parents) {
    const loc = locateDefExpr(c.def, c.name, parents);
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
        // var x = rhs → drop the declarator (or null its init if it's the
        // only declarator in a const, but const is rejected upstream by the
        // shape check).
        const decl = loc.decl;
        if (decl.declarations.length === 1) {
            removeFromParent(decl, parents);
        }
        else {
            const idx = decl.declarations.indexOf(loc.expr);
            if (idx >= 0)
                decl.declarations.splice(idx, 1);
        }
    }
}
function buildParentMap(root) {
    const map = new WeakMap();
    const walk = (n, parent, key, index) => {
        if (parent !== null)
            map.set(n, { parent, key, index });
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c && typeof c === 'object' && 'type' in c)
                        walk(c, n, k, i);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
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
    // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
    const arr = info.parent[info.key];
    return arr.slice(info.index + 1).filter((x) => x && typeof x === 'object' && 'type' in x);
}
function leftSiblings(n, parents) {
    const info = parents.get(n);
    if (info === undefined)
        return [];
    if (info.index === undefined)
        return [];
    // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
    const arr = info.parent[info.key];
    return arr.slice(0, info.index).filter((x) => x && typeof x === 'object' && 'type' in x);
}
function replaceInParent(n, replacement, parents) {
    const info = parents.get(n);
    if (info === undefined)
        return;
    const { parent, key, index } = info;
    if (index !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const arr = parent[key];
        arr[index] = replacement;
    }
    else {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        parent[key] = replacement;
    }
    parents.set(replacement, { parent, key, index });
}
function removeFromParent(n, parents) {
    const info = parents.get(n);
    if (info === undefined)
        return;
    const { parent, key, index } = info;
    if (index !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const arr = parent[key];
        arr.splice(index, 1);
        for (let i = index; i < arr.length; i++) {
            const c = arr[i];
            if (c && typeof c === 'object' && 'type' in c) {
                parents.set(c, { parent, key, index: i });
            }
        }
    }
    else {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        parent[key] = null;
    }
}

// Helper used by LiveVariablesAnalysis (and downstream DeadAssignmentsElim).
//
// Closure has a full Scope/Var/ScopeCreator stack (jscomp/Scope.java +
// SyntacticScopeCreator etc., ~1000 LOC). For our v1 we don't need that
// generality — we just need:
//
//   1. An enumeration of every local-to-this-function variable (params +
//      var/let/const/function declarations at any nesting inside the function
//      body) keyed by name in declaration order. This becomes the variable
//      index space the BitSet lattices use.
//
//   2. A predicate "was variable X referenced inside a nested function?",
//      which marks X as ESCAPED — escaped locals are treated as live-out at
//      the implicit return so liveness analysis doesn't drop their stores.
//
// Limitations vs Closure (deliberately taken to keep this small and to avoid
// the ScopeCreator port):
//
//   - We don't model lexical shadowing inside the function. Two separate
//     `let x` in non-overlapping inner blocks collapse to "the same x" for
//     analysis purposes. This is over-conservative: liveness sees more uses,
//     DAE eliminates fewer stores. Always safe.
//
//   - We don't distinguish between locals and outer-scope captures. A name
//     used inside the function that wasn't declared here is ignored entirely
//     (we never index it). DAE never touches it; safe.
//
// If/when we hit a real correctness issue from this, we either upgrade to a
// proper scope walker or port jscomp/Scope.java.
function buildLocalVariableTable(fn) {
    const indexByName = new Map();
    const escaped = new Set();
    const addLocal = (name) => {
        if (!indexByName.has(name))
            indexByName.set(name, indexByName.size);
    };
    // Params first (Closure indexes parameters before body locals).
    for (const param of fn.params) {
        for (const name of bindingNamesIn(param))
            addLocal(name);
    }
    // Walk the body collecting var/let/const/function decl bindings. We
    // descend into nested blocks/loops/etc. but NOT into nested functions —
    // their locals belong to that function's table.
    const body = fn.body;
    if (t.isBlockStatement(body)) {
        collectDeclsIn(body, addLocal);
    }
    // Now find which collected locals are referenced from inside a nested
    // function (= escape via closure).
    if (t.isBlockStatement(body)) {
        collectEscapesIn(body, indexByName, escaped, /* insideNestedFn */ false);
    }
    // `arguments` use: if any reference to `arguments` exists in the
    // function (not inside a nested non-arrow function which has its own
    // arguments), Closure escapes ALL parameters. Mirror that.
    if (referencesArguments(fn)) {
        for (const param of fn.params) {
            for (const name of bindingNamesIn(param))
                escaped.add(name);
        }
    }
    return { indexByName, escaped, size: indexByName.size };
}
// Returns the variable names introduced by a binding pattern (param or
// var/let/const target). Handles destructuring + rest + defaults.
function bindingNamesIn(node) {
    const out = [];
    const visit = (n) => {
        if (t.isIdentifier(n)) {
            out.push(n.name);
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
            for (const el of n.elements) {
                if (el !== null)
                    visit(el);
            }
            return;
        }
        if (t.isObjectPattern(n)) {
            for (const p of n.properties) {
                if (t.isRestElement(p)) {
                    visit(p.argument);
                }
                else if (t.isObjectProperty(p)) {
                    visit(p.value);
                }
            }
            return;
        }
        if (t.isVariableDeclarator(n)) {
            visit(n.id);
            return;
        }
    };
    visit(node);
    return out;
}
function collectDeclsIn(node, addLocal) {
    // Don't descend into nested functions — they have their own table.
    if (t.isFunction(node)) {
        // …unless we're at the very root, but the caller never passes the
        // function itself in here.
        if (t.isFunctionDeclaration(node) && node.id) {
            // function declarations bind their name in the enclosing scope —
            // so a `function inner() {}` inside our body adds `inner` as a
            // local of OUR function.
            addLocal(node.id.name);
        }
        return;
    }
    if (t.isVariableDeclaration(node)) {
        for (const d of node.declarations) {
            for (const name of bindingNamesIn(d.id))
                addLocal(name);
        }
        // VariableDeclarator initializers might contain function expressions
        // that themselves should not contribute, but they could contain inner
        // var declarations only if those funcs aren't nested — which they are.
        // Stop here.
        return;
    }
    if (t.isCatchClause(node) && node.param) {
        for (const name of bindingNamesIn(node.param))
            addLocal(name);
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const child = node[key];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c && typeof c === 'object' && 'type' in c)
                    collectDeclsIn(c, addLocal);
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
            collectDeclsIn(child, addLocal);
        }
    }
}
function collectEscapesIn(node, indexByName, escaped, insideNestedFn) {
    if (t.isIdentifier(node)) {
        if (insideNestedFn && indexByName.has(node.name)) {
            escaped.add(node.name);
        }
        return;
    }
    const isFn = t.isFunction(node);
    const nestedNow = insideNestedFn || isFn;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const child = node[key];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c && typeof c === 'object' && 'type' in c) {
                    collectEscapesIn(c, indexByName, escaped, nestedNow);
                }
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
            collectEscapesIn(child, indexByName, escaped, nestedNow);
        }
    }
}
function referencesArguments(fn) {
    let found = false;
    const visit = (node, insideNestedNonArrow) => {
        if (found)
            return;
        if (t.isIdentifier(node) && node.name === 'arguments' && !insideNestedNonArrow) {
            found = true;
            return;
        }
        // Arrow functions inherit `arguments` from their enclosing function;
        // declarations / expressions / methods get their own.
        const enters = (t.isFunctionDeclaration(node) ||
            t.isFunctionExpression(node) ||
            t.isObjectMethod(node) ||
            t.isClassMethod(node) ||
            t.isClassPrivateMethod(node)) &&
            node !== fn;
        const nested = insideNestedNonArrow || enters;
        for (const key of t.VISITOR_KEYS[node.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = node[key];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c, nested);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                visit(child, nested);
            }
        }
    };
    visit(fn, false);
    return found;
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
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const child = n[k];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c && typeof c === 'object' && 'type' in c)
                    walk$2(c, n, k, i, ctx);
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
            walk$2(child, n, k, undefined, ctx);
        }
    }
    if (parent === null)
        return;
    const replacement = tryFold(n);
    if (replacement === null)
        return;
    if (index !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const arr = parent[key];
        arr[index] = replacement;
    }
    else {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        parent[key] = replacement;
    }
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
        if (t.isUnaryExpression(n.argument) &&
            n.argument.operator === '-' &&
            t.isNumericLiteral(n.argument.argument)) {
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
        if (t.isIdentifier(n.left) &&
            n.left.name === 'undefined') {
            return n.right;
        }
        // Any non-null/undefined literal short-circuits to the LHS.
        if ((t.isNumericLiteral(n.left) ||
            t.isStringLiteral(n.left) ||
            t.isBooleanLiteral(n.left)) &&
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
    if (t.isUnaryExpression(node) &&
        node.operator === '-' &&
        t.isNumericLiteral(node.argument)) {
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
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/':
            if (r === 0)
                return null;
            return l / r;
        case '%':
            if (r === 0)
                return null;
            return l % r;
        case '**': return l ** r;
        case '&': return toInt32(l) & toInt32(r);
        case '|': return toInt32(l) | toInt32(r);
        case '^': return toInt32(l) ^ toInt32(r);
        // Shift counts: JS masks the RHS to 5 bits — we let the engine do it.
        case '<<': return toInt32(l) << toInt32(r);
        case '>>': return toInt32(l) >> toInt32(r);
        case '>>>': return toUint32(l) >>> toInt32(r);
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
    // biome-ignore lint/suspicious/noExplicitAny: union narrowing
    const obj = n.object;
    // biome-ignore lint/suspicious/noExplicitAny: union narrowing
    const callee = n.callee;
    const head = obj ?? callee;
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
            case '<': return lv < rv;
            case '<=': return lv <= rv;
            case '>': return lv > rv;
            case '>=': return lv >= rv;
            case '==': return lv == rv;
            case '!=': return lv != rv;
            case '===': return lv === rv;
            case '!==': return lv !== rv;
        }
    }
    if (t.isStringLiteral(left) && t.isStringLiteral(right)) {
        switch (op) {
            case '==': return left.value === right.value;
            case '!=': return left.value !== right.value;
            case '===': return left.value === right.value;
            case '!==': return left.value !== right.value;
            case '<': return left.value < right.value;
            case '<=': return left.value <= right.value;
            case '>': return left.value > right.value;
            case '>=': return left.value >= right.value;
        }
    }
    if (t.isBooleanLiteral(left) && t.isBooleanLiteral(right)) {
        switch (op) {
            case '==': return left.value === right.value;
            case '!=': return left.value !== right.value;
            case '===': return left.value === right.value;
            case '!==': return left.value !== right.value;
        }
    }
    return null;
}

// Port of jscomp/PeepholeMinimizeConditions.java (subset).
//
// Boolean control-flow minimization. Operates bottom-up; safe to repeat at
// the fixpoint level alongside fold-constants and remove-dead-code.
//
// Covered:
//   - !(a CMP b) → a NEG_CMP b for ==, ===, !=, !==, <, <=, >, >=
//   - !(!x)      → x   (the inner negation has the boolean coercion already)
//   - cond ? a : a → a  (when cond is pure)
//   - cond ? true : false → !!cond (preserved as ConditionalExpression
//     against !cond when cond isn't already boolean — see helper)
//   - cond ? false : true → !cond
//   - if (c) return X; else return Y;        → return c ? X : Y;
//   - if (c) return X; (followed by) return Y → return c ? X : Y; (collapses
//     across siblings in the same block)
//   - if (c) X = A; else X = B; → X = c ? A : B; (same target identifier)
//
// Not covered:
//   - de Morgan's full rewrite
//   - if/else with mixed return + non-return
//   - swap-conditional based on cost (Closure tries both shapes)
//   - exhaustive HOOK-flattening
//
// Closure runs this in the simplifier pass-list. We invoke it from the
// fixpoint loop via Simplifier.
function runPeepholeMinimizeConditions(root) {
    const ctx = { minimized: 0 };
    walk$1(root, null, '', undefined, ctx);
    return { minimized: ctx.minimized };
}
function walk$1(n, parent, key, index, ctx) {
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const child = n[k];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c && typeof c === 'object' && 'type' in c)
                    walk$1(c, n, k, i, ctx);
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
            walk$1(child, n, k, undefined, ctx);
        }
    }
    // Statement-list-level rewrites (block scope) — operate on the array.
    if (t.isBlockStatement(n) || t.isProgram(n)) {
        if (collapseIfReturnPair(n, ctx)) ;
    }
    if (parent === null)
        return;
    const replacement = tryMinimize(n);
    if (replacement === undefined)
        return;
    if (index !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const arr = parent[key];
        arr[index] = replacement;
    }
    else {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        parent[key] = replacement;
    }
    ctx.minimized++;
}
// ---------------------------------------------------------------------------
// Per-node minimizer.
function tryMinimize(n) {
    if (t.isUnaryExpression(n) && n.operator === '!')
        return minimizeNot(n);
    if (t.isConditionalExpression(n))
        return minimizeConditional(n);
    if (t.isIfStatement(n))
        return minimizeIfReturnElse(n);
    return undefined;
}
// ---------------------------------------------------------------------------
// !(...) rewrites.
const COMPARISON_NEGATION = {
    '==': '!=',
    '!=': '==',
    '===': '!==',
    '!==': '===',
    '<': '>=',
    '<=': '>',
    '>': '<=',
    '>=': '<',
};
function minimizeNot(n) {
    const arg = n.argument;
    // !(!x) → x   ('!' is boolean-typed, so the outer ! can't change x's value)
    if (t.isUnaryExpression(arg) && arg.operator === '!') {
        return arg.argument;
    }
    // !(a CMP b) → a NEG_CMP b
    if (t.isBinaryExpression(arg) && COMPARISON_NEGATION[arg.operator] !== undefined) {
        if (t.isPrivateName(arg.left))
            return undefined;
        return t.binaryExpression(COMPARISON_NEGATION[arg.operator], arg.left, arg.right);
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Conditional (?:) rewrites.
function minimizeConditional(n) {
    // cond ? a : a → a (when cond is pure)
    if (sameNode(n.consequent, n.alternate) && !mayHaveSideEffects(n.test)) {
        return n.consequent;
    }
    // cond ? true : false → cond  (only when cond is already boolean-typed —
    // we don't have type info, so wrap as `!!cond` via two negations).
    if (t.isBooleanLiteral(n.consequent) &&
        n.consequent.value === true &&
        t.isBooleanLiteral(n.alternate) &&
        n.alternate.value === false) {
        return t.unaryExpression('!', t.unaryExpression('!', n.test));
    }
    // cond ? false : true → !cond
    if (t.isBooleanLiteral(n.consequent) &&
        n.consequent.value === false &&
        t.isBooleanLiteral(n.alternate) &&
        n.alternate.value === true) {
        return t.unaryExpression('!', n.test);
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// if (c) return X; else return Y;  →  return c ? X : Y;
function minimizeIfReturnElse(n) {
    const cons = singleReturn(n.consequent);
    const alt = n.alternate ? singleReturn(n.alternate) : null;
    if (cons !== null && alt !== null) {
        return t.returnStatement(t.conditionalExpression(n.test, cons.argument ?? t.identifier('undefined'), alt.argument ?? t.identifier('undefined')));
    }
    // if (c) X = A; else X = B;  →  X = c ? A : B;
    const consAssign = singleAssign(n.consequent);
    const altAssign = n.alternate ? singleAssign(n.alternate) : null;
    if (consAssign !== null && altAssign !== null) {
        if (t.isIdentifier(consAssign.left) &&
            t.isIdentifier(altAssign.left) &&
            consAssign.left.name === altAssign.left.name &&
            consAssign.operator === altAssign.operator) {
            return t.expressionStatement(t.assignmentExpression(consAssign.operator, t.cloneNode(consAssign.left, true), t.conditionalExpression(n.test, consAssign.right, altAssign.right)));
        }
    }
    return undefined;
}
function singleReturn(s) {
    if (t.isReturnStatement(s))
        return s;
    if (t.isBlockStatement(s) && s.body.length === 1 && t.isReturnStatement(s.body[0])) {
        return s.body[0];
    }
    return null;
}
function singleAssign(s) {
    if (t.isExpressionStatement(s) &&
        t.isAssignmentExpression(s.expression) &&
        s.expression.operator === '=') {
        return s.expression;
    }
    if (t.isBlockStatement(s) && s.body.length === 1)
        return singleAssign(s.body[0]);
    return null;
}
// ---------------------------------------------------------------------------
// Statement-list collapses.
//
// if (c) return X;        if (c) return X;
// return Y;          →    return c ? X : Y;
function collapseIfReturnPair(block, ctx) {
    const body = block.body;
    let changed = false;
    for (let i = 0; i < body.length - 1; i++) {
        const a = body[i];
        const b = body[i + 1];
        if (t.isIfStatement(a) &&
            a.alternate == null &&
            t.isReturnStatement(b)) {
            const cons = singleReturn(a.consequent);
            if (cons === null)
                continue;
            const merged = t.returnStatement(t.conditionalExpression(a.test, cons.argument ?? t.identifier('undefined'), b.argument ?? t.identifier('undefined')));
            body.splice(i, 2, merged);
            ctx.minimized++;
            changed = true;
            // Do not advance i — re-check at this position.
            i--;
        }
    }
    return changed;
}
// ---------------------------------------------------------------------------
function sameNode(a, b) {
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
    return false;
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
//
// Not covered (deferred):
//   - switch case folding
//   - try/catch/finally optimization
//   - label removal (classic dce.ts handles unused labels via scope)
//   - optional-chain folding
//   - var/let hoisting through dead branches
//
// Closure runs this in the simplifier loop right after fold-constants. We do
// the same.
function runPeepholeRemoveDeadCode(root) {
    const ctx = { removed: 0 };
    walk(root, null, '', undefined, ctx);
    return { removed: ctx.removed };
}
function walk(n, parent, key, index, ctx) {
    // Bottom-up.
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const child = n[k];
        if (child === null || child === undefined)
            continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c && typeof c === 'object' && 'type' in c)
                    walk(c, n, k, i, ctx);
            }
        }
        else if (typeof child === 'object' && 'type' in child) {
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
    if (index !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        const arr = parent[key];
        arr[index] = replacement;
    }
    else {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
        parent[key] = replacement;
    }
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
    return undefined;
}
// ---------------------------------------------------------------------------
// If / Conditional
function foldIfStatement(n) {
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
    // Flatten nested plain BlockStatement children (those without their own
    // let/const/class declarations at the top level — those would change scope
    // semantics if hoisted). Done first so terminator scanning sees the
    // inner shape.
    const body = n.body;
    let flattened = 0;
    for (let i = 0; i < body.length; i++) {
        const s = body[i];
        if (t.isBlockStatement(s) && !blockHasLexicalDecl(s)) {
            body.splice(i, 1, ...s.body);
            flattened++;
            i += s.body.length - 1;
        }
    }
    if (flattened > 0)
        ctx.removed += flattened;
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
function blockHasLexicalDecl(b) {
    for (const s of b.body) {
        if (t.isVariableDeclaration(s) && (s.kind === 'let' || s.kind === 'const'))
            return true;
        if (t.isClassDeclaration(s))
            return true;
        if (t.isFunctionDeclaration(s))
            return true;
    }
    return false;
}
function isTerminator(s) {
    return (t.isReturnStatement(s) ||
        t.isThrowStatement(s) ||
        t.isBreakStatement(s) ||
        t.isContinueStatement(s));
}
function containsVarDeclaration(s) {
    if (t.isVariableDeclaration(s) && s.kind === 'var')
        return true;
    let found = false;
    const visit = (n) => {
        if (found || !n)
            return;
        if (t.isFunction(n))
            return;
        if (t.isVariableDeclaration(n) && n.kind === 'var') {
            found = true;
            return;
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                visit(child);
            }
        }
    };
    visit(s);
    return found;
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

// Per-function simplifier fixpoint. Mirrors the inner loop of Closure's
// `DefaultPassConfig` "simplify" group: alternate constant-folding, dead-code
// removal, flow-sensitive variable inlining, and dead-assignment elimination
// until no pass reports a change.
//
// Each iteration rebuilds CFG + LocalVariableTable from scratch because the
// AST mutates. This is wasteful in the limit but matches Closure's per-pass
// invalidation model and keeps invariants clean. CFG construction bails on
// try/with/generator/async — those functions short-circuit immediately.
const MAX_ITERATIONS = 16;
/**
 * Simplify a single function in place. Caller is responsible for picking
 * which functions to simplify (zone gating happens in the pipeline layer).
 */
function simplifyFunction(fn) {
    const stats = {
        iterations: 0,
        folded: 0,
        removed: 0,
        inlined: 0,
        deadAssigns: 0,
        minimized: 0,
    };
    for (let i = 0; i < MAX_ITERATIONS; i++) {
        let changed = false;
        const fold = runPeepholeFoldConstants(fn.body);
        if (fold.folded > 0) {
            changed = true;
            stats.folded += fold.folded;
        }
        const min = runPeepholeMinimizeConditions(fn.body);
        if (min.minimized > 0) {
            changed = true;
            stats.minimized += min.minimized;
        }
        const dead = runPeepholeRemoveDeadCode(fn.body);
        if (dead.removed > 0) {
            changed = true;
            stats.removed += dead.removed;
        }
        const cfg = buildControlFlowGraph({ root: fn.body });
        if (cfg !== null) {
            const table = buildLocalVariableTable(fn);
            const inline = runFlowSensitiveInlineVariables(fn, cfg, table);
            if (inline.inlined > 0) {
                changed = true;
                stats.inlined += inline.inlined;
            }
            // DAE needs a fresh CFG+table after inline, since inline mutates.
            if (inline.inlined > 0) {
                const cfg2 = buildControlFlowGraph({ root: fn.body });
                const table2 = buildLocalVariableTable(fn);
                if (cfg2 !== null) {
                    const live = runLiveVariablesAnalysis(cfg2, table2);
                    const da = eliminateDeadAssignments(fn, cfg2, live);
                    if (da.removed > 0) {
                        changed = true;
                        stats.deadAssigns += da.removed;
                    }
                }
            }
            else {
                const live = runLiveVariablesAnalysis(cfg, table);
                const da = eliminateDeadAssignments(fn, cfg, live);
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
 * Walk the program and simplify every Function node bottom-up. Bottom-up so
 * inner functions are simplified before outer; outer simplification then sees
 * the already-cleaned inner shape.
 */
function simplifyAll(root) {
    const total = {
        iterations: 0,
        folded: 0,
        removed: 0,
        inlined: 0,
        deadAssigns: 0,
        minimized: 0,
    };
    const visit = (n) => {
        if (n == null)
            return;
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic AST
            const child = n[k];
            if (child === null || child === undefined)
                continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c)
                        visit(c);
                }
            }
            else if (typeof child === 'object' && 'type' in child) {
                visit(child);
            }
        }
        if (t.isFunction(n)) {
            const s = simplifyFunction(n);
            total.iterations += s.iterations;
            total.folded += s.folded;
            total.removed += s.removed;
            total.inlined += s.inlined;
            total.deadAssigns += s.deadAssigns;
            total.minimized += s.minimized;
        }
    };
    visit(root);
    // Program-level cleanup: AST-only peepholes (no CFG) over the whole tree
    // for top-level statements outside any function.
    let topChanged = true;
    let topIters = 0;
    while (topChanged && topIters < MAX_ITERATIONS) {
        topChanged = false;
        const f = runPeepholeFoldConstants(root);
        if (f.folded > 0) {
            topChanged = true;
            total.folded += f.folded;
        }
        const m = runPeepholeMinimizeConditions(root);
        if (m.minimized > 0) {
            topChanged = true;
            total.minimized += m.minimized;
        }
        const d = runPeepholeRemoveDeadCode(root);
        if (d.removed > 0) {
            topChanged = true;
            total.removed += d.removed;
        }
        topIters++;
    }
    total.iterations += topIters;
    return total;
}

// Per-file orchestration. Mirrors src/plugin/transform.ts but driven by the
// gcc-tree analyses + transforms.
//
// Steps:
//   1. ANY_DIRECTIVE_IN_SOURCE pre-check (caller's responsibility usually).
//   2. Parse with @babel/parser.
//   3. Run InlineFunctions across the file.
//   4. Run simplifyAll across the file.
//   5. Generate code (and optional sourcemap).
// Babel CJS default-export interop: shows up as `{ default: fn }` under some
// bundlers and as `fn` directly under others.
// biome-ignore lint/suspicious/noExplicitAny: interop shim
const generate = _generate.default ?? _generate;
function transform(code, options = {}) {
    const ast = parse(code, parserOptions(options.filename));
    const inl = inlineFunctions(ast, {
        consumerPath: options.filename,
        fileCache: options.fileCache,
        fileReader: options.fileReader,
        allowLibraryInline: options.allowLibraryInline,
    });
    const unr = unrollLoops(ast);
    const sroa = applySroa(ast);
    const simp = simplifyAll(ast);
    const ivar = inlineVariables(ast);
    const ruc = removeUnusedCode(ast);
    // biome-ignore lint/suspicious/noExplicitAny: generator default-import shim
    const gen = generate;
    const out = gen(ast, {
        sourceMaps: options.sourceMaps === true,
        sourceFileName: options.filename,
    });
    return {
        code: out.code,
        map: out.map,
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
    };
}
function parserOptions(filename) {
    const isTs = filename ? /\.tsx?$/.test(filename) : false;
    const isJsx = filename ? /\.[jt]sx$/.test(filename) : false;
    const plugins = [];
    if (isTs)
        plugins.push('typescript');
    if (isJsx)
        plugins.push('jsx');
    return {
        sourceType: 'module',
        allowImportExportEverywhere: true,
        allowReturnOutsideFunction: false,
        plugins,
    };
}

const factory = (options = {}) => {
    const debug = options.debug === true;
    const crossFile = options.crossFile !== false;
    const libraryInline = options.libraryInline === true;
    // One FileCache per build amortizes parse + index across consumer files.
    const fileCache = crossFile ? createFileCache() : undefined;
    return {
        name: 'compilecat',
        transform(code, id) {
            if (!/\.(js|ts|jsx|tsx)$/.test(id))
                return null;
            if (!ANY_DIRECTIVE_IN_SOURCE.test(code))
                return null;
            if (debug)
                console.log(`[compilecat] transforming ${id}`);
            try {
                const r = transform(code, {
                    sourceMaps: true,
                    filename: id,
                    fileCache,
                    fileReader: options.fileReader,
                    allowLibraryInline: libraryInline,
                });
                if (debug) {
                    console.log(`[compilecat] ${id}: inlined=${r.stats.inlined} folded=${r.stats.folded} dead=${r.stats.removedDeadCode}`);
                }
                return { code: r.code, map: r.map };
            }
            catch (err) {
                console.error(`[compilecat] failed to transform ${id}:`, err);
                return null;
            }
        },
    };
};
const unplugin = createUnplugin(factory);

export { createFileCache, unplugin as default, inlineFunctions, simplifyAll, simplifyFunction, transform, unplugin };
//# sourceMappingURL=index.js.map
