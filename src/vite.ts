// Vite adapter. Returns two plugin instances gated by Vite's `apply`:
//
//   - per-file transform during `vite dev` (apply: 'serve')
//   - whole-program renderChunk during `vite build` (apply: 'build')
//
// Mutually exclusive — exactly one fires per Vite command, so the same code
// never goes through both passes.

import type { Plugin } from 'vite';

import { type PerFileOptions, compilecat, compilecatPerFile } from './plugin';

export type Options = PerFileOptions;

export function compilecatVite(options: Options): Plugin[] {
    return [
        { ...compilecatPerFile(options), apply: 'serve' },
        { ...compilecat(options), apply: 'build' },
    ] as Plugin[];
}

export { compilecatPerFile, compilecat };
export default compilecatVite;
