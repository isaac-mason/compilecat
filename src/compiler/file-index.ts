// Lazy, cached cross-file indexing.
//
//   - createFileCache() returns a mutable cache; share across multiple
//     transform calls in one build to amortize parse/index cost.
//   - ensureIndexed(cache, path, reader) parses + indexes if not cached and
//     returns the index. null when the file can't be read or parsed.
//   - Cycle-guard sentinel ('in-progress') breaks A→B→A recursion.

import { parse } from '@babel/parser';

import { type FileIndex, indexFile } from './discover';
import { type FileReader, defaultFileReader } from './resolve';

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

export function invalidate(cache: FileCache, absolutePath: string): void {
    cache.entries.delete(absolutePath);
}

export function invalidateAll(cache: FileCache): void {
    cache.entries.clear();
}
