// In-browser TS→JS step for the playground. compilecat is a TS→TS optimizer
// (types preserved by design), so the previews need a downstream bundler to turn
// TypeScript into runnable JS — exactly as a real Vite/rollup pipeline would.
//
// We run @rollup/browser (real bundling: tree-shake + scope-hoist, and the path
// to cross-file demos later). rollup itself doesn't strip TS, so a small plugin
// does the type-strip with sucrase — isolated here, swappable for esbuild-wasm.

import { type Plugin, rollup } from '@rollup/browser';
import { transform as sucrase } from 'sucrase';

const ENTRY = '\0compilecat-input';

function virtualEntry(code: string): Plugin {
    return {
        name: 'virtual-entry',
        resolveId(id) {
            // Only the single in-memory entry resolves; the demo has no other
            // modules, so anything else stays unresolved (treated as external).
            return id === ENTRY ? ENTRY : null;
        },
        load(id) {
            return id === ENTRY ? code : null;
        },
        transform(src, id) {
            if (id !== ENTRY) return null;
            // Strip TS types only — keep ESM so rollup owns module handling.
            const out = sucrase(src, { transforms: ['typescript'] });
            return { code: out.code, map: null };
        },
    };
}

/** Bundle a single TypeScript source string to runnable ES JS. */
export async function bundle(tsCode: string): Promise<string> {
    const build = await rollup({
        input: ENTRY,
        plugins: [virtualEntry(tsCode)],
        onwarn() {}, // single-file demo: unresolved-import / empty-chunk noise
    });
    try {
        const { output } = await build.generate({ format: 'es' });
        return output[0].code;
    } finally {
        await build.close();
    }
}
