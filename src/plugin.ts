// compilecat's bundler plugin (Rust/oxc core).
//
// Optimizes each source file in the `transform` hook, BEFORE bundling, keeping
// TypeScript. It is **cross-module aware**: when a file imports an `@inline`
// donor, the plugin resolves + reads the donor module (via the bundler's
// resolver + fs) and hands it to the core, which inlines across the module
// boundary and drops the now-unused import. `addWatchFile` keeps HMR correct
// (re-transform the consumer when a donor changes).
//
// Exposed via unplugin — supports rollup, vite, rolldown (native Rust-level id
// filter), webpack, esbuild, and rspack from a single factory.

import fs from 'node:fs';
import path from 'node:path';

import { createUnplugin } from 'unplugin';
import { createCompiler, donorEdges } from './compiler';
import { createFilter } from './filter';
import { declarationCandidates, specifierToSubpath, typeImportSpecifiers, typesFromExports } from './type-resolve';

export type FilterPattern = string | RegExp | (string | RegExp)[];

function toArray<T>(v: T | T[] | undefined): T[] {
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
}

// Inlined so the native plugin doesn't pull the Babel-based compiler modules.
const ANY_DIRECTIVE = /@(?:inline|flatten|sroa|unroll|optimize)\b/;
const TRANSFORMABLE = /\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
// Any `… from "<spec>"` import — relative (`./x`, `../x`) or bare (`pkg`).
const IMPORT_FROM = /import\b[^'"]*?from\s*['"]([^'"]+)['"]/g;
// Flat re-exports only — `export * from S` and `export {…}`/`export type {…} from S`;
// EXCLUDES `export * as ns from S`, which contributes `ns.X` not a flat name and so is
// never followed for flat type resolution (matches the core). Keeps the donor set to a
// package's real flat surface rather than every namespaced submodule. Used only by the
// SEPARATE `.d.ts` type-donor path (`gatherTypeSourceDonors`); the runtime donor BFS
// follows edges via the core's AST-based `donorEdges` instead.
const EXPORT_FLAT_FROM = /export\s+(?:type\s+)?(?:\*(?!\s*as\b)|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g;

// Extensions/index files tried when resolving a relative import ourselves —
// cheap fs probes instead of the bundler's `this.resolve`, which is only needed
// for bare specifiers (aliases, package exports, node_modules layout).
const REL_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const REL_INDEX = ['/index.ts', '/index.tsx', '/index.js', '/index.mjs', '/index.cjs'];
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
function resolveRelative(importerId: string, spec: string): string | null {
    const abs = path.resolve(path.dirname(importerId), spec);
    // Only probe the exact path when the specifier already has an extension —
    // `./foo` goes straight to `./foo.ts`, halving the stat count in TS projects.
    if (path.extname(abs) !== '' && isFile(abs)) return abs;
    for (const ext of REL_EXTS) {
        if (isFile(abs + ext)) return abs + ext;
    }
    for (const idx of REL_INDEX) {
        if (isFile(abs + idx)) return abs + idx;
    }
    return null;
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

interface PluginDonor {
    specifier: string;
    path: string;
    code: string;
    resolved: { specifier: string; path: string }[];
}

export interface Options {
    /** Module ids compilecat operates on — its **scope** (picomatch globs and/or
     *  RegExps). Required; there is no implicit default. Both the files that get
     *  transformed *and* the donor modules that may be read+inlined are limited
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
     *  were seen vs optimized, and where wall time went: donor resolve, fs read,
     *  native compile). @default false */
    debug?: boolean;
}

interface PluginStats {
    files: number; // transform() calls (transformable files)
    directiveFiles: number; // files carrying a directive
    skippedNoDirective: number; // returned early (no directive / no donor directive)
    compiledFile: number; // compileFile calls (no donors)
    compiledCross: number; // compileFileCross calls (with donors)
    changed: number; // files actually rewritten
    resolves: number; // this.resolve calls (cache misses)
    resolveCacheHits: number;
    donorReads: number; // fs reads (cache misses)
    donorCacheHits: number;
    edgeScans: number; // donorEdges() parses (cache misses)
    edgeCacheHits: number;
    scanMs: number; // directive/import regex scans
    resolveMs: number; // this.resolve
    readMs: number; // fs.readFileSync donors
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
            `  resolves=${s.resolves} (cacheHits=${s.resolveCacheHits}) donorReads=${s.donorReads} (cacheHits=${s.donorCacheHits}) ` +
            `edgeScans=${s.edgeScans} (cacheHits=${s.edgeCacheHits})\n` +
            `${row('scan (regex)', s.scanMs)}\n${row('resolve', s.resolveMs)}\n` +
            `${row('read donors (fs)', s.readMs)}\n${row('native compile', s.compileMs)}\n` +
            `  ${'TOTAL in transform'.padEnd(20)} ${s.totalMs.toFixed(1).padStart(9)}ms`,
    );
}

// biome-ignore lint/suspicious/noExplicitAny: unplugin/rollup PluginContext is structural
type Ctx = any;

export const unpluginCompilecat = createUnplugin<Options, false>((options, _meta) => {
    const compiler = createCompiler();
    const sourcemap = options.sourcemap ?? true;
    // Scope: which module ids may be transformed and read as donors. `inScope`
    // gates donor reads in JS; the transform filter gates the hook in the bundler
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
              donorReads: 0,
              donorCacheHits: 0,
              edgeScans: 0,
              edgeCacheHits: 0,
              scanMs: 0,
              resolveMs: 0,
              readMs: 0,
              compileMs: 0,
              totalMs: 0,
          }
        : null;

    // Build-scoped caches (the plugin instance lives for the whole build):
    //  - donorCache: read + directive-scan a donor once, not once per consumer.
    //  - consumersByDonor: reverse map donorPath → the files that inlined it.
    //    Inlining removes the import edge, so the module graph no longer carries
    //    donor→consumer; a Vite HMR adapter uses this to invalidate consumers
    //    when a donor changes. `watchChange` also uses it to evict the cache.
    //    `edges` (the core's AST-derived re-export/re-bind specifiers) is memoized
    //    lazily on the entry the first time the BFS needs it, so `donorEdges` PARSES
    //    each donor once per build, not once per consumer that imports it. It rides
    //    on the same entry `watchChange` evicts, so a donor edit recomputes it.
    const donorCache = new Map<string, { code: string; hasDirective: boolean; edges?: string[] }>();
    const consumersByDonor = new Map<string, Set<string>>();
    //  - resolveCache: `this.resolve` is the dominant cost (it walks the bundler's
    //    resolver + plugin pipeline). The same (importer, specifier) pair recurs
    //    constantly — every directive file re-walks the same barrel graph — so
    //    memoize results for the whole build. Keyed `importer\0specifier`.
    const resolveCache = new Map<string, { id: string; external?: boolean } | null>();
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
    const readDonor = (donorPath: string): { code: string; hasDirective: boolean } | null => {
        const hit = donorCache.get(donorPath);
        if (hit) {
            if (stats) stats.donorCacheHits++;
            return hit;
        }
        let code: string;
        const r0 = stats ? performance.now() : 0;
        try {
            code = fs.readFileSync(donorPath, 'utf8');
        } catch {
            return null;
        }
        if (stats) {
            stats.readMs += performance.now() - r0;
            stats.donorReads++;
        }
        const entry = { code, hasDirective: ANY_DIRECTIVE.test(code) };
        donorCache.set(donorPath, entry);
        return entry;
    };
    // The core's AST re-export/re-bind edges for a donor, computed once per build.
    // `donorEdges` parses the donor with oxc, so memoize it on the cache entry —
    // otherwise every consumer importing the same donor re-parses it for the same
    // result. `(donorPath, code)` are the only inputs and both are stable per
    // cached entry (the entry is dropped on change), so the memo is a pure one.
    const donorEdgesFor = (donorPath: string, entry: { code: string; edges?: string[] }): string[] => {
        if (entry.edges !== undefined) {
            if (stats) stats.edgeCacheHits++;
            return entry.edges;
        }
        if (stats) stats.edgeScans++;
        entry.edges = donorEdges(donorPath, entry.code);
        return entry.edges;
    };

    return {
        name: 'compilecat',
        // A changed donor drops from the read cache so the next transform re-reads.
        // Rollup watch re-runs the consumer's transform via `addWatchFile`; a Vite
        // dev adapter additionally invalidates `consumersByDonor[changedId]`.
        watchChange(this: Ctx, changedId: string) {
            donorCache.delete(changedId);
            // A dep's package.json edit can change its `types`/`exports` entry, so the
            // derived type-entry + parsed-package caches must drop too (keys don't
            // include the changed path, so clear both — package.json edits are rare).
            if (changedId.endsWith('package.json')) {
                pkgTypeEntryCache.clear();
                pkgJsonCache.clear();
            }
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
        } finally {
            if (stats) stats.totalMs += performance.now() - t0;
        }
    }

    async function runTransform(this: Ctx, code: string, id: string) {
        const consumerHasDirective = ANY_DIRECTIVE.test(code);
        if (stats && consumerHasDirective) stats.directiveFiles++;

        // Gather donor modules via BFS over the consumer's imports and the
        // re-export edges of each donor (so `export * as vec3 from './vec3'`
        // barrels resolve). The bundler owns resolution; we read raw source
        // and record each resolved edge so the core can follow re-exports by
        // path without re-implementing module resolution. Follow every import;
        // the `inScope` check on the *resolved* path is what keeps the BFS
        // inside `include` (so node_modules outside the scope is never read).
        const byPath = new Map<string, PluginDonor>();
        const seen = new Set<string>();
        // queue items carry the donor that imported them (for edge recording);
        // `null` importer = the consumer itself (no donor to attach the edge to).
        const queue: { specifier: string; importer: PluginDonor | null }[] = [];
        for (const m of code.matchAll(IMPORT_FROM)) {
            const spec = m[1];
            // Relative (first-party) imports are always followed — that's how a
            // `@inline` function in your own src takes effect even when the
            // caller has no directive. Bare/node_modules imports are followed
            // only when the consumer itself opts in (`@optimize`/`@inline`),
            // so node_modules is never trawled from directive-less files.
            if (spec.startsWith('.') || consumerHasDirective) {
                queue.push({ specifier: spec, importer: null });
            }
        }

        // No donor-count cap: the `seen` set visits each resolved module once and
        // `inScope` bounds the frontier, so this terminates on the finite reachable
        // graph — like a bundler, which never silently stops at a magic import count.
        while (queue.length > 0) {
            const { specifier, importer } = queue.shift() as (typeof queue)[number];
            const importerId = importer ? importer.path : id;
            const cacheKey = `${importerId} ${specifier}`;
            let resolved: { id: string; external?: boolean } | null;
            if (resolveCache.has(cacheKey)) {
                if (stats) stats.resolveCacheHits++;
                resolved = resolveCache.get(cacheKey) ?? null;
            } else {
                const rs0 = stats ? performance.now() : 0;
                // Relative imports resolve with a cheap fs probe (≈0.05ms) —
                // the bundler's `this.resolve` (≈5ms, full plugin pipeline) is
                // reserved for bare specifiers, which only directive consumers
                // follow. This keeps the first-party `@inline` scan fast.
                try {
                    if (specifier.startsWith('.')) {
                        const id2 = resolveRelative(importerId, specifier);
                        resolved = id2 ? { id: id2, external: false } : null;
                    } else {
                        resolved = (await this.resolve?.(specifier, importerId)) ?? null;
                    }
                } catch {
                    resolved = null;
                } finally {
                    if (stats) {
                        stats.resolveMs += performance.now() - rs0;
                        stats.resolves++;
                    }
                }
                resolveCache.set(cacheKey, resolved);
            }
            // Skip unresolved, externalized, and out-of-scope donors — the
            // last is what stops node_modules (outside `include`) being read.
            if (!resolved || resolved.external || !inScope(resolved.id)) continue;
            // Record the edge on the importing donor so the core can follow it.
            if (importer) importer.resolved.push({ specifier, path: resolved.id });
            if (seen.has(resolved.id)) continue;
            seen.add(resolved.id);

            const cached = readDonor(resolved.id);
            if (!cached) continue; // unreadable donor — skip
            this.addWatchFile?.(resolved.id);
            const donor: PluginDonor = {
                specifier,
                path: resolved.id,
                code: cached.code,
                resolved: [],
            };
            byPath.set(resolved.id, donor);
            // Follow this donor's edges to find more donors — computed by the core
            // by PARSING (oxc), not regex. `donorEdges` returns every specifier that
            // could surface an inlinable callable: re-export edges (barrels), a
            // re-exported namespace object (`import * as ns from S; export { ns }`),
            // and a re-exported imported binding (`import { set as set$1 } from S;
            // const set = set$1; export { set }` — quat-as-vec4). AST-correct, so it
            // catches minified / multi-declarator / ASI shapes the old regexes missed.
            for (const s of donorEdgesFor(resolved.id, cached)) {
                queue.push({ specifier: s, importer: donor });
            }
        }

        const runtimeDonors = [...byPath.values()];
        // Track which consumer inlined which donor (for HMR invalidation).
        for (const d of runtimeDonors) {
            let set = consumersByDonor.get(d.path);
            if (!set) {
                set = new Set();
                consumersByDonor.set(d.path, set);
            }
            set.add(id);
        }
        const donorHasDirective = runtimeDonors.some((d) => donorCache.get(d.path)?.hasDirective ?? false);
        if (!consumerHasDirective && !donorHasDirective) {
            if (stats) stats.skippedNoDirective++;
            return null;
        }

        // Type-source donors: only a directive consumer runs type-directed passes
        // (SROA, etc.) that need imported shapes, so gather the `.d.ts` surface of
        // the consumer's imports only then (it's fs-cheap and resolve-cached).
        const typeImports = consumerHasDirective ? typeImportSpecifiers(code) : [];
        const typeDonors = typeImports.length > 0 ? await gatherTypeSourceDonors.call(this, id, typeImports) : [];
        const donors = typeDonors.length > 0 ? [...runtimeDonors, ...typeDonors] : runtimeDonors;

        const c0 = stats ? performance.now() : 0;
        const r =
            donors.length > 0
                ? compiler.compileFileCross(id, code, donors, { sourcemap })
                : compiler.compileFile(id, code, { sourcemap });
        if (stats) {
            stats.compileMs += performance.now() - c0;
            if (donors.length > 0) stats.compiledCross++;
            else stats.compiledFile++;
        }
        if (!r.changed) return null;
        if (stats) stats.changed++;
        return { code: r.code, map: r.map };
    }

    // BFS the `.d.ts` type surface of a consumer's type imports so the core can resolve
    // package type aliases. Donors carry `.d.ts` PATHS (the core parses by extension — a
    // `.js` path silently drops the types) plus their resolved re-export edges, so the
    // core follows re-exports without re-resolving modules.
    async function gatherTypeSourceDonors(this: Ctx, consumerId: string, imports: string[]): Promise<PluginDonor[]> {
        const byPath = new Map<string, PluginDonor>();
        const seen = new Set<string>();
        const queue: { specifier: string; importer: PluginDonor | null }[] = imports.map((specifier) => ({
            specifier,
            importer: null,
        }));

        // No cap: `seen` + flat-only following bound this to a package's finite type
        // surface, so it gathers the complete set — never a silently-truncated one.
        while (queue.length > 0) {
            const { specifier, importer } = queue.shift() as (typeof queue)[number];
            const importerId = importer ? importer.path : consumerId;

            let dtsPath: string | null;
            if (specifier.startsWith('.')) {
                // A `.d.ts` re-export like `export * from './x.js'` often names a
                // type-only module with no runtime `.js`, so probe the `.d.ts` directly
                // before falling back to resolving a runtime module + its sibling.
                const abs = path.resolve(path.dirname(importerId), specifier);
                dtsPath = declarationCandidates(abs).find(isFile) ?? null;
                if (!dtsPath) {
                    const rt = resolveRelative(importerId, specifier);
                    dtsPath = rt ? declarationFor(rt) : null;
                }
            } else {
                dtsPath = await resolvePackageTypeEntry.call(this, specifier, importerId);
            }
            if (!dtsPath || !inScope(dtsPath)) continue;
            // Record the edge (by path) so the core follows this re-export to its target.
            if (importer) importer.resolved.push({ specifier, path: dtsPath });
            if (seen.has(dtsPath)) continue;
            seen.add(dtsPath);

            const cached = readDonor(dtsPath);
            if (!cached) continue;
            this.addWatchFile?.(dtsPath);
            const donor: PluginDonor = { specifier, path: dtsPath, code: cached.code, resolved: [] };
            byPath.set(dtsPath, donor);
            for (const m of cached.code.matchAll(EXPORT_FLAT_FROM)) {
                queue.push({ specifier: m[1], importer: donor });
            }
        }

        return [...byPath.values()];
    }

    // Resolve a bare package specifier to its `.d.ts` type entry, in TypeScript's
    // precedence: `exports` map "types" condition → `types`/`typings` field → a
    // sibling `.d.ts` of the resolved runtime entry. Cached per build.
    // Known gap: `@types/<pkg>` (DefinitelyTyped, separate package) is not consulted.
    async function resolvePackageTypeEntry(this: Ctx, specifier: string, importerId: string): Promise<string | null> {
        const key = `${importerId}\0${specifier}`;
        const hit = pkgTypeEntryCache.get(key);
        if (hit !== undefined) {
            // Watch on hits too, so every consumer of this package re-transforms when its
            // `types`/`exports` entry changes (`watchChange` then clears these caches).
            if (hit.pkgJson) this.addWatchFile?.(hit.pkgJson);
            return hit.dts;
        }

        // Node-resolve the runtime entry (shares the runtime resolve cache) — used to
        // locate the package root and as the sibling-`.d.ts` fallback.
        const cacheKey = `${importerId} ${specifier}`;
        let runtimeId: string | null;
        if (resolveCache.has(cacheKey)) {
            if (stats) stats.resolveCacheHits++;
            runtimeId = resolveCache.get(cacheKey)?.id ?? null;
        } else {
            const rs0 = stats ? performance.now() : 0;
            try {
                const r = (await this.resolve?.(specifier, importerId)) ?? null;
                runtimeId = r?.id ?? null;
                resolveCache.set(cacheKey, r);
            } catch {
                runtimeId = null;
            } finally {
                if (stats) {
                    stats.resolveMs += performance.now() - rs0;
                    stats.resolves++;
                }
            }
        }

        const result = resolveTypeEntryFrom(runtimeId, specifier);
        if (result.pkgJson) this.addWatchFile?.(result.pkgJson);
        pkgTypeEntryCache.set(key, result);
        return result.dts;
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
