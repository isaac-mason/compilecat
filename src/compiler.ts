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

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type CompileOptions = {
    sourcemap?: boolean;
    allowLibraryInline?: boolean;
};

/** Per-pass optimization counts — mirrors `compilecat_core::Stats`. */
export type CompileStats = {
    inlined: number;
    unrolled: number;
    sroa: number;
    folded: number;
    removedDeadCode: number;
    flowInlined: number;
    deadAssigns: number;
    minimized: number;
    inlinedVariables: number;
    stripped: number;
};

export type CompileResult = {
    code: string;
    map: any;
    changed: boolean;
    stats: CompileStats;
};

export type ResolvedEdge = {
    specifier: string;
    path: string;
};

export type Dependency = {
    specifier: string;
    /** The dependency's own resolved path — lets the core rebase the dependency's relative
     *  imports when forwarding them into the consumer, and match it as a
     *  re-export target. */
    path: string;
    code: string;
    /** Resolved `… from '<specifier>'` edges of this dependency (specifier → path),
     *  so the core can follow re-export barrels without resolving modules. */
    resolved: ResolvedEdge[];
};

/** One module edge the host still needs but that isn't reachable within the
 *  dependencies gathered so far — the demand-driven counterpart to a `Dependency`.
 *  The plugin resolves `specifier` relative to `fromPath` (as a runtime module
 *  for `kind: "value"`, a type module for `kind: "type"`), reads it, adds it as a
 *  dependency, and calls `resolutionFrontier` again until the frontier is empty. */
export type FrontierRequest = {
    specifier: string;
    fromPath: string;
    /** `"value"` (runtime `.js`) or `"type"` (`.d.ts`). */
    kind: string;
};

export type Compiler = {
    compileFile(id: string, code: string, options?: CompileOptions): CompileResult;
    compileChunk(id: string, code: string, options?: CompileOptions): CompileResult;
    /** Cross-module: inline `@inline` dependencies the consumer imports. */
    compileFileCross(id: string, code: string, dependencies: Dependency[], options?: CompileOptions): CompileResult;
    /** Run a single named pass in isolation. Null for an unknown pass. */
    runPass(name: string, id: string, code: string): CompileResult | null;
};

type Addon = {
    Compiler: new () => Compiler;
    format: (id: string, code: string) => string;
    /** The specifiers the dependency BFS should follow from ONE module — the AST-based
     *  replacement for the plugin's dependency-edge regexes. `id` (the dependency's path)
     *  picks the source type; returns a dedup'd, order-stable specifier list. */
    dependencyEdges: (id: string, code: string) => string[];
    /** The module edges the host still needs given the dependencies gathered so far —
     *  the demand-driven dependency-gather fixpoint's "what's still missing?" query.
     *  `inlineDefNames` is the build-start index of first-party `@inline`-def names;
     *  a host that CALLS one gathers its module even with no directive of its own. */
    resolutionFrontier: (id: string, code: string, provided: Dependency[], inlineDefNames: string[]) => FrontierRequest[];
};

let addon: Addon | undefined;

// Platforms we ship a native binary for. Anything else falls back to the wasm
// core (@compilecat/core-wasm32-wasi) — correct but slower; we warn once.
const NATIVE_PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']);

function loadAddon(): Addon {
    if (addon) return addon;
    // The napi-generated loader probes a local `.node` (dev) first, then the
    // published `@compilecat/core-<triple>` platform package, then the wasm
    // fallback. It lives at `dist/core/` in built/installed packages (folded in
    // by `build:loader`), and at `rust/crates/compilecat_napi/` in the source
    // tree (tests, monorepo).
    let lastError: unknown;
    for (const p of ['./core/index.js', '../rust/crates/compilecat_napi/index.js']) {
        try {
            addon = require(p) as Addon;
            if (!NATIVE_PLATFORMS.has(`${process.platform}-${process.arch}`)) {
                console.warn(
                    `compilecat: no native binary for ${process.platform}-${process.arch} — ` + 'using the slower wasm core.',
                );
            }
            return addon;
        } catch (cause) {
            lastError = cause;
        }
    }
    throw new Error(
        'compilecat: core not built/installed. For local dev run `pnpm build`; ' +
            'installed copies resolve a @compilecat/core-<platform> package.\n' +
            `(underlying: ${(lastError as Error).message})`,
    );
}

/** Mirrors the `createCompiler()` seam — one instance per build amortizes any
 *  internal caches (dependency parse cache, etc.). */
export function createCompiler(): Compiler {
    const { Compiler } = loadAddon();
    return new Compiler();
}

/** Identity reprint (parse → codegen, no passes). Useful for normalizing away
 *  cosmetic formatting differences when comparing outputs. */
export function format(id: string, code: string): string {
    return loadAddon().format(id, code);
}

/** The specifiers the dependency BFS should follow from ONE module (`id` = the dependency's
 *  path, `code` = its source) — the AST-based replacement for the plugin's brittle
 *  dependency-edge regexes. Returns a dedup'd, order-stable list of import/re-export
 *  specifiers to read as further dependencies. */
export function dependencyEdges(id: string, code: string): string[] {
    return loadAddon().dependencyEdges(id, code);
}

/** The module edges the host still needs given the dependencies gathered so far — the
 *  demand-driven dependency-gather fixpoint's "what's still missing?" query. STATELESS:
 *  the plugin calls this with a growing `provided` set until it returns `[]`, then
 *  hands the assembled set to `compileFileCross`. A directive-less host → `[]`, unless
 *  it calls a first-party `@inline`-def name in `inlineDefNames` (the build-start index),
 *  in which case that def's defining module is gathered so the call can be inlined. */
export function resolutionFrontier(
    id: string,
    code: string,
    provided: Dependency[],
    inlineDefNames: string[],
): FrontierRequest[] {
    return loadAddon().resolutionFrontier(id, code, provided, inlineDefNames);
}
