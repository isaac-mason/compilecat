export type TransformOptions = {
    sourceMaps?: boolean;
    /** Filename for sourcemap purposes. */
    filename?: string;
    /** Incoming source map to chain through (e.g. from rollup's chunk). */
    inputSourceMap?: unknown;
};
export type TransformResult = {
    code: string;
    map: any;
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
};
export declare function transform(code: string, options?: TransformOptions): TransformResult;
