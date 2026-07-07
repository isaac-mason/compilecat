// esbuild adapter.
import { unpluginCompilecat, type Options } from './plugin';

export type { Options };
export const compilecatEsbuild = unpluginCompilecat.esbuild;
export { compilecatEsbuild as compilecat };
export default compilecatEsbuild;
