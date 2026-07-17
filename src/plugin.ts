// compilecat's bundler plugin (Rust/oxc core).
//
// Optimizes each source file in the `transform` hook, BEFORE bundling, keeping
// TypeScript. It is **cross-module aware**: when a file's `@optimize`/`@flatten`/
// `@sroa` directives reference an imported callable or type, the plugin resolves
// + reads exactly that dependency module (via the bundler's resolver + fs) and hands it
// to the core, which inlines across the module boundary and drops the now-unused
// import. `addWatchFile` keeps HMR correct (re-transform the consumer when a dependency
// changes).
//
// Dependency gathering is DEMAND-DRIVEN: instead of eagerly resolving the whole
// reachable module graph, the plugin asks the core's stateless `resolutionFrontier`
// what modules are still MISSING to satisfy the host's directives, resolves+reads
// only those, and re-queries until the frontier is empty. A directive-less file
// resolves and reads nothing.
//
// Exposed via unplugin — supports rollup, vite, rolldown (native Rust-level id
// filter), webpack, esbuild, and rspack from a single factory.

import fs from 'node:fs';
import path from 'node:path';

import { createUnplugin } from 'unplugin';
import type { FrontierRequest } from './compiler';
import { createCompiler, resolutionFrontier } from './compiler';
import { createFilter } from './filter';
import { declarationCandidates, specifierToSubpath, typesFromExports } from './type-resolve';

export type FilterPattern = string | RegExp | (string | RegExp)[];

function toArray<T>(v: T | T[] | undefined): T[] {
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
}

// Inlined so the native plugin doesn't pull the Babel-based compiler modules.
const ANY_DIRECTIVE = /@(?:inline|flatten|sroa|unroll|optimize)\b/;
const TRANSFORMABLE = /\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;

// Directories the build-start `@inline`-def scan never descends into (build
// output, deps, VCS metadata) — pruned whole so a large repo scan stays cheap.
const PRUNE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', 'coverage', '.turbo']);

// A `/* @inline */` (JSDoc / line / block comment carrying `@inline`) immediately
// before a function/const DEFINITION — `export? (async)? function NAME` or
// `export? (const|let|var) NAME = …`. This is the C++-`inline`-style DEF marker;
// captures the defined NAME. Distinct from a call-site marker (`/* @inline */
// foo()` before a CALL, where a `(` or `.` follows the comment instead of a
// declaration keyword) — only DEFS go in the index. A regex candidate scan is
// enough: the core's real `@inline`-export detection confirms the actual export,
// so a false-positive name merely yields a resolve that finds no `@inline` export
// → a harmless no-op.
const INLINE_DEF =
    /@inline\b[^\n]*(?:\r?\n\s*(?:\/\/[^\n]*\r?\n\s*|\/\*[\s\S]*?\*\/\s*)*)?\*?\/?\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/g;

// Scan one source file for its first-party `@inline`-DEF names (the marker sits on
// a comment immediately before the definition). Returns the defined names.
function scanInlineDefNames(code: string): string[] {
    if (!code.includes('@inline')) return [];
    const names: string[] = [];
    INLINE_DEF.lastIndex = 0;
    for (let m = INLINE_DEF.exec(code); m !== null; m = INLINE_DEF.exec(code)) {
        // Guard against a call-site marker (`/* @inline */ foo(` / `ns.foo(`): the
        // capture would only match a real declaration keyword, but a stray match on a
        // name directly followed by `(`/`.` (with no `function`/`const`) can't occur
        // because the pattern requires one of those keywords. Nothing extra needed.
        names.push(m[1]);
    }
    return names;
}

const statCache = new Map<string, boolean>();
function isFile(p: string): boolean {
    const hit = statCache.get(p);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
        ok = fs.statSync(p).isFile();
    } catch {
        ok = false;
    }
    statCache.set(p, ok);
    return ok;
}

// Given a resolved RUNTIME module path, find its TypeScript declaration companion
// (`foo.js` → `foo.d.ts`, `foo.mjs` → `foo.d.mts`) — where a published package's
// `export type`s live (the `.js` has them stripped). This is what lets the type
// oracle read e.g. mathcat's `Vec3`/`Quat` from `dist/types.d.ts`. Returns null if
// no declaration file sits beside it (a JS-only dep, or a first-party `.ts` source
// which already carries its own types).
function declarationFor(runtimePath: string): string | null {
    if (/\.d\.(?:ts|mts|cts)$/.test(runtimePath)) return runtimePath; // already a decl file
    const m = runtimePath.match(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/);
    if (!m) return null;
    const base = runtimePath.slice(0, -m[0].length);
    const ext = m[1];
    const candidates =
        ext === 'mjs' || ext === 'mts' ? ['.d.mts', '.d.ts'] : ext === 'cjs' || ext === 'cts' ? ['.d.cts', '.d.ts'] : ['.d.ts'];
    for (const c of candidates) {
        if (isFile(base + c)) return base + c;
    }
    return null;
}

// Walk up from `startPath` to the nearest directory containing a package.json.
function findPackageDir(startPath: string): string | null {
    let dir = path.dirname(startPath);
    for (let i = 0; i < 40; i++) {
        if (isFile(path.join(dir, 'package.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
}

// The package name of a bare specifier: `foo/sub` → `foo`, `@scope/foo/sub` → `@scope/foo`.
function packageNameOf(specifier: string): string {
    const parts = specifier.split('/');
    return specifier.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

interface PluginDependency {
    specifier: string;
    path: string;
    code: string;
    resolved: { specifier: string; path: string }[];
}

export interface Options {
    /** Module ids compilecat operates on — its **scope** (picomatch globs and/or
     *  RegExps). Required; there is no implicit default. Both the files that get
     *  transformed *and* the dependency modules that may be read+inlined are limited
     *  to this scope, so `node_modules` is never trawled unless a package is
     *  explicitly listed (e.g. `['**​/src/**', '**​/node_modules/mathcat/**']`).
     *  For rolldown, wired through the native hook-filter API so out-of-scope
     *  files are skipped in Rust without ever calling into JS. */
    include: FilterPattern;
    /** Ids to exclude on top of `include`. */
    exclude?: FilterPattern;
    /** Emit source maps. @default true */
    sourcemap?: boolean;
    /** Print a per-build timing/counter breakdown at `buildEnd` (how many files
     *  were seen vs optimized, and where wall time went: dependency resolve, fs read,
     *  native compile). @default false */
    debug?: boolean;
    /** Directory the build-start `@inline`-def scan walks to build its first-party
     *  index (so a directive-less file that CALLS an in-project `/* @inline *​/`
     *  function still inlines it). @default `process.cwd()` — normally the project
     *  root, where the in-scope src lives. */
    scanRoot?: string;
}

interface PluginStats {
    files: number; // transform() calls (transformable files)
    directiveFiles: number; // files carrying a directive
    skippedNoDirective: number; // returned early (no directive / no dependency directive)
    compiledFile: number; // compileFile calls (no dependencies)
    compiledCross: number; // compileFileCross calls (with dependencies)
    changed: number; // files actually rewritten
    resolves: number; // this.resolve calls (cache misses)
    resolveCacheHits: number;
    dependencyReads: number; // fs reads (cache misses)
    dependencyCacheHits: number;
    scanMs: number; // directive/import regex scans
    resolveMs: number; // this.resolve
    readMs: number; // fs.readFileSync dependencies
    compileMs: number; // native compileFile/compileFileCross
    totalMs: number; // total in transform()
}

function reportStats(s: PluginStats): void {
    const row = (label: string, ms: number) =>
        `  ${label.padEnd(20)} ${ms.toFixed(1).padStart(9)}ms  ${((ms / Math.max(s.totalMs, 0.001)) * 100).toFixed(1).padStart(5)}%`;
    console.log(
        `[compilecat-native] ${s.files} files seen, ${s.directiveFiles} with directive, ` +
            `${s.skippedNoDirective} skipped, ${s.compiledFile + s.compiledCross} compiled ` +
            `(${s.compiledCross} cross-file), ${s.changed} changed.\n` +
            `  resolves=${s.resolves} (cacheHits=${s.resolveCacheHits}) dependencyReads=${s.dependencyReads} (cacheHits=${s.dependencyCacheHits})\n` +
            `${row('scan (regex)', s.scanMs)}\n${row('resolve', s.resolveMs)}\n` +
            `${row('read dependencies (fs)', s.readMs)}\n${row('native compile', s.compileMs)}\n` +
            `  ${'TOTAL in transform'.padEnd(20)} ${s.totalMs.toFixed(1).padStart(9)}ms`,
    );
}

// biome-ignore lint/suspicious/noExplicitAny: unplugin/rollup PluginContext is structural
type Ctx = any;

export const unpluginCompilecat = createUnplugin<Options, false>((options, _meta) => {
    const compiler = createCompiler();
    const sourcemap = options.sourcemap ?? true;
    // Scope: which module ids may be transformed and read as dependencies. `inScope`
    // gates dependency reads in JS; the transform filter gates the hook in the bundler
    // (Rust for rolldown, JS for others), so out-of-scope files cost nothing.
    const inScope = createFilter(options.include, options.exclude);
    const include = toArray(options.include);
    const exclude = toArray(options.exclude);
    const stats: PluginStats | null = options.debug
        ? {
              files: 0,
              directiveFiles: 0,
              skippedNoDirective: 0,
              compiledFile: 0,
              compiledCross: 0,
              changed: 0,
              resolves: 0,
              resolveCacheHits: 0,
              dependencyReads: 0,
              dependencyCacheHits: 0,
              scanMs: 0,
              resolveMs: 0,
              readMs: 0,
              compileMs: 0,
              totalMs: 0,
          }
        : null;

    // Build-scoped caches (the plugin instance lives for the whole build):
    //  - dependencyCache: read + directive-scan a dependency once, not once per consumer.
    //  - consumersByDependency: reverse map dependencyPath → the files that inlined it.
    //    Inlining removes the import edge, so the module graph no longer carries
    //    dependency→consumer; a Vite HMR adapter uses this to invalidate consumers
    //    when a dependency changes. `watchChange` also uses it to evict the cache.
    const dependencyCache = new Map<string, { code: string; hasDirective: boolean }>();
    const consumersByDependency = new Map<string, Set<string>>();
    //  - inlineDefIndex: first-party `@inline`-DEF names, built once at `buildStart`
    //    by walking `scanRoot` (see `scanInlineDefIndex`). Feeds two things: the
    //    transform GATE (a directive-less file that CALLS one of these is no longer
    //    short-circuited) and the FRONTIER (`inline_def_names` → the def's module is
    //    gathered so the `require_inline` path inlines the call). Rebuilt lazily on the
    //    first transform if `buildStart` never ran (some bundler paths), and kept
    //    correct by `watchChange` (re-scan a changed file, add/remove its names).
    const inlineDefIndex = new Set<string>();
    let inlineDefIndexBuilt = false;
    const scanRoot = options.scanRoot ?? process.cwd();
    // The names each in-scope file contributed, so a `watchChange` re-scan can remove
    // the file's stale names before adding its fresh ones (a def deleted/renamed in an
    // edit must leave the index).
    const inlineDefNamesByFile = new Map<string, Set<string>>();
    // Bumped whenever the index MEMBERSHIP changes (build, watch re-scan). The gate
    // regex is cached against it, so a watch edit that swaps one name for another (same
    // size) still rebuilds the gate.
    let inlineDefIndexVersion = 0;
    const buildInlineDefIndex = () => {
        if (inlineDefIndexBuilt) return;
        inlineDefIndexBuilt = true;
        inlineDefIndex.clear();
        inlineDefNamesByFile.clear();
        // Re-derive per-file contributions so the whole index is refreshable; the walk
        // reads each file once, so re-scan them here to populate `inlineDefNamesByFile`
        // alongside the aggregate set. Cheap (a few ms per the spike).
        const stack: string[] = [scanRoot];
        while (stack.length) {
            const dir = stack.pop() as string;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (PRUNE_DIRS.has(e.name)) continue;
                    // Skip dotdirs (`.git`, `.cache`) UNLESS the scope filter would admit
                    // files under them — so an in-scope source dir like `.generated/` is
                    // still indexed rather than blanket-skipped. Probe with a synthetic child.
                    if (e.name.startsWith('.') && !inScope(path.join(full, '__cc_probe__.ts'))) continue;
                    stack.push(full);
                    continue;
                }
                if (!e.isFile() || !TRANSFORMABLE.test(e.name) || !inScope(full)) continue;
                let code: string;
                try {
                    code = fs.readFileSync(full, 'utf8');
                } catch {
                    continue;
                }
                const names = scanInlineDefNames(code);
                if (names.length) {
                    inlineDefNamesByFile.set(full, new Set(names));
                    for (const n of names) inlineDefIndex.add(n);
                }
            }
        }
        inlineDefIndexVersion++;
    };
    // Alternation regex over the current index names, cached until the set changes —
    // the per-file gate that lets a directive-less caller through. `null` when the
    // index is empty (no `@inline` defs → the gate reduces to the directive check).
    let defCallGate: RegExp | null = null;
    let defCallGateVersion = -1;
    const defCallGateFor = (): RegExp | null => {
        if (defCallGateVersion === inlineDefIndexVersion) return defCallGate;
        defCallGateVersion = inlineDefIndexVersion;
        if (inlineDefIndex.size === 0) {
            defCallGate = null;
        } else {
            const alt = [...inlineDefIndex].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
            // A call to one of the def names: `\b(name1|name2|…)\s*(` — a word-boundary'd
            // name followed by a call `(`. Loose (a same-named local/property call also
            // matches), but the gate only decides whether to PROCEED — the frontier +
            // core then confirm the real import/export, so a false match is a no-op.
            defCallGate = new RegExp(`\\b(?:${alt})\\s*\\(`);
        }
        return defCallGate;
    };
    //  - resolveCache: `this.resolve` is the dominant cost (it walks the bundler's
    //    resolver + plugin pipeline). The same (importer, specifier) pair recurs
    //    constantly — every directive file re-walks the same barrel graph — so
    //    memoize results for the whole build. Keyed `importer\0specifier`.
    // Stores the in-flight PROMISE (not the result) so concurrent transforms that
    // request the same specifier share ONE `this.resolve` — rolldown runs transform
    // hooks concurrently, so a result-cache would let N files all miss + resolve
    // `mathcat` before any populates it (N× the pipeline warmup).
    const resolveCache = new Map<string, Promise<{ id: string; external?: boolean } | null>>();
    //  - pkgTypeEntryCache: a bare package's resolved `.d.ts` type entry (or null),
    //    keyed `importer\0specifier`. Resolving it walks package.json/exports (see
    //    `resolvePackageTypeEntry`), so memoize per build. Stores the package.json path
    //    too, so cache hits still `addWatchFile` it (a `types`/`exports` edit must
    //    re-transform every consumer). Distinct from `resolveCache` (runtime `.js`).
    const pkgTypeEntryCache = new Map<string, { dts: string | null; pkgJson: string | null }>();
    //  - pkgJsonCache: parsed package.json per package dir (read once per build).
    const pkgJsonCache = new Map<string, Record<string, unknown> | null>();
    const readPackageJson = (dir: string): Record<string, unknown> | null => {
        const hit = pkgJsonCache.get(dir);
        if (hit !== undefined) return hit;
        let parsed: Record<string, unknown> | null = null;
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        } catch {
            parsed = null;
        }
        pkgJsonCache.set(dir, parsed);
        return parsed;
    };
    const readDependency = (dependencyPath: string): { code: string; hasDirective: boolean } | null => {
        const hit = dependencyCache.get(dependencyPath);
        if (hit) {
            if (stats) stats.dependencyCacheHits++;
            return hit;
        }
        let code: string;
        const r0 = stats ? performance.now() : 0;
        try {
            code = fs.readFileSync(dependencyPath, 'utf8');
        } catch {
            return null;
        }
        if (stats) {
            stats.readMs += performance.now() - r0;
            stats.dependencyReads++;
        }
        const entry = { code, hasDirective: ANY_DIRECTIVE.test(code) };
        dependencyCache.set(dependencyPath, entry);
        return entry;
    };

    return {
        name: 'compilecat',
        // Build the first-party `@inline`-def index ONCE per build (walk `scanRoot`
        // for in-scope defs — see `buildInlineDefIndex`). Cheap (a few ms) and it
        // gates + feeds the demand-driven inline of directive-less callers.
        buildStart() {
            buildInlineDefIndex();
        },
        // A changed dependency drops from the read cache so the next transform re-reads.
        // Rollup watch re-runs the consumer's transform via `addWatchFile`; a Vite
        // dev adapter additionally invalidates `consumersByDependency[changedId]`.
        watchChange(this: Ctx, changedId: string) {
            dependencyCache.delete(changedId);
            // An in-scope file's `@inline`-def set may have changed — re-scan it and
            // rebuild the index's names for that file (remove its stale names, add its
            // fresh ones). Correct over clever: a def deleted/renamed in an edit must
            // leave the index, a new one must enter. Recompute the aggregate set from
            // the per-file map so a removed name that no OTHER file still defines drops.
            if (TRANSFORMABLE.test(changedId) && (inScope(changedId) || inlineDefNamesByFile.has(changedId))) {
                let fresh: string[] = [];
                try {
                    fresh = scanInlineDefNames(fs.readFileSync(changedId, 'utf8'));
                } catch {
                    fresh = []; // deleted / unreadable → contributes nothing
                }
                if (fresh.length) inlineDefNamesByFile.set(changedId, new Set(fresh));
                else inlineDefNamesByFile.delete(changedId);
                inlineDefIndex.clear();
                for (const set of inlineDefNamesByFile.values()) for (const n of set) inlineDefIndex.add(n);
                inlineDefIndexVersion++;
                // KNOWN LIMITATION (dev/watch only): if this edit ADDS a new `@inline`
                // def, callers that already transformed against the old index keep their
                // cached (un-inlined) output until they themselves change — no bundler
                // exposes a portable "re-transform this unchanged module" trigger, and a
                // caller re-inlines correctly on its next edit or any full/production
                // build. This is correctness-preserving: dev output is merely UNoptimized,
                // never wrong. (A Vite adapter can force it via `consumersByDependency` +
                // `moduleGraph.invalidateModule`; that lives outside this portable core.)
            }
            // A dep's package.json edit can change its `types`/`exports` entry, so the
            // derived type-entry + parsed-package caches must drop too (keys don't
            // include the changed path, so clear both — package.json edits are rare).
            if (changedId.endsWith('package.json')) {
                pkgTypeEntryCache.clear();
                pkgJsonCache.clear();
            }
            // A file add / delete / rename changes what's on disk, so the fs-probe's
            // `statCache` (does `foo.ts` exist?) and the `resolveCache` (what does a
            // specifier bind to?) can go stale — a `.ts` that now exists, a specifier
            // that now resolves elsewhere. Neither key is path-addressable per change,
            // and both are cheap to repopulate lazily while watch rebuilds are
            // human-paced, so drop them wholesale rather than risk a stale resolution.
            statCache.clear();
            resolveCache.clear();
        },
        buildEnd() {
            if (stats) reportStats(stats);
        },
        // Scope the hook at the bundler level: for rolldown, `filter.id` skips
        // out-of-scope modules in Rust without ever crossing into JS (unplugin
        // passes the object-form through unchanged). For other bundlers, unplugin
        // applies a JS-level filter from the same descriptor. No `code` filter:
        // an in-scope file that calls an in-scope `@inline` function must be
        // processed even when it carries no directive of its own.
        transform: {
            filter: { id: { include, ...(exclude.length ? { exclude } : {}) } },
            handler: transformHandler,
        },
    };

    async function transformHandler(this: Ctx, code: string, id: string) {
        if (!TRANSFORMABLE.test(id)) return null;
        const t0 = stats ? performance.now() : 0;
        if (stats) stats.files++;
        try {
            return await runTransform.call(this, code, id);
        } catch (err) {
            // An optimizer must NEVER break the user's build. If the native core throws
            // or panics on some input (an id it can't parse, an unexpected syntax edge,
            // malformed dependency source), surface it as a WARNING and hand back the
            // ORIGINAL module unoptimized — visible enough to notice, non-fatal.
            this.warn?.(`compilecat: skipped ${id} — ${err instanceof Error ? err.message : String(err)}`);
            return null;
        } finally {
            if (stats) stats.totalMs += performance.now() - t0;
        }
    }

    async function runTransform(this: Ctx, code: string, id: string) {
        // The index must exist before the gate can consult it; build it lazily if
        // `buildStart` never fired (some bundler adapters skip it). No-op once built.
        buildInlineDefIndex();
        const consumerHasDirective = ANY_DIRECTIVE.test(code);
        if (stats && consumerHasDirective) stats.directiveFiles++;

        // GATE first, before ANY resolution: a file that neither carries a directive
        // NOR calls a first-party `@inline`-def name gathers nothing (the core's
        // `resolutionFrontier` yields `[]` for it), so short-circuit it here — zero
        // resolves/reads (the point of the pull model). A directive-less file that
        // CALLS an `@inline` def (one cheap regex over the index name-set) proceeds:
        // its def's module must be gathered so the call inlines (the C++-`inline`
        // "mark once, inline everywhere" ergonomic).
        const gate = defCallGateFor();
        if (!consumerHasDirective && !gate?.test(code)) {
            if (stats) stats.skippedNoDirective++;
            return null;
        }

        // DEMAND-DRIVEN dependency gather. Instead of eagerly resolving the reachable
        // graph, ask the core what modules are still MISSING to satisfy the host's
        // directives (`resolutionFrontier`), resolve+read exactly those, record the
        // edge that lets the core follow to them, and re-query until the frontier is
        // empty (fixpoint). VALUE dependencies (runtime `.js`/`.ts`) are kept BEFORE TYPE
        // dependencies (`.d.ts`) in the array handed to both the frontier and the inliner:
        // the frontier's value-seed and the core `.find` the first dependency by specifier
        // and must get the runtime one, not its `.d.ts` sibling.
        const valueDeps: PluginDependency[] = [];
        const typeDeps: PluginDependency[] = [];
        const byPath = new Map<string, PluginDependency>();
        // Top-level seed specifiers per resolved path. A file imported under MULTIPLE
        // specifiers (e.g. `./m.js` and the extensionless `./m`) is ONE `byPath` entry
        // but must be handed to the core as one VIEW per specifier — the core matches a
        // seed by `d.specifier`, so a single specifier would drop the other import's
        // inlining. Views share code + resolved edges (same file), which the core
        // tolerates (phase-1 caches by path; deeper edges resolve by path).
        const seedSpecs = new Map<string, Set<string>>();
        const providedOf = (): PluginDependency[] => {
            const base = typeDeps.length ? [...valueDeps, ...typeDeps] : valueDeps;
            // Fast path: expand lazily, only if some file carries >1 seed specifier.
            let expanded: PluginDependency[] | null = null;
            for (let i = 0; i < base.length; i++) {
                const d = base[i];
                const specs = seedSpecs.get(d.path);
                if (specs && specs.size > 1) {
                    if (!expanded) expanded = base.slice(0, i);
                    for (const s of specs) expanded.push(s === d.specifier ? d : { ...d, specifier: s });
                } else if (expanded) {
                    expanded.push(d);
                }
            }
            return expanded ?? base;
        };
        // A request tried once (resolved, out-of-scope, or unresolvable) is never
        // retried, so an unsatisfiable edge can't spin the loop.
        const attempted = new Set<string>();

        // The first-party `@inline`-def index, marshaled once for the fixpoint. The
        // frontier turns a host's calls to these names into value needs so their
        // defining modules (+ closure) get gathered; the core's `require_inline` path
        // then inlines every such call. Empty array (no defs) → no extra needs.
        const inlineDefNames = [...inlineDefIndex];

        const f0 = stats ? performance.now() : 0;
        let requests = resolutionFrontier(id, code, providedOf(), inlineDefNames);
        if (stats) stats.compileMs += performance.now() - f0;

        while (requests.length > 0) {
            let addedDependency = false;
            let addedEdge = false;
            for (const req of requests) {
                const attemptKey = `${req.specifier}\0${req.fromPath}\0${req.kind}`;
                if (attempted.has(attemptKey)) continue;
                attempted.add(attemptKey);

                // Route by kind EXHAUSTIVELY: a future core `FrontierKind` the plugin
                // doesn't know must NOT be silently treated as a value need — warn + skip.
                let resolvedPath: string | null;
                if (req.kind === 'type') resolvedPath = await resolveTypeRequest.call(this, req);
                else if (req.kind === 'value') resolvedPath = await resolveValueRequest.call(this, req);
                else {
                    this.warn?.(`compilecat: unknown frontier kind '${req.kind}' — skipping ${req.specifier}`);
                    resolvedPath = null;
                }
                // Skip unresolved / externalized / out-of-scope - the last is what
                // keeps node_modules outside `include` from being read.
                if (!resolvedPath || !inScope(resolvedPath)) continue;

                // Ensure ONE dependency per distinct resolved path.
                let dependency = byPath.get(resolvedPath);
                if (!dependency) {
                    const cached = readDependency(resolvedPath);
                    if (!cached) continue; // unreadable - skip
                    this.addWatchFile?.(resolvedPath);
                    dependency = { specifier: req.specifier, path: resolvedPath, code: cached.code, resolved: [] };
                    byPath.set(resolvedPath, dependency);
                    (req.kind === 'type' ? typeDeps : valueDeps).push(dependency);
                    addedDependency = true;
                }

                // Record the edge so the frontier can follow it. A top-level seed
                // (`fromPath === id`) is matched by SPECIFIER, so stamp the dependency's
                // `.specifier`; a deeper edge is matched by PATH, so push it onto the
                // importing dependency's `.resolved` (deduped).
                if (req.fromPath === id) {
                    // Top-level seed: record the specifier (a file may be imported under
                    // several). The FIRST becomes the canonical `dependency.specifier`
                    // (the single-specifier common case needs no expansion); `providedOf`
                    // fans out any file that accrues more than one.
                    let specs = seedSpecs.get(resolvedPath);
                    if (!specs) {
                        specs = new Set();
                        seedSpecs.set(resolvedPath, specs);
                    }
                    if (!specs.has(req.specifier)) {
                        if (specs.size === 0) dependency.specifier = req.specifier;
                        specs.add(req.specifier);
                        addedEdge = true;
                    }
                } else {
                    const from = byPath.get(req.fromPath);
                    if (from && !from.resolved.some((e) => e.specifier === req.specifier && e.path === resolvedPath)) {
                        from.resolved.push({ specifier: req.specifier, path: resolvedPath });
                        addedEdge = true;
                    }
                }
            }
            // Fixpoint: a round that added neither a dependency nor an edge can't advance
            // the frontier - the remaining requests are genuinely unresolvable, so
            // their calls stay un-inlined (correct). Break before re-querying.
            if (!addedDependency && !addedEdge) break;
            const fN = stats ? performance.now() : 0;
            requests = resolutionFrontier(id, code, providedOf(), inlineDefNames);
            if (stats) stats.compileMs += performance.now() - fN;
        }

        const dependencies = providedOf();
        // Track which consumer inlined which dependency (for HMR invalidation).
        for (const d of dependencies) {
            let set = consumersByDependency.get(d.path);
            if (!set) {
                set = new Set();
                consumersByDependency.set(d.path, set);
            }
            set.add(id);
        }

        const c0 = stats ? performance.now() : 0;
        const r =
            dependencies.length > 0
                ? compiler.compileFileCross(id, code, dependencies, { sourcemap })
                : compiler.compileFile(id, code, { sourcemap });
        if (stats) {
            stats.compileMs += performance.now() - c0;
            if (dependencies.length > 0) stats.compiledCross++;
            else stats.compiledFile++;
        }
        if (!r.changed) return null;
        if (stats) stats.changed++;
        return { code: r.code, map: r.map };
    }

    // Resolve one VALUE frontier request to its runtime module path, bundler-faithfully
    // via `this.resolve` (aliases / `exports` / `resolve.extensions` / plugins) — EXCEPT
    // the one case a probe can't get wrong: a RELATIVE specifier with an explicit,
    // transformable extension that exists on disk (a cheap `isFile`, skipping
    // `this.resolve`'s pipeline warmup). Everything else — bare specifiers, and
    // EXTENSIONLESS relatives whose extension/index the bundler picks by config — defers.
    // Affordable now that the pull model resolves almost nothing. Cached by
    // `dirname(fromPath)\0specifier` — importer-DIRECTORY-scoped, since Node resolution
    // depends on the importing file's directory (nested/duplicated deps, workspace
    // hoisting), so a global specifier-only key could hand one importer another's copy.
    async function resolveValueRequest(this: Ctx, req: FrontierRequest): Promise<string | null> {
        const bare = !req.specifier.startsWith('.');
        const cacheKey = `${path.dirname(req.fromPath)}\0${req.specifier}`;
        let p = resolveCache.get(cacheKey);
        if (p) {
            if (stats) stats.resolveCacheHits++;
        } else {
            if (stats) stats.resolves++;
            const rs0 = performance.now();
            // Start + cache the PROMISE synchronously (before any await) so concurrent
            // callers dedup onto it. See the doc above: `this.resolve` for everything
            // except a relative specifier with an explicit transformable extension on disk.
            const bundlerResolve = () => this.resolve?.(req.specifier, req.fromPath, { skipSelf: true });
            p = (async () => {
                try {
                    if (bare) return (await bundlerResolve()) ?? null;
                    const abs = path.resolve(path.dirname(req.fromPath), req.specifier);
                    // Explicit extension → fast-path only a TRANSFORMABLE module that
                    // exists on disk. A non-transformable asset (`.json`/`.css`/`.wasm`)
                    // or a virtual/query specifier may carry a bundler loader/transform,
                    // so defer to `this.resolve` rather than bind the raw file.
                    if (path.extname(abs)) return (TRANSFORMABLE.test(abs) && isFile(abs) ? { id: abs } : await bundlerResolve()) ?? null;
                    // Extensionless relative → defer to `this.resolve`. WHICH extension
                    // (and index file) the bundler binds is CONFIG-sensitive:
                    // `resolve.extensions` order + allowlist, `alias`, tsconfig `paths`.
                    // An fs-probe can't see that config, so "exactly one candidate on
                    // disk" is NOT proof the bundler binds it (it may be told to ignore
                    // that extension, or redirect the path). Only the explicit-extension
                    // case above is probe-safe (no guessing).
                    return (await bundlerResolve()) ?? null;
                } catch {
                    return null;
                } finally {
                    if (stats) stats.resolveMs += performance.now() - rs0;
                }
            })();
            resolveCache.set(cacheKey, p);
        }
        const resolved = await p;
        if (!resolved || resolved.external) return null;
        return resolved.id;
    }

    // Resolve one TYPE frontier request to its `.d.ts` entry, on demand - the
    // per-request form of the old eager type-dependency gather. Bare packages go through
    // the package.json `exports`/`types` resolver; a relative type edge (a `.d.ts`
    // re-export like `export * from './types.js'`, which often names a type-only
    // module with no runtime `.js`) probes the `.d.ts` candidates directly, then
    // falls back to a resolved runtime module's sibling `.d.ts`.
    async function resolveTypeRequest(this: Ctx, req: FrontierRequest): Promise<string | null> {
        if (!req.specifier.startsWith('.')) {
            return resolvePackageTypeEntry.call(this, req.specifier, req.fromPath);
        }
        const abs = path.resolve(path.dirname(req.fromPath), req.specifier);
        const direct = declarationCandidates(abs).find(isFile);
        if (direct) return direct;
        const rt = await resolveValueRequest.call(this, req);
        return rt ? declarationFor(rt) : null;
    }

    // Resolve a bare package specifier to its `.d.ts` type entry, in TypeScript's
    // precedence: `exports` map "types" condition → `types`/`typings` field → a
    // sibling `.d.ts` of the resolved runtime entry → the DefinitelyTyped
    // `@types/<pkg>` package (see `resolveAtTypesEntry`). Cached per build.
    // Known gap: `typesVersions` (TS-version-keyed `.d.ts` redirects) is not consulted.
    async function resolvePackageTypeEntry(this: Ctx, specifier: string, importerId: string): Promise<string | null> {
        const key = `${importerId}\0${specifier}`;
        const hit = pkgTypeEntryCache.get(key);
        if (hit !== undefined) {
            // Watch on hits too, so every consumer of this package re-transforms when its
            // `types`/`exports` entry changes (`watchChange` then clears these caches).
            if (hit.pkgJson) this.addWatchFile?.(hit.pkgJson);
            return hit.dts;
        }

        // Node-resolve the runtime entry — used to locate the package root and as the
        // sibling-`.d.ts` fallback. Reuses `resolveValueRequest`'s promise-cache, so a
        // package's runtime entry resolves ONCE across both its value and type needs.
        const runtimeId = await resolveValueRequest.call(this, {
            specifier,
            fromPath: importerId,
            kind: 'value',
        } as FrontierRequest);

        let result = resolveTypeEntryFrom(runtimeId, specifier);
        // DefinitelyTyped fallback: a package that ships NO own types (no `exports`
        // "types" / `types` field / sibling `.d.ts`) may have its declarations in a
        // separate `@types/<pkg>` package. Consult it before giving up.
        if (!result.dts) {
            const at = await resolveAtTypesEntry.call(this, specifier, importerId);
            if (at.dts) result = at;
        }
        if (result.pkgJson) this.addWatchFile?.(result.pkgJson);
        pkgTypeEntryCache.set(key, result);
        return result.dts;
    }

    // Resolve a package's DefinitelyTyped `@types/<pkg>` declarations, if installed.
    // `@types/<mangled>` where `@scope/foo` → `scope__foo`. Resolves the @types
    // package.json (an always-present subpath) through the bundler, then reads its
    // `exports` "types" / `types` field / default `index.d.ts` (the DT convention).
    async function resolveAtTypesEntry(
        this: Ctx,
        specifier: string,
        importerId: string,
    ): Promise<{ dts: string | null; pkgJson: string | null }> {
        const pkgName = packageNameOf(specifier);
        const mangled = pkgName.startsWith('@') ? pkgName.slice(1).replace('/', '__') : pkgName;
        const resolved = await this.resolve?.(`@types/${mangled}/package.json`, importerId, { skipSelf: true });
        if (!resolved || resolved.external) return { dts: null, pkgJson: null };
        const pkgJson = resolved.id;
        const pkgDir = path.dirname(pkgJson);
        const pj = readPackageJson(pkgDir);
        if (pj) {
            const fromExports = pj.exports != null ? typesFromExports(pj.exports, '.') : null;
            if (fromExports) {
                const p = path.resolve(pkgDir, fromExports);
                if (isFile(p)) return { dts: p, pkgJson };
            }
            const t = pj.types ?? pj.typings;
            if (typeof t === 'string') {
                const p = path.resolve(pkgDir, t);
                if (isFile(p)) return { dts: p, pkgJson };
            }
        }
        const idx = path.join(pkgDir, 'index.d.ts'); // DefinitelyTyped default entry
        if (isFile(idx)) return { dts: idx, pkgJson };
        return { dts: null, pkgJson };
    }

    // The package.json half of `resolvePackageTypeEntry`: exports/types/typings, else
    // the sibling `.d.ts`. Returns the package.json path too (for watch registration).
    function resolveTypeEntryFrom(runtimeId: string | null, specifier: string): { dts: string | null; pkgJson: string | null } {
        if (!runtimeId) return { dts: null, pkgJson: null };
        const pkgDir = findPackageDir(runtimeId);
        const pkgJson = pkgDir ? path.join(pkgDir, 'package.json') : null;
        if (pkgDir) {
            const pj = readPackageJson(pkgDir);
            if (pj) {
                const subpath = specifierToSubpath(specifier);
                const fromExports = pj.exports != null ? typesFromExports(pj.exports, subpath) : null;
                if (fromExports) {
                    const p = path.resolve(pkgDir, fromExports);
                    if (isFile(p)) return { dts: p, pkgJson };
                }
                if (subpath === '.') {
                    const t = pj.types ?? pj.typings;
                    if (typeof t === 'string') {
                        const p = path.resolve(pkgDir, t);
                        if (isFile(p)) return { dts: p, pkgJson };
                    }
                }
            }
        }
        return { dts: declarationFor(runtimeId), pkgJson }; // sibling `.d.ts` fallback
    }
});

export const compilecat = unpluginCompilecat.rollup;
export default compilecat;
