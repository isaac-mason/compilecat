import { type FileIndex } from './discover';
import { type FileReader } from './resolve';
/**
 * Lazy, cached cross-file indexing.
 *
 * - `createFileCache()` returns a mutable cache; hold onto it across multiple
 *   `transform` calls to amortize parse/index cost.
 * - `ensureIndexed(cache, path, reader)` parses and indexes the file if not
 *   already present, then returns the index. Returns `null` if the file can't
 *   be read (treat as "not our problem" — the consumer skips it).
 * - A cycle-guard sentinel (`'in-progress'`) prevents infinite recursion when
 *   A imports B imports A and the graph walker tries to re-enter mid-flight.
 */
export type FileCache = {
    entries: Map<string, FileIndex | 'in-progress'>;
};
export declare function createFileCache(): FileCache;
export declare function ensureIndexed(cache: FileCache, absolutePath: string, reader?: FileReader): FileIndex | null;
/** Invalidate a single file's cached index (e.g., after on-disk change). */
export declare function invalidate(cache: FileCache, absolutePath: string): void;
/** Invalidate the entire cache. */
export declare function invalidateAll(cache: FileCache): void;
