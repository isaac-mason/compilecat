import { type FileReader } from './analyses/resolve';
export type Options = {
    /**
     * Enable debug logging to help diagnose issues.
     * @default false
     */
    debug?: boolean;
    /**
     * Resolve `@cc-inline` functions imported from other source files.
     * @default true
     */
    crossFile?: boolean;
    /**
     * Allow inlining functions imported from `node_modules` packages, but only
     * at call sites that explicitly opt in via `/* @cc-inline *​/`. We never
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
export declare const unplugin: import("unplugin").UnpluginInstance<Options | undefined, boolean>;
