import { createUnplugin } from 'unplugin';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import _generate from '@babel/generator';
import _traverse from '@babel/traverse';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

/**
 * Babel's CJS default exports show up as `{ default: fn }` under some bundler
 * configurations and as `fn` directly under others. Normalise once, here, so
 * the rest of plugin-alt can just `import { traverse, generate }` without
 * every call site re-doing the interop dance.
 */
function unwrapDefault(module) {
    return module.default ?? module;
}
const traverse = unwrapDefault(_traverse);
const generate = unwrapDefault(_generate);

/**
 * Single source of truth for compilecat's `@*` annotation vocabulary.
 *
 * Every zone name, its canonical regex, and the `@optimize` umbrella
 * membership live here. Other modules (zones.ts, discover.ts, the inline /
 * sroa / unroll transforms, the unplugin skip-gate) import from this file
 * so adding or renaming a directive is a one-line change.
 */
/**
 * Authored-form patterns. The `inline` regex excludes the `-body` suffix so
 * `@inline-body` doesn't also register as `@inline`. `\b` at the tail stops
 * `@inline` from matching the `@inlined` breadcrumb compilecat writes back
 * into the output.
 */
const DIRECTIVE_PATTERNS = {
    inline: /@inline(?!-body)\b/,
    'inline-body': /@inline-body\b/,
    sroa: /@sroa\b/,
    unroll: /@unroll\b/,
    optimize: /@optimize\b/,
};
/**
 * Zones implied by `@optimize`. Deliberately narrow: decl-visibility
 * (`@inline`) is a separate axis from body-level aggressiveness — you
 * might want a function heavily optimized without wanting V8 to inline it
 * at every callsite.
 */
const OPTIMIZE_DIRECTIVES = ['inline-body', 'sroa', 'unroll'];
/**
 * True iff `value` (the text inside a `/* ... *​/` block comment) matches
 * the inline-specific directives — `@inline` or `@inline-body`. Used
 * by the post-inline sweep to strip consumed inline markers without touching
 * `@sroa`, `@unroll`, or `@optimize`, which later passes still need to read.
 *
 * Matches directives authored in the source, not the `@inlined` breadcrumb
 * compilecat writes back into the output.
 */
function commentIsInlineDirective(value) {
    return DIRECTIVE_PATTERNS.inline.test(value) || DIRECTIVE_PATTERNS['inline-body'].test(value);
}
/**
 * Fast pre-check for whole-file skip: does the source contain any of our
 * directive markers? Cheaper than parsing the file just to learn there's
 * nothing to do. Enumerates the known directive names — a typo'd `@inlien`
 * won't pass the gate, which is the usual tradeoff: fewer false positives
 * (so fewer wasted parses) at the cost of needing to update this regex when
 * we add a directive.
 */
const ANY_DIRECTIVE_IN_SOURCE = /@(?:inline(?:-body)?|sroa|unroll|optimize)\b/;

/**
 * discover — builds a FileIndex for a single source file.
 *
 * Surfaces the structural facts the inliner needs:
 *   - `@inline`-annotated top-level functions (with their params/body)
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
function hasBlockAnnotation(node, pattern) {
    if (!node)
        return false;
    const comments = node.leadingComments;
    if (!comments)
        return false;
    return comments.some((c) => c.type === 'CommentBlock' && pattern.test(c.value));
}
function hasInlineAnnotation(node) {
    return hasBlockAnnotation(node, INLINE_PATTERN);
}
function hasInlineBodyAnnotation(node) {
    return hasBlockAnnotation(node, INLINE_BODY_PATTERN) || hasBlockAnnotation(node, OPTIMIZE_PATTERN);
}
function hasSroaAnnotation(node) {
    return hasBlockAnnotation(node, SROA_PATTERN) || hasBlockAnnotation(node, OPTIMIZE_PATTERN);
}
function hasUnrollAnnotation(node) {
    return hasBlockAnnotation(node, UNROLL_PATTERN) || hasBlockAnnotation(node, OPTIMIZE_PATTERN);
}
/**
 * Callsite `@inline` detection — handles both
 *   `/* @inline *​/ foo();`       (comment on the enclosing statement)
 *   `const x = /* @inline *​/ foo();`  (comment on the call expression itself)
 */
function callSiteHasInlineAnnotation(path) {
    if (hasInlineAnnotation(path.node))
        return true;
    const parent = path.parentPath;
    if (parent?.isExpressionStatement()) {
        if (hasInlineAnnotation(parent.node))
            return true;
    }
    return false;
}
function indexFile(absolutePath, ast) {
    const functions = new Map();
    const moduleVars = new Map();
    const imports = new Map();
    const namespaceReexports = new Map();
    for (const stmt of ast.program.body) {
        collectStatement(stmt, absolutePath, functions, moduleVars, imports, namespaceReexports, false, false);
    }
    // Second pass: free-reference analysis. Needs the full top-level name set
    // to distinguish "reads a module var" from "reads a local".
    const topLevelNames = new Set([...functions.keys(), ...moduleVars.keys(), ...imports.keys()]);
    for (const fn of functions.values()) {
        analyzeFreeRefs(fn, topLevelNames, functions, moduleVars, imports, ast);
    }
    return { absolutePath, ast, functions, moduleVars, imports, namespaceReexports };
}
/**
 * Collect a top-level statement. The `inherited*` flags let a block comment
 * above an export declaration flow down to the exported function.
 */
function collectStatement(stmt, sourceFile, functions, moduleVars, imports, namespaceReexports, inheritedInline, inheritedInlineBody) {
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
            collectStatement(stmt.declaration, sourceFile, functions, moduleVars, imports, namespaceReexports, localInline, localInlineBody);
        }
        return;
    }
    if (t.isExportDefaultDeclaration(stmt)) {
        const decl = stmt.declaration;
        if (t.isFunctionDeclaration(decl) || t.isFunctionExpression(decl) || t.isArrowFunctionExpression(decl)) {
            functions.set('default', buildFunctionEntry('default', sourceFile, decl, null, localInline, localInlineBody));
        }
        return;
    }
    if (t.isFunctionDeclaration(stmt) && stmt.id) {
        functions.set(stmt.id.name, buildFunctionEntry(stmt.id.name, sourceFile, stmt, null, localInline, localInlineBody));
        return;
    }
    if (t.isVariableDeclaration(stmt)) {
        for (const decl of stmt.declarations) {
            if (!t.isIdentifier(decl.id))
                continue;
            const name = decl.id.name;
            if (decl.init && (t.isArrowFunctionExpression(decl.init) || t.isFunctionExpression(decl.init))) {
                functions.set(name, buildFunctionEntry(name, sourceFile, decl.init, null, localInline, localInlineBody));
            }
            else {
                moduleVars.set(name, { name, declaration: stmt, isExported: false });
            }
        }
        return;
    }
}
function buildFunctionEntry(name, sourceFile, fn, path, hasInlineAnnotation, hasInlineBodyAnnotation) {
    let body;
    if (t.isBlockStatement(fn.body)) {
        body = fn.body;
    }
    else {
        // arrow with expression body: wrap in `{ return <expr> }` equivalent
        body = t.blockStatement([t.returnStatement(fn.body)]);
    }
    const { isSimpleReturn, returnExpression } = classifyBody(body);
    const kind = t.isFunctionDeclaration(fn) ? 'declaration' : t.isArrowFunctionExpression(fn) ? 'arrow' : 'expression';
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
            const importedName = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
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
/**
 * Walk a function body and record which top-level names it references. Uses
 * babel scope to filter out locals and parameters.
 */
function analyzeFreeRefs(fn, topLevelNames, functions, moduleVars, imports, ast) {
    // We need a NodePath to use babel scope. Re-find the function via traversal.
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
                (t.isArrowFunctionExpression(path.node.init) || t.isFunctionExpression(path.node.init))) {
                rootPath = path.get('init');
                path.stop();
            }
        },
        ExportDefaultDeclaration(path) {
            if (fn.name !== 'default')
                return;
            const decl = path.node.declaration;
            if (t.isFunctionDeclaration(decl) || t.isFunctionExpression(decl) || t.isArrowFunctionExpression(decl)) {
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
            // Skip identifiers in binding positions (decls, function params, etc.).
            if (!innerPath.isReferencedIdentifier())
                return;
            const scopeBinding = innerPath.scope.getBinding(name);
            // No binding: treat as global (e.g. `Math`, `console`) — not a top-level ref.
            if (!scopeBinding)
                return;
            // Any binding that isn't at Program scope is a local shadow.
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

const defaultFileReader = (absolutePath) => {
    try {
        return fs.readFileSync(absolutePath, 'utf-8');
    }
    catch {
        return null;
    }
};
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
/** Disk-backed existence check using statSync. */
function diskExists(path) {
    try {
        return fs.statSync(path).isFile();
    }
    catch {
        return false;
    }
}
/**
 * Build an existence predicate from a FileReader. When no reader is given we
 * fall back to statSync (cheap, no file-read). With a reader we call it and
 * treat a non-null return as "exists" — this is how tests with a virtual
 * filesystem get relative-resolution to work.
 */
function makeExists(reader) {
    if (!reader)
        return diskExists;
    return (path) => reader(path) !== null;
}
/** Try `base`, then each `base + ext`, then `base/index.ext`. */
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
/**
 * Resolve a relative or absolute import specifier to a filesystem path.
 * Returns null for bare specifiers (those are library imports).
 */
function resolveRelativeImport(fromFile, specifier, reader) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) {
        return null;
    }
    const base = nodePath.isAbsolute(specifier)
        ? specifier
        : nodePath.resolve(nodePath.dirname(fromFile), specifier);
    return probeWithExtensions(base, makeExists(reader));
}
/**
 * Split a bare specifier into (package name, subpath).
 *   `lodash`           → ['lodash', '.']
 *   `lodash/get`       → ['lodash', './get']
 *   `@scope/pkg`       → ['@scope/pkg', '.']
 *   `@scope/pkg/sub`   → ['@scope/pkg', './sub']
 */
function splitBareSpecifier(specifier) {
    if (specifier.startsWith('@')) {
        const parts = specifier.split('/');
        if (parts.length < 2)
            return [specifier, '.'];
        const name = `${parts[0]}/${parts[1]}`;
        const sub = parts.length > 2 ? './' + parts.slice(2).join('/') : '.';
        return [name, sub];
    }
    const idx = specifier.indexOf('/');
    if (idx < 0)
        return [specifier, '.'];
    return [specifier.slice(0, idx), './' + specifier.slice(idx + 1)];
}
/** Walk up from a dir looking for `node_modules/<pkg>`. */
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
/**
 * Resolve a subpath through package.json `exports`. We only handle what
 * real code actually uses: a string target, or a conditions object with the
 * standard conditions. Nested condition objects recurse.
 */
function resolveThroughExports(exportsField, subpath) {
    if (!exportsField || typeof exportsField !== 'object')
        return null;
    const exps = exportsField;
    // shorthand: `"exports": "./dist/index.js"` — only valid for subpath '.'
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
/**
 * Resolve a bare specifier (`lodash`, `@scope/pkg/sub`) to a filesystem path.
 * Returns null if the package can't be found or the subpath doesn't resolve.
 *
 * Library resolution reads package.json from disk; tests use real tmpdirs
 * because mocking node_modules through a virtual reader is impractical.
 */
function resolveLibraryImport(fromFile, specifier) {
    const [pkgName, subpath] = splitBareSpecifier(specifier);
    const pkgRoot = findPackageRoot(nodePath.dirname(fromFile), pkgName);
    if (!pkgRoot)
        return null;
    const pkg = readPackageJson(pkgRoot);
    if (!pkg)
        return null;
    const diskExistsFn = diskExists;
    // exports field first
    const exportTarget = resolveThroughExports(pkg.exports, subpath);
    if (exportTarget) {
        return probeWithExtensions(nodePath.join(pkgRoot, exportTarget), diskExistsFn);
    }
    // fall back to main / module for root subpath
    if (subpath === '.') {
        const target = pkg.module ?? pkg.main;
        if (target)
            return probeWithExtensions(nodePath.join(pkgRoot, target), diskExistsFn);
        return probeWithExtensions(nodePath.join(pkgRoot, 'index'), diskExistsFn);
    }
    // non-root subpath without exports: probe directly
    return probeWithExtensions(nodePath.join(pkgRoot, subpath), diskExistsFn);
}
/**
 * Unified resolver. Tries relative first, then library only if permitted.
 * `allowLibrary` gates node_modules inlining — pass `true` only when the
 * callsite has an explicit `@inline` annotation.
 *
 * `reader`, if given, is used for relative-import existence checks so virtual
 * filesystems work. Library resolution always goes to disk.
 */
function resolveImportSource(fromFile, specifier, allowLibrary, reader) {
    const rel = resolveRelativeImport(fromFile, specifier, reader);
    if (rel)
        return rel;
    if (allowLibrary)
        return resolveLibraryImport(fromFile, specifier);
    return null;
}

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

function init$1() {
    return {
        cache: new WeakMap(),
    };
}
/**
 * True iff `expr` is side-effect-free under opt-in-zone assumptions. Use this
 * when deciding whether to delete a declaration whose RHS is `expr` or
 * duplicate `expr` at another site.
 */
function isPure(state, expr) {
    const cached = state.cache.get(expr);
    if (cached !== undefined)
        return cached;
    const result = classify(state, expr);
    state.cache.set(expr, result);
    return result;
}
function classify(state, node) {
    // Primitives and bindings: always pure. We enumerate the specific literal
    // types rather than using t.isLiteral, because TemplateLiteral is also in
    // that group and has embedded expressions we need to classify recursively.
    if (t.isIdentifier(node) ||
        t.isPrivateName(node) ||
        t.isStringLiteral(node) ||
        t.isNumericLiteral(node) ||
        t.isBooleanLiteral(node) ||
        t.isNullLiteral(node) ||
        t.isRegExpLiteral(node) ||
        t.isBigIntLiteral(node) ||
        t.isDecimalLiteral(node) ||
        t.isThisExpression(node) ||
        t.isSuper(node)) {
        return true;
    }
    // Member access: pure under opt-in-zone assumptions. `obj.prop` doesn't
    // throw for well-typed obj (typeof obj !== 'null' | 'undefined') which we
    // trust inside zones. Computed keys must also be pure.
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        if (!isPure(state, node.object))
            return false;
        if (node.computed)
            return isPure(state, node.property);
        return true;
    }
    // Unary: typeof/void/!/-/+/~ have no side effects aside from evaluating
    // their argument. `delete` mutates — impure.
    if (t.isUnaryExpression(node)) {
        if (node.operator === 'delete')
            return false;
        return isPure(state, node.argument);
    }
    // Binary/logical: pure iff both sides are pure. Arithmetic in opt-in
    // zones doesn't trigger Symbol.toPrimitive side effects.
    if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
        const left = node.left;
        return isPure(state, left) && isPure(state, node.right);
    }
    // Conditional: pure iff test and both branches are pure.
    if (t.isConditionalExpression(node)) {
        return (isPure(state, node.test) &&
            isPure(state, node.consequent) &&
            isPure(state, node.alternate));
    }
    // Array/Object literal: allocates memory, but allocation itself has no
    // observable side effect beyond identity. Safe to delete; copyprop won't
    // duplicate these because its RHS must be an Identifier.
    if (t.isArrayExpression(node)) {
        return node.elements.every((el) => el === null || isPureElement(state, el));
    }
    if (t.isObjectExpression(node)) {
        return node.properties.every((p) => isPureObjectProperty(state, p));
    }
    // Template literals: in opt-in zones, embedded expressions' toString is
    // assumed side-effect-free. Pure iff every embedded expression is pure.
    if (t.isTemplateLiteral(node)) {
        return node.expressions.every((e) => t.isTSType(e) ? true : isPure(state, e));
    }
    // Sequence: pure iff every sub-expression is pure. Rare in generated
    // code but cheap to handle.
    if (t.isSequenceExpression(node)) {
        return node.expressions.every((e) => isPure(state, e));
    }
    // Parenthesized: unwrap.
    if (t.isParenthesizedExpression(node)) {
        return isPure(state, node.expression);
    }
    // TS type assertion wrappers: look through.
    if (t.isTSAsExpression(node) ||
        t.isTSTypeAssertion(node) ||
        t.isTSNonNullExpression(node) ||
        t.isTSSatisfiesExpression(node)) {
        return isPure(state, node.expression);
    }
    // Anything else — calls, assignments, updates, yield, await, new,
    // tagged templates, spread, JSX, etc. — conservatively impure.
    return false;
}
function isPureElement(state, el) {
    if (t.isSpreadElement(el)) {
        // Spread invokes the iterator protocol — side-effecting in general.
        return false;
    }
    return isPure(state, el);
}
function isPureObjectProperty(state, p) {
    if (t.isSpreadElement(p))
        return false;
    if (t.isObjectMethod(p))
        return true; // method definition; no call, just a function value
    if (p.computed && !isPure(state, p.key))
        return false;
    const v = p.value;
    if (t.isPatternLike(v) && !t.isExpression(v))
        return false;
    return isPure(state, v);
}

/**
 * Read direct-on-node zone annotations from block-comment leading comments.
 * An `@optimize` marker expands here into every implied zone — doing the
 * expansion at collection time keeps `isInZone` a plain WeakMap lookup.
 *
 * Line comments (`// @inline`) are intentionally ignored — keeps
 * annotations visually deliberate.
 */
function directZonesOn(node) {
    const comments = node.leadingComments;
    if (!comments || comments.length === 0)
        return [];
    const result = [];
    for (const c of comments) {
        if (c.type !== 'CommentBlock')
            continue;
        for (const kind of Object.keys(DIRECTIVE_PATTERNS)) {
            if (DIRECTIVE_PATTERNS[kind].test(c.value)) {
                result.push(kind);
                if (kind === 'optimize') {
                    for (const implied of OPTIMIZE_DIRECTIVES)
                        result.push(implied);
                }
            }
        }
    }
    return result;
}
function init() {
    return {
        // Each cached set covers the node's own annotations plus every ancestor
        // it was resolved against. Shared between nodes that share an ancestor
        // prefix, so repeated queries in the same function body are O(1).
        cache: new WeakMap(),
    };
}
/**
 * Drop every cached entry. Call after a transform moves nodes across scope
 * boundaries; zone membership depends on ancestors, so structural reshapes
 * can invalidate otherwise-stable entries. Local expression rewrites that
 * don't change parent chains are safe to leave cached.
 */
function invalidateAll(state) {
    state.cache = new WeakMap();
}
/** The full set of zones active for `path` (considering itself and all ancestors). */
function activeZones(state, path) {
    const cached = state.cache.get(path.node);
    if (cached)
        return cached;
    const own = directZonesOn(path.node);
    const parent = path.parentPath;
    const parentZones = parent ? activeZones(state, parent) : EMPTY;
    if (own.length === 0) {
        state.cache.set(path.node, parentZones);
        return parentZones;
    }
    const combined = new Set(parentZones);
    for (const z of own)
        combined.add(z);
    state.cache.set(path.node, combined);
    return combined;
}
/** True iff `path` sits inside (or on) a node annotated with the given zone. */
function isInZone(state, path, kind) {
    return activeZones(state, path).has(kind);
}
const EMPTY = new Set();

const AGGRESSIVE_ZONES$2 = ['sroa', 'inline', 'unroll'];
function inAggressiveZone$2(state, path) {
    const zones = activeZones(state, path);
    return AGGRESSIVE_ZONES$2.some((z) => zones.has(z));
}
/** Read a numeric literal, possibly wrapped in a single unary `-`. */
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
function numericLiteral(value) {
    if (value < 0) {
        return t.unaryExpression('-', t.numericLiteral(-value));
    }
    return t.numericLiteral(value);
}
function applyConstfold(ast, options) {
    let changed = false;
    traverse(ast, {
        BinaryExpression: {
            exit(path) {
                if (!inAggressiveZone$2(options.zones, path))
                    return;
                if (fold(path, options.effects))
                    changed = true;
            },
        },
    });
    return changed;
}
function fold(path, effects) {
    const { operator, left, right } = path.node;
    if (t.isPrivateName(left))
        return false;
    const lv = asNumeric(left);
    const rv = asNumeric(right);
    // literal-literal fold
    if (lv !== null && rv !== null) {
        const folded = evalBinary(operator, lv, rv);
        if (folded !== null && Number.isFinite(folded)) {
            path.replaceWith(numericLiteral(folded));
            return true;
        }
    }
    // identities — the variable side must be pure so dropping side effects is safe
    if (operator === '+' && rv === 0 && isPure(effects, left)) {
        path.replaceWith(left);
        return true;
    }
    if (operator === '+' && lv === 0 && isPure(effects, right)) {
        path.replaceWith(right);
        return true;
    }
    if (operator === '-' && rv === 0 && isPure(effects, left)) {
        path.replaceWith(left);
        return true;
    }
    if (operator === '*' && rv === 1 && isPure(effects, left)) {
        path.replaceWith(left);
        return true;
    }
    if (operator === '*' && lv === 1 && isPure(effects, right)) {
        path.replaceWith(right);
        return true;
    }
    if (operator === '/' && rv === 1 && isPure(effects, left)) {
        path.replaceWith(left);
        return true;
    }
    return false;
}
function evalBinary(op, l, r) {
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
        default:
            return null;
    }
}

const AGGRESSIVE_ZONES$1 = ['sroa', 'inline', 'unroll'];
function inAggressiveZone$1(state, path) {
    const zones = activeZones(state, path);
    return AGGRESSIVE_ZONES$1.some((z) => zones.has(z));
}
function applyCopyprop(ast, options) {
    traverse(ast, {
        Program(path) {
            path.scope.crawl();
        },
    });
    let changed = false;
    traverse(ast, {
        VariableDeclarator(path) {
            if (!inAggressiveZone$1(options.zones, path))
                return;
            const { id, init } = path.node;
            if (!t.isIdentifier(id) || !init || !t.isIdentifier(init))
                return;
            const xName = id.name;
            const yName = init.name;
            if (xName === yName)
                return;
            // Reject for-loop init forms — removing the declarator breaks the loop.
            const grandparent = path.parentPath?.parentPath;
            if (!grandparent ||
                grandparent.isForStatement() ||
                grandparent.isForInStatement() ||
                grandparent.isForOfStatement()) {
                return;
            }
            const xBinding = path.scope.getBinding(xName);
            if (!xBinding || !xBinding.constant)
                return;
            const yBinding = path.scope.getBinding(yName);
            if (!yBinding || !yBinding.constant)
                return;
            // Shadow check: every reference of x must resolve yName to the same
            // binding we saw at the declaration site.
            for (const ref of xBinding.referencePaths) {
                if (ref.scope.getBinding(yName) !== yBinding)
                    return;
            }
            for (const ref of xBinding.referencePaths) {
                ref.replaceWith(t.identifier(yName));
            }
            const declPath = path.parentPath;
            path.remove();
            if (declPath &&
                declPath.isVariableDeclaration() &&
                declPath.node.declarations.length === 0) {
                declPath.remove();
            }
            changed = true;
        },
    });
    return changed;
}

/** The set of zone kinds that allow aggressive simplification. */
const AGGRESSIVE_ZONES = ['sroa', 'inline', 'unroll'];
function inAggressiveZone(state, path) {
    const zones = activeZones(state, path);
    return AGGRESSIVE_ZONES.some((z) => zones.has(z));
}
function applyDce(ast, options) {
    // Scope data may be stale if prior passes (inline, SROA, unroll) mutated
    // the AST without re-crawling. Force a fresh scope walk so binding
    // reference counts reflect the current AST.
    traverse(ast, {
        Program(path) {
            path.scope.crawl();
        },
    });
    let changed = false;
    traverse(ast, {
        VariableDeclaration(path) {
            if (!inAggressiveZone(options.zones, path))
                return;
            const declarators = path.get('declarations');
            for (const decl of declarators) {
                const id = decl.node.id;
                if (!t.isIdentifier(id))
                    continue;
                const binding = path.scope.getBinding(id.name);
                if (!binding)
                    continue;
                if (binding.references > 0)
                    continue;
                if (eliminateBinding(binding, decl, options.effects)) {
                    changed = true;
                }
                // eliminateBinding may replace the enclosing VariableDeclaration
                // (e.g. with an ExpressionStatement that preserves impure init
                // side effects). In that case this path is stale and we stop.
                if (!path.node || !t.isVariableDeclaration(path.node))
                    return;
            }
            // If we removed every declarator, babel may or may not have
            // auto-removed the surrounding VariableDeclaration. Clean up if
            // still present.
            if (path.node && t.isVariableDeclaration(path.node) && path.node.declarations.length === 0) {
                path.remove();
                changed = true;
            }
        },
    });
    return changed;
}
/**
 * Remove a dead binding: delete the declarator plus every write to it.
 * Returns true if the elimination succeeded (some writes may block it, e.g.
 * updates embedded in complex expressions we don't want to rewrite).
 */
function eliminateBinding(binding, declPath, effectsState) {
    // First, verify every write is in a shape we can safely rewrite. If any
    // violation is embedded (e.g., inside an argument list), bail — we'd need
    // to hoist side effects, which v1 doesn't do.
    for (const writePath of binding.constantViolations) {
        if (!isRemovableWrite(writePath))
            return false;
    }
    // Remove writes. Pure writes disappear entirely; writes with an impure RHS
    // become expression statements so side effects survive.
    for (const writePath of binding.constantViolations) {
        removeWrite(writePath, effectsState);
    }
    // Remove the initializer's side effects too if impure.
    const initNode = declPath.node.init;
    if (initNode && !isPure(effectsState, initNode)) {
        // Replace the declaration with a bare expression statement for the
        // init, preserving side effects. Only do this if the declarator is
        // the sole one in its VariableDeclaration; otherwise we'd need to
        // insert a sibling statement, which complicates traversal.
        const parent = declPath.parent;
        if (t.isVariableDeclaration(parent) && parent.declarations.length === 1) {
            declPath.parentPath.replaceWith(t.expressionStatement(initNode));
            return true;
        }
        // Mixed declaration: conservatively leave this binding alone.
        return false;
    }
    declPath.remove();
    return true;
}
/**
 * A write we can remove without losing statements we can't resynthesize. We
 * handle: assignment expressions used as statements (`x = foo();`) and update
 * expressions used as statements (`x++;`). Assignments buried inside other
 * expressions (e.g. `if ((x = foo())) ...`) would require hoisting and are
 * deferred.
 */
function isRemovableWrite(writePath) {
    if (writePath.isAssignmentExpression()) {
        // the write is removable if it sits directly in an ExpressionStatement
        return writePath.parentPath?.isExpressionStatement() ?? false;
    }
    if (writePath.isUpdateExpression()) {
        return writePath.parentPath?.isExpressionStatement() ?? false;
    }
    // VariableDeclarator itself registers as a constantViolation for the
    // binding's declaration — that's handled by the declarator removal.
    if (writePath.isVariableDeclarator())
        return true;
    return false;
}
function removeWrite(writePath, effectsState) {
    if (writePath.isAssignmentExpression()) {
        const rhs = writePath.node.right;
        const stmt = writePath.parentPath;
        if (isPure(effectsState, rhs)) {
            stmt.remove();
        }
        else {
            stmt.replaceWith(t.expressionStatement(rhs));
        }
        return;
    }
    if (writePath.isUpdateExpression()) {
        // `x++` on a dead binding: drop entirely. The read-of-x inside x++ has
        // no side effect (x is pure).
        const stmt = writePath.parentPath;
        stmt.remove();
        return;
    }
    if (writePath.isVariableDeclarator()) {
        // handled by the declarator removal at call site
        return;
    }
}

function initSimplifier() {
    return { zones: init(), effects: init$1() };
}
const MAX_ITERS = 8;
/**
 * Run constfold → copyprop → dce to fixpoint, capped at MAX_ITERS.
 *
 * Each transform reports whether it mutated the AST; the loop exits when a
 * full round reports no change. Order matters:
 *   - constfold first: creates new literal-literal opportunities for copyprop
 *     and dead-binding targets for dce.
 *   - copyprop next: creates new dead bindings for dce to remove.
 *   - dce last: cleans up the dead bindings the earlier passes produced.
 */
function runSimplifier(ast, state) {
    for (let i = 0; i < MAX_ITERS; i++) {
        const foldChanged = applyConstfold(ast, { zones: state.zones, effects: state.effects });
        const copyChanged = applyCopyprop(ast, { zones: state.zones });
        const dceChanged = applyDce(ast, { zones: state.zones, effects: state.effects });
        if (!foldChanged && !copyChanged && !dceChanged)
            break;
    }
}

function applyInline(ast, absolutePath, options) {
    const reader = options.fileReader ?? defaultFileReader;
    const cache = options.fileCache;
    const allowLibrary = options.allowLibraryInline === true;
    const zones = options.zones ?? init();
    const index = indexFile(absolutePath, ast);
    const localPool = buildLocalPool(index);
    inlineDependenciesBottomUp(localPool);
    // External pools are lazy — one per donor file we've touched. Inside each
    // pool the donor file's own `@inline` functions have been pre-inlined
    // bottom-up so nested call chains resolve before substitution.
    const externalPools = new Map();
    const requiredModuleVars = new Map();
    const requiredImports = new Map();
    // Fixpoint: an `@inline-body` zone can expose chained calls only revealed
    // after the first pass. Each pass is O(AST) so we cap at a small N.
    const MAX_PASSES = 8;
    let overallChanged = false;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const { changed } = inlineCallsitesInAst(ast, absolutePath, index, localPool, externalPools, requiredModuleVars, requiredImports, cache, reader, allowLibrary, zones);
        if (!changed)
            break;
        overallChanged = true;
        // Inlining restructures ancestry: hoisted preludes and spliced bodies
        // move into new parents, so cached zone sets for those nodes are stale.
        // Cheaper than reasoning about which entries survived the pass.
        invalidateAll(zones);
    }
    if (!overallChanged)
        return false;
    // Imports first (they come before module-var decls in output order, and
    // donor module-var initializers may reference hoisted imports).
    if (requiredImports.size > 0) {
        hoistRequiredImports(ast, absolutePath, index, requiredImports, reader);
    }
    if (requiredModuleVars.size > 0) {
        hoistRequiredModuleVars(ast, index, requiredModuleVars);
    }
    // Decl-annotated functions in the current file are consumed — the original
    // declaration is dead weight. Callsite-inlined functions stay put (some
    // callsites may not be annotated). Cross-file donors are never removed
    // from their own file — we only operate on the consumer AST.
    removeInlinedDeclarations(ast, localPool);
    // `@inline` / `@inline-body` markers are directives consumed by this
    // transform. Once we've inlined, leaving them in the output is noise
    // (often alongside `@inlined` breadcrumbs). Babel can also park a
    // block comment authored between two statements as a *trailing* comment
    // on the preceding one, so per-callsite stripping by itself isn't enough.
    stripInlineMarkersGlobally(ast);
    return true;
}
// ============================================================================
// Pool construction
// ============================================================================
function buildLocalPool(index) {
    const pool = new Map();
    for (const [name, fn] of index.functions) {
        if (!fn.hasInlineAnnotation)
            continue;
        const entry = buildInlineable(fn, index.absolutePath, true);
        if (entry)
            pool.set(name, entry);
    }
    dropCyclicEntries(pool);
    return pool;
}
function buildInlineable(fn, sourceFile, stripOriginal) {
    if (!isInlinableBody(fn.body))
        return null;
    if (containsForbiddenConstructs(fn.body))
        return null;
    // Params must all be plain identifiers (optionally with defaults). Any
    // ObjectPattern / ArrayPattern / RestElement would require destructuring
    // logic we don't implement — naively substituting the arg would leak
    // the original param names into the caller's scope.
    for (const p of fn.params) {
        if (t.isIdentifier(p))
            continue;
        if (t.isAssignmentPattern(p) && t.isIdentifier(p.left))
            continue;
        return null;
    }
    return {
        fn,
        body: t.cloneNode(fn.body, true, false),
        params: paramNames(fn.params),
        sourceFile,
        moduleVarRefs: new Set(fn.moduleVarRefs),
        importRefs: new Set(fn.importRefs),
        stripOriginal,
    };
}
function paramNames(params) {
    const out = [];
    for (const p of params) {
        if (t.isIdentifier(p))
            out.push(p.name);
        else if (t.isAssignmentPattern(p) && t.isIdentifier(p.left))
            out.push(p.left.name);
        else
            out.push('');
    }
    return out;
}
/**
 * Top-level shape constraint: no `return` can appear before the final statement.
 * Nested control flow is fine — `containsForbiddenConstructs` (called next in
 * `buildInlineable`) walks into nested blocks and rejects early returns there,
 * which is the real safety concern for splicing a body into a statement callsite.
 */
function isInlinableBody(body) {
    const stmts = body.body;
    for (let i = 0; i < stmts.length - 1; i++) {
        if (t.isReturnStatement(stmts[i]))
            return false;
    }
    return true;
}
function containsForbiddenConstructs(body) {
    let found = false;
    const walk = (node) => {
        if (found)
            return;
        if (t.isFunctionDeclaration(node) ||
            t.isFunctionExpression(node) ||
            t.isArrowFunctionExpression(node) ||
            t.isObjectMethod(node) ||
            t.isClassMethod(node)) {
            return;
        }
        if (t.isReturnStatement(node)) {
            found = true;
            return;
        }
        for (const key in node) {
            const v = node[key];
            if (Array.isArray(v)) {
                for (const child of v)
                    if (child && typeof child === 'object' && 'type' in child)
                        walk(child);
            }
            else if (v && typeof v === 'object' && 'type' in v) {
                walk(v);
            }
        }
    };
    const stmts = body.body;
    const lastIsReturn = stmts.length > 0 && t.isReturnStatement(stmts[stmts.length - 1]);
    for (let i = 0; i < stmts.length - (lastIsReturn ? 1 : 0); i++)
        walk(stmts[i]);
    return found;
}
function dropCyclicEntries(pool) {
    const deps = new Map();
    for (const [name, entry] of pool) {
        const outs = new Set();
        walkCalls(entry.body, (callee) => {
            if (pool.has(callee))
                outs.add(callee);
        });
        deps.set(name, outs);
    }
    const inCycle = new Set();
    for (const start of deps.keys()) {
        const seen = new Set();
        const stack = [start];
        while (stack.length > 0) {
            const n = stack.pop();
            for (const m of deps.get(n) ?? []) {
                if (m === start)
                    inCycle.add(start);
                if (!seen.has(m)) {
                    seen.add(m);
                    stack.push(m);
                }
            }
        }
    }
    for (const name of inCycle)
        pool.delete(name);
}
function inlineDependenciesBottomUp(pool) {
    const deps = new Map();
    const reverseDeps = new Map();
    for (const name of pool.keys()) {
        deps.set(name, new Set());
        reverseDeps.set(name, new Set());
    }
    for (const [name, entry] of pool) {
        walkCalls(entry.body, (calleeName) => {
            if (pool.has(calleeName) && calleeName !== name) {
                deps.get(name).add(calleeName);
                reverseDeps.get(calleeName).add(name);
            }
        });
    }
    const queue = [];
    for (const [name, d] of deps)
        if (d.size === 0)
            queue.push(name);
    const ordered = [];
    while (queue.length > 0) {
        const n = queue.shift();
        ordered.push(n);
        for (const dep of reverseDeps.get(n) ?? []) {
            deps.get(dep).delete(n);
            if (deps.get(dep).size === 0)
                queue.push(dep);
        }
    }
    for (const name of ordered) {
        const entry = pool.get(name);
        const wrapper = t.file(t.program([t.functionDeclaration(t.identifier('__inline_wrapper__'), [], entry.body)]));
        // In-file wrapper — no cross-file concerns, no hoists to collect.
        const localOnly = new Map();
        const localImports = new Map();
        // Fresh zones state per wrapper — the wrapper's synthetic
        // `__inline_wrapper__` function has no `@inline-body` comment, so
        // there's nothing meaningful to cache between pool entries.
        inlineCallsitesInAst(wrapper, '__wrapper__.ts', null, pool, new Map(), localOnly, localImports, undefined, defaultFileReader, false, init(), 
        // Breadcrumbs at this stage would record callsite args against
        // the enclosing function's *params* (e.g. `proximity(o, a)` where
        // o/a are select's params). Those disappear once select gets
        // inlined at its real callsite, leaving a misleading breadcrumb.
        // Only the final outer pass tags breadcrumbs so every `@inlined`
        // sig reflects a call that actually appeared in the source.
        false);
    }
}
function walkCalls(node, cb) {
    const walk = (n) => {
        if (t.isCallExpression(n) && t.isIdentifier(n.callee))
            cb(n.callee.name);
        for (const key in n) {
            const v = n[key];
            if (Array.isArray(v)) {
                for (const child of v)
                    if (child && typeof child === 'object' && 'type' in child)
                        walk(child);
            }
            else if (v && typeof v === 'object' && 'type' in v) {
                walk(v);
            }
        }
    };
    walk(node);
}
// ============================================================================
// Callee resolution
// ============================================================================
/**
 * A callsite is opted-in when either the original `@inline` marker is present
 * or any ancestor carries an `@inline-body` comment. The ancestor walk is
 * delegated to `Zones.isInZone`, which caches results per node so repeated
 * queries in the same function body are O(1) after the first resolution.
 */
function isCallOptedIn(path, zones) {
    return callSiteHasInlineAnnotation(path) || isInZone(zones, path, 'inline-body');
}
/**
 * Resolve a CallExpression to an Inlineable, or null if it should not be
 * inlined. Non-null result means the callsite is eligible:
 *   - a decl-annotated local callee (no callsite annotation needed), or
 *   - any other callee the callsite has opted into via `/* @inline *​/` or
 *     by sitting inside an `@inline-body`-annotated function.
 */
function resolveCallee(path, consumerFile, consumerIndex, localPool, externalPools, cache, reader, allowLibrary, zones) {
    const callee = path.node.callee;
    // Identifier callee — either a local name or a named/default import.
    if (t.isIdentifier(callee)) {
        const name = callee.name;
        const inPool = localPool.get(name);
        if (inPool)
            return inPool;
        if (!consumerIndex)
            return null;
        // Named/default import — resolve into the donor file.
        const binding = consumerIndex.imports.get(name);
        if (binding) {
            return resolveImportBinding(path, consumerFile, binding, binding.importedName, externalPools, cache, reader, allowLibrary, zones);
        }
        // Local function without decl-annotation — needs callsite opt-in
        // (either `/* @inline */` at the call, or caller is `@inline-body`).
        if (!isCallOptedIn(path, zones))
            return null;
        const localFn = consumerIndex.functions.get(name);
        if (localFn) {
            return buildInlineable(localFn, consumerFile, false);
        }
        return null;
    }
    // MemberExpression callee — handle `ns.fn` where ns is a namespace import
    // or a namespace re-export. A decl-annotated target in the donor file
    // inlines automatically; non-annotated targets require callsite opt-in.
    if (t.isMemberExpression(callee) && !callee.computed) {
        if (!consumerIndex)
            return null;
        if (!t.isIdentifier(callee.object))
            return null;
        if (!t.isIdentifier(callee.property))
            return null;
        const nsName = callee.object.name;
        const fnName = callee.property.name;
        const binding = consumerIndex.imports.get(nsName);
        if (binding && binding.style === 'namespace') {
            return resolveImportBinding(path, consumerFile, binding, fnName, externalPools, cache, reader, allowLibrary, zones);
        }
        const reexportSource = consumerIndex.namespaceReexports.get(nsName);
        if (reexportSource) {
            const fakeBinding = {
                source: reexportSource,
            };
            return resolveImportBinding(path, consumerFile, fakeBinding, fnName, externalPools, cache, reader, allowLibrary, zones);
        }
        // `import { ns } from 'pkg'` where pkg re-exports `ns` as a namespace:
        //   `export * as ns from './impl'`                 (namespaceReexports)
        //   `import * as ns from './impl'; export { ns };` (namespace import)
        // Follow through to the impl file and resolve `fnName` there.
        if (binding && binding.style === 'named') {
            if (!cache)
                return null;
            const donorPath = resolveImportSource(consumerFile, binding.source, allowLibrary, reader);
            if (!donorPath)
                return null;
            const donorEntry = ensureExternalPool(donorPath, externalPools, cache, reader);
            if (!donorEntry)
                return null;
            let nsSource = donorEntry.index.namespaceReexports.get(binding.importedName);
            if (!nsSource) {
                const nsImport = donorEntry.index.imports.get(binding.importedName);
                if (nsImport?.style === 'namespace') {
                    nsSource = nsImport.source;
                }
            }
            if (!nsSource)
                return null;
            const fakeBinding = {
                source: nsSource,
            };
            return resolveImportBinding(path, donorPath, fakeBinding, fnName, externalPools, cache, reader, allowLibrary, zones);
        }
    }
    return null;
}
function resolveImportBinding(path, consumerFile, binding, importedName, externalPools, cache, reader, allowLibrary, zones) {
    const resolvedPath = resolveImportSource(consumerFile, binding.source, allowLibrary, reader);
    if (!resolvedPath)
        return null;
    if (!cache)
        return null;
    const entry = ensureExternalPool(resolvedPath, externalPools, cache, reader);
    if (!entry)
        return null;
    // Prefer an entry from the pre-inlined donor pool — these are
    // decl-annotated in the donor file, so they inline automatically.
    const poolHit = entry.pool.get(importedName);
    if (poolHit) {
        return {
            ...poolHit,
            body: t.cloneNode(poolHit.body, true, false),
        };
    }
    // Not decl-annotated in the donor — needs callsite opt-in (direct
    // `/* @inline */` or an enclosing `@inline-body` function).
    if (!isCallOptedIn(path, zones))
        return null;
    const fn = entry.index.functions.get(importedName);
    if (!fn)
        return null;
    return buildInlineable(fn, entry.index.absolutePath, false);
}
function ensureExternalPool(donorPath, externalPools, cache, reader) {
    const existing = externalPools.get(donorPath);
    if (existing)
        return existing;
    const donorIndex = ensureIndexed(cache, donorPath, reader);
    if (!donorIndex)
        return null;
    // Build the donor's own local pool and pre-inline bottom-up, exactly like
    // we do for the consumer file. This way `/* @inline */ a()` inside donor's
    // `b()` body has already been substituted before we clone b into the
    // consumer.
    const donorPool = new Map();
    for (const [name, fn] of donorIndex.functions) {
        if (!fn.hasInlineAnnotation)
            continue;
        const entry = buildInlineable(fn, donorIndex.absolutePath, true);
        if (entry)
            donorPool.set(name, entry);
    }
    dropCyclicEntries(donorPool);
    inlineDependenciesBottomUp(donorPool);
    const record = { pool: donorPool, index: donorIndex };
    externalPools.set(donorPath, record);
    return record;
}
// ============================================================================
// Callsite walk
// ============================================================================
function inlineCallsitesInAst(ast, consumerFile, consumerIndex, localPool, externalPools, requiredModuleVars, requiredImports, cache, reader, allowLibrary, zones, tagBreadcrumbs = true) {
    let changed = false;
    traverse(ast, {
        CallExpression(path) {
            const entry = resolveCallee(path, consumerFile, consumerIndex, localPool, externalPools, cache, reader, allowLibrary, zones);
            if (!entry)
                return;
            const callsite = recognizeCallsite(path);
            if (callsite) {
                if (inlineOneCall(path, entry, callsite, tagBreadcrumbs)) {
                    trackDonorRefs(entry, consumerFile, externalPools, requiredModuleVars, requiredImports);
                    changed = true;
                }
                return;
            }
            if (isSimpleReturnBody(entry.body)) {
                if (inlineSimpleReturn(path, entry, tagBreadcrumbs)) {
                    trackDonorRefs(entry, consumerFile, externalPools, requiredModuleVars, requiredImports);
                    changed = true;
                }
                return;
            }
            // Expression-position callsite with a multi-statement body
            // (e.g. `proximity(o, a)` inside `proximity(o, a) < proximity(o, b)`).
            // Only safe when every prelude statement is a pure const/let decl —
            // then we can hoist the prelude above the enclosing statement and
            // replace the call with the return expression.
            if (inlineExpressionPosition(path, entry, tagBreadcrumbs)) {
                trackDonorRefs(entry, consumerFile, externalPools, requiredModuleVars, requiredImports);
                changed = true;
            }
        },
    });
    return { changed };
}
function trackDonorRefs(entry, consumerFile, externalPools, requiredModuleVars, requiredImports) {
    // Same-file callsite: module vars and imports already live in the consumer.
    if (entry.sourceFile === consumerFile)
        return;
    const donor = externalPools.get(entry.sourceFile);
    if (!donor)
        return;
    for (const name of entry.moduleVarRefs) {
        const mv = donor.index.moduleVars.get(name);
        if (!mv)
            continue;
        const key = `${entry.sourceFile}::${name}`;
        if (requiredModuleVars.has(key))
            continue;
        requiredModuleVars.set(key, { sourceFile: entry.sourceFile, name, moduleVar: mv });
    }
    for (const name of entry.importRefs) {
        const b = donor.index.imports.get(name);
        if (!b)
            continue;
        const key = `${entry.sourceFile}::${name}`;
        if (requiredImports.has(key))
            continue;
        requiredImports.set(key, {
            sourceFile: entry.sourceFile,
            localName: name,
            binding: b,
        });
    }
}
function isSimpleReturnBody(body) {
    return (body.body.length === 1 &&
        t.isReturnStatement(body.body[0]) &&
        body.body[0].argument !== null &&
        body.body[0].argument !== undefined);
}
/**
 * Strip any `@inline` block comment from `node.leadingComments`. Called
 * before we splice in a replacement so the original marker doesn't float
 * onto whatever we emit. We tag the replacement with `@inlined <sig>`.
 */
function stripInlineLeading(node) {
    const n = node;
    if (!n.leadingComments)
        return;
    const kept = n.leadingComments.filter((c) => !(c.type === 'CommentBlock' && isInlineMarkerComment(c.value)));
    n.leadingComments =
        kept.length > 0 ? kept : null;
}
function isInlineMarkerComment(value) {
    // Only strip inline-specific markers. `@sroa`, `@unroll`, and
    // `@optimize` are consumed by later passes and must survive this sweep.
    return commentIsInlineDirective(value);
}
/**
 * Final sweep: drop every `@inline` / `@inline-body` block comment from every
 * comment slot in the consumer AST. Covers the cases where Babel attached the
 * marker as trailing on a preceding sibling, inner on a parent block, or
 * leading on a node we didn't touch directly.
 */
function stripInlineMarkersGlobally(ast) {
    const filterList = (list) => {
        if (!list || list.length === 0)
            return list ?? null;
        const kept = list.filter((c) => !(c.type === 'CommentBlock' && isInlineMarkerComment(c.value)));
        if (kept.length === list.length)
            return list;
        return kept.length > 0 ? kept : null;
    };
    traverse(ast, {
        enter(path) {
            const n = path.node;
            n.leadingComments = filterList(n.leadingComments);
            n.trailingComments = filterList(n.trailingComments);
            n.innerComments = filterList(n.innerComments);
        },
    });
    // Babel also stashes comments on File.comments — keeps codegen-by-offset
    // consistent. Same filter there.
    const astComments = ast.comments;
    if (astComments && astComments.length > 0) {
        ast.comments = astComments.filter((c) => !(c.type === 'CommentBlock' && isInlineMarkerComment(c.value)));
    }
}
/**
 * Breadcrumb built from the callsite itself: preserves the authored form
 * (`mat4.create(out, q)` rather than a synthetic `create(out, q)`) so the
 * comment points back to the original source.
 */
function breadcrumbFor(callPath) {
    const src = generate(t.cloneNode(callPath.node, true, false), {
        concise: true,
        comments: false,
        retainLines: false,
    }).code;
    return src.replace(/\s+/g, ' ').trim();
}
/** Add a leading ` @inlined <sig> ` block comment to `node`. */
function tagInlined(node, sig) {
    t.addComment(node, 'leading', ` @inlined ${sig} `);
}
// ============================================================================
// Callsite splicing
// ============================================================================
function inlineSimpleReturn(callPath, entry, tagBreadcrumbs) {
    const args = callPath.node.arguments;
    for (const a of args)
        if (t.isSpreadElement(a) || t.isArgumentPlaceholder(a))
            return false;
    const paramNamesArr = entry.params;
    const ret = entry.body.body[0].argument;
    const refCounts = countParamReferences(ret, new Set(paramNamesArr));
    const substitution = new Map();
    for (let i = 0; i < paramNamesArr.length; i++) {
        const pname = paramNamesArr[i];
        if (!pname)
            continue;
        const arg = args[i] ?? t.identifier('undefined');
        const count = refCounts.get(pname) ?? 0;
        const pure = isSimpleArg(arg);
        if (!pure && count !== 1) {
            return false;
        }
        substitution.set(pname, arg);
    }
    const clonedRet = t.cloneNode(ret, true, false);
    const wrapperBody = t.blockStatement([t.returnStatement(clonedRet)]);
    renameLocalsInBody(wrapperBody, createFreshNamer(callPath), new Set(paramNamesArr));
    applyParamSubstitution(wrapperBody, substitution);
    const renamedRet = wrapperBody.body[0].argument;
    // Strip the original `@inline` marker from the callsite and any enclosing
    // statement before replacement, then tag the substituted expression with
    // `@inlined <sig>` as a breadcrumb.
    stripInlineLeading(callPath.node);
    const parentStmt = callPath.parentPath;
    if (parentStmt?.isStatement())
        stripInlineLeading(parentStmt.node);
    if (tagBreadcrumbs) {
        tagInlined(renamedRet, breadcrumbFor(callPath));
    }
    callPath.replaceWith(renamedRet);
    return true;
}
function countParamReferences(expr, params) {
    const counts = new Map();
    const wrapper = t.file(t.program([t.expressionStatement(expr)]));
    traverse(wrapper, {
        Identifier(path) {
            if (!path.isReferencedIdentifier())
                return;
            if (!params.has(path.node.name))
                return;
            counts.set(path.node.name, (counts.get(path.node.name) ?? 0) + 1);
        },
    });
    return counts;
}
function recognizeCallsite(path) {
    const parent = path.parentPath;
    if (!parent)
        return null;
    if (parent.isExpressionStatement()) {
        return { kind: 'statement', stmtPath: parent };
    }
    if (parent.isVariableDeclarator() && parent.node.init === path.node) {
        const decl = parent.parentPath;
        if (decl && decl.isVariableDeclaration()) {
            if (decl.node.declarations.length !== 1)
                return null;
            return {
                kind: 'init',
                declarator: parent,
                decl: decl,
            };
        }
    }
    if (parent.isAssignmentExpression() &&
        parent.node.operator === '=' &&
        parent.node.right === path.node) {
        const stmt = parent.parentPath;
        if (stmt && stmt.isExpressionStatement()) {
            return {
                kind: 'assign',
                stmtPath: stmt,
                assign: parent,
            };
        }
    }
    if (parent.isReturnStatement() && parent.node.argument === path.node) {
        return { kind: 'return', retPath: parent };
    }
    return null;
}
function inlineOneCall(callPath, entry, callsite, tagBreadcrumbs) {
    const args = callPath.node.arguments;
    for (const a of args) {
        if (t.isSpreadElement(a) || t.isArgumentPlaceholder(a))
            return false;
    }
    const paramNamesArr = entry.params;
    const paramSet = new Set(paramNamesArr);
    const mutatedParams = findMutatedParams(entry.body, paramSet);
    const substitution = new Map();
    const argHoists = [];
    const namer = createFreshNamer(callPath);
    for (let i = 0; i < paramNamesArr.length; i++) {
        const pname = paramNamesArr[i];
        if (!pname)
            continue;
        const arg = args[i] ?? t.identifier('undefined');
        if (mutatedParams.has(pname)) {
            // The callee writes to this param (e.g. `rad *= 0.5;`). Hoist the
            // arg into a `let` temp and rename every reference — reads and
            // writes — to the temp.
            const tempName = namer(`_arg_${pname}`);
            argHoists.push(t.variableDeclaration('let', [
                t.variableDeclarator(t.identifier(tempName), t.cloneNode(arg, true, false)),
            ]));
            substitution.set(pname, t.identifier(tempName));
        }
        else if (isSimpleArg(arg)) {
            substitution.set(pname, arg);
        }
        else {
            const tempName = namer(`_arg_${pname}`);
            argHoists.push(t.variableDeclaration('const', [
                t.variableDeclarator(t.identifier(tempName), t.cloneNode(arg, true, false)),
            ]));
            substitution.set(pname, t.identifier(tempName));
        }
    }
    const clonedBody = t.cloneNode(entry.body, true, false);
    // Rename body-locals BEFORE substituting params. Substitution can inject
    // caller identifiers whose names happen to match a body-local (e.g. a
    // callee with `const tmp = ...` called as `f(tmp, ...)`); if we renamed
    // after, the rename pass couldn't tell the substituted `tmp` apart from
    // the body's own `tmp`, and would alias them into the same fresh name.
    renameLocalsInBody(clonedBody, namer, paramSet);
    applyParamSubstitution(clonedBody, substitution);
    let clonedReturn = null;
    if (clonedBody.body.length > 0 &&
        t.isReturnStatement(clonedBody.body[clonedBody.body.length - 1])) {
        const ret = clonedBody.body.pop();
        clonedReturn = ret.argument ?? null;
    }
    const prelude = [...argHoists, ...clonedBody.body];
    const sig = tagBreadcrumbs ? breadcrumbFor(callPath) : '';
    stripInlineLeading(callPath.node);
    const tag = (node) => {
        if (tagBreadcrumbs)
            tagInlined(node, sig);
    };
    switch (callsite.kind) {
        case 'statement': {
            const stmt = callsite.stmtPath;
            if (clonedReturn && expressionCouldHaveEffect(clonedReturn)) {
                prelude.push(t.expressionStatement(clonedReturn));
            }
            stripInlineLeading(stmt.node);
            if (prelude.length > 0)
                tag(prelude[0]);
            stmt.replaceWithMultiple(prelude);
            return true;
        }
        case 'init': {
            const decl = callsite.decl;
            const declarator = callsite.declarator.node;
            declarator.init = clonedReturn ?? t.identifier('undefined');
            stripInlineLeading(decl.node);
            if (prelude.length > 0) {
                tag(prelude[0]);
                decl.insertBefore(prelude);
            }
            else {
                tag(decl.node);
            }
            return true;
        }
        case 'assign': {
            const stmt = callsite.stmtPath;
            const assign = callsite.assign.node;
            assign.right = clonedReturn ?? t.identifier('undefined');
            stripInlineLeading(stmt.node);
            if (prelude.length > 0) {
                tag(prelude[0]);
                stmt.insertBefore(prelude);
            }
            else {
                tag(stmt.node);
            }
            return true;
        }
        case 'return': {
            const retPath = callsite.retPath;
            retPath.node.argument = clonedReturn ?? null;
            stripInlineLeading(retPath.node);
            if (prelude.length > 0) {
                tag(prelude[0]);
                retPath.insertBefore(prelude);
            }
            else {
                tag(retPath.node);
            }
            return true;
        }
    }
}
/**
 * Inline a multi-statement-body callee whose callsite is in expression position
 * (not one of the four statement-level forms recognized by `recognizeCallsite`).
 *
 * Strategy: hoist the callee's prelude (every statement before the final return)
 * above the nearest enclosing statement, then replace the call with the return
 * expression. Only safe when every prelude statement is pure — i.e. a
 * `const`/`let` declaration whose initializer is a simple arg or a pure
 * composite expression. Any prelude that writes observable state would be
 * reordered relative to sibling expressions in the original statement, so we
 * bail.
 */
function inlineExpressionPosition(callPath, entry, tagBreadcrumbs) {
    const args = callPath.node.arguments;
    for (const a of args) {
        if (t.isSpreadElement(a) || t.isArgumentPlaceholder(a))
            return false;
    }
    const bodyStmts = entry.body.body;
    if (bodyStmts.length === 0)
        return false;
    const last = bodyStmts[bodyStmts.length - 1];
    if (!t.isReturnStatement(last) || last.argument == null)
        return false;
    // Every stmt before the return must be a pure decl — otherwise hoisting it
    // before the enclosing statement could reorder side effects with the rest
    // of the host expression.
    for (let i = 0; i < bodyStmts.length - 1; i++) {
        if (!isPurePreludeStatement(bodyStmts[i]))
            return false;
    }
    // Walk up to the nearest enclosing statement, but bail if we cross a
    // Function boundary — we only hoist inside the caller's own statement.
    let stmtPath = callPath.parentPath;
    while (stmtPath && !stmtPath.isStatement()) {
        if (stmtPath.isFunction())
            return false;
        stmtPath = stmtPath.parentPath;
    }
    if (!stmtPath || !stmtPath.isStatement())
        return false;
    // Build substitution map — non-simple args must have a single use in the
    // body (otherwise we'd re-evaluate them at each substitution site).
    const paramNamesArr = entry.params;
    const paramSet = new Set(paramNamesArr);
    const mutatedParams = findMutatedParams(entry.body, paramSet);
    const bodyParamUses = countParamReferencesInBody(entry.body, paramSet);
    const substitution = new Map();
    const argHoists = [];
    const namer = createFreshNamer(callPath);
    for (let i = 0; i < paramNamesArr.length; i++) {
        const pname = paramNamesArr[i];
        if (!pname)
            continue;
        const arg = args[i] ?? t.identifier('undefined');
        if (mutatedParams.has(pname)) {
            const tempName = namer(`_arg_${pname}`);
            argHoists.push(t.variableDeclaration('let', [
                t.variableDeclarator(t.identifier(tempName), t.cloneNode(arg, true, false)),
            ]));
            substitution.set(pname, t.identifier(tempName));
        }
        else if (isSimpleArg(arg)) {
            substitution.set(pname, arg);
        }
        else {
            const count = bodyParamUses.get(pname) ?? 0;
            if (count > 1) {
                const tempName = namer(`_arg_${pname}`);
                argHoists.push(t.variableDeclaration('const', [
                    t.variableDeclarator(t.identifier(tempName), t.cloneNode(arg, true, false)),
                ]));
                substitution.set(pname, t.identifier(tempName));
            }
            else {
                substitution.set(pname, arg);
            }
        }
    }
    const clonedBody = t.cloneNode(entry.body, true, false);
    renameLocalsInBody(clonedBody, namer, paramSet);
    applyParamSubstitution(clonedBody, substitution);
    const clonedStmts = clonedBody.body;
    const retStmt = clonedStmts.pop();
    const retExpr = retStmt.argument;
    const prelude = [...argHoists, ...clonedStmts];
    stripInlineLeading(callPath.node);
    if (tagBreadcrumbs) {
        const sig = breadcrumbFor(callPath);
        if (prelude.length > 0) {
            tagInlined(prelude[0], sig);
        }
        else {
            tagInlined(retExpr, sig);
        }
    }
    if (prelude.length > 0) {
        stmtPath.insertBefore(prelude);
    }
    callPath.replaceWith(retExpr);
    return true;
}
function isPurePreludeStatement(stmt) {
    if (!t.isVariableDeclaration(stmt))
        return false;
    if (stmt.kind === 'var')
        return false;
    for (const d of stmt.declarations) {
        if (!t.isIdentifier(d.id))
            return false;
        if (!d.init)
            return false;
        if (!isPureInitExpression(d.init))
            return false;
    }
    return true;
}
/**
 * "Pure enough to hoist above the host expression inside an `@inline` zone."
 * More permissive than `isSimpleArg` — allows nested member chains and pure
 * arithmetic — but rejects anything that could trigger a call or observable
 * write: CallExpression, NewExpression, AssignmentExpression, UpdateExpression,
 * YieldExpression, AwaitExpression.
 *
 * Getters are assumed side-effect-free (consistent with the rest of plugin-alt's
 * @inline-zone contract).
 */
function isPureInitExpression(expr) {
    if (t.isIdentifier(expr) || t.isThisExpression(expr) || t.isSuper(expr))
        return true;
    if (t.isNumericLiteral(expr) ||
        t.isStringLiteral(expr) ||
        t.isBooleanLiteral(expr) ||
        t.isNullLiteral(expr) ||
        t.isBigIntLiteral(expr) ||
        t.isRegExpLiteral(expr)) {
        return true;
    }
    if (t.isMemberExpression(expr)) {
        if (!t.isExpression(expr.object))
            return false;
        if (!isPureInitExpression(expr.object))
            return false;
        if (expr.computed) {
            if (!t.isExpression(expr.property))
                return false;
            return isPureInitExpression(expr.property);
        }
        return true;
    }
    if (t.isUnaryExpression(expr) && expr.operator !== 'delete' && expr.operator !== 'throw') {
        return isPureInitExpression(expr.argument);
    }
    if (t.isBinaryExpression(expr)) {
        if (!t.isExpression(expr.left))
            return false;
        return (isPureInitExpression(expr.left) &&
            isPureInitExpression(expr.right));
    }
    if (t.isLogicalExpression(expr)) {
        return (isPureInitExpression(expr.left) &&
            isPureInitExpression(expr.right));
    }
    if (t.isConditionalExpression(expr)) {
        return (isPureInitExpression(expr.test) &&
            isPureInitExpression(expr.consequent) &&
            isPureInitExpression(expr.alternate));
    }
    if (t.isArrayExpression(expr)) {
        for (const el of expr.elements) {
            if (el == null)
                continue;
            if (t.isSpreadElement(el))
                return false;
            if (!isPureInitExpression(el))
                return false;
        }
        return true;
    }
    if (t.isObjectExpression(expr)) {
        for (const p of expr.properties) {
            if (!t.isObjectProperty(p))
                return false;
            if (p.computed && t.isExpression(p.key) && !isPureInitExpression(p.key)) {
                return false;
            }
            if (!t.isExpression(p.value))
                return false;
            if (!isPureInitExpression(p.value))
                return false;
        }
        return true;
    }
    return false;
}
function countParamReferencesInBody(body, params) {
    const counts = new Map();
    const wrapper = t.file(t.program([t.functionDeclaration(t.identifier('__count_wrapper__'), [], body)]));
    traverse(wrapper, {
        Identifier(path) {
            if (!path.isReferencedIdentifier())
                return;
            if (!params.has(path.node.name))
                return;
            counts.set(path.node.name, (counts.get(path.node.name) ?? 0) + 1);
        },
    });
    return counts;
}
function isSimpleArg(expr) {
    if (t.isIdentifier(expr))
        return true;
    if (t.isThisExpression(expr) || t.isSuper(expr))
        return true;
    if (t.isNumericLiteral(expr) ||
        t.isStringLiteral(expr) ||
        t.isBooleanLiteral(expr) ||
        t.isNullLiteral(expr)) {
        return true;
    }
    if (t.isMemberExpression(expr)) {
        if (expr.computed) {
            if (!t.isIdentifier(expr.property) &&
                !t.isNumericLiteral(expr.property) &&
                !t.isStringLiteral(expr.property)) {
                return false;
            }
        }
        if (t.isIdentifier(expr.object) || t.isThisExpression(expr.object))
            return true;
        if (t.isMemberExpression(expr.object))
            return isSimpleArg(expr.object);
        return false;
    }
    return false;
}
function expressionCouldHaveEffect(expr) {
    return (t.isCallExpression(expr) ||
        t.isNewExpression(expr) ||
        t.isAssignmentExpression(expr) ||
        t.isUpdateExpression(expr) ||
        t.isYieldExpression(expr) ||
        t.isAwaitExpression(expr));
}
function applyParamSubstitution(body, subst) {
    traverse(t.file(t.program([t.functionDeclaration(t.identifier('__subst_wrapper__'), [], body)])), {
        Identifier(path) {
            const replacement = subst.get(path.node.name);
            if (!replacement)
                return;
            // Skip obvious non-references (member property names, object
            // property keys) — those are strings-in-identifier-clothing.
            if (path.parentPath?.isMemberExpression() &&
                !path.parentPath.node.computed &&
                path.key === 'property') {
                return;
            }
            if (path.parentPath?.isObjectProperty() &&
                path.key === 'key' &&
                !path.parentPath.node.computed) {
                return;
            }
            // Write-position identifiers (LHS of `=`, arg of `++`/`--`) are
            // not `isReferencedIdentifier`, but we still need to rewrite
            // them when the callee mutates a param. Only safe when the
            // replacement is itself an Identifier — we can rename a
            // binding, but not replace it with an arbitrary expression.
            const isWrite = (path.parentPath?.isAssignmentExpression() &&
                path.parentPath.node.left === path.node) ||
                (path.parentPath?.isUpdateExpression() &&
                    path.parentPath.node.argument === path.node);
            if (isWrite) {
                if (!t.isIdentifier(replacement))
                    return;
                path.node.name = replacement.name;
                return;
            }
            if (!path.isReferencedIdentifier())
                return;
            path.replaceWith(t.cloneNode(replacement, true, false));
            // Don't re-visit the replacement — if it contains an Identifier
            // whose name happens to match a subst key (e.g. the caller's
            // arg is named the same as the callee's param), we'd loop.
            path.skip();
        },
    });
}
function findMutatedParams(body, paramSet) {
    const mutated = new Set();
    if (paramSet.size === 0)
        return mutated;
    const wrapper = t.file(t.program([t.functionDeclaration(t.identifier('__mut_wrapper__'), [], body)]));
    traverse(wrapper, {
        AssignmentExpression(path) {
            const lhs = path.node.left;
            if (t.isIdentifier(lhs) && paramSet.has(lhs.name))
                mutated.add(lhs.name);
        },
        UpdateExpression(path) {
            const arg = path.node.argument;
            if (t.isIdentifier(arg) && paramSet.has(arg.name))
                mutated.add(arg.name);
        },
    });
    return mutated;
}
/**
 * Returns a name picker for the callsite's scope. First call for a given
 * base name returns the name unchanged iff the base isn't already bound at
 * the callsite; otherwise appends `_2`, `_3`, ... until we find one that's
 * free (both in the scope and among names already handed out by this
 * namer). The namer is scoped to one splice — each call to an inline
 * function builds a fresh one.
 *
 * We crawl the enclosing function scope first so bindings introduced by
 * earlier splices into the same scope are visible. That keeps a second
 * inline of the same callee from stomping the first's locals.
 */
function createFreshNamer(callPath) {
    const functionParent = callPath.getFunctionParent();
    const enclosingScope = functionParent ? functionParent.scope : callPath.scope.getProgramParent();
    enclosingScope.crawl();
    const scope = callPath.scope;
    const reserved = new Set();
    return (base) => {
        if (!scope.hasBinding(base) && !reserved.has(base)) {
            reserved.add(base);
            return base;
        }
        for (let i = 2;; i++) {
            const candidate = `${base}_${i}`;
            if (!scope.hasBinding(candidate) && !reserved.has(candidate)) {
                reserved.add(candidate);
                return candidate;
            }
        }
    };
}
function renameLocalsInBody(body, namer, paramSet) {
    const locals = collectLocalBindings(body, paramSet);
    if (locals.size === 0)
        return;
    const renames = new Map();
    for (const name of locals) {
        const fresh = namer(name);
        if (fresh !== name)
            renames.set(name, fresh);
    }
    if (renames.size === 0)
        return;
    traverse(t.file(t.program([t.functionDeclaration(t.identifier('__rename_wrapper__'), [], body)])), {
        Identifier(path) {
            if (path.parentPath?.isMemberExpression() &&
                !path.parentPath.node.computed &&
                path.key === 'property') {
                return;
            }
            if (path.parentPath?.isObjectProperty() &&
                path.key === 'key' &&
                !path.parentPath.node.computed) {
                return;
            }
            const fresh = renames.get(path.node.name);
            if (fresh)
                path.node.name = fresh;
        },
    });
}
function collectLocalBindings(body, paramSet) {
    const locals = new Set();
    const wrapper = t.file(t.program([t.functionDeclaration(t.identifier('__bind_wrapper__'), [], body)]));
    traverse(wrapper, {
        VariableDeclarator(path) {
            if (t.isIdentifier(path.node.id) && !paramSet.has(path.node.id.name)) {
                locals.add(path.node.id.name);
            }
        },
        FunctionDeclaration(path) {
            if (path.node.id)
                locals.add(path.node.id.name);
        },
    });
    return locals;
}
function removeInlinedDeclarations(ast, pool) {
    const names = new Set();
    for (const [name, entry] of pool)
        if (entry.stripOriginal)
            names.add(name);
    if (names.size === 0)
        return;
    ast.program.body = ast.program.body.filter((stmt) => {
        if (t.isFunctionDeclaration(stmt) && stmt.id && names.has(stmt.id.name))
            return false;
        if (t.isExportNamedDeclaration(stmt) && stmt.declaration) {
            if (t.isFunctionDeclaration(stmt.declaration) &&
                stmt.declaration.id &&
                names.has(stmt.declaration.id.name)) {
                return false;
            }
        }
        if (t.isExportDefaultDeclaration(stmt) && names.has('default')) {
            const decl = stmt.declaration;
            if (t.isFunctionDeclaration(decl) ||
                t.isFunctionExpression(decl) ||
                t.isArrowFunctionExpression(decl)) {
                return false;
            }
        }
        if (t.isVariableDeclaration(stmt)) {
            stmt.declarations = stmt.declarations.filter((d) => !(t.isIdentifier(d.id) &&
                names.has(d.id.name) &&
                (t.isArrowFunctionExpression(d.init) || t.isFunctionExpression(d.init))));
            if (stmt.declarations.length === 0)
                return false;
        }
        return true;
    });
}
// ============================================================================
// Hoisting donor module-vars + imports
// ============================================================================
function hoistRequiredModuleVars(ast, consumerIndex, required) {
    const consumerLocals = new Set([
        ...consumerIndex.moduleVars.keys(),
        ...consumerIndex.functions.keys(),
        ...consumerIndex.imports.keys(),
    ]);
    const toInsert = [];
    const insertedKeys = new Set();
    for (const [key, req] of required) {
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
    return t.variableDeclaration(moduleVar.declaration.kind, [t.cloneNode(matching, true, false)]);
}
function hoistRequiredImports(ast, consumerFile, consumerIndex, required, reader) {
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
    for (const req of required.values()) {
        const binding = req.binding;
        if (!binding)
            continue;
        if (existingBindings.has(binding.localName))
            continue;
        let rewrittenSource = binding.source;
        // For relative imports, rewrite relative to the consumer file.
        if (binding.source.startsWith('./') ||
            binding.source.startsWith('../') ||
            binding.source.startsWith('/')) {
            const abs = resolveRelativeImport(req.sourceFile, binding.source, reader);
            if (abs) {
                let rel = nodePath.relative(consumerDir, abs);
                if (!rel.startsWith('.'))
                    rel = './' + rel;
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

function applySroa(ast) {
    const candidates = collectCandidates(ast);
    if (candidates.length === 0)
        return false;
    const safe = [];
    for (const c of candidates) {
        if (passesEscapeAnalysis(c.scopeNode, c.name, c.size, c.declaratorNode.id)) {
            safe.push(c);
        }
    }
    if (safe.length === 0)
        return false;
    rewriteDeclarations(safe);
    rewriteAccesses(ast, safe);
    return true;
}
// ============================================================================
// Phase 1: collect candidates
// ============================================================================
function collectCandidates(ast) {
    const out = [];
    traverse(ast, {
        VariableDeclarator(declaratorPath) {
            const declarator = declaratorPath.node;
            if (!t.isIdentifier(declarator.id))
                return;
            if (!declarator.init)
                return;
            const init = inferInitializer(declarator.init);
            if (!init)
                return;
            const annotatedSize = inferSizeFromAnnotation(ast, declarator);
            if (annotatedSize !== null && annotatedSize !== init.size)
                return;
            const declPath = declaratorPath.parentPath;
            if (!declPath || !t.isVariableDeclaration(declPath.node))
                return;
            if (!isSroaEnabled(declaratorPath))
                return;
            out.push({
                name: declarator.id.name,
                size: init.size,
                initExprs: init.initExprs,
                declaratorNode: declarator,
                declarationStatement: declPath.node,
                scopeNode: findEnclosingScope(declaratorPath),
            });
        },
    });
    return out;
}
function inferInitializer(init) {
    if (!t.isArrayExpression(init))
        return null;
    const size = init.elements.length;
    // Below 2 there's nothing to gain; above 16 the scalar explosion hurts.
    if (size < 2 || size > 16)
        return null;
    const exprs = [];
    for (const el of init.elements) {
        if (el === null || t.isSpreadElement(el))
            return null;
        exprs.push(el);
    }
    return { size, initExprs: exprs };
}
function inferSizeFromAnnotation(ast, declarator) {
    const annotation = declarator.id.typeAnnotation;
    if (!annotation || !t.isTSTypeAnnotation(annotation))
        return null;
    const typeNode = annotation.typeAnnotation;
    if (!t.isTSTupleType(typeNode)) {
        if (t.isTSTypeReference(typeNode) && t.isIdentifier(typeNode.typeName)) {
            return resolveTupleTypeSize(ast, typeNode.typeName.name);
        }
        return null;
    }
    return typeNode.elementTypes.length;
}
function resolveTupleTypeSize(ast, typeName) {
    for (const stmt of ast.program.body) {
        if (!t.isTSTypeAliasDeclaration(stmt))
            continue;
        if (stmt.id.name !== typeName)
            continue;
        if (!t.isTSTupleType(stmt.typeAnnotation))
            continue;
        return stmt.typeAnnotation.elementTypes.length;
    }
    return null;
}
function isSroaEnabled(declaratorPath) {
    let current = declaratorPath.parentPath;
    while (current && !t.isProgram(current.node)) {
        if (hasSroaAnnotation(current.node))
            return true;
        current = current.parentPath;
    }
    return false;
}
function findEnclosingScope(path) {
    let current = path.parentPath;
    while (current) {
        if (t.isFunctionDeclaration(current.node) ||
            t.isFunctionExpression(current.node) ||
            t.isArrowFunctionExpression(current.node) ||
            t.isProgram(current.node)) {
            return current.node;
        }
        current = current.parentPath;
    }
    return path.node;
}
// ============================================================================
// Phase 2: escape analysis
// ============================================================================
function passesEscapeAnalysis(scopeNode, name, size, declaratorId) {
    let safe = true;
    const wrapper = t.isProgram(scopeNode)
        ? t.file(scopeNode, [], [])
        : t.file(t.program([
            t.isStatement(scopeNode)
                ? scopeNode
                : t.expressionStatement(scopeNode),
        ]), [], []);
    traverse(wrapper, {
        Identifier(path) {
            if (!safe) {
                path.stop();
                return;
            }
            if (path.node.name !== name)
                return;
            if (path.node === declaratorId)
                return;
            if (!path.isReferencedIdentifier())
                return;
            const parent = path.parent;
            if (t.isMemberExpression(parent) && parent.object === path.node) {
                if (parent.computed && t.isNumericLiteral(parent.property)) {
                    const idx = parent.property.value;
                    if (idx >= 0 && idx < size && Number.isInteger(idx))
                        return;
                }
                safe = false;
                return;
            }
            safe = false;
        },
        // Nested functions that shadow the name are a different binding; skip.
        FunctionDeclaration(path) {
            if (path.node.params.some((p) => t.isIdentifier(p) && p.name === name))
                path.skip();
        },
        FunctionExpression(path) {
            if (path.node.params.some((p) => t.isIdentifier(p) && p.name === name))
                path.skip();
        },
        ArrowFunctionExpression(path) {
            if (path.node.params.some((p) => t.isIdentifier(p) && p.name === name))
                path.skip();
        },
    });
    return safe;
}
// ============================================================================
// Phase 3: rewrite declarations + accesses
// ============================================================================
function rewriteDeclarations(safe) {
    for (const c of safe) {
        const newDeclarators = [];
        for (let i = 0; i < c.size; i++) {
            const scalarName = `${c.name}_${i}`;
            const initExpr = c.initExprs[i]
                ? t.cloneNode(c.initExprs[i], true, false)
                : t.identifier('undefined');
            newDeclarators.push(t.variableDeclarator(t.identifier(scalarName), initExpr));
        }
        const declStmt = c.declarationStatement;
        const idx = declStmt.declarations.indexOf(c.declaratorNode);
        if (idx === -1)
            continue;
        if (declStmt.declarations.length === 1) {
            // `const` → `let` because we may write to the scalars later.
            declStmt.kind = 'let';
            declStmt.declarations = newDeclarators;
        }
        else {
            declStmt.declarations.splice(idx, 1, ...newDeclarators);
        }
    }
}
function rewriteAccesses(ast, safe) {
    const byScope = new Map();
    for (const c of safe) {
        const list = byScope.get(c.scopeNode) ?? [];
        list.push(c);
        byScope.set(c.scopeNode, list);
    }
    traverse(ast, {
        MemberExpression(path) {
            if (!path.node.computed)
                return;
            if (!t.isIdentifier(path.node.object))
                return;
            if (!t.isNumericLiteral(path.node.property))
                return;
            const name = path.node.object.name;
            let scopeNode = null;
            let cursor = path.parentPath;
            while (cursor) {
                if (byScope.has(cursor.node)) {
                    scopeNode = cursor.node;
                    break;
                }
                cursor = cursor.parentPath;
            }
            if (!scopeNode)
                return;
            const candidate = byScope.get(scopeNode).find((c) => c.name === name);
            if (!candidate)
                return;
            const idx = path.node.property.value;
            path.replaceWith(t.identifier(`${candidate.name}_${idx}`));
        },
    });
}

/**
 * Loop unrolling.
 *
 * Replaces an opt-in `/* @unroll *​/` loop with a flat sequence of its body,
 * one copy per iteration, with the loop variable substituted by its concrete
 * value. Works on:
 *
 *   - `for (let i = <lit>; i <(=) <lit>; i(++|+= <lit>)) { ... }`
 *   - `for (const x of <array literal | const array binding>) { ... }`
 *
 * Unrolling is only safe when the trip count is statically known and the body
 * contains no break/continue/return that would cross the loop boundary. A
 * loop that fails any precondition is left untouched with a console.warn
 * pointing at the source location — this is a soft-failure channel for
 * silent no-ops.
 *
 * Nested `@unroll` directives are handled by running the pass to a fixpoint
 * (with a hard ceiling on total passes to guard against pathological input).
 */
const MAX_UNROLL_ITERATIONS = 1024;
const MAX_UNROLL_PASSES = 16;
function applyUnroll(ast) {
    let anyChange = false;
    for (let pass = 0; pass < MAX_UNROLL_PASSES; pass++) {
        if (!unrollPass(ast))
            break;
        anyChange = true;
    }
    return anyChange;
}
function unrollPass(ast) {
    let changed = false;
    traverse(ast, {
        ForStatement(path) {
            if (!hasUnrollAnnotation(path.node))
                return;
            if (unrollForStatement(path))
                changed = true;
        },
        ForOfStatement(path) {
            if (!hasUnrollAnnotation(path.node))
                return;
            if (unrollForOfStatement(path))
                changed = true;
        },
    });
    return changed;
}
// ============================================================================
// for (let i = 0; i < N; i++) — classic counted loop
// ============================================================================
function unrollForStatement(path) {
    const shape = parseLoopShape(path.node);
    if (!shape) {
        warn(path.node, 'could not determine loop shape');
        stripUnrollComments(path.node);
        return false;
    }
    const values = computeIterationValues(shape);
    if (!values) {
        warn(path.node, `trip count exceeds maximum (${MAX_UNROLL_ITERATIONS})`);
        stripUnrollComments(path.node);
        return false;
    }
    if (values.length === 0) {
        path.remove();
        return true;
    }
    if (bodyHasUnsafeControlFlow(path.node.body)) {
        warn(path.node, 'loop body contains break/continue/return');
        stripUnrollComments(path.node);
        return false;
    }
    const bodyStmts = t.isBlockStatement(path.node.body) ? path.node.body.body : [path.node.body];
    const unrolled = [];
    for (const value of values) {
        for (const stmt of bodyStmts) {
            unrolled.push(cloneAndSubstitute(stmt, shape.varName, t.numericLiteral(value)));
        }
    }
    // Strip @unroll off the original before replaceWithMultiple — otherwise
    // babel transfers the leading comment onto the first replacement statement
    // and the next pass would try to unroll it again (the replacement isn't a
    // loop, but the warning path would fire).
    stripUnrollComments(path.node);
    path.replaceWithMultiple(unrolled);
    return true;
}
function parseLoopShape(node) {
    const init = node.init;
    if (!t.isVariableDeclaration(init) || init.declarations.length !== 1)
        return null;
    const declarator = init.declarations[0];
    if (!t.isIdentifier(declarator.id))
        return null;
    if (!declarator.init || !t.isNumericLiteral(declarator.init))
        return null;
    const varName = declarator.id.name;
    const start = declarator.init.value;
    const test = node.test;
    if (!t.isBinaryExpression(test))
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
// ============================================================================
// for (const x of [...]) — iterable-unroll
// ============================================================================
function unrollForOfStatement(path) {
    const node = path.node;
    if (!t.isVariableDeclaration(node.left)) {
        warn(node, 'for-of left-hand side must be a variable declaration');
        stripUnrollComments(node);
        return false;
    }
    if (node.left.declarations.length !== 1 || !t.isIdentifier(node.left.declarations[0].id)) {
        warn(node, 'for-of must declare a single identifier');
        stripUnrollComments(node);
        return false;
    }
    const varName = node.left.declarations[0].id.name;
    const elements = resolveStaticIterable(node.right, path);
    if (!elements) {
        warn(node, 'could not resolve for-of iterable to static values');
        stripUnrollComments(node);
        return false;
    }
    if (elements.length > MAX_UNROLL_ITERATIONS) {
        warn(node, `for-of iterable exceeds maximum (${MAX_UNROLL_ITERATIONS})`);
        stripUnrollComments(node);
        return false;
    }
    if (elements.length === 0) {
        path.remove();
        return true;
    }
    if (bodyHasUnsafeControlFlow(node.body)) {
        warn(node, 'for-of body contains break/continue/return');
        stripUnrollComments(node);
        return false;
    }
    const bodyStmts = t.isBlockStatement(node.body) ? node.body.body : [node.body];
    const unrolled = [];
    for (const element of elements) {
        for (const stmt of bodyStmts) {
            unrolled.push(cloneAndSubstitute(stmt, varName, element));
        }
    }
    stripUnrollComments(node);
    path.replaceWithMultiple(unrolled);
    return true;
}
function resolveStaticIterable(right, path) {
    if (t.isArrayExpression(right)) {
        return collectArrayElements(right);
    }
    if (t.isIdentifier(right)) {
        const binding = path.scope.getBinding(right.name);
        if (!binding || binding.kind !== 'const')
            return null;
        const declarator = binding.path.node;
        if (!t.isVariableDeclarator(declarator))
            return null;
        if (!declarator.init || !t.isArrayExpression(declarator.init))
            return null;
        return collectArrayElements(declarator.init);
    }
    return null;
}
function collectArrayElements(arr) {
    const out = [];
    for (const el of arr.elements) {
        if (el === null || t.isSpreadElement(el))
            return null;
        out.push(el);
    }
    return out;
}
// ============================================================================
// shared: substitute loop var into cloned body, control-flow safety, comments
// ============================================================================
function bodyHasUnsafeControlFlow(body) {
    return walk(body, false, false);
    function walk(node, insideNestedLoop, insideFunction) {
        if (!node)
            return false;
        if (t.isReturnStatement(node) && !insideFunction)
            return true;
        if ((t.isBreakStatement(node) || t.isContinueStatement(node)) && !insideNestedLoop) {
            return true;
        }
        if (t.isFunction(node)) {
            insideFunction = true;
            insideNestedLoop = true;
        }
        if (t.isForStatement(node) ||
            t.isWhileStatement(node) ||
            t.isDoWhileStatement(node) ||
            t.isForInStatement(node) ||
            t.isForOfStatement(node) ||
            t.isSwitchStatement(node)) {
            insideNestedLoop = true;
        }
        for (const key of t.VISITOR_KEYS[node.type] || []) {
            const child = node[key];
            if (Array.isArray(child)) {
                for (const item of child) {
                    if (item && typeof item === 'object' && 'type' in item) {
                        if (walk(item, insideNestedLoop, insideFunction))
                            return true;
                    }
                }
            }
            else if (child && typeof child === 'object' && 'type' in child) {
                if (walk(child, insideNestedLoop, insideFunction))
                    return true;
            }
        }
        return false;
    }
}
function cloneAndSubstitute(stmt, varName, replacement) {
    const cloned = t.cloneNode(stmt, true, false);
    const wrapper = t.file(t.program([cloned]), [], []);
    traverse(wrapper, {
        Identifier(idPath) {
            if (idPath.node.name !== varName)
                return;
            // skip declaration IDs (e.g. `let ${varName} = ...` inside body)
            if (idPath.parentPath?.isVariableDeclarator() && idPath.key === 'id')
                return;
            // skip when a closer scope shadows the loop var
            if (idPath.scope.hasOwnBinding(varName) &&
                idPath.scope.getBindingIdentifier(varName) !== idPath.node) {
                return;
            }
            // property keys and labels aren't referenced identifiers
            if (!idPath.isReferencedIdentifier())
                return;
            idPath.replaceWith(t.cloneNode(replacement, true, false));
        },
        Function(fnPath) {
            if (fnPath.scope.hasOwnBinding(varName))
                fnPath.skip();
        },
    });
    return wrapper.program.body[0];
}
function stripUnrollComments(node) {
    if (!node.leadingComments)
        return;
    node.leadingComments = node.leadingComments.filter((c) => !(c.type === 'CommentBlock' && DIRECTIVE_PATTERNS.unroll.test(c.value)));
    if (node.leadingComments.length === 0) {
        node.leadingComments = null;
    }
}
function warn(node, reason) {
    const loc = node.loc?.start;
    const locStr = loc ? ` (line ${loc.line})` : '';
    console.warn(`[compilecat] @unroll: ${reason}${locStr}, skipping`);
}

function transform(code, absolutePath, options = {}) {
    const ast = parse(code, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
        sourceFilename: absolutePath,
    });
    const state = initSimplifier();
    applyInline(ast, absolutePath, {
        zones: state.zones,
        fileCache: options.fileCache,
        fileReader: options.fileReader,
        allowLibraryInline: options.allowLibraryInline,
    });
    runSimplifier(ast, state);
    const unrolled = applyUnroll(ast);
    const sroaed = applySroa(ast);
    if (unrolled || sroaed) {
        runSimplifier(ast, state);
    }
    const result = generate(ast, {
        sourceMaps: options.sourceMaps ?? false,
        sourceFileName: absolutePath,
    });
    return { code: result.code, map: result.map ?? undefined };
}

const unplugin = createUnplugin((options = {}) => {
    const { debug = false, crossFile = true, libraryInline = true, fileReader = defaultFileReader, } = options;
    // Single cache shared across all files transformed in one build instance.
    const fileCache = createFileCache();
    return {
        name: 'compilecat',
        transform(code, id) {
            if (!/\.(js|ts|jsx|tsx)$/.test(id))
                return null;
            // Skip files with no `@*` markers. Avoids unnecessary babel
            // codegen round-trips that can break downstream TS parsers.
            if (!ANY_DIRECTIVE_IN_SOURCE.test(code))
                return null;
            if (debug)
                console.log(`[compilecat] Transforming ${id}`);
            try {
                const { code: out, map } = transform(code, id, {
                    sourceMaps: true,
                    fileCache: crossFile ? fileCache : undefined,
                    fileReader,
                    allowLibraryInline: libraryInline,
                });
                if (debug) {
                    console.log(`[compilecat] Output for ${id}:\n${out}`);
                }
                return { code: out, map };
            }
            catch (error) {
                console.error(`[compilecat] Failed to transform ${id}:`, error);
                return null;
            }
        },
    };
});

export { createFileCache, unplugin as default, defaultFileReader, unplugin as inlineFunctionsPlugin, transform, unplugin };
//# sourceMappingURL=index.js.map
