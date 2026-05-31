import type { Plugin } from 'vite';
import { type PerFileOptions, compilecat, compilecatPerFile } from './plugin';
export type Options = PerFileOptions;
export declare function compilecatVite(options: Options): Plugin[];
export { compilecatPerFile, compilecat };
export default compilecatVite;
