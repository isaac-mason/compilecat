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

export type DonorModule = {
    specifier: string;
    /** The donor's own resolved path — lets the core rebase the donor's relative
     *  imports when forwarding them into the consumer, and match it as a
     *  re-export target. */
    path: string;
    code: string;
    /** Resolved `… from '<specifier>'` edges of this donor (specifier → path),
     *  so the core can follow re-export barrels without resolving modules. */
    resolved: ResolvedEdge[];
};

export type Compiler = {
    compileFile(id: string, code: string, options?: CompileOptions): CompileResult;
    compileChunk(id: string, code: string, options?: CompileOptions): CompileResult;
    /** Cross-module: inline `@inline` donors the consumer imports. */
    compileFileCross(id: string, code: string, donors: DonorModule[], options?: CompileOptions): CompileResult;
    /** Run a single named pass in isolation. Null for an unknown pass. */
    runPass(name: string, id: string, code: string): CompileResult | null;
};

type Addon = {
    Compiler: new () => Compiler;
    format: (id: string, code: string) => string;
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
 *  internal caches (donor parse cache, etc.). */
export function createCompiler(): Compiler {
    const { Compiler } = loadAddon();
    return new Compiler();
}

/** Identity reprint (parse → codegen, no passes). Useful for normalizing away
 *  cosmetic formatting differences when comparing outputs. */
export function format(id: string, code: string): string {
    return loadAddon().format(id, code);
}
