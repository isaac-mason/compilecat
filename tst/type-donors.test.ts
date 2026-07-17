// End-to-end type-source dependency resolution: a real on-disk package (package.json +
// dist `.js`/`.d.ts`) imported for TYPES, driven through the compilecat plugin in a
// real rollup build. Proves the plugin resolves the `.d.ts` type surface (types
// field / exports condition), follows the `.d.ts` re-export graph, and feeds the
// core so type-aware module-scratch SROA fires — the crashcat/mathcat scenario.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compilecat } from '../src/plugin';

let root: string;

// A package that ships `.js` + `.d.ts` split, with its types re-exported from a
// TYPE-ONLY module via a bare `export * from './types.js'` (the mathcat shape).
function writePkg(name: string, packageJson: Record<string, unknown>, files: Record<string, string>) {
    const dir = path.join(root, 'node_modules', name);
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, ...packageJson }));
    for (const [rel, content] of Object.entries(files)) {
        writeFileSync(path.join(dir, rel), content);
    }
}

// Invoke the plugin's `transform` hook directly with a mock bundler context —
// avoids rollup parsing compilecat's (still-typed) output. `this.resolve` is a
// minimal node-resolve mapping bare `<pkg>` → its dist/index.js.
async function run(consumer: string): Promise<{ code: string; watched: string[] }> {
    const plugin: any = compilecat({ include: [/.*/] });
    const watched: string[] = [];
    const ctx = {
        async resolve(source: string) {
            if (source.startsWith('.') || source.startsWith('/')) return null;
            return { id: path.join(root, 'node_modules', source, 'dist', 'index.js') };
        },
        addWatchFile(p: string) {
            watched.push(p);
        },
    };
    const t = plugin.transform;
    const handler = typeof t === 'function' ? t : t.handler;
    const res = await handler.call(ctx, consumer, path.join(root, 'entry.ts'));
    return { code: res ? res.code : consumer, watched };
}

async function compileConsumer(consumer: string): Promise<string> {
    return (await run(consumer)).code;
}

const CONSUMER = (pkg: string) => `import { type Quat, create } from '${pkg}';
const _s: Quat = /* @__PURE__ */ create();
/* @optimize */ export function f(out: number[], a: number[]): number[] {
    _s[0] = a[0];
    _s[1] = a[1];
    _s[2] = a[2];
    _s[3] = a[3];
    out[0] = _s[0] + _s[1] + _s[2] + _s[3];
    return out;
}`;

const scalarized = (code: string) => /_s_0\b/.test(code) && !/\b_s\[/.test(code);

beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cc-typedeps-'));
});
afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('cross-package .d.ts type resolution (e2e via rollup)', () => {
    it('types field + bare `export *` re-export to a type-only module (mathcat shape)', async () => {
        writePkg(
            'legacypkg',
            { main: 'dist/index.js', types: 'dist/index.d.ts' },
            {
                'dist/index.js': 'export const create = () => [0, 0, 0, 0];',
                'dist/index.d.ts': "export * from './types.js';\nexport declare const create: () => Quat;",
                'dist/types.d.ts': 'export type Quat = [x: number, y: number, z: number, w: number];',
            },
        );
        const out = await compileConsumer(CONSUMER('legacypkg'));
        expect(scalarized(out), `expected SROA to fire:\n${out}`).toBe(true);
    });

    it('exports map with a "types" condition', async () => {
        writePkg(
            'modernpkg',
            {
                exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
            },
            {
                'dist/index.js': 'export const create = () => [0, 0, 0, 0];',
                'dist/index.d.ts':
                    'export type Quat = [x: number, y: number, z: number, w: number];\nexport declare const create: () => Quat;',
            },
        );
        const out = await compileConsumer(CONSUMER('modernpkg'));
        expect(scalarized(out), `expected SROA to fire via exports types:\n${out}`).toBe(true);
    });

    it('does NOT resolve/scalarize when the package ships no declarations', async () => {
        writePkg(
            'jsonly',
            { main: 'dist/index.js' },
            {
                'dist/index.js': 'export const create = () => [0, 0, 0, 0];',
            },
        );
        // No `Quat` type available → annotation unresolved → scratch stays an array.
        const out = await compileConsumer(CONSUMER('jsonly'));
        expect(scalarized(out)).toBe(false);
    });

    it('falls back to @types/<pkg> (DefinitelyTyped) when the package ships no own declarations', async () => {
        // `phantom` ships JS only; its declarations live in the separate `@types/phantom`
        // package. The type resolver must consult `@types/<pkg>` so `Quat` resolves and
        // SROA fires — the classic DefinitelyTyped split.
        writePkg('phantom', { main: 'index.js' }, { 'index.js': 'export const create = () => [0, 0, 0, 0];' });
        writePkg('@types/phantom', { types: 'index.d.ts' }, {
            'index.d.ts':
                'export type Quat = [x: number, y: number, z: number, w: number];\nexport declare const create: () => Quat;',
        });
        const plugin: any = compilecat({ include: [/.*/] });
        const ctx = {
            async resolve(source: string) {
                if (source.startsWith('.') || source.startsWith('/')) return null;
                // A subpath (e.g. `@types/phantom/package.json`) → the literal file.
                if (source.endsWith('/package.json')) return { id: path.join(root, 'node_modules', source) };
                return { id: path.join(root, 'node_modules', source, 'index.js') };
            },
            addWatchFile() {},
        };
        const t: any = plugin.transform;
        const handler = typeof t === 'function' ? t : t.handler;
        const res = await handler.call(ctx, CONSUMER('phantom'), path.join(root, 'entry.ts'));
        const out = res ? res.code : '';
        expect(scalarized(out), `expected SROA to fire via @types/phantom:\n${out}`).toBe(true);
    });

    it('watches the package.json AND the .d.ts so edits invalidate (no stale cache)', async () => {
        writePkg(
            'watchpkg',
            { main: 'dist/index.js', types: 'dist/index.d.ts' },
            {
                'dist/index.js': 'export const create = () => [0, 0, 0, 0];',
                'dist/index.d.ts':
                    'export type Quat = [x: number, y: number, z: number, w: number];\nexport declare const create: () => Quat;',
            },
        );
        const { watched } = await run(CONSUMER('watchpkg'));
        // package.json must be watched so a `types`/`exports` edit re-transforms the
        // consumer (and `watchChange` clears the type-entry caches); the .d.ts too.
        expect(watched.some((p) => p.endsWith(`${path.sep}watchpkg${path.sep}package.json`))).toBe(true);
        expect(watched.some((p) => p.endsWith('index.d.ts'))).toBe(true);
    });
});
