import { type FileIndex } from './discover';
import { type FileReader } from './resolve';
export type FileCache = {
    entries: Map<string, FileIndex | 'in-progress'>;
};
export declare function createFileCache(): FileCache;
export declare function ensureIndexed(cache: FileCache, absolutePath: string, reader?: FileReader): FileIndex | null;
export declare function invalidate(cache: FileCache, absolutePath: string): void;
export declare function invalidateAll(cache: FileCache): void;
