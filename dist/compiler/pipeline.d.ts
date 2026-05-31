import type { FileCache } from './file-index';
import type { FileReader } from './resolve';
import { type SimplifyTimings } from './simplifier';
export declare const Mode: {
    readonly PerFile: 0;
    readonly WholeProgram: 1;
};
export type Mode = (typeof Mode)[keyof typeof Mode];
export type TransformOptions = {
    sourceMaps?: boolean;
    /** Filename for sourcemap purposes. In PerFile mode this is also the
     *  consumer path used by the cross-file resolver. */
    filename?: string;
    /** Incoming source map to chain through (e.g. from rollup's chunk). */
    inputSourceMap?: unknown;
    /** Optimization unit being processed. Defaults to WholeProgram. */
    mode?: Mode;
    /** Shared cache for parsed donor files. Required (with PerFile mode) to
     *  enable cross-file inlining. Ignored in WholeProgram mode. */
    fileCache?: FileCache;
    /** File reader; defaults to disk. */
    fileReader?: FileReader;
    /** Permit inlining from `node_modules` when the call site opts in. */
    allowLibraryInline?: boolean;
};
export type TransformResult = {
    code: string;
    map: any;
    /** Donor files whose bodies were spliced in. Empty unless PerFile mode
     *  with cross-file context. PerFile plugin callers use this to register
     *  watchers (`this.addWatchFile`) so consumers re-transform on donor
     *  changes. */
    donorPaths: Set<string>;
    stats: {
        inlined: number;
        unrolled: number;
        sroad: number;
        folded: number;
        removedDeadCode: number;
        flowInlined: number;
        deadAssigns: number;
        minimized: number;
        inlinedVariables: number;
        removedDeclarators: number;
        removedFunctionDecls: number;
        removedImportSpecifiers: number;
        removedImportDeclarations: number;
    };
    /** Wall-clock ms per phase. Always populated; the cost is a handful of
     *  `performance.now()` calls per transform. */
    timings: Timings;
    /** Per-sub-pass breakdown of the `simplify` phase, summed across every
     *  simplified function and fixpoint iteration. */
    simplifyTimings: SimplifyTimings;
};
export type Timings = {
    parse: number;
    stripTypeScript: number;
    normalize: number;
    inlineFunctions: number;
    unrollLoops: number;
    inlineVariablesPre: number;
    sroa: number;
    simplify: number;
    inlineVariablesPost: number;
    removeUnusedCode: number;
    stripDirectiveComments: number;
    generate: number;
    total: number;
};
export declare function transform(code: string, options?: TransformOptions): TransformResult;
