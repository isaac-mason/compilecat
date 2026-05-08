import type { FileCache } from './file-index';
import type { FileReader } from './resolve';
export type TransformOptions = {
    sourceMaps?: boolean;
    /** Filename for sourcemap purposes. */
    filename?: string;
    /** Shared cache for cross-file inlining. When omitted, cross-file is off. */
    fileCache?: FileCache;
    /** Custom file reader (defaults to disk). */
    fileReader?: FileReader;
    /** Permit `node_modules` inlining when the call site opts in. */
    allowLibraryInline?: boolean;
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
