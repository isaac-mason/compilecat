import { createUnplugin, type UnpluginFactory } from 'unplugin';

import { ANY_DIRECTIVE_IN_SOURCE } from './compiler/directives';
import { createFileCache } from './compiler/file-index';
import { transform } from './compiler/pipeline';
import type { FileReader } from './compiler/resolve';

export type Options = {
    /**
     * Enable debug logging.
     * @default false
     */
    debug?: boolean;
    include?: string | RegExp | (string | RegExp)[];
    exclude?: string | RegExp | (string | RegExp)[];
    /**
     * Enable cross-file inlining (relative imports). On by default.
     * @default true
     */
    crossFile?: boolean;
    /**
     * Permit inlining from `node_modules` when the call site opts in via
     * `/* @inline *​/`. Off by default — library reach must be explicit.
     * @default false
     */
    libraryInline?: boolean;
    /**
     * Custom file reader for cross-file (defaults to disk).
     */
    fileReader?: FileReader;
};

const factory: UnpluginFactory<Options | undefined> = (options = {}) => {
    const debug = options.debug === true;
    const crossFile = options.crossFile !== false;
    const libraryInline = options.libraryInline === true;
    // One FileCache per build amortizes parse + index across consumer files.
    const fileCache = crossFile ? createFileCache() : undefined;
    return {
        name: 'compilecat',
        transform(code: string, id: string) {
            if (!/\.(js|ts|jsx|tsx)$/.test(id)) return null;
            if (!ANY_DIRECTIVE_IN_SOURCE.test(code)) return null;

            if (debug) console.log(`[compilecat] transforming ${id}`);

            try {
                const r = transform(code, {
                    sourceMaps: true,
                    filename: id,
                    fileCache,
                    fileReader: options.fileReader,
                    allowLibraryInline: libraryInline,
                });
                if (debug) {
                    console.log(
                        `[compilecat] ${id}: inlined=${r.stats.inlined} folded=${r.stats.folded} dead=${r.stats.removedDeadCode}`,
                    );
                }
                return { code: r.code, map: r.map };
            } catch (err) {
                console.error(`[compilecat] failed to transform ${id}:`, err);
                return null;
            }
        },
    };
};

export const unplugin = createUnplugin(factory);
