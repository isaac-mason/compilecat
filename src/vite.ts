// Vite adapter. compilecat has a single per-file `transform` pass (valid in both
// `vite dev` and `vite build`), so the adapter is just the plugin — no
// serve/build split needed.

import type { Plugin } from 'vite';

import { compilecat, type Options } from './plugin';

export type { Options };

export function compilecatVite(options: Options): Plugin {
    return compilecat(options) as Plugin;
}

export { compilecat };
export default compilecatVite;
