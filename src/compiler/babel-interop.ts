// Babel ships its packages as CJS with a `default` export. Under some
// bundlers / loaders the ESM default-import lands as the function directly;
// under others it lands as `{ default: fn }`. Centralised here so each
// consumer just imports the unwrapped value.

import _generate from '@babel/generator';
import _traverse from '@babel/traverse';

// biome-ignore lint/suspicious/noExplicitAny: interop shim
const unwrap = <T>(mod: T): T => (mod as any).default ?? mod;

export const generate: typeof _generate = unwrap(_generate);
export const traverse: typeof _traverse = unwrap(_traverse);
