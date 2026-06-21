import fs from 'node:fs';
import path from 'node:path';
import { createFilter } from '@rollup/pluginutils';
import { createRequire } from 'node:module';

// Loader + thin typing for the compilecat (oxc/Rust) core built under `rust/`.
//
// The Rust napi crate (`rust/crates/compilecat_napi`) builds to a `.node` addon
// plus a generated `index.js` loader. This module wraps it so the rest of the
// TS plugin imports a stable interface and never touches the build path.
//
// Build it with:
//   cd rust/crates/compilecat_napi && pnpm install && pnpm build
//
// Until then `createCompiler()` throws an actionable error.
const require$1 = createRequire(import.meta.url);
let addon;
// Platforms we ship a native binary for. Anything else falls back to the wasm
// core (@compilecat/core-wasm32-wasi) — correct but slower; we warn once.
const NATIVE_PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']);
function loadAddon() {
    if (addon)
        return addon;
    // The napi-generated loader probes a local `.node` (dev) first, then the
    // published `@compilecat/core-<triple>` platform package, then the wasm
    // fallback. It lives at `dist/core/` in built/installed packages (folded in
    // by `build:loader`), and at `rust/crates/compilecat_napi/` in the source
    // tree (tests, monorepo).
    let lastError;
    for (const p of ['./core/index.js', '../rust/crates/compilecat_napi/index.js']) {
        try {
            addon = require$1(p);
            if (!NATIVE_PLATFORMS.has(`${process.platform}-${process.arch}`)) {
                console.warn(`compilecat: no native binary for ${process.platform}-${process.arch} — ` +
                    'using the slower wasm core.');
            }
            return addon;
        }
        catch (cause) {
            lastError = cause;
        }
    }
    throw new Error('compilecat: core not built/installed. For local dev run `pnpm build`; ' +
        'installed copies resolve a @compilecat/core-<platform> package.\n' +
        `(underlying: ${lastError.message})`);
}
/** Mirrors the `createCompiler()` seam — one instance per build amortizes any
 *  internal caches (donor parse cache, etc.). */
function createCompiler() {
    const { Compiler } = loadAddon();
    return new Compiler();
}

// compilecat's bundler plugin (Rust/oxc core).
//
// Optimizes each source file in the `transform` hook, BEFORE bundling, keeping
// TypeScript. It is **cross-module aware**: when a file imports an `@inline`
// donor, the plugin resolves + reads the donor module (via the bundler's
// resolver + fs) and hands it to the core, which inlines across the module
// boundary and drops the now-unused import. `addWatchFile` keeps HMR correct
// (re-transform the consumer when a donor changes).
//
// Compatible with the rollup plugin shape (rollup / vite / rolldown).
function toArray(v) {
    if (v === undefined)
        return [];
    return Array.isArray(v) ? v : [v];
}
// Inlined so the native plugin doesn't pull the Babel-based compiler modules.
const ANY_DIRECTIVE = /@(?:inline|flatten|sroa|unroll|optimize)\b/;
const TRANSFORMABLE = /\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
// Any `… from "<spec>"` import — relative (`./x`, `../x`) or bare (`pkg`).
const IMPORT_FROM = /import\b[^'"]*?from\s*['"]([^'"]+)['"]/g;
// `export … from "<spec>"` re-export edges (barrels) — followed to find donors.
const EXPORT_FROM = /export\b[^'"]*?from\s*['"]([^'"]+)['"]/g;
// `import * as <ns> from "<spec>"` — a namespace import; followed only when the
// barrel re-exports `<ns>` (the mathcat shape: `import * as vec3 from './vec3';
// export { vec3 }`), so the impl module holding the members is read as a donor.
const NS_IMPORT = /import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g;
// A sourceless `export { … }` clause (ends in `;` or EOL, not `from`).
const EXPORT_CLAUSE = /export\s*\{([^}]*)\}[ \t]*(?:;|$)/gm;
// Whether `code` re-exports the local binding `name` via a sourceless clause.
const reexportsLocal = (code, name) => {
    for (const m of code.matchAll(EXPORT_CLAUSE)) {
        const names = m[1].split(',').map((s) => s
            .trim()
            .split(/\s+as\s+/)[0]
            .trim());
        if (names.includes(name))
            return true;
    }
    return false;
};
// Safety cap on transitive donor modules read per consumer file.
const MAX_DONORS = 200;
// Extensions/index files tried when resolving a relative import ourselves —
// cheap fs probes instead of the bundler's `this.resolve`, which is only needed
// for bare specifiers (aliases, package exports, node_modules layout).
const REL_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const REL_INDEX = ['/index.ts', '/index.tsx', '/index.js', '/index.mjs', '/index.cjs'];
const statCache = new Map();
function isFile(p) {
    const hit = statCache.get(p);
    if (hit !== undefined)
        return hit;
    let ok = false;
    try {
        ok = fs.statSync(p).isFile();
    }
    catch {
        ok = false;
    }
    statCache.set(p, ok);
    return ok;
}
function resolveRelative(importerId, spec) {
    const abs = path.resolve(path.dirname(importerId), spec);
    // Only probe the exact path when the specifier already has an extension —
    // `./foo` goes straight to `./foo.ts`, halving the stat count in TS projects.
    if (path.extname(abs) !== '' && isFile(abs))
        return abs;
    for (const ext of REL_EXTS) {
        if (isFile(abs + ext))
            return abs + ext;
    }
    for (const idx of REL_INDEX) {
        if (isFile(abs + idx))
            return abs + idx;
    }
    return null;
}
function reportStats(s) {
    const row = (label, ms) => `  ${label.padEnd(20)} ${ms.toFixed(1).padStart(9)}ms  ${((ms / Math.max(s.totalMs, 0.001)) * 100).toFixed(1).padStart(5)}%`;
    console.log(`[compilecat-native] ${s.files} files seen, ${s.directiveFiles} with directive, ` +
        `${s.skippedNoDirective} skipped, ${s.compiledFile + s.compiledCross} compiled ` +
        `(${s.compiledCross} cross-file), ${s.changed} changed.\n` +
        `  resolves=${s.resolves} (cacheHits=${s.resolveCacheHits}) donorReads=${s.donorReads} (cacheHits=${s.donorCacheHits})\n` +
        `${row('scan (regex)', s.scanMs)}\n${row('resolve', s.resolveMs)}\n` +
        `${row('read donors (fs)', s.readMs)}\n${row('native compile', s.compileMs)}\n` +
        `  ${'TOTAL in transform'.padEnd(20)} ${s.totalMs.toFixed(1).padStart(9)}ms`);
}
function compilecat(options) {
    const compiler = createCompiler();
    const sourcemap = options.sourcemap ?? true;
    // Scope: which module ids may be transformed and read as donors. `inScope`
    // gates donor reads in JS; `idFilter` gates the transform hook in the bundler
    // (Rust), so out-of-scope files never reach JS at all.
    const inScope = createFilter(options.include, options.exclude);
    const idFilter = {
        include: toArray(options.include),
    };
    const userExclude = toArray(options.exclude);
    if (userExclude.length > 0)
        idFilter.exclude = userExclude;
    const stats = options.debug
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
    const donorCache = new Map();
    const consumersByDonor = new Map();
    //  - resolveCache: `this.resolve` is the dominant cost (it walks the bundler's
    //    resolver + plugin pipeline). The same (importer, specifier) pair recurs
    //    constantly — every directive file re-walks the same barrel graph — so
    //    memoize results for the whole build. Keyed `importer\0specifier`.
    const resolveCache = new Map();
    const readDonor = (donorPath) => {
        const hit = donorCache.get(donorPath);
        if (hit) {
            if (stats)
                stats.donorCacheHits++;
            return hit;
        }
        let code;
        const r0 = stats ? performance.now() : 0;
        try {
            code = fs.readFileSync(donorPath, 'utf8');
        }
        catch {
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
    return {
        name: 'compilecat',
        // A changed donor drops from the read cache so the next transform re-reads.
        // Rollup watch re-runs the consumer's transform via `addWatchFile`; a Vite
        // dev adapter additionally invalidates `consumersByDonor[changedId]`.
        watchChange(changedId) {
            donorCache.delete(changedId);
        },
        closeBundle() {
            if (stats)
                reportStats(stats);
        },
        // Scope the hook in the *bundler* (Rust): rolldown's `filter.id` skips
        // out-of-scope modules without ever calling into JS, so node_modules (and
        // anything outside `include`) costs nothing. Mirrors the OLD per-file
        // plugin's `transform.filter`. No `code` filter here: an in-scope file
        // that calls an in-scope `@inline` function must be processed even when
        // it carries no directive of its own.
        transform: { filter: { id: idFilter }, handler: transformHandler },
    };
    async function transformHandler(code, id) {
        if (!TRANSFORMABLE.test(id))
            return null;
        const t0 = stats ? performance.now() : 0;
        if (stats)
            stats.files++;
        try {
            return await runTransform.call(this, code, id);
        }
        finally {
            if (stats)
                stats.totalMs += performance.now() - t0;
        }
    }
    async function runTransform(code, id) {
        const consumerHasDirective = ANY_DIRECTIVE.test(code);
        if (stats && consumerHasDirective)
            stats.directiveFiles++;
        // Gather donor modules via BFS over the consumer's imports and the
        // re-export edges of each donor (so `export * as vec3 from './vec3'`
        // barrels resolve). The bundler owns resolution; we read raw source
        // and record each resolved edge so the core can follow re-exports by
        // path without re-implementing module resolution. Follow every import;
        // the `inScope` check on the *resolved* path is what keeps the BFS
        // inside `include` (so node_modules outside the scope is never read).
        const byPath = new Map();
        const seen = new Set();
        // queue items carry the donor that imported them (for edge recording);
        // `null` importer = the consumer itself (no donor to attach the edge to).
        const queue = [];
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
        while (queue.length > 0 && byPath.size < MAX_DONORS) {
            const { specifier, importer } = queue.shift();
            const importerId = importer ? importer.path : id;
            const cacheKey = `${importerId} ${specifier}`;
            let resolved;
            if (resolveCache.has(cacheKey)) {
                if (stats)
                    stats.resolveCacheHits++;
                resolved = resolveCache.get(cacheKey) ?? null;
            }
            else {
                const rs0 = stats ? performance.now() : 0;
                // Relative imports resolve with a cheap fs probe (≈0.05ms) —
                // the bundler's `this.resolve` (≈5ms, full plugin pipeline) is
                // reserved for bare specifiers, which only directive consumers
                // follow. This keeps the first-party `@inline` scan fast.
                try {
                    if (specifier.startsWith('.')) {
                        const id2 = resolveRelative(importerId, specifier);
                        resolved = id2 ? { id: id2, external: false } : null;
                    }
                    else {
                        resolved = (await this.resolve?.(specifier, importerId)) ?? null;
                    }
                }
                catch {
                    resolved = null;
                }
                finally {
                    if (stats) {
                        stats.resolveMs += performance.now() - rs0;
                        stats.resolves++;
                    }
                }
                resolveCache.set(cacheKey, resolved);
            }
            // Skip unresolved, externalized, and out-of-scope donors — the
            // last is what stops node_modules (outside `include`) being read.
            if (!resolved || resolved.external || !inScope(resolved.id))
                continue;
            // Record the edge on the importing donor so the core can follow it.
            if (importer)
                importer.resolved.push({ specifier, path: resolved.id });
            if (seen.has(resolved.id))
                continue;
            seen.add(resolved.id);
            const cached = readDonor(resolved.id);
            if (!cached)
                continue; // unreadable donor — skip
            this.addWatchFile?.(resolved.id);
            const donor = {
                specifier,
                path: resolved.id,
                code: cached.code,
                resolved: [],
            };
            byPath.set(resolved.id, donor);
            // Follow this donor's re-export edges (barrels) to find more donors.
            for (const m of cached.code.matchAll(EXPORT_FROM)) {
                queue.push({ specifier: m[1], importer: donor });
            }
            // …and `import * as ns from S; export { ns }` — a re-exported
            // namespace object (mathcat's barrel): S holds its members.
            for (const m of cached.code.matchAll(NS_IMPORT)) {
                if (reexportsLocal(cached.code, m[1])) {
                    queue.push({ specifier: m[2], importer: donor });
                }
            }
        }
        const donors = [...byPath.values()];
        // Track which consumer inlined which donor (for HMR invalidation).
        for (const d of donors) {
            let set = consumersByDonor.get(d.path);
            if (!set) {
                set = new Set();
                consumersByDonor.set(d.path, set);
            }
            set.add(id);
        }
        const donorHasDirective = donors.some((d) => donorCache.get(d.path)?.hasDirective ?? false);
        if (!consumerHasDirective && !donorHasDirective) {
            if (stats)
                stats.skippedNoDirective++;
            return null;
        }
        const c0 = stats ? performance.now() : 0;
        const r = donors.length > 0
            ? compiler.compileFileCross(id, code, donors, { sourcemap })
            : compiler.compileFile(id, code, { sourcemap });
        if (stats) {
            stats.compileMs += performance.now() - c0;
            if (donors.length > 0)
                stats.compiledCross++;
            else
                stats.compiledFile++;
        }
        if (!r.changed)
            return null;
        if (stats)
            stats.changed++;
        return { code: r.code, map: r.map };
    }
}

export { compilecat, compilecat as default };
//# sourceMappingURL=index.js.map
