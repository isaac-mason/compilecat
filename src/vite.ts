// Vite adapter.
import type { Plugin } from 'vite';

import { unpluginCompilecat, type Options } from './plugin';

export type { Options };

export function compilecatVite(options: Options): Plugin {
    return unpluginCompilecat.vite(options) as Plugin;
}

export { compilecatVite as compilecat };
export default compilecatVite;
