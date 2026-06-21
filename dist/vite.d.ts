import type { Plugin } from 'vite';
import { compilecat, type Options } from './plugin';
export type { Options };
export declare function compilecatVite(options: Options): Plugin;
export { compilecat };
export default compilecatVite;
