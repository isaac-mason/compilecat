import type { Plugin, StringOrRegExp } from 'rollup';
export type FilterPattern = StringOrRegExp | StringOrRegExp[];
export type Options = {
    /**
     * Enable debug logging.
     * @default false
     */
    debug?: boolean;
};
export type PerFileOptions = Options & {
    /**
     * Permit inlining from `node_modules` when the call site opts in via
     * `/* @inline *​/`. Off by default — library reach must be explicit.
     * @default false
     */
    allowLibraryInline?: boolean;
    /**
     * Restrict transforms to module ids matching these patterns (picomatch
     * glob strings and/or RegExps). Required — there is no project-wide
     * default. Wired through Rollup 4's hook-filter API, so rolldown skips
     * non-matching files in Rust without ever calling into JS.
     */
    include: FilterPattern;
    /**
     * Additional ids to skip on top of `include`.
     */
    exclude?: FilterPattern;
};
export declare function compilecat(options?: Options): Plugin;
export declare function compilecatPerFile(options: PerFileOptions): Plugin;
export default compilecat;
