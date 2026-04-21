import { parse } from '@babel/parser';
import { type FileIndex, indexFile } from './discover';
import { type FileReader, defaultFileReader } from './resolve';

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

export function createFileCache(): FileCache {
    return { entries: new Map() };
}

export function ensureIndexed(
    cache: FileCache,
    absolutePath: string,
    reader: FileReader = defaultFileReader,
): FileIndex | null {
    const existing = cache.entries.get(absolutePath);
    if (existing === 'in-progress') return null;
    if (existing) return existing;

    cache.entries.set(absolutePath, 'in-progress');
    const code = reader(absolutePath);
    if (code === null) {
        cache.entries.delete(absolutePath);
        return null;
    }

    let ast: ReturnType<typeof parse>;
    try {
        ast = parse(code, {
            sourceType: 'module',
            plugins: ['typescript', 'jsx'],
            sourceFilename: absolutePath,
        });
    } catch {
        cache.entries.delete(absolutePath);
        return null;
    }

    const index = indexFile(absolutePath, ast);
    cache.entries.set(absolutePath, index);
    return index;
}

/** Invalidate a single file's cached index (e.g., after on-disk change). */
export function invalidate(cache: FileCache, absolutePath: string): void {
    cache.entries.delete(absolutePath);
}

/** Invalidate the entire cache. */
export function invalidateAll(cache: FileCache): void {
    cache.entries.clear();
}
