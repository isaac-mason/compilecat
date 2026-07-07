// rsbuild adapter.
import { unpluginCompilecat, type Options } from './plugin';

export type { Options };
export const compilecatRsbuild = unpluginCompilecat.rsbuild;
export { compilecatRsbuild as compilecat };
export default compilecatRsbuild;
