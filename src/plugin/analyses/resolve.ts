import * as fs from 'node:fs';
import * as nodePath from 'node:path';

/**
 * Path resolution for cross-file inlining.
 *
 * Two modes, with different rules:
 *   - Same-project (relative + absolute paths): `./vec3`, `../util`, `/abs`.
 *     Always allowed. Probes extensions and index files.
 *   - Library (bare specifier): `lodash`, `@scope/pkg/sub`.
 *     Only consulted when the callsite explicitly opts in via `/* @inline *​/`.
 *     Walks up `node_modules`, honors package.json `exports` / `main` / `module`.
 *
 * A `FileReader` abstraction lets tests inject virtual filesystems without
 * touching disk. Library resolution reads package.json directly from disk
 * because probing `node_modules` dynamically through a virtual reader is
 * awkward; library use-cases are real-world only.
 */

export type FileReader = (absolutePath: string) => string | null;

export const defaultFileReader: FileReader = (absolutePath) => {
    try {
        return fs.readFileSync(absolutePath, 'utf-8');
    } catch {
        return null;
    }
};

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

type ExistsFn = (path: string) => boolean;

/** Disk-backed existence check using statSync. */
function diskExists(path: string): boolean {
    try {
        return fs.statSync(path).isFile();
    } catch {
        return false;
    }
}

/**
 * Build an existence predicate from a FileReader. When no reader is given we
 * fall back to statSync (cheap, no file-read). With a reader we call it and
 * treat a non-null return as "exists" — this is how tests with a virtual
 * filesystem get relative-resolution to work.
 */
function makeExists(reader: FileReader | undefined): ExistsFn {
    if (!reader) return diskExists;
    return (path) => reader(path) !== null;
}

/** Try `base`, then each `base + ext`, then `base/index.ext`. */
function probeWithExtensions(base: string, exists: ExistsFn): string | null {
    if (exists(base)) return base;
    for (const ext of SOURCE_EXTENSIONS) {
        if (exists(base + ext)) return base + ext;
    }
    for (const ext of SOURCE_EXTENSIONS) {
        const p = nodePath.join(base, `index${ext}`);
        if (exists(p)) return p;
    }
    return null;
}

/**
 * Resolve a relative or absolute import specifier to a filesystem path.
 * Returns null for bare specifiers (those are library imports).
 */
export function resolveRelativeImport(
    fromFile: string,
    specifier: string,
    reader?: FileReader,
): string | null {
    if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) {
        return null;
    }
    const base = nodePath.isAbsolute(specifier)
        ? specifier
        : nodePath.resolve(nodePath.dirname(fromFile), specifier);
    return probeWithExtensions(base, makeExists(reader));
}

/**
 * Split a bare specifier into (package name, subpath).
 *   `lodash`           → ['lodash', '.']
 *   `lodash/get`       → ['lodash', './get']
 *   `@scope/pkg`       → ['@scope/pkg', '.']
 *   `@scope/pkg/sub`   → ['@scope/pkg', './sub']
 */
function splitBareSpecifier(specifier: string): [string, string] {
    if (specifier.startsWith('@')) {
        const parts = specifier.split('/');
        if (parts.length < 2) return [specifier, '.'];
        const name = `${parts[0]}/${parts[1]}`;
        const sub = parts.length > 2 ? './' + parts.slice(2).join('/') : '.';
        return [name, sub];
    }
    const idx = specifier.indexOf('/');
    if (idx < 0) return [specifier, '.'];
    return [specifier.slice(0, idx), './' + specifier.slice(idx + 1)];
}

/** Walk up from a dir looking for `node_modules/<pkg>`. */
function findPackageRoot(fromDir: string, pkgName: string): string | null {
    let dir = fromDir;
    for (;;) {
        const candidate = nodePath.join(dir, 'node_modules', pkgName);
        if (diskExists(nodePath.join(candidate, 'package.json'))) {
            return candidate;
        }
        const parent = nodePath.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

type Pkg = {
    main?: string;
    module?: string;
    exports?: unknown;
};

function readPackageJson(pkgRoot: string): Pkg | null {
    try {
        const raw = fs.readFileSync(nodePath.join(pkgRoot, 'package.json'), 'utf-8');
        return JSON.parse(raw) as Pkg;
    } catch {
        return null;
    }
}

const EXPORT_CONDITIONS = ['import', 'module', 'default', 'require'];

/**
 * Resolve a subpath through package.json `exports`. We only handle what
 * real code actually uses: a string target, or a conditions object with the
 * standard conditions. Nested condition objects recurse.
 */
function resolveThroughExports(exportsField: unknown, subpath: string): string | null {
    if (!exportsField || typeof exportsField !== 'object') return null;
    const exps = exportsField as Record<string, unknown>;

    // shorthand: `"exports": "./dist/index.js"` — only valid for subpath '.'
    if (typeof exportsField === 'string') {
        return subpath === '.' ? (exportsField as string) : null;
    }

    const directKey = subpath === '.' ? '.' : subpath;
    const entry = exps[directKey];
    if (entry === undefined) return null;
    return resolveConditionEntry(entry);
}

function resolveConditionEntry(entry: unknown): string | null {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return null;
    const obj = entry as Record<string, unknown>;
    for (const cond of EXPORT_CONDITIONS) {
        if (cond in obj) {
            const resolved = resolveConditionEntry(obj[cond]);
            if (resolved) return resolved;
        }
    }
    return null;
}

/**
 * Resolve a bare specifier (`lodash`, `@scope/pkg/sub`) to a filesystem path.
 * Returns null if the package can't be found or the subpath doesn't resolve.
 *
 * Library resolution reads package.json from disk; tests use real tmpdirs
 * because mocking node_modules through a virtual reader is impractical.
 */
export function resolveLibraryImport(
    fromFile: string,
    specifier: string,
): string | null {
    const [pkgName, subpath] = splitBareSpecifier(specifier);
    const pkgRoot = findPackageRoot(nodePath.dirname(fromFile), pkgName);
    if (!pkgRoot) return null;
    const pkg = readPackageJson(pkgRoot);
    if (!pkg) return null;

    const diskExistsFn: ExistsFn = diskExists;

    // exports field first
    const exportTarget = resolveThroughExports(pkg.exports, subpath);
    if (exportTarget) {
        return probeWithExtensions(nodePath.join(pkgRoot, exportTarget), diskExistsFn);
    }

    // fall back to main / module for root subpath
    if (subpath === '.') {
        const target = pkg.module ?? pkg.main;
        if (target) return probeWithExtensions(nodePath.join(pkgRoot, target), diskExistsFn);
        return probeWithExtensions(nodePath.join(pkgRoot, 'index'), diskExistsFn);
    }

    // non-root subpath without exports: probe directly
    return probeWithExtensions(nodePath.join(pkgRoot, subpath), diskExistsFn);
}

/**
 * Unified resolver. Tries relative first, then library only if permitted.
 * `allowLibrary` gates node_modules inlining — pass `true` only when the
 * callsite has an explicit `@inline` annotation.
 *
 * `reader`, if given, is used for relative-import existence checks so virtual
 * filesystems work. Library resolution always goes to disk.
 */
export function resolveImportSource(
    fromFile: string,
    specifier: string,
    allowLibrary: boolean,
    reader?: FileReader,
): string | null {
    const rel = resolveRelativeImport(fromFile, specifier, reader);
    if (rel) return rel;
    if (allowLibrary) return resolveLibraryImport(fromFile, specifier);
    return null;
}
