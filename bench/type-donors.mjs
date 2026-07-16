// Micro-bench for the type-source donor gathering (cross-package `.d.ts` resolution).
// Builds a mathcat-shaped package in a temp dir (a bare `export * from './types.js'`
// plus 24 `export * as ns` namespace re-exports) and drives the plugin's transform
// directly, measuring: cold vs warm (cached) gather cost, the no-type-import baseline
// (gate skips gathering), and the number of `.d.ts` files read on a cold gather
// (demonstrates flat-only following: 2, not 26).
//
// Uses the built plugin. Run: `pnpm bench:type-donors` (builds dist first).

import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { compilecat } = await import(path.join(here, '..', 'dist', 'plugin.js'));

const NS_MODULES = 24; // mathcat re-exports ~24 namespaces besides its flat `types`
const TYPE_ALIASES = ['Vec2', 'Vec3', 'Vec4', 'Quat', 'Quat2', 'Mat3', 'Mat4'];

const root = fs.mkdtempSync(path.join(tmpdir(), 'cc-bench-typedonors-'));
const pkgDir = path.join(root, 'node_modules', 'benchcat', 'dist');
fs.mkdirSync(pkgDir, { recursive: true });

fs.writeFileSync(
    path.join(root, 'node_modules', 'benchcat', 'package.json'),
    JSON.stringify({ name: 'benchcat', main: 'dist/index.js', types: 'dist/index.d.ts' }),
);
// index.d.ts: one FLAT re-export (types) + many namespace re-exports (skipped by flat-only).
fs.writeFileSync(
    path.join(pkgDir, 'index.d.ts'),
    `export * from './types.js';\n${Array.from({ length: NS_MODULES }, (_, i) => `export * as m${i} from './m${i}.js';`).join('\n')}\n`,
);
fs.writeFileSync(
    path.join(pkgDir, 'types.d.ts'),
    TYPE_ALIASES.map((t, i) => `export type ${t} = [${Array.from({ length: 3 + (i % 2) }, (_, j) => `x${j}: number`).join(', ')}];`).join('\n'),
);
fs.writeFileSync(path.join(pkgDir, 'index.js'), 'export const quat = { create: () => [0, 0, 0, 0] };');
// The namespace-re-exported modules exist on disk but must NOT be read (flat-only).
for (let i = 0; i < NS_MODULES; i++) {
    fs.writeFileSync(path.join(pkgDir, `m${i}.js`), `export const f${i} = () => ${i};`);
    fs.writeFileSync(path.join(pkgDir, `m${i}.d.ts`), `export declare const f${i}: () => number;`);
}

const CONSUMER = `import { type Quat, quat } from 'benchcat';
const _s: Quat = /* @__PURE__ */ quat.create();
/* @optimize */ export function f(out, a) {
    _s[0] = a[0]; _s[1] = a[1]; _s[2] = a[2]; _s[3] = a[3];
    return out[0] = _s[0] + _s[1] + _s[2] + _s[3], out;
}`;
// Baseline: same shape but no TYPE import → the gate skips type gathering entirely.
const BASELINE = `import { quat } from 'benchcat';
const _s = /* @__PURE__ */ quat.create();
/* @optimize */ export function f(out, a) {
    _s[0] = a[0]; _s[1] = a[1]; _s[2] = a[2]; _s[3] = a[3];
    return out[0] = _s[0] + _s[1] + _s[2] + _s[3], out;
}`;

function makeCtx() {
    return {
        async resolve(source) {
            if (source.startsWith('.') || source.startsWith('/')) return null;
            return { id: path.join(root, 'node_modules', source, 'dist', 'index.js') };
        },
        addWatchFile() {},
    };
}

function makePlugin() {
    const p = compilecat({ include: [/.*/] });
    const t = p.transform;
    return typeof t === 'function' ? t : t.handler;
}

async function transform(handler, ctx, code, id) {
    const r = await handler.call(ctx, code, id);
    return r ? r.code : code;
}

// Count `.d.ts` reads during a thunk (instrument fs.readFileSync).
async function countDtsReads(thunk) {
    const orig = fs.readFileSync;
    let n = 0;
    fs.readFileSync = (p, ...rest) => {
        if (typeof p === 'string' && p.endsWith('.d.ts') && p.startsWith(root)) n++;
        return orig(p, ...rest);
    };
    try {
        await thunk();
    } finally {
        fs.readFileSync = orig;
    }
    return n;
}

const N = 500;
const entry = (i) => path.join(root, `c${i}.ts`);

// ── measurements ────────────────────────────────────────────────────────────
// Cold: a fresh plugin (empty caches) transforms one type-importing consumer.
const coldHandler = makePlugin();
const coldCtx = makeCtx();
let dtsColdReads = 0;
const coldMs = await (async () => {
    const t0 = process.hrtime.bigint();
    dtsColdReads = await countDtsReads(() => transform(coldHandler, coldCtx, CONSUMER, entry(0)));
    return Number(process.hrtime.bigint() - t0) / 1e6;
})();

// Warm: the SAME plugin (caches primed) transforms N more consumers.
let warmTotal = 0;
for (let i = 1; i <= N; i++) {
    const t0 = process.hrtime.bigint();
    await transform(coldHandler, coldCtx, CONSUMER, entry(i));
    warmTotal += Number(process.hrtime.bigint() - t0) / 1e6;
}
const warmMs = warmTotal / N;
const dtsWarmReads = await countDtsReads(() => transform(coldHandler, coldCtx, CONSUMER, entry(N + 1)));

// Baseline: fresh plugin, N consumers with NO type import (gate skips gathering).
const baseHandler = makePlugin();
const baseCtx = makeCtx();
let baseTotal = 0;
for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    await transform(baseHandler, baseCtx, BASELINE, entry(i));
    baseTotal += Number(process.hrtime.bigint() - t0) / 1e6;
}
const baseMs = baseTotal / N;

fs.rmSync(root, { recursive: true, force: true });

const f = (x) => x.toFixed(3).padStart(8);
console.log(`\ntype-donor gathering — package with 1 flat + ${NS_MODULES} namespace re-exports, N=${N}\n`);
console.log(`  cold transform (empty caches)      ${f(coldMs)} ms`);
console.log(`  warm transform (avg, cached)       ${f(warmMs)} ms`);
console.log(`  baseline (no type import, avg)     ${f(baseMs)} ms`);
console.log(`  type-gather overhead (warm - base) ${f(warmMs - baseMs)} ms`);
console.log('');
console.log(`  .d.ts reads on a COLD gather       ${String(dtsColdReads).padStart(6)}   (flat-only: index.d.ts + types.d.ts, NOT ${NS_MODULES + 2})`);
console.log(`  .d.ts reads on a WARM gather       ${String(dtsWarmReads).padStart(6)}   (donor cache: read once per build)`);
console.log('');
