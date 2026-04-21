/**
 * Path resolution for cross-file inlining.
 *
 * Two modes, with different rules:
 *   - Same-project (relative + absolute paths): `./vec3`, `../util`, `/abs`.
 *     Always allowed. Probes extensions and index files.
 *   - Library (bare specifier): `lodash`, `@scope/pkg/sub`.
 *     Only consulted when the callsite explicitly opts in via `/* @cc-inline *​/`.
 *     Walks up `node_modules`, honors package.json `exports` / `main` / `module`.
 *
 * A `FileReader` abstraction lets tests inject virtual filesystems without
 * touching disk. Library resolution reads package.json directly from disk
 * because probing `node_modules` dynamically through a virtual reader is
 * awkward; library use-cases are real-world only.
 */
export type FileReader = (absolutePath: string) => string | null;
export declare const defaultFileReader: FileReader;
/**
 * Resolve a relative or absolute import specifier to a filesystem path.
 * Returns null for bare specifiers (those are library imports).
 */
export declare function resolveRelativeImport(fromFile: string, specifier: string, reader?: FileReader): string | null;
/**
 * Resolve a bare specifier (`lodash`, `@scope/pkg/sub`) to a filesystem path.
 * Returns null if the package can't be found or the subpath doesn't resolve.
 *
 * Library resolution reads package.json from disk; tests use real tmpdirs
 * because mocking node_modules through a virtual reader is impractical.
 */
export declare function resolveLibraryImport(fromFile: string, specifier: string): string | null;
/**
 * Unified resolver. Tries relative first, then library only if permitted.
 * `allowLibrary` gates node_modules inlining — pass `true` only when the
 * callsite has an explicit `@cc-inline` annotation.
 *
 * `reader`, if given, is used for relative-import existence checks so virtual
 * filesystems work. Library resolution always goes to disk.
 */
export declare function resolveImportSource(fromFile: string, specifier: string, allowLibrary: boolean, reader?: FileReader): string | null;
