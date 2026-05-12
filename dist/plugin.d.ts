import type { Plugin } from 'rollup';
export type Options = {
    /**
     * Enable debug logging.
     * @default false
     */
    debug?: boolean;
};
export declare function compilecat(options?: Options): Plugin;
export default compilecat;
