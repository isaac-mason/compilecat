import { createUnplugin } from 'unplugin';
import { createFileCache } from './analyses/fileindex';
import { ANY_DIRECTIVE_IN_SOURCE } from './analyses/directives';
import { defaultFileReader, type FileReader } from './analyses/resolve';
import { transform as runTransform } from './transform';

export type Options = {
    /**
     * Enable debug logging to help diagnose issues.
     * @default false
     */
    debug?: boolean;

    /**
     * Resolve `@inline` functions imported from other source files.
     * @default true
     */
    crossFile?: boolean;

    /**
     * Allow inlining functions imported from `node_modules` packages, but only
     * at call sites that explicitly opt in via `/* @inline *​/`. We never
     * eagerly scan node_modules.
     * @default true
     */
    libraryInline?: boolean;

    /**
     * Override the file reader used for cross-file resolution. Defaults to
     * reading from disk via `node:fs`.
     */
    fileReader?: FileReader;
};

export const unplugin = createUnplugin<Options | undefined>((options = {}) => {
    const {
        debug = false,
        crossFile = true,
        libraryInline = true,
        fileReader = defaultFileReader,
    } = options;

    // Single cache shared across all files transformed in one build instance.
    const fileCache = createFileCache();

    return {
        name: 'compilecat',

        transform(code: string, id: string) {
            if (!/\.(js|ts|jsx|tsx)$/.test(id)) return null;

            // Skip files with no `@*` markers. Avoids unnecessary babel
            // codegen round-trips that can break downstream TS parsers.
            if (!ANY_DIRECTIVE_IN_SOURCE.test(code)) return null;

            if (debug) console.log(`[compilecat] Transforming ${id}`);

            try {
                const { code: out, map } = runTransform(code, id, {
                    sourceMaps: true,
                    fileCache: crossFile ? fileCache : undefined,
                    fileReader,
                    allowLibraryInline: libraryInline,
                });
                if (debug) {
                    console.log(`[compilecat] Output for ${id}:\n${out}`);
                }
                return { code: out, map };
            } catch (error) {
                console.error(`[compilecat] Failed to transform ${id}:`, error);
                return null;
            }
        },
    };
});
