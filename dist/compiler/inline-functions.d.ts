import * as t from '@babel/types';
import { type FileCache } from './file-index';
import { type FileReader } from './resolve';
export type InlineResult = {
    /** Number of distinct candidates that were resolved at least once. */
    inlined: number;
    /** Call sites attempted (DIRECT or BLOCK). */
    calls: number;
    /** Call sites where injection succeeded. */
    succeeded: number;
    /** Donor file paths whose bodies were spliced into the consumer. PerFile
     *  callers use these to register watchers (e.g. `this.addWatchFile`) so
     *  consumers re-transform when a donor changes. Empty in WholeProgram. */
    donorPaths: Set<string>;
};
export type InlineOptions = {
    /** Absolute path of the consumer file. Required to enable cross-file. */
    consumerPath?: string;
    /** Shared cache for parsed donor files. Required to enable cross-file. */
    fileCache?: FileCache;
    /** File reader; defaults to disk. */
    fileReader?: FileReader;
    /** Permit inlining from `node_modules` when the call site opts in. */
    allowLibraryInline?: boolean;
    /** Set populated with every enclosing function of a successful inline. */
    touched?: WeakSet<t.Function>;
};
export declare function inlineFunctions(root: t.Node, options?: InlineOptions): InlineResult;
