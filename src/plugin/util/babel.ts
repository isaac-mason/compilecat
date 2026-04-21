import _generate from '@babel/generator';
import _traverse from '@babel/traverse';

/**
 * Babel's CJS default exports show up as `{ default: fn }` under some bundler
 * configurations and as `fn` directly under others. Normalise once, here, so
 * the rest of plugin-alt can just `import { traverse, generate }` without
 * every call site re-doing the interop dance.
 */
function unwrapDefault<T>(module: T | { default: T }): T {
    return (module as { default: T }).default ?? (module as T);
}

export const traverse = unwrapDefault(_traverse);
export const generate = unwrapDefault(_generate);
