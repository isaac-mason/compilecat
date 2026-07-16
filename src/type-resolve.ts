// Pure (fs-free) type-resolution helpers used by the plugin's type-source donor
// gathering: mapping runtime specifiers to `.d.ts` candidates, resolving a
// package.json `exports` map to its `"types"` target, and detecting which imports
// are TYPE imports. Kept separate from the plugin so they're unit-testable without
// a bundler or filesystem.

// Import statements with their binding clause captured (group 1) and specifier
// (group 2) — used to detect TYPE imports.
const IMPORT_CLAUSE = /import\b([^'"]*?)from\s*['"]([^'"]+)['"]/g;

/**
 * The BARE specifiers a module imports TYPES from (`import type …` or an inline
 * `{ type X }`). Type-source `.d.ts` gathering is scoped to these — a package used
 * purely at runtime is never trawled. Relative imports are excluded: their `.ts`
 * source is the runtime donor and already carries its types.
 */
export function typeImportSpecifiers(code: string): string[] {
    const out: string[] = [];
    for (const m of code.matchAll(IMPORT_CLAUSE)) {
        const spec = m[2];
        // `type` must be followed by a name / `{` / `*` — so `import type {…}` and
        // `import { type X }` match, but a VALUE named `type` (`import { type }`,
        // `import { type, x }`) does not.
        if (!spec.startsWith('.') && /\btype\s+[A-Za-z_$*{]/.test(m[1])) out.push(spec);
    }
    return out;
}

/**
 * Declaration-file candidates for a resolved absolute path, mapping a runtime
 * extension to its `.d.ts` form. Used to resolve a re-export like `export * from
 * './types.js'` DIRECTLY to `./types.d.ts` — a type-only module has no runtime
 * `.js` on disk, so resolving to a runtime module first would fail.
 */
export function declarationCandidates(abs: string): string[] {
    const m = abs.match(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/);
    if (!m) return [`${abs}.d.ts`, `${abs}/index.d.ts`];
    const base = abs.slice(0, -m[0].length);
    const ext = m[1];
    if (ext === 'mjs' || ext === 'mts') return [`${base}.d.mts`, `${base}.d.ts`];
    if (ext === 'cjs' || ext === 'cts') return [`${base}.d.cts`, `${base}.d.ts`];
    return [`${base}.d.ts`];
}

/**
 * A bare specifier's subpath within its package, in `exports`-map form:
 * `mathcat` → '.', `mathcat/foo` → './foo', `@scope/pkg/foo` → './foo'.
 */
export function specifierToSubpath(specifier: string): string {
    const parts = specifier.split('/');
    const rootLen = specifier.startsWith('@') ? 2 : 1; // scoped names span two segments
    const sub = parts.slice(rootLen).join('/');
    return sub ? `./${sub}` : '.';
}

/**
 * Resolve the `.d.ts` target for `subpath` from a package.json `exports` field,
 * preferring the `"types"` condition. Handles string / conditions-object / array
 * targets, the subpath-map vs conditions-for-"." distinction, and `./*` wildcards.
 * A focused implementation of TypeScript's exports resolution for the types
 * condition (swappable for `resolve.exports` if exotic maps ever need it).
 * Returns a package-relative path, or null.
 */
export function typesFromExports(exportsField: unknown, subpath: string): string | null {
    if (typeof exportsField === 'string') {
        return null; // a bare string target carries no `types` condition
    }
    if (Array.isArray(exportsField)) {
        for (const e of exportsField) {
            const r = typesFromExports(e, subpath);
            if (r) return r;
        }
        return null;
    }
    if (exportsField && typeof exportsField === 'object') {
        const obj = exportsField as Record<string, unknown>;
        const keys = Object.keys(obj);
        const isSubpathMap = keys.length > 0 && keys.every((k) => k.startsWith('.') || k.startsWith('#'));
        if (isSubpathMap) {
            if (subpath in obj) return typesFromConditions(obj[subpath]);
            const w = matchWildcardSubpath(obj, subpath);
            if (!w) return null;
            const t = typesFromConditions(w.target);
            return t ? t.replace('*', w.wild) : null;
        }
        return subpath === '.' ? typesFromConditions(obj) : null; // conditions object describes "."
    }
    return null;
}

/** Find the `.d.ts` under a target's condition tree, preferring `types`. */
export function typesFromConditions(target: unknown): string | null {
    if (typeof target === 'string') return null; // a bare string is a runtime path (no types)
    if (Array.isArray(target)) {
        for (const t of target) {
            const r = typesFromConditions(t);
            if (r) return r;
        }
        return null;
    }
    if (target && typeof target === 'object') {
        const obj = target as Record<string, unknown>;
        if (typeof obj.types === 'string') return obj.types;
        if (obj.types !== undefined) return typesFromConditions(obj.types); // nested types condition
        for (const cond of ['import', 'module', 'node', 'default', 'require']) {
            if (obj[cond] !== undefined) {
                const r = typesFromConditions(obj[cond]);
                if (r) return r;
            }
        }
    }
    return null;
}

/**
 * Match `subpath` against a `./prefix*suffix` wildcard key, returning the key's
 * target plus the captured `*` segment (so the caller can substitute it into the
 * resolved `types` string). Node/TS `exports` resolution is LONGEST-MATCH-WINS:
 * pick the key with the longest static prefix (ties broken by longest suffix), not
 * the first in insertion order — otherwise a broad `./*` shadows a specific
 * `./feature/*` and resolves the wrong `.d.ts`.
 */
export function matchWildcardSubpath(map: Record<string, unknown>, subpath: string): { target: unknown; wild: string } | null {
    let best: { target: unknown; wild: string; prefixLen: number; suffixLen: number } | null = null;
    for (const key of Object.keys(map)) {
        const star = key.indexOf('*');
        if (star < 0) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
            if (
                best === null ||
                prefix.length > best.prefixLen ||
                (prefix.length === best.prefixLen && suffix.length > best.suffixLen)
            ) {
                best = {
                    target: map[key],
                    wild: subpath.slice(prefix.length, subpath.length - suffix.length),
                    prefixLen: prefix.length,
                    suffixLen: suffix.length,
                };
            }
        }
    }
    return best === null ? null : { target: best.target, wild: best.wild };
}
