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
export declare const unplugin: import("unplugin").UnpluginInstance<Options | undefined, boolean>;
