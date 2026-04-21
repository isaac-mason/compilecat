import { parse } from '@babel/parser';
import { type FileCache } from './analyses/fileindex';
import { type FileReader } from './analyses/resolve';
import { initSimplifier, runSimplifier } from './pipeline';
import { applyInline } from './transforms/inline';
import { applySroa } from './transforms/sroa';
import { applyUnroll } from './transforms/unroll';
import { generate } from './util/babel';

/**
 * plugin-alt transform — LLVM-inspired optimizer.
 *
 * Pipeline:
 *   parse
 *     → inline (decl+callsite annotations, cross-file via FileCache,
 *               library opt-in)
 *     → simplifier fixpoint (constfold + copyprop + dce)
 *     → unroll (opt-in `@unroll`) — runs before SROA so unrolled constant
 *                                      indices become SROA candidates
 *     → SROA (opt-in `@sroa`)
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
    /** Permit library (node_modules) inlining via callsite `@inline`. */
    allowLibraryInline?: boolean;
};

export type TransformResult = {
    code: string;
    map?: ReturnType<typeof generate>['map'];
};

export function transform(
    code: string,
    absolutePath: string,
    options: TransformOptions = {},
): TransformResult {
    const ast = parse(code, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
        sourceFilename: absolutePath,
    });

    const state = initSimplifier();

    applyInline(ast, absolutePath, {
        effects: state.effects,
        zones: state.zones,
        fileCache: options.fileCache,
        fileReader: options.fileReader,
        allowLibraryInline: options.allowLibraryInline,
    });

    runSimplifier(ast, state);

    const unrolled = applyUnroll(ast);
    const sroaed = applySroa(ast);
    if (unrolled || sroaed) {
        runSimplifier(ast, state);
    }

    const result = generate(ast, {
        sourceMaps: options.sourceMaps ?? false,
        sourceFileName: absolutePath,
    });

    return { code: result.code, map: result.map ?? undefined };
}
