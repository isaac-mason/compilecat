// rspack adapter.
import { unpluginCompilecat, type Options } from './plugin';

export type { Options };
export const compilecatRspack = unpluginCompilecat.rspack;
export { compilecatRspack as compilecat };
export default compilecatRspack;
