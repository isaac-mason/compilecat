// A small include/exclude matcher — our own, so compilecat carries no runtime
// dependency just for `createFilter` (it was the only use of
// `@rollup/pluginutils`). Drop-in for the `createFilter(include, exclude)` shape
// the plugin needs.
//
// A pattern is either a RegExp (tested against the id as-is) or a glob string
// supporting:
//   `**`  any run of characters, crossing `/`     (e.g. `src/**`)
//   `**/` zero or more leading path segments       (e.g. `**/mathcat/**`)
//   `*`   any run within a single path segment
//   `?`   one character, not `/`
// For anything beyond that — brace expansion, character classes, extglobs —
// pass a RegExp instead. All matching is on POSIX-normalised paths.

import path from 'node:path';

export type FilterPattern = string | RegExp | (string | RegExp)[];

const toArray = <T>(v: T | T[] | undefined): T[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];

const toPosix = (p: string): string => p.replace(/\\/g, '/');

// Glob → anchored RegExp. Regex metacharacters are escaped (matched literally);
// only `*`/`**`/`?` are interpreted.
export function globToRegExp(glob: string): RegExp {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                i++;
                if (glob[i + 1] === '/') {
                    i++;
                    re += '(?:.*/)?'; // `**/` → zero or more leading segments
                } else {
                    re += '.*'; // `**` → anything, crossing `/`
                }
            } else {
                re += '[^/]*'; // `*` → within a single segment
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if ('.+^${}()|[]\\'.includes(c)) {
            re += `\\${c}`; // escape regex specials (matched literally)
        } else {
            re += c;
        }
    }
    return new RegExp(`^${re}$`);
}

// Build a matcher over already-POSIX-normalised ids.
function toMatcher(pattern: string | RegExp): (id: string) => boolean {
    if (pattern instanceof RegExp) return (id) => pattern.test(id);
    // Anchor a relative glob at cwd (so `src/**` means *this project's* src),
    // unless it already starts with `*` — then its leading `**` absorbs the path
    // prefix and it matches wherever the file lives.
    const g = pattern.startsWith('*') ? toPosix(pattern) : toPosix(path.resolve(pattern));
    const re = globToRegExp(g);
    return (id) => re.test(id);
}

/**
 * `(id) => boolean`: true when `id` is matched by `include` (or `include` is
 * empty/omitted) and not matched by `exclude`. Mirrors the `@rollup/pluginutils`
 * `createFilter` contract for the patterns compilecat documents.
 */
export function createFilter(
    include?: FilterPattern,
    exclude?: FilterPattern,
): (id: string) => boolean {
    const inc = toArray(include).map(toMatcher);
    const exc = toArray(exclude).map(toMatcher);
    return (rawId: string) => {
        const id = toPosix(rawId);
        if (exc.some((m) => m(id))) return false;
        if (inc.length === 0) return true;
        return inc.some((m) => m(id));
    };
}
