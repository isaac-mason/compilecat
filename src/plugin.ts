// Bundle-mode rollup plugin. Operates on whole chunks via `renderChunk`,
// after the bundler has tree-shaken and concatenated modules. By the time
// we run, the chunk is a single Program — every `@inline` function in
// scope is directly reachable, no cross-file resolution needed.
//
// Compatible with rollup, vite, and rolldown (vite/rolldown share rollup's
// plugin shape). esbuild + webpack are not supported in bundle-mode.

import type { Plugin } from 'rollup';

import { ANY_DIRECTIVE_IN_SOURCE } from './compiler/directives';
import { transform } from './compiler/pipeline';

export type Options = {
    /**
     * Enable debug logging.
     * @default false
     */
    debug?: boolean;
};

export function compilecat(options: Options = {}): Plugin {
    const debug = options.debug === true;
    return {
        name: 'compilecat',
        renderChunk(code, chunk) {
            if (!ANY_DIRECTIVE_IN_SOURCE.test(code)) return null;

            const id = chunk.fileName;
            if (debug) console.log(`[compilecat] transforming chunk ${id}`);

            try {
                const r = transform(code, {
                    sourceMaps: true,
                    filename: id,
                });
                if (debug) {
                    console.log(
                        `[compilecat] ${id}: inlined=${r.stats.inlined} folded=${r.stats.folded} dead=${r.stats.removedDeadCode}`,
                    );
                }
                return { code: r.code, map: r.map };
            } catch (err) {
                console.error(`[compilecat] failed to transform chunk ${id}:`, err);
                return null;
            }
        },
    };
}

export default compilecat;
