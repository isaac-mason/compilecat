// Prove the compiler runs as a real per-file `transform` plugin in an actual
// bundler build (not just compileChunk in isolation).
//
// Uses rollup with a virtual entry. JS input (rollup's own parser can't read
// the TS we'd emit; TS-in→TS-out is covered by ts.test.ts). The point here is
// the *plugin integration*: the `transform` hook fires per file and optimizes.

import { rollup } from 'rollup';
import { describe, expect, it } from 'vitest';

import { compilecat } from '../src/plugin';

function virtual(files: Record<string, string>) {
    return {
        name: 'virtual',
        resolveId(id: string) {
            return files[id] ? id : null;
        },
        load(id: string) {
            return files[id] ?? null;
        },
    };
}

async function build(files: Record<string, string>, input: string): Promise<string> {
    const bundle = await rollup({
        input,
        plugins: [virtual(files), compilecat({ include: [/.*/] })],
        onwarn: () => {},
    });
    const { output } = await bundle.generate({ format: 'es' });
    return output[0].code;
}

describe('compiler per-file transform plugin (rollup)', () => {
    it('inlines an @inline dependency during transform', async () => {
        const code = await build(
            {
                'entry.js': `/* @inline */ function add(a, b) { return a + b; }\nexport function step(x) { return add(x, 1); }`,
            },
            'entry.js',
        );
        expect(code).toContain('return x + 1');
        expect(code).not.toContain('add(x, 1)');
    });

    it('optimizes @sroa per file', async () => {
        const code = await build(
            {
                'entry.js': `/* @sroa */ export function f() { const v = [1, 2, 3]; v[0] = v[1] + v[2]; return v[0]; }`,
            },
            'entry.js',
        );
        expect(code).toContain('return 5');
        expect(code).not.toContain('[1, 2, 3]');
    });

    it('leaves directive-free files untouched (no-op)', async () => {
        const code = await build({ 'entry.js': `export function f(a, b) { return a + b; }` }, 'entry.js');
        expect(code).toContain('return a + b');
    });
});
