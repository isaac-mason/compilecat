// webpack adapter.
import { unpluginCompilecat, type Options } from './plugin';

export type { Options };
export const compilecatWebpack = unpluginCompilecat.webpack;
export { compilecatWebpack as compilecat };
export default compilecatWebpack;
