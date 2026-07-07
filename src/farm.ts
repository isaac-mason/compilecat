// farm adapter.
import { unpluginCompilecat, type Options } from './plugin';

export type { Options };
export const compilecatFarm = unpluginCompilecat.farm;
export { compilecatFarm as compilecat };
export default compilecatFarm;
