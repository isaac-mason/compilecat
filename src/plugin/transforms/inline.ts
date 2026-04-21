import { type NodePath } from '@babel/traverse';
import * as nodePath from 'node:path';
import * as t from '@babel/types';
import * as Effects from '../analyses/effects';
import * as Zones from '../analyses/zones';
import { commentIsInlineDirective } from '../analyses/directives';
import {
    type FileIndex,
    type ImportBinding,
    type IndexedFunction,
    type ModuleVar,
    callSiteHasInlineAnnotation,
    indexFile,
} from '../analyses/discover';
import { type FileCache, ensureIndexed } from '../analyses/fileindex';
import {
    type FileReader,
    defaultFileReader,
    resolveImportSource,
    resolveRelativeImport,
} from '../analyses/resolve';
import { generate, traverse } from '../util/babel';

/**
 * Alt-native inliner.
 *
 * Layers (bottom → top):
 *   1. Single-file decl-annotated `@cc-inline` — bodies pre-inlined bottom-up
 *      within the file, then substituted at four canonical callsite forms.
 *      Non-simple args hoisted once to `_arg_<param>_<suffix>` temps.
 *   2. Callsite-annotated calls (`/* @cc-inline *​/ foo()`) — opt-in inlining of
 *      a non-decl-annotated callee; applies to local functions and imports.
 *   3. Cross-file imports — relative imports resolve through FileCache +
 *      FileReader; imported function bodies are cloned and substituted just
 *      like local ones. Donor-file module vars and imports are hoisted into
 *      the consumer as needed.
 *   4. Library inlining — bare specifiers (`lodash`, `@scope/pkg`) walk up
 *      `node_modules`, honoring package.json exports / main / module. Only
 *      permitted with a callsite `@cc-inline` annotation, to keep library reach
 *      explicit at the call site.
 */

export type Options = {
    effects: Effects.State;
    /**
     * Zone cache shared with the simplifier. When omitted, a fresh state is
     * created — sharing is only a performance win, not a correctness need.
     */
    zones?: Zones.State;
    /** Cross-file file cache. When omitted, cross-file inlining is off. */
    fileCache?: FileCache;
    /** File reader for cross-file inlining. Defaults to `defaultFileReader`. */
    fileReader?: FileReader;
    /** Permit `node_modules` inlining via callsite `@cc-inline`. Default false. */
    allowLibraryInline?: boolean;
};

type Inlineable = {
    fn: IndexedFunction;
    /** Cloned body, safe to mutate. Includes the trailing return if present. */
    body: t.BlockStatement;
    params: string[];
    /** File the function lives in — used for hoist keys & import re-resolution. */
    sourceFile: string;
    /** Module vars the body reads from its source file. */
    moduleVarRefs: Set<string>;
    /** Import bindings the body reads from its source file. */
    importRefs: Set<string>;
    /** True when the original declaration should be stripped from the consumer. */
    stripOriginal: boolean;
};

type ExternalPoolEntry = {
    pool: Map<string, Inlineable>;
    index: FileIndex;
};

type RequiredModuleVar = {
    sourceFile: string;
    name: string;
    moduleVar: ModuleVar;
};

type RequiredImport = {
    sourceFile: string;
    /** Local name in the consumer. */
    localName: string;
    binding: ImportBinding;
};

export function applyInline(
    ast: t.File,
    absolutePath: string,
    options: Options,
): boolean {
    const reader = options.fileReader ?? defaultFileReader;
    const cache = options.fileCache;
    const allowLibrary = options.allowLibraryInline === true;
    const zones = options.zones ?? Zones.init();

    const index = indexFile(absolutePath, ast);
    const localPool = buildLocalPool(index);
    inlineDependenciesBottomUp(localPool);

    // External pools are lazy — one per donor file we've touched. Inside each
    // pool the donor file's own `@cc-inline` functions have been pre-inlined
    // bottom-up so nested call chains resolve before substitution.
    const externalPools = new Map<string, ExternalPoolEntry>();
    const requiredModuleVars = new Map<string, RequiredModuleVar>();
    const requiredImports = new Map<string, RequiredImport>();

    // Fixpoint: an `@cc-inline-body` zone can expose chained calls only revealed
    // after the first pass. Each pass is O(AST) so we cap at a small N.
    const MAX_PASSES = 8;
    let overallChanged = false;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const { changed } = inlineCallsitesInAst(
            ast,
            absolutePath,
            index,
            localPool,
            externalPools,
            requiredModuleVars,
            requiredImports,
            cache,
            reader,
            allowLibrary,
            zones,
        );
        if (!changed) break;
        overallChanged = true;
        // Inlining restructures ancestry: hoisted preludes and spliced bodies
        // move into new parents, so cached zone sets for those nodes are stale.
        // Cheaper than reasoning about which entries survived the pass.
        Zones.invalidateAll(zones);
    }

    if (!overallChanged) return false;

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

    // `@cc-inline` / `@cc-inline-body` markers are directives consumed by this
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

function buildLocalPool(index: FileIndex): Map<string, Inlineable> {
    const pool = new Map<string, Inlineable>();
    for (const [name, fn] of index.functions) {
        if (!fn.hasInlineAnnotation) continue;
        const entry = buildInlineable(fn, index.absolutePath, true);
        if (entry) pool.set(name, entry);
    }
    dropCyclicEntries(pool);
    return pool;
}

function buildInlineable(
    fn: IndexedFunction,
    sourceFile: string,
    stripOriginal: boolean,
): Inlineable | null {
    if (!isInlinableBody(fn.body)) return null;
    if (containsForbiddenConstructs(fn.body)) return null;
    // Params must all be plain identifiers (optionally with defaults). Any
    // ObjectPattern / ArrayPattern / RestElement would require destructuring
    // logic we don't implement — naively substituting the arg would leak
    // the original param names into the caller's scope.
    for (const p of fn.params) {
        if (t.isIdentifier(p)) continue;
        if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) continue;
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

function paramNames(params: t.Node[]): string[] {
    const out: string[] = [];
    for (const p of params) {
        if (t.isIdentifier(p)) out.push(p.name);
        else if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) out.push(p.left.name);
        else out.push('');
    }
    return out;
}

/**
 * Top-level shape constraint: no `return` can appear before the final statement.
 * Nested control flow is fine — `containsForbiddenConstructs` (called next in
 * `buildInlineable`) walks into nested blocks and rejects early returns there,
 * which is the real safety concern for splicing a body into a statement callsite.
 */
function isInlinableBody(body: t.BlockStatement): boolean {
    const stmts = body.body;
    for (let i = 0; i < stmts.length - 1; i++) {
        if (t.isReturnStatement(stmts[i])) return false;
    }
    return true;
}

function containsForbiddenConstructs(body: t.BlockStatement): boolean {
    let found = false;
    const walk = (node: t.Node) => {
        if (found) return;
        if (
            t.isFunctionDeclaration(node) ||
            t.isFunctionExpression(node) ||
            t.isArrowFunctionExpression(node) ||
            t.isObjectMethod(node) ||
            t.isClassMethod(node)
        ) {
            return;
        }
        if (t.isReturnStatement(node)) {
            found = true;
            return;
        }
        for (const key in node) {
            const v = (node as unknown as Record<string, unknown>)[key];
            if (Array.isArray(v)) {
                for (const child of v)
                    if (child && typeof child === 'object' && 'type' in child) walk(child as t.Node);
            } else if (v && typeof v === 'object' && 'type' in (v as Record<string, unknown>)) {
                walk(v as t.Node);
            }
        }
    };
    const stmts = body.body;
    const lastIsReturn = stmts.length > 0 && t.isReturnStatement(stmts[stmts.length - 1]);
    for (let i = 0; i < stmts.length - (lastIsReturn ? 1 : 0); i++) walk(stmts[i]);
    return found;
}

function dropCyclicEntries(pool: Map<string, Inlineable>): void {
    const deps = new Map<string, Set<string>>();
    for (const [name, entry] of pool) {
        const outs = new Set<string>();
        walkCalls(entry.body, (callee) => {
            if (pool.has(callee)) outs.add(callee);
        });
        deps.set(name, outs);
    }

    const inCycle = new Set<string>();
    for (const start of deps.keys()) {
        const seen = new Set<string>();
        const stack: string[] = [start];
        while (stack.length > 0) {
            const n = stack.pop()!;
            for (const m of deps.get(n) ?? []) {
                if (m === start) inCycle.add(start);
                if (!seen.has(m)) {
                    seen.add(m);
                    stack.push(m);
                }
            }
        }
    }
    for (const name of inCycle) pool.delete(name);
}

function inlineDependenciesBottomUp(pool: Map<string, Inlineable>): void {
    const deps = new Map<string, Set<string>>();
    const reverseDeps = new Map<string, Set<string>>();
    for (const name of pool.keys()) {
        deps.set(name, new Set());
        reverseDeps.set(name, new Set());
    }
    for (const [name, entry] of pool) {
        walkCalls(entry.body, (calleeName) => {
            if (pool.has(calleeName) && calleeName !== name) {
                deps.get(name)!.add(calleeName);
                reverseDeps.get(calleeName)!.add(name);
            }
        });
    }

    const queue: string[] = [];
    for (const [name, d] of deps) if (d.size === 0) queue.push(name);
    const ordered: string[] = [];
    while (queue.length > 0) {
        const n = queue.shift()!;
        ordered.push(n);
        for (const dep of reverseDeps.get(n) ?? []) {
            deps.get(dep)!.delete(n);
            if (deps.get(dep)!.size === 0) queue.push(dep);
        }
    }

    for (const name of ordered) {
        const entry = pool.get(name)!;
        const wrapper = t.file(
            t.program([t.functionDeclaration(t.identifier('__inline_wrapper__'), [], entry.body)]),
        );
        // In-file wrapper — no cross-file concerns, no hoists to collect.
        const localOnly = new Map<string, RequiredModuleVar>();
        const localImports = new Map<string, RequiredImport>();
        // Fresh zones state per wrapper — the wrapper's synthetic
        // `__inline_wrapper__` function has no `@cc-inline-body` comment, so
        // there's nothing meaningful to cache between pool entries.
        inlineCallsitesInAst(
            wrapper,
            '__wrapper__.ts',
            null,
            pool,
            new Map(),
            localOnly,
            localImports,
            undefined,
            defaultFileReader,
            false,
            Zones.init(),
            // Breadcrumbs at this stage would record callsite args against
            // the enclosing function's *params* (e.g. `proximity(o, a)` where
            // o/a are select's params). Those disappear once select gets
            // inlined at its real callsite, leaving a misleading breadcrumb.
            // Only the final outer pass tags breadcrumbs so every `@inlined`
            // sig reflects a call that actually appeared in the source.
            false,
        );
    }
}

function walkCalls(node: t.Node, cb: (callee: string) => void): void {
    const walk = (n: t.Node) => {
        if (t.isCallExpression(n) && t.isIdentifier(n.callee)) cb(n.callee.name);
        for (const key in n) {
            const v = (n as unknown as Record<string, unknown>)[key];
            if (Array.isArray(v)) {
                for (const child of v)
                    if (child && typeof child === 'object' && 'type' in child) walk(child as t.Node);
            } else if (v && typeof v === 'object' && 'type' in (v as Record<string, unknown>)) {
                walk(v as t.Node);
            }
        }
    };
    walk(node);
}

// ============================================================================
// Callee resolution
// ============================================================================

/**
 * A callsite is opted-in when either the original `@cc-inline` marker is present
 * or any ancestor carries an `@cc-inline-body` comment. The ancestor walk is
 * delegated to `Zones.isInZone`, which caches results per node so repeated
 * queries in the same function body are O(1) after the first resolution.
 */
function isCallOptedIn(path: NodePath<t.CallExpression>, zones: Zones.State): boolean {
    return callSiteHasInlineAnnotation(path) || Zones.isInZone(zones, path, 'inline-body');
}

/**
 * Resolve a CallExpression to an Inlineable, or null if it should not be
 * inlined. Non-null result means the callsite is eligible:
 *   - a decl-annotated local callee (no callsite annotation needed), or
 *   - any other callee the callsite has opted into via `/* @cc-inline *​/` or
 *     by sitting inside an `@cc-inline-body`-annotated function.
 */
function resolveCallee(
    path: NodePath<t.CallExpression>,
    consumerFile: string,
    consumerIndex: FileIndex | null,
    localPool: Map<string, Inlineable>,
    externalPools: Map<string, ExternalPoolEntry>,
    cache: FileCache | undefined,
    reader: FileReader,
    allowLibrary: boolean,
    zones: Zones.State,
): Inlineable | null {
    const callee = path.node.callee;

    // Identifier callee — either a local name or a named/default import.
    if (t.isIdentifier(callee)) {
        const name = callee.name;
        const inPool = localPool.get(name);
        if (inPool) return inPool;

        if (!consumerIndex) return null;

        // Named/default import — resolve into the donor file.
        const binding = consumerIndex.imports.get(name);
        if (binding) {
            return resolveImportBinding(
                path,
                consumerFile,
                binding,
                binding.importedName,
                externalPools,
                cache,
                reader,
                allowLibrary,
                zones,
            );
        }

        // Local function without decl-annotation — needs callsite opt-in
        // (either `/* @cc-inline */` at the call, or caller is `@cc-inline-body`).
        if (!isCallOptedIn(path, zones)) return null;
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
        if (!consumerIndex) return null;
        if (!t.isIdentifier(callee.object)) return null;
        if (!t.isIdentifier(callee.property)) return null;
        const nsName = callee.object.name;
        const fnName = callee.property.name;

        const binding = consumerIndex.imports.get(nsName);
        if (binding && binding.style === 'namespace') {
            return resolveImportBinding(
                path,
                consumerFile,
                binding,
                fnName,
                externalPools,
                cache,
                reader,
                allowLibrary,
                zones,
            );
        }
        const reexportSource = consumerIndex.namespaceReexports.get(nsName);
        if (reexportSource) {
            const fakeBinding: ImportBinding = {
                localName: nsName,
                importedName: '*',
                style: 'namespace',
                source: reexportSource,
            };
            return resolveImportBinding(
                path,
                consumerFile,
                fakeBinding,
                fnName,
                externalPools,
                cache,
                reader,
                allowLibrary,
                zones,
            );
        }

        // `import { ns } from 'pkg'` where pkg re-exports `ns` as a namespace:
        //   `export * as ns from './impl'`                 (namespaceReexports)
        //   `import * as ns from './impl'; export { ns };` (namespace import)
        // Follow through to the impl file and resolve `fnName` there.
        if (binding && binding.style === 'named') {
            if (!cache) return null;
            const donorPath = resolveImportSource(
                consumerFile,
                binding.source,
                allowLibrary,
                reader,
            );
            if (!donorPath) return null;
            const donorEntry = ensureExternalPool(donorPath, externalPools, cache, reader);
            if (!donorEntry) return null;
            let nsSource = donorEntry.index.namespaceReexports.get(binding.importedName);
            if (!nsSource) {
                const nsImport = donorEntry.index.imports.get(binding.importedName);
                if (nsImport?.style === 'namespace') {
                    nsSource = nsImport.source;
                }
            }
            if (!nsSource) return null;
            const fakeBinding: ImportBinding = {
                localName: nsName,
                importedName: '*',
                style: 'namespace',
                source: nsSource,
            };
            return resolveImportBinding(
                path,
                donorPath,
                fakeBinding,
                fnName,
                externalPools,
                cache,
                reader,
                allowLibrary,
                zones,
            );
        }
    }
    return null;
}

function resolveImportBinding(
    path: NodePath<t.CallExpression>,
    consumerFile: string,
    binding: ImportBinding,
    importedName: string,
    externalPools: Map<string, ExternalPoolEntry>,
    cache: FileCache | undefined,
    reader: FileReader,
    allowLibrary: boolean,
    zones: Zones.State,
): Inlineable | null {
    const resolvedPath = resolveImportSource(consumerFile, binding.source, allowLibrary, reader);
    if (!resolvedPath) return null;
    if (!cache) return null;

    const entry = ensureExternalPool(resolvedPath, externalPools, cache, reader);
    if (!entry) return null;

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
    // `/* @cc-inline */` or an enclosing `@cc-inline-body` function).
    if (!isCallOptedIn(path, zones)) return null;
    const fn = entry.index.functions.get(importedName);
    if (!fn) return null;
    return buildInlineable(fn, entry.index.absolutePath, false);
}

function ensureExternalPool(
    donorPath: string,
    externalPools: Map<string, ExternalPoolEntry>,
    cache: FileCache,
    reader: FileReader,
): ExternalPoolEntry | null {
    const existing = externalPools.get(donorPath);
    if (existing) return existing;

    const donorIndex = ensureIndexed(cache, donorPath, reader);
    if (!donorIndex) return null;

    // Build the donor's own local pool and pre-inline bottom-up, exactly like
    // we do for the consumer file. This way `/* @cc-inline */ a()` inside donor's
    // `b()` body has already been substituted before we clone b into the
    // consumer.
    const donorPool = new Map<string, Inlineable>();
    for (const [name, fn] of donorIndex.functions) {
        if (!fn.hasInlineAnnotation) continue;
        const entry = buildInlineable(fn, donorIndex.absolutePath, true);
        if (entry) donorPool.set(name, entry);
    }
    dropCyclicEntries(donorPool);
    inlineDependenciesBottomUp(donorPool);

    const record: ExternalPoolEntry = { pool: donorPool, index: donorIndex };
    externalPools.set(donorPath, record);
    return record;
}

// ============================================================================
// Callsite walk
// ============================================================================

function inlineCallsitesInAst(
    ast: t.File,
    consumerFile: string,
    consumerIndex: FileIndex | null,
    localPool: Map<string, Inlineable>,
    externalPools: Map<string, ExternalPoolEntry>,
    requiredModuleVars: Map<string, RequiredModuleVar>,
    requiredImports: Map<string, RequiredImport>,
    cache: FileCache | undefined,
    reader: FileReader,
    allowLibrary: boolean,
    zones: Zones.State,
    tagBreadcrumbs = true,
): { changed: boolean } {
    let changed = false;
    let suffixCounter = 0;

    traverse(ast, {
        CallExpression(path) {
            const entry = resolveCallee(
                path,
                consumerFile,
                consumerIndex,
                localPool,
                externalPools,
                cache,
                reader,
                allowLibrary,
                zones,
            );
            if (!entry) return;

            const suffix = String(suffixCounter++);

            const callsite = recognizeCallsite(path);
            if (callsite) {
                if (inlineOneCall(path, entry, callsite, suffix, tagBreadcrumbs)) {
                    trackDonorRefs(
                        entry,
                        consumerFile,
                        externalPools,
                        requiredModuleVars,
                        requiredImports,
                    );
                    changed = true;
                }
                return;
            }

            if (isSimpleReturnBody(entry.body)) {
                if (inlineSimpleReturn(path, entry, suffix, tagBreadcrumbs)) {
                    trackDonorRefs(
                        entry,
                        consumerFile,
                        externalPools,
                        requiredModuleVars,
                        requiredImports,
                    );
                    changed = true;
                }
                return;
            }

            // Expression-position callsite with a multi-statement body
            // (e.g. `proximity(o, a)` inside `proximity(o, a) < proximity(o, b)`).
            // Only safe when every prelude statement is a pure const/let decl —
            // then we can hoist the prelude above the enclosing statement and
            // replace the call with the return expression.
            if (inlineExpressionPosition(path, entry, suffix, tagBreadcrumbs)) {
                trackDonorRefs(
                    entry,
                    consumerFile,
                    externalPools,
                    requiredModuleVars,
                    requiredImports,
                );
                changed = true;
            }
        },
    });

    return { changed };
}

function trackDonorRefs(
    entry: Inlineable,
    consumerFile: string,
    externalPools: Map<string, ExternalPoolEntry>,
    requiredModuleVars: Map<string, RequiredModuleVar>,
    requiredImports: Map<string, RequiredImport>,
): void {
    // Same-file callsite: module vars and imports already live in the consumer.
    if (entry.sourceFile === consumerFile) return;

    const donor = externalPools.get(entry.sourceFile);
    if (!donor) return;

    for (const name of entry.moduleVarRefs) {
        const mv = donor.index.moduleVars.get(name);
        if (!mv) continue;
        const key = `${entry.sourceFile}::${name}`;
        if (requiredModuleVars.has(key)) continue;
        requiredModuleVars.set(key, { sourceFile: entry.sourceFile, name, moduleVar: mv });
    }
    for (const name of entry.importRefs) {
        const b = donor.index.imports.get(name);
        if (!b) continue;
        const key = `${entry.sourceFile}::${name}`;
        if (requiredImports.has(key)) continue;
        requiredImports.set(key, {
            sourceFile: entry.sourceFile,
            localName: name,
            binding: b,
        });
    }
}

function isSimpleReturnBody(body: t.BlockStatement): boolean {
    return (
        body.body.length === 1 &&
        t.isReturnStatement(body.body[0]) &&
        body.body[0].argument !== null &&
        body.body[0].argument !== undefined
    );
}

/**
 * Strip any `@cc-inline` block comment from `node.leadingComments`. Called
 * before we splice in a replacement so the original marker doesn't float
 * onto whatever we emit. We tag the replacement with `@inlined <sig>`.
 */
function stripInlineLeading(node: t.Node): void {
    const n = node as { leadingComments?: readonly t.Comment[] | null };
    if (!n.leadingComments) return;
    const kept = n.leadingComments.filter(
        (c) => !(c.type === 'CommentBlock' && isInlineMarkerComment(c.value)),
    );
    (n as { leadingComments: t.Comment[] | null }).leadingComments =
        kept.length > 0 ? (kept as t.Comment[]) : null;
}

function isInlineMarkerComment(value: string): boolean {
    // Only strip inline-specific markers. `@cc-sroa`, `@cc-unroll`, and
    // `@cc-optimize` are consumed by later passes and must survive this sweep.
    return commentIsInlineDirective(value);
}

/**
 * Final sweep: drop every `@cc-inline` / `@cc-inline-body` block comment from every
 * comment slot in the consumer AST. Covers the cases where Babel attached the
 * marker as trailing on a preceding sibling, inner on a parent block, or
 * leading on a node we didn't touch directly.
 */
function stripInlineMarkersGlobally(ast: t.File): void {
    const filterList = (list: readonly t.Comment[] | null | undefined): t.Comment[] | null => {
        if (!list || list.length === 0) return (list as t.Comment[] | null) ?? null;
        const kept = list.filter(
            (c) => !(c.type === 'CommentBlock' && isInlineMarkerComment(c.value)),
        );
        if (kept.length === list.length) return list as t.Comment[];
        return kept.length > 0 ? kept : null;
    };
    traverse(ast, {
        enter(path) {
            const n = path.node as {
                leadingComments?: t.Comment[] | null;
                trailingComments?: t.Comment[] | null;
                innerComments?: t.Comment[] | null;
            };
            n.leadingComments = filterList(n.leadingComments);
            n.trailingComments = filterList(n.trailingComments);
            n.innerComments = filterList(n.innerComments);
        },
    });
    // Babel also stashes comments on File.comments — keeps codegen-by-offset
    // consistent. Same filter there.
    const astComments = (ast as { comments?: t.Comment[] | null }).comments;
    if (astComments && astComments.length > 0) {
        (ast as { comments: t.Comment[] | null }).comments = astComments.filter(
            (c) => !(c.type === 'CommentBlock' && isInlineMarkerComment(c.value)),
        );
    }
}

/**
 * Breadcrumb built from the callsite itself: preserves the authored form
 * (`mat4.create(out, q)` rather than a synthetic `create(out, q)`) so the
 * comment points back to the original source.
 */
function breadcrumbFor(callPath: NodePath<t.CallExpression>): string {
    const src = generate(t.cloneNode(callPath.node, true, false), {
        concise: true,
        comments: false,
        retainLines: false,
    }).code;
    return src.replace(/\s+/g, ' ').trim();
}

/** Add a leading ` @inlined <sig> ` block comment to `node`. */
function tagInlined(node: t.Node, sig: string): void {
    t.addComment(node, 'leading', ` @inlined ${sig} `);
}

// ============================================================================
// Callsite splicing
// ============================================================================

function inlineSimpleReturn(
    callPath: NodePath<t.CallExpression>,
    entry: Inlineable,
    suffix: string,
    tagBreadcrumbs: boolean,
): boolean {
    const args = callPath.node.arguments;
    for (const a of args) if (t.isSpreadElement(a) || t.isArgumentPlaceholder(a)) return false;

    const paramNamesArr = entry.params;
    const ret = (entry.body.body[0] as t.ReturnStatement).argument as t.Expression;
    const refCounts = countParamReferences(ret, new Set(paramNamesArr));
    const substitution = new Map<string, t.Expression>();

    for (let i = 0; i < paramNamesArr.length; i++) {
        const pname = paramNamesArr[i];
        if (!pname) continue;
        const arg = (args[i] as t.Expression | undefined) ?? t.identifier('undefined');
        const count = refCounts.get(pname) ?? 0;
        const pure = isSimpleArg(arg);
        if (!pure && count !== 1) {
            return false;
        }
        substitution.set(pname, arg);
    }

    const clonedRet = t.cloneNode(ret, true, false);
    const wrapperBody = t.blockStatement([t.returnStatement(clonedRet)]);
    applyParamSubstitution(wrapperBody, substitution);
    renameLocalsInBody(wrapperBody, suffix, new Set(paramNamesArr));
    const renamedRet = (wrapperBody.body[0] as t.ReturnStatement).argument as t.Expression;

    // Strip the original `@cc-inline` marker from the callsite and any enclosing
    // statement before replacement, then tag the substituted expression with
    // `@inlined <sig>` as a breadcrumb.
    stripInlineLeading(callPath.node);
    const parentStmt = callPath.parentPath;
    if (parentStmt?.isStatement()) stripInlineLeading(parentStmt.node);
    if (tagBreadcrumbs) {
        tagInlined(renamedRet, breadcrumbFor(callPath));
    }

    callPath.replaceWith(renamedRet);
    return true;
}

function countParamReferences(expr: t.Expression, params: Set<string>): Map<string, number> {
    const counts = new Map<string, number>();
    const wrapper = t.file(t.program([t.expressionStatement(expr)]));
    traverse(wrapper, {
        Identifier(path) {
            if (!path.isReferencedIdentifier()) return;
            if (!params.has(path.node.name)) return;
            counts.set(path.node.name, (counts.get(path.node.name) ?? 0) + 1);
        },
    });
    return counts;
}

type CallsiteKind =
    | { kind: 'statement'; stmtPath: NodePath<t.ExpressionStatement> }
    | { kind: 'init'; declarator: NodePath<t.VariableDeclarator>; decl: NodePath<t.VariableDeclaration> }
    | { kind: 'assign'; stmtPath: NodePath<t.ExpressionStatement>; assign: NodePath<t.AssignmentExpression> }
    | { kind: 'return'; retPath: NodePath<t.ReturnStatement> };

function recognizeCallsite(path: NodePath<t.CallExpression>): CallsiteKind | null {
    const parent = path.parentPath;
    if (!parent) return null;

    if (parent.isExpressionStatement()) {
        return { kind: 'statement', stmtPath: parent as NodePath<t.ExpressionStatement> };
    }
    if (parent.isVariableDeclarator() && parent.node.init === path.node) {
        const decl = parent.parentPath;
        if (decl && decl.isVariableDeclaration()) {
            if (decl.node.declarations.length !== 1) return null;
            return {
                kind: 'init',
                declarator: parent as NodePath<t.VariableDeclarator>,
                decl: decl as NodePath<t.VariableDeclaration>,
            };
        }
    }
    if (
        parent.isAssignmentExpression() &&
        parent.node.operator === '=' &&
        parent.node.right === path.node
    ) {
        const stmt = parent.parentPath;
        if (stmt && stmt.isExpressionStatement()) {
            return {
                kind: 'assign',
                stmtPath: stmt as NodePath<t.ExpressionStatement>,
                assign: parent as NodePath<t.AssignmentExpression>,
            };
        }
    }
    if (parent.isReturnStatement() && parent.node.argument === path.node) {
        return { kind: 'return', retPath: parent as NodePath<t.ReturnStatement> };
    }
    return null;
}

function inlineOneCall(
    callPath: NodePath<t.CallExpression>,
    entry: Inlineable,
    callsite: CallsiteKind,
    suffix: string,
    tagBreadcrumbs: boolean,
): boolean {
    const args = callPath.node.arguments;
    for (const a of args) {
        if (t.isSpreadElement(a) || t.isArgumentPlaceholder(a)) return false;
    }

    const paramNamesArr = entry.params;
    const paramSet = new Set(paramNamesArr);
    const mutatedParams = findMutatedParams(entry.body, paramSet);
    const substitution = new Map<string, t.Expression>();
    const argHoists: t.Statement[] = [];

    for (let i = 0; i < paramNamesArr.length; i++) {
        const pname = paramNamesArr[i];
        if (!pname) continue;
        const arg = (args[i] as t.Expression | undefined) ?? t.identifier('undefined');
        if (mutatedParams.has(pname)) {
            // The callee writes to this param (e.g. `rad *= 0.5;`). Hoist the
            // arg into a `let` temp and rename every reference — reads and
            // writes — to the temp.
            const tempName = `_arg_${pname}_${suffix}`;
            argHoists.push(
                t.variableDeclaration('let', [
                    t.variableDeclarator(t.identifier(tempName), t.cloneNode(arg, true, false)),
                ]),
            );
            substitution.set(pname, t.identifier(tempName));
        } else if (isSimpleArg(arg)) {
            substitution.set(pname, arg);
        } else {
            const tempName = `_arg_${pname}_${suffix}`;
            argHoists.push(
                t.variableDeclaration('const', [
                    t.variableDeclarator(t.identifier(tempName), t.cloneNode(arg, true, false)),
                ]),
            );
            substitution.set(pname, t.identifier(tempName));
        }
    }

    const clonedBody = t.cloneNode(entry.body, true, false) as t.BlockStatement;
    applyParamSubstitution(clonedBody, substitution);
    renameLocalsInBody(clonedBody, suffix, paramSet);

    let clonedReturn: t.Expression | null = null;
    if (
        clonedBody.body.length > 0 &&
        t.isReturnStatement(clonedBody.body[clonedBody.body.length - 1])
    ) {
        const ret = clonedBody.body.pop() as t.ReturnStatement;
        clonedReturn = ret.argument ?? null;
    }

    const prelude: t.Statement[] = [...argHoists, ...clonedBody.body];
    const sig = tagBreadcrumbs ? breadcrumbFor(callPath) : '';
    stripInlineLeading(callPath.node);

    const tag = (node: t.Node) => {
        if (tagBreadcrumbs) tagInlined(node, sig);
    };

    switch (callsite.kind) {
        case 'statement': {
            const stmt = callsite.stmtPath;
            if (clonedReturn && expressionCouldHaveEffect(clonedReturn)) {
                prelude.push(t.expressionStatement(clonedReturn));
            }
            stripInlineLeading(stmt.node);
            if (prelude.length > 0) tag(prelude[0]);
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
            } else {
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
            } else {
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
            } else {
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
function inlineExpressionPosition(
    callPath: NodePath<t.CallExpression>,
    entry: Inlineable,
    suffix: string,
    tagBreadcrumbs: boolean,
): boolean {
    const args = callPath.node.arguments;
    for (const a of args) {
        if (t.isSpreadElement(a) || t.isArgumentPlaceholder(a)) return false;
    }

    const bodyStmts = entry.body.body;
    if (bodyStmts.length === 0) return false;

    const last = bodyStmts[bodyStmts.length - 1];
    if (!t.isReturnStatement(last) || last.argument == null) return false;

    // Every stmt before the return must be a pure decl — otherwise hoisting it
    // before the enclosing statement could reorder side effects with the rest
    // of the host expression.
    for (let i = 0; i < bodyStmts.length - 1; i++) {
        if (!isPurePreludeStatement(bodyStmts[i])) return false;
    }

    // Walk up to the nearest enclosing statement, but bail if we cross a
    // Function boundary — we only hoist inside the caller's own statement.
    let stmtPath: NodePath | null = callPath.parentPath;
    while (stmtPath && !stmtPath.isStatement()) {
        if (stmtPath.isFunction()) return false;
        stmtPath = stmtPath.parentPath;
    }
    if (!stmtPath || !stmtPath.isStatement()) return false;

    // Build substitution map — non-simple args must have a single use in the
    // body (otherwise we'd re-evaluate them at each substitution site).
    const paramNamesArr = entry.params;
    const paramSet = new Set(paramNamesArr);
    const mutatedParams = findMutatedParams(entry.body, paramSet);
    const bodyParamUses = countParamReferencesInBody(entry.body, paramSet);
    const substitution = new Map<string, t.Expression>();
    const argHoists: t.Statement[] = [];

    for (let i = 0; i < paramNamesArr.length; i++) {
        const pname = paramNamesArr[i];
        if (!pname) continue;
        const arg = (args[i] as t.Expression | undefined) ?? t.identifier('undefined');
        if (mutatedParams.has(pname)) {
            const tempName = `_arg_${pname}_${suffix}`;
            argHoists.push(
                t.variableDeclaration('let', [
                    t.variableDeclarator(t.identifier(tempName), t.cloneNode(arg, true, false)),
                ]),
            );
            substitution.set(pname, t.identifier(tempName));
        } else if (isSimpleArg(arg)) {
            substitution.set(pname, arg);
        } else {
            const count = bodyParamUses.get(pname) ?? 0;
            if (count > 1) {
                const tempName = `_arg_${pname}_${suffix}`;
                argHoists.push(
                    t.variableDeclaration('const', [
                        t.variableDeclarator(
                            t.identifier(tempName),
                            t.cloneNode(arg, true, false),
                        ),
                    ]),
                );
                substitution.set(pname, t.identifier(tempName));
            } else {
                substitution.set(pname, arg);
            }
        }
    }

    const clonedBody = t.cloneNode(entry.body, true, false) as t.BlockStatement;
    applyParamSubstitution(clonedBody, substitution);
    renameLocalsInBody(clonedBody, suffix, paramSet);

    const clonedStmts = clonedBody.body;
    const retStmt = clonedStmts.pop() as t.ReturnStatement;
    const retExpr = retStmt.argument as t.Expression;

    const prelude: t.Statement[] = [...argHoists, ...clonedStmts];

    stripInlineLeading(callPath.node);
    if (tagBreadcrumbs) {
        const sig = breadcrumbFor(callPath);
        if (prelude.length > 0) {
            tagInlined(prelude[0], sig);
        } else {
            tagInlined(retExpr, sig);
        }
    }
    if (prelude.length > 0) {
        (stmtPath as NodePath<t.Statement>).insertBefore(prelude);
    }

    callPath.replaceWith(retExpr);
    return true;
}

function isPurePreludeStatement(stmt: t.Statement): boolean {
    if (!t.isVariableDeclaration(stmt)) return false;
    if (stmt.kind === 'var') return false;
    for (const d of stmt.declarations) {
        if (!t.isIdentifier(d.id)) return false;
        if (!d.init) return false;
        if (!isPureInitExpression(d.init)) return false;
    }
    return true;
}

/**
 * "Pure enough to hoist above the host expression inside an `@cc-inline` zone."
 * More permissive than `isSimpleArg` — allows nested member chains and pure
 * arithmetic — but rejects anything that could trigger a call or observable
 * write: CallExpression, NewExpression, AssignmentExpression, UpdateExpression,
 * YieldExpression, AwaitExpression.
 *
 * Getters are assumed side-effect-free (consistent with the rest of plugin-alt's
 * @cc-inline-zone contract).
 */
function isPureInitExpression(expr: t.Expression): boolean {
    if (t.isIdentifier(expr) || t.isThisExpression(expr) || t.isSuper(expr)) return true;
    if (
        t.isNumericLiteral(expr) ||
        t.isStringLiteral(expr) ||
        t.isBooleanLiteral(expr) ||
        t.isNullLiteral(expr) ||
        t.isBigIntLiteral(expr) ||
        t.isRegExpLiteral(expr)
    ) {
        return true;
    }
    if (t.isMemberExpression(expr)) {
        if (!t.isExpression(expr.object)) return false;
        if (!isPureInitExpression(expr.object as t.Expression)) return false;
        if (expr.computed) {
            if (!t.isExpression(expr.property)) return false;
            return isPureInitExpression(expr.property as t.Expression);
        }
        return true;
    }
    if (t.isUnaryExpression(expr) && expr.operator !== 'delete' && expr.operator !== 'throw') {
        return isPureInitExpression(expr.argument as t.Expression);
    }
    if (t.isBinaryExpression(expr)) {
        if (!t.isExpression(expr.left)) return false;
        return (
            isPureInitExpression(expr.left as t.Expression) &&
            isPureInitExpression(expr.right as t.Expression)
        );
    }
    if (t.isLogicalExpression(expr)) {
        return (
            isPureInitExpression(expr.left as t.Expression) &&
            isPureInitExpression(expr.right as t.Expression)
        );
    }
    if (t.isConditionalExpression(expr)) {
        return (
            isPureInitExpression(expr.test as t.Expression) &&
            isPureInitExpression(expr.consequent as t.Expression) &&
            isPureInitExpression(expr.alternate as t.Expression)
        );
    }
    if (t.isArrayExpression(expr)) {
        for (const el of expr.elements) {
            if (el == null) continue;
            if (t.isSpreadElement(el)) return false;
            if (!isPureInitExpression(el as t.Expression)) return false;
        }
        return true;
    }
    if (t.isObjectExpression(expr)) {
        for (const p of expr.properties) {
            if (!t.isObjectProperty(p)) return false;
            if (p.computed && t.isExpression(p.key) && !isPureInitExpression(p.key as t.Expression)) {
                return false;
            }
            if (!t.isExpression(p.value)) return false;
            if (!isPureInitExpression(p.value as t.Expression)) return false;
        }
        return true;
    }
    return false;
}

function countParamReferencesInBody(
    body: t.BlockStatement,
    params: Set<string>,
): Map<string, number> {
    const counts = new Map<string, number>();
    const wrapper = t.file(
        t.program([t.functionDeclaration(t.identifier('__count_wrapper__'), [], body)]),
    );
    traverse(wrapper, {
        Identifier(path) {
            if (!path.isReferencedIdentifier()) return;
            if (!params.has(path.node.name)) return;
            counts.set(path.node.name, (counts.get(path.node.name) ?? 0) + 1);
        },
    });
    return counts;
}

function isSimpleArg(expr: t.Expression): boolean {
    if (t.isIdentifier(expr)) return true;
    if (t.isThisExpression(expr) || t.isSuper(expr)) return true;
    if (
        t.isNumericLiteral(expr) ||
        t.isStringLiteral(expr) ||
        t.isBooleanLiteral(expr) ||
        t.isNullLiteral(expr)
    ) {
        return true;
    }
    if (t.isMemberExpression(expr)) {
        if (expr.computed) {
            if (
                !t.isIdentifier(expr.property) &&
                !t.isNumericLiteral(expr.property) &&
                !t.isStringLiteral(expr.property)
            ) {
                return false;
            }
        }
        if (t.isIdentifier(expr.object) || t.isThisExpression(expr.object)) return true;
        if (t.isMemberExpression(expr.object)) return isSimpleArg(expr.object);
        return false;
    }
    return false;
}

function expressionCouldHaveEffect(expr: t.Expression): boolean {
    return (
        t.isCallExpression(expr) ||
        t.isNewExpression(expr) ||
        t.isAssignmentExpression(expr) ||
        t.isUpdateExpression(expr) ||
        t.isYieldExpression(expr) ||
        t.isAwaitExpression(expr)
    );
}

function applyParamSubstitution(body: t.BlockStatement, subst: Map<string, t.Expression>): void {
    traverse(
        t.file(t.program([t.functionDeclaration(t.identifier('__subst_wrapper__'), [], body)])),
        {
            Identifier(path) {
                const replacement = subst.get(path.node.name);
                if (!replacement) return;

                // Skip obvious non-references (member property names, object
                // property keys) — those are strings-in-identifier-clothing.
                if (
                    path.parentPath?.isMemberExpression() &&
                    !path.parentPath.node.computed &&
                    path.key === 'property'
                ) {
                    return;
                }
                if (
                    path.parentPath?.isObjectProperty() &&
                    path.key === 'key' &&
                    !path.parentPath.node.computed
                ) {
                    return;
                }

                // Write-position identifiers (LHS of `=`, arg of `++`/`--`) are
                // not `isReferencedIdentifier`, but we still need to rewrite
                // them when the callee mutates a param. Only safe when the
                // replacement is itself an Identifier — we can rename a
                // binding, but not replace it with an arbitrary expression.
                const isWrite =
                    (path.parentPath?.isAssignmentExpression() &&
                        path.parentPath.node.left === path.node) ||
                    (path.parentPath?.isUpdateExpression() &&
                        path.parentPath.node.argument === path.node);
                if (isWrite) {
                    if (!t.isIdentifier(replacement)) return;
                    path.node.name = replacement.name;
                    return;
                }

                if (!path.isReferencedIdentifier()) return;
                path.replaceWith(t.cloneNode(replacement, true, false));
                // Don't re-visit the replacement — if it contains an Identifier
                // whose name happens to match a subst key (e.g. the caller's
                // arg is named the same as the callee's param), we'd loop.
                path.skip();
            },
        },
    );
}

function findMutatedParams(body: t.BlockStatement, paramSet: Set<string>): Set<string> {
    const mutated = new Set<string>();
    if (paramSet.size === 0) return mutated;
    const wrapper = t.file(
        t.program([t.functionDeclaration(t.identifier('__mut_wrapper__'), [], body)]),
    );
    traverse(wrapper, {
        AssignmentExpression(path) {
            const lhs = path.node.left;
            if (t.isIdentifier(lhs) && paramSet.has(lhs.name)) mutated.add(lhs.name);
        },
        UpdateExpression(path) {
            const arg = path.node.argument;
            if (t.isIdentifier(arg) && paramSet.has(arg.name)) mutated.add(arg.name);
        },
    });
    return mutated;
}

function renameLocalsInBody(
    body: t.BlockStatement,
    suffix: string,
    paramSet: Set<string>,
): void {
    const locals = collectLocalBindings(body, paramSet);
    if (locals.size === 0) return;

    traverse(
        t.file(t.program([t.functionDeclaration(t.identifier('__rename_wrapper__'), [], body)])),
        {
            Identifier(path) {
                if (
                    path.parentPath?.isMemberExpression() &&
                    !path.parentPath.node.computed &&
                    path.key === 'property'
                ) {
                    return;
                }
                if (
                    path.parentPath?.isObjectProperty() &&
                    path.key === 'key' &&
                    !path.parentPath.node.computed
                ) {
                    return;
                }
                if (locals.has(path.node.name)) {
                    path.node.name = `${path.node.name}_${suffix}`;
                }
            },
        },
    );
}

function collectLocalBindings(body: t.BlockStatement, paramSet: Set<string>): Set<string> {
    const locals = new Set<string>();
    const wrapper = t.file(
        t.program([t.functionDeclaration(t.identifier('__bind_wrapper__'), [], body)]),
    );
    traverse(wrapper, {
        VariableDeclarator(path) {
            if (t.isIdentifier(path.node.id) && !paramSet.has(path.node.id.name)) {
                locals.add(path.node.id.name);
            }
        },
        FunctionDeclaration(path) {
            if (path.node.id) locals.add(path.node.id.name);
        },
    });
    return locals;
}

function removeInlinedDeclarations(ast: t.File, pool: Map<string, Inlineable>): void {
    const names = new Set<string>();
    for (const [name, entry] of pool) if (entry.stripOriginal) names.add(name);
    if (names.size === 0) return;

    ast.program.body = ast.program.body.filter((stmt) => {
        if (t.isFunctionDeclaration(stmt) && stmt.id && names.has(stmt.id.name)) return false;
        if (t.isExportNamedDeclaration(stmt) && stmt.declaration) {
            if (
                t.isFunctionDeclaration(stmt.declaration) &&
                stmt.declaration.id &&
                names.has(stmt.declaration.id.name)
            ) {
                return false;
            }
        }
        if (t.isExportDefaultDeclaration(stmt) && names.has('default')) {
            const decl = stmt.declaration;
            if (
                t.isFunctionDeclaration(decl) ||
                t.isFunctionExpression(decl) ||
                t.isArrowFunctionExpression(decl)
            ) {
                return false;
            }
        }
        if (t.isVariableDeclaration(stmt)) {
            stmt.declarations = stmt.declarations.filter(
                (d) =>
                    !(
                        t.isIdentifier(d.id) &&
                        names.has(d.id.name) &&
                        (t.isArrowFunctionExpression(d.init) || t.isFunctionExpression(d.init))
                    ),
            );
            if (stmt.declarations.length === 0) return false;
        }
        return true;
    });
}

// ============================================================================
// Hoisting donor module-vars + imports
// ============================================================================

function hoistRequiredModuleVars(
    ast: t.File,
    consumerIndex: FileIndex,
    required: Map<string, RequiredModuleVar>,
): void {
    const consumerLocals = new Set<string>([
        ...consumerIndex.moduleVars.keys(),
        ...consumerIndex.functions.keys(),
        ...consumerIndex.imports.keys(),
    ]);

    const toInsert: t.VariableDeclaration[] = [];
    const insertedKeys = new Set<string>();

    for (const [key, req] of required) {
        if (insertedKeys.has(key)) continue;
        if (consumerLocals.has(req.name)) continue;
        const cloned = cloneModuleVarForHoisting(req.moduleVar, req.name);
        if (!cloned) continue;
        toInsert.push(cloned);
        insertedKeys.add(key);
    }

    if (toInsert.length === 0) return;

    const body = ast.program.body;
    let insertAt = 0;
    for (let i = 0; i < body.length; i++) {
        if (t.isImportDeclaration(body[i])) insertAt = i + 1;
        else break;
    }
    body.splice(insertAt, 0, ...toInsert);
}

function cloneModuleVarForHoisting(moduleVar: ModuleVar, name: string): t.VariableDeclaration | null {
    const matching = moduleVar.declaration.declarations.find(
        (d) => t.isIdentifier(d.id) && d.id.name === name,
    );
    if (!matching) return null;
    return t.variableDeclaration(moduleVar.declaration.kind, [t.cloneNode(matching, true, false)]);
}

function hoistRequiredImports(
    ast: t.File,
    consumerFile: string,
    consumerIndex: FileIndex,
    required: Map<string, RequiredImport>,
    reader: FileReader,
): void {
    const existingBindings = new Set<string>([
        ...consumerIndex.imports.keys(),
        ...consumerIndex.functions.keys(),
        ...consumerIndex.moduleVars.keys(),
    ]);
    for (const stmt of ast.program.body) {
        if (t.isImportDeclaration(stmt)) {
            for (const spec of stmt.specifiers) existingBindings.add(spec.local.name);
        }
    }

    // Group by rewritten import source so we can merge specifiers per module.
    type Spec = { localName: string; importedName: string; style: 'named' | 'default' | 'namespace' };
    const byTarget = new Map<string, { source: string; specs: Spec[] }>();

    const consumerDir = nodePath.dirname(consumerFile);

    for (const req of required.values()) {
        const binding = req.binding;
        if (!binding) continue;
        if (existingBindings.has(binding.localName)) continue;

        let rewrittenSource = binding.source;
        // For relative imports, rewrite relative to the consumer file.
        if (
            binding.source.startsWith('./') ||
            binding.source.startsWith('../') ||
            binding.source.startsWith('/')
        ) {
            const abs = resolveRelativeImport(req.sourceFile, binding.source, reader);
            if (abs) {
                let rel = nodePath.relative(consumerDir, abs);
                if (!rel.startsWith('.')) rel = './' + rel;
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

    if (byTarget.size === 0) return;

    const importsToInsert: t.ImportDeclaration[] = [];
    for (const { source, specs } of byTarget.values()) {
        const specifiers: t.ImportDeclaration['specifiers'] = [];
        for (const s of specs) {
            if (s.style === 'default') {
                specifiers.push(t.importDefaultSpecifier(t.identifier(s.localName)));
            } else if (s.style === 'namespace') {
                specifiers.push(t.importNamespaceSpecifier(t.identifier(s.localName)));
            } else {
                specifiers.push(
                    t.importSpecifier(t.identifier(s.localName), t.identifier(s.importedName)),
                );
            }
        }
        importsToInsert.push(t.importDeclaration(specifiers, t.stringLiteral(source)));
    }

    ast.program.body.unshift(...importsToInsert);
}
