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
/** Mirrors the `createCompiler()` seam — one instance per build amortizes any
 *  internal caches (donor parse cache, etc.). */
export declare function createCompiler(): Compiler;
/** Identity reprint (parse → codegen, no passes). Useful for normalizing away
 *  cosmetic formatting differences when comparing outputs. */
export declare function format(id: string, code: string): string;
