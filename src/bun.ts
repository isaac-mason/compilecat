// bun adapter.
import { unpluginCompilecat, type Options } from './plugin';

export type { Options };
export const compilecatBun = unpluginCompilecat.bun;
export { compilecatBun as compilecat };
export default compilecatBun;
