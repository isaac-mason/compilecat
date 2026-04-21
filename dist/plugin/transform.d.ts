import { type FileCache } from './analyses/fileindex';
import { type FileReader } from './analyses/resolve';
import { generate } from './util/babel';
/**
 * plugin-alt transform — LLVM-inspired optimizer.
 *
 * Pipeline:
 *   parse
 *     → inline (decl+callsite annotations, cross-file via FileCache,
 *               library opt-in)
 *     → simplifier fixpoint (constfold + copyprop + dce)
 *     → unroll (opt-in `@cc-unroll`) — runs before SROA so unrolled constant
 *                                      indices become SROA candidates
 *     → SROA (opt-in `@cc-sroa`)
 *     → simplifier fixpoint again to clean up scalars/literals introduced
 *       by unroll and SROA
 *     → regenerate
 */
export type TransformOptions = {
    sourceMaps?: boolean;
    /** Enable cross-file inlining (relative imports). Requires fileCache. */
    fileCache?: FileCache;
    /** Custom file reader for cross-file. Defaults to disk. */
    fileReader?: FileReader;
    /** Permit library (node_modules) inlining via callsite `@cc-inline`. */
    allowLibraryInline?: boolean;
};
export type TransformResult = {
    code: string;
    map?: ReturnType<typeof generate>['map'];
};
export declare function transform(code: string, absolutePath: string, options?: TransformOptions): TransformResult;
