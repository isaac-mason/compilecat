// Path resolution for cross-file inlining.
//
// Two modes:
//   - Same-project (relative + absolute paths). Always allowed; probes
//     extensions and index files.
//   - Library (bare specifier `lodash`, `@scope/pkg/sub`). Only consulted
//     when the call site explicitly opts in via `/* @inline */`. Walks up
//     `node_modules`, honors package.json `exports` / `main` / `module`.
//
// FileReader abstraction lets tests inject a virtual filesystem. Library
// resolution always reads package.json directly from disk.

import * as fs from 'node:fs';
import * as nodePath from 'node:path';

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

function diskExists(path: string): boolean {
    try {
        return fs.statSync(path).isFile();
    } catch {
        return false;
    }
}

function makeExists(reader: FileReader | undefined): ExistsFn {
    if (!reader) return diskExists;
    return (path) => reader(path) !== null;
}

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

export function resolveRelativeImport(
    fromFile: string,
    specifier: string,
    reader?: FileReader,
): string | null {
    if (
        !specifier.startsWith('./') &&
        !specifier.startsWith('../') &&
        !specifier.startsWith('/')
    ) {
        return null;
    }
    const base = nodePath.isAbsolute(specifier)
        ? specifier
        : nodePath.resolve(nodePath.dirname(fromFile), specifier);
    return probeWithExtensions(base, makeExists(reader));
}

function splitBareSpecifier(specifier: string): [string, string] {
    if (specifier.startsWith('@')) {
        const parts = specifier.split('/');
        if (parts.length < 2) return [specifier, '.'];
        const name = `${parts[0]}/${parts[1]}`;
        const sub = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.';
        return [name, sub];
    }
    const idx = specifier.indexOf('/');
    if (idx < 0) return [specifier, '.'];
    return [specifier.slice(0, idx), `./${specifier.slice(idx + 1)}`];
}

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

function resolveThroughExports(exportsField: unknown, subpath: string): string | null {
    if (!exportsField || typeof exportsField !== 'object') return null;
    const exps = exportsField as Record<string, unknown>;

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

export function resolveLibraryImport(fromFile: string, specifier: string): string | null {
    const [pkgName, subpath] = splitBareSpecifier(specifier);
    const pkgRoot = findPackageRoot(nodePath.dirname(fromFile), pkgName);
    if (!pkgRoot) return null;
    const pkg = readPackageJson(pkgRoot);
    if (!pkg) return null;

    const exists: ExistsFn = diskExists;

    const exportTarget = resolveThroughExports(pkg.exports, subpath);
    if (exportTarget) {
        return probeWithExtensions(nodePath.join(pkgRoot, exportTarget), exists);
    }

    if (subpath === '.') {
        const target = pkg.module ?? pkg.main;
        if (target) return probeWithExtensions(nodePath.join(pkgRoot, target), exists);
        return probeWithExtensions(nodePath.join(pkgRoot, 'index'), exists);
    }

    return probeWithExtensions(nodePath.join(pkgRoot, subpath), exists);
}

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
