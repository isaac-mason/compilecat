import * as t from '@babel/types';
import { type FileCache } from './file-index';
import { type FileReader } from './resolve';
export type InlineResult = {
    /** Callees that were resolved at least once. */
    inlined: number;
    /** Call sites attempted (DIRECT or BLOCK). */
    calls: number;
    /** Call sites where injection succeeded. */
    succeeded: number;
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
};
export declare function inlineFunctions(root: t.Node, options?: InlineOptions): InlineResult;
