// Cross-module inlining — the differentiated value a plain bundler can't do.
// Two checks:
//   (a) core behavioral equivalence (compileFileCross + eval the combined modules)
//   (b) end-to-end through a real rollup build with real files on disk.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { transformSync } from 'esbuild';
import { rolldown } from 'rolldown';
import { type RollupOptions, rollup } from 'rollup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCompiler } from '../src/compiler';
import { compilecat } from '../src/plugin';

const compiler = createCompiler();

function stripTS(code: string): string {
    return transformSync(code, { loader: 'ts' }).code;
}

// Eval a module-ish snippet in a plain Function: strip types, then drop
// `export`/`import` lines so `new Function` accepts it.
function ev(code: string, call: string): unknown {
    // Strip module syntax BEFORE esbuild, so a combined donor+consumer (which
    // has both `import { add }` and `function add`) doesn't trip a redeclare.
    const noModule = code.replace(/^\s*import[^\n]*\n?/gm, '').replace(/\bexport\s+/g, '');
    return new Function(`${stripTS(noModule)}\nreturn (${call});`)();
}

// ── (a) core cross-file behavioral equivalence ───────────────────────────────

describe('cross-file inline: core behavioral equivalence', () => {
    it('inlines an imported @inline donor + drops the import', () => {
        const consumer = `import { add } from "./math";\nexport function step(x: number): number { return add(x, 1); }`;
        const donor = `/* @inline */ export function add(a: number, b: number): number { return a + b; }`;

        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './math', path: '/p/math.ts', code: donor, resolved: [] }],
            {},
        ).code;

        // import gone, call inlined
        expect(out).not.toContain('import');
        expect(out).toContain('return x + 1');

        // behavioral: compiler output ≡ original (donor + consumer combined)
        const expected = ev(`${donor}\n${consumer}`, 'step(41)');
        const actual = ev(out, 'step(41)');
        expect(actual).toEqual(expected);
    });

    it('renames a cross-file BLOCK donor param colliding with a host param', () => {
        // Regression (gjkClosestPoints-class miscompile): a cross-file @inline
        // donor whose param is `out` — same name as the @optimize host's param —
        // inlines via the BLOCK path with a `let out = <arg>` prologue. If that
        // isn't renamed away from the host param, it shadows it and the host's
        // EARLIER `out` use throws "Cannot access 'out' before initialization".
        // Caught only by RUNNING the cross-file output (a structural check misses
        // the TDZ).
        // The donor's `out` param is inlined with an ARG that references the
        // host's `out` (`cp(out.axis, …)`), so a missed rename yields
        // `let out = out.axis` whose own RHS is in the shadow's dead zone.
        const donor = `/* @inline */ export function cp(out: number[], a: number[]): void {\n  out[0] = a[0];\n  out[1] = a[1];\n}`;
        const consumer = `import { cp } from "./d";\nconst src = [10, 20];\n/* @optimize */ export function host(out: { axis: number[]; ok: boolean }): number {\n  cp(out.axis, src);\n  out.ok = true;\n  return out.axis[0] + out.axis[1];\n}`;

        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './d', path: '/p/d.ts', code: donor, resolved: [] }],
            {},
        ).code;

        const arg = '{ axis: [0, 0], ok: false }';
        const expected = ev(`${donor}\n${consumer}`, `host(${arg})`);
        const actual = ev(out, `host(${arg})`); // throws TDZ if the donor `out` shadows the host param
        expect(actual).toEqual(expected);
    });

    it('resolves an imported tuple type for cross-module SROA', () => {
        // `Vec3` lives in the donor; the consumer imports it and types an opaque
        // aggregate with it. Cross-module type resolution gives the arity so SROA
        // destructures `mk()` into scalars — behaviorally identical.
        const consumer = `import { Vec3 } from "./math";
function mk(): Vec3 { return [10, 20, 30]; }
/* @sroa */ export function f(): number { const v: Vec3 = mk(); v[0] = v[1] + v[2]; return v[0]; }`;
        const donor = `export type Vec3 = [number, number, number];`;

        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './math', path: '/p/math.ts', code: donor, resolved: [] }],
            {},
        ).code;

        // SROA fired (scalars present, indexing gone) — driven by the imported type.
        expect(out).toContain('v_0');
        expect(out).not.toContain('v[1]');

        const expected = ev(`${donor}\n${consumer}`, 'f()');
        expect(ev(out, 'f()')).toEqual(expected);
        expect(expected).toEqual(50);
    });

    it('resolves an imported interface for cross-module object SROA', () => {
        // `Vec3` is an interface in the donor; the consumer imports it and types
        // an opaque aggregate. Cross-module resolution gives the field set so SROA
        // destructures `mk()` into named scalars.
        const consumer = `import { Vec3 } from "./math";
function mk(): Vec3 { return { x: 4, y: 5, z: 6 }; }
/* @sroa */ export function f(): number { const v: Vec3 = mk(); v.x = v.y + v.z; return v.x; }`;
        const donor = `export interface Vec3 { x: number; y: number; z: number }`;

        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './math', path: '/p/math.ts', code: donor, resolved: [] }],
            {},
        ).code;

        expect(out).toContain('v_x');
        expect(out).not.toContain('v.x');

        const expected = ev(`${donor}\n${consumer}`, 'f()');
        expect(ev(out, 'f()')).toEqual(expected);
        expect(expected).toEqual(11);
    });

    it('hoists a donor module const and folds it (copy-then-clean)', () => {
        const consumer = `import { scale } from "./m";\nexport function f(x: number): number { return scale(x); }`;
        const donor = `const FACTOR = 3;\n/* @inline */ export function scale(v: number): number { return v * FACTOR; }`;
        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './m', path: '/p/m.ts', code: donor, resolved: [] }],
            {},
        ).code;
        // inlined; literal const folded away by the cleanup pipeline; import gone
        expect(out).not.toContain('import');
        expect(out).not.toContain('scale');
        expect(out).toContain('x * 3');

        const expected = ev(`${donor}\n${consumer}`, 'f(14)');
        const actual = ev(out, 'f(14)');
        expect(actual).toEqual(expected);
    });

    it('copies a non-literal const dep and stays behaviorally equivalent', () => {
        const consumer = `import { origin } from "./m";\nexport function f(): number[] { return origin(); }`;
        const donor = `const ZERO = [0, 0, 0];\n/* @inline */ export function origin(): number[] { return ZERO; }`;
        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './m', path: '/p/m.ts', code: donor, resolved: [] }],
            {},
        ).code;
        // array const isn't foldable → copied into the consumer, still referenced
        expect(out).not.toContain('origin(');
        expect(out).toContain('ZERO');

        const expected = ev(`${donor}\n${consumer}`, 'JSON.stringify(f())');
        const actual = ev(out, 'JSON.stringify(f())');
        expect(actual).toEqual(expected);
    });

    it('forwards a bare-specifier import dep the donor body needs', () => {
        const consumer = `import { norm } from "./m";\nexport function f(x: number): number { return norm(x); }`;
        const donor = `import { clamp } from "math-utils";\n/* @inline */ export function norm(v: number): number { return clamp(v); }`;
        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './m', path: '/p/m.ts', code: donor, resolved: [] }],
            {},
        ).code;
        // inlined, and the bare import forwarded verbatim (one shared binding)
        expect(out).not.toContain('norm(');
        expect(out).toContain('clamp(x)');
        expect(out).toContain('from "math-utils"');
    });

    it('rebases a relative import dep to the consumer location', () => {
        const consumer = `import { norm } from "../lib/m";\nexport function f(x: number): number { return norm(x); }`;
        const donor = `import { clamp } from "./util";\n/* @inline */ export function norm(v: number): number { return clamp(v); }`;
        const out = compiler.compileFileCross(
            '/proj/app/entry.ts',
            consumer,
            [{ specifier: '../lib/m', path: '/proj/lib/m.ts', code: donor, resolved: [] }],
            {},
        ).code;
        expect(out).toContain('clamp(x)');
        // ./util next to the donor (/proj/lib) seen from /proj/app → ../lib/util
        expect(out).toContain('from "../lib/util"');
    });
});

// ── (a2) cross-file behavioral matrix — every BLOCK/DIRECT body shape, RUN the
//     output (a TDZ/shadow miscompile only throws at execution; structural
//     assertions miss it). This is the coverage gap that let the gjkClosestPoints
//     `let out` shadow ship. Each case: inline a `./d` donor into an `@optimize`
//     host, then assert compiled-output ≡ original by evaluating both. ──────────

type XfCase = { name: string; donor: string; host: string; call: string };

const XF_MATRIX: XfCase[] = [
    {
        name: 'single-return object literal, field-read',
        donor: `/* @inline */ export function mk(a: number, b: number) { return { x: a, y: b }; }`,
        host: `import { mk } from "./d";\n/* @optimize */ export function f(p: number): number { const v = mk(p, p + 1); return v.x * v.y; }`,
        call: 'f(4)',
    },
    {
        name: 'single-return with prologue (normalize shape)',
        donor: `/* @inline */ export function norm(a: { x: number; y: number }) { const l = Math.abs(a.x) + Math.abs(a.y) || 1; return { x: a.x / l, y: a.y / l }; }`,
        host: `import { norm } from "./d";\n/* @optimize */ export function f(px: number, py: number): number { const d = norm({ x: px, y: py }); return d.x + d.y; }`,
        call: 'f(3, 5)',
    },
    {
        name: 'multi-return body (genuinely deferred)',
        donor: `/* @inline */ export function pick(c: boolean, a: number, b: number) { if (c) return { v: a }; return { v: b }; }`,
        host: `import { pick } from "./d";\n/* @optimize */ export function f(c: boolean, n: number): number { const r = pick(c, n, -n); return r.v * 2; }`,
        call: 'f(true, 7)',
    },
    {
        name: 'void donor mutating an out param',
        donor: `/* @inline */ export function cp(out: number[], a: number[]): void { out[0] = a[0]; out[1] = a[1]; }`,
        host: `import { cp } from "./d";\n/* @optimize */ export function f(): number { const o = [0, 0]; cp(o, [10, 20]); return o[0] + o[1]; }`,
        call: 'f()',
    },
    {
        name: 'PARAM COLLISION: donor param `out` == host param `out`',
        donor: `/* @inline */ export function neg(out: number[], a: number[]): void { out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; }`,
        host: `import { neg } from "./d";\nconst scratch = [1, 2, 3];\n/* @optimize */ export function host(out: { axis: number[]; started: boolean }): number { out.started = true; neg(out.axis, scratch); return out.axis[0] + out.axis[1] + out.axis[2] + (out.started ? 0 : 99); }`,
        call: 'host({ axis: [0, 0, 0], started: false })',
    },
    {
        name: 'PARAM COLLISION + arg references the host param',
        donor: `/* @inline */ export function cp(out: number[], a: number[]): void { out[0] = a[0]; out[1] = a[1]; }`,
        host: `import { cp } from "./d";\nconst src = [10, 20];\n/* @optimize */ export function host(out: { axis: number[]; ok: boolean }): number { out.ok = true; cp(out.axis, src); return out.axis[0] + out.axis[1] + (out.ok ? 0 : 99); }`,
        call: 'host({ axis: [0, 0], ok: false })',
    },
    {
        name: 'PARAM COLLISION used BEFORE and AFTER the inlined call (TDZ-prone)',
        donor: `/* @inline */ export function setLen(out: { v: number }, k: number): void { const t = k + 1; out.v = t * 2; }`,
        host: `import { setLen } from "./d";\n/* @optimize */ export function host(out: { v: number; seen: number }): number { out.seen = out.v; setLen(out, 5); return out.seen + out.v; }`,
        call: 'host({ v: 3, seen: 0 })',
    },
    {
        name: 'two inlined calls in one host (id/rename uniqueness)',
        donor: `/* @inline */ export function add(a: { x: number }, b: { x: number }) { return { x: a.x + b.x }; }`,
        host: `import { add } from "./d";\n/* @optimize */ export function f(): number { const p = add({ x: 1 }, { x: 2 }); const q = add({ x: 10 }, { x: 20 }); return p.x + q.x; }`,
        call: 'f()',
    },
    {
        name: 'early-return guard then value',
        donor: `/* @inline */ export function safe(x: number) { if (x < 0) return { v: 0 }; return { v: x * 2 }; }`,
        host: `import { safe } from "./d";\n/* @optimize */ export function f(n: number): number { const r = safe(n); return r.v; }`,
        call: 'f(-3)',
    },
    {
        name: 'return array (tuple)',
        donor: `/* @inline */ export function pair(a: number, b: number): [number, number] { return [a + 1, b + 1]; }`,
        host: `import { pair } from "./d";\n/* @optimize */ export function f(a: number, b: number): number { const v = pair(a, b); return v[0] * v[1]; }`,
        call: 'f(2, 3)',
    },
    {
        name: 'return scalar (no aggregate)',
        donor: `/* @inline */ export function len2(a: { x: number; y: number }): number { const s = a.x * a.x + a.y * a.y; return s; }`,
        host: `import { len2 } from "./d";\n/* @optimize */ export function f(x: number, y: number): number { const r = len2({ x, y }); return r + 1; }`,
        call: 'f(3, 4)',
    },
    {
        name: 'inlined-result used as an arg to a second inlined call (chain)',
        donor: `/* @inline */ export function sub(a: { x: number }, b: { x: number }) { return { x: a.x - b.x }; }\n/* @inline */ export function scale(a: { x: number }, s: number) { return { x: a.x * s }; }`,
        host: `import { sub, scale } from "./d";\n/* @optimize */ export function f(p: number, q: number): number { const v = scale(sub({ x: p }, { x: q }), 2); return v.x; }`,
        call: 'f(10, 3)',
    },
];

describe('cross-file inline: behavioral matrix (run the output)', () => {
    for (const c of XF_MATRIX) {
        it(c.name, () => {
            const out = compiler.compileFileCross(
                'entry.ts',
                c.host,
                [{ specifier: './d', path: '/p/d.ts', code: c.donor, resolved: [] }],
                {},
            ).code;
            const expected = ev(`${c.donor}\n${c.host}`, c.call);
            const actual = ev(out, c.call); // throws on a TDZ/shadow miscompile
            expect(actual).toEqual(expected);
        });
    }
});

// ── (b) end-to-end through rollup with real files ────────────────────────────

describe('cross-file inline: end-to-end (rollup, real files)', () => {
    let dir: string;
    beforeAll(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'cc-xfile-'));
        writeFileSync(path.join(dir, 'math.js'), `/* @inline */ export function add(a, b) { return a + b; }\n`);
        writeFileSync(
            path.join(dir, 'entry.js'),
            `import { add } from "./math.js";\nexport function step(x) { return add(x, 1); }\n`,
        );
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('inlines across modules during a real build', async () => {
        const bundle = await rollup({
            input: path.join(dir, 'entry.js'),
            plugins: [compilecat({ include: [/.*/] })],
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code).toContain('return x + 1');
        expect(code).not.toContain('add(x, 1)');
    });

    it('forwards a donor import dep and the bundler resolves it', async () => {
        // donor (mathlib) needs `clamp` from a sibling file; after inlining norm
        // into entry, the forwarded `./clamp.js` import must still resolve+bundle.
        writeFileSync(path.join(dir, 'clamp.js'), `export function clamp(v) { return Math.max(0, v); }\n`);
        writeFileSync(
            path.join(dir, 'mathlib.js'),
            `import { clamp } from "./clamp.js";\n/* @inline */ export function norm(v) { return clamp(v) + 1; }\n`,
        );
        writeFileSync(
            path.join(dir, 'entry2.js'),
            `import { norm } from "./mathlib.js";\nexport function step(x) { return norm(x); }\n`,
        );
        const bundle = await rollup({
            input: path.join(dir, 'entry2.js'),
            plugins: [compilecat({ include: [/.*/] })],
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code).not.toContain('norm(');
        expect(code).toContain('clamp(x) + 1'); // norm inlined, clamp still referenced
        expect(code).toContain('Math.max(0, v)'); // clamp.js was resolved + bundled
    });
});

// ── (c) library inlining: bare-specifier (node_modules) donors ───────────────

describe('library inline: bare-specifier donors (via include scope)', () => {
    let dir: string;
    // Resolve the bare `mathcat` specifier to our fixture without needing
    // @rollup/plugin-node-resolve — `this.resolve` runs the full plugin chain.
    const resolveMathcat = (file: string) => ({
        name: 'resolve-mathcat',
        resolveId(source: string) {
            return source === 'mathcat' ? file : null;
        },
    });

    beforeAll(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'cc-lib-'));
        // A node_modules-shaped donor with a module const, exercising the full
        // hoist+fold machinery through a package boundary.
        writeFileSync(path.join(dir, 'mathcat.js'), `const ONE = 1;\n/* @inline */ export function inc(v) { return v + ONE; }\n`);
        writeFileSync(
            path.join(dir, 'entry.js'),
            `import { inc } from "mathcat";\n/* @optimize */ export function step(x) { return inc(x); }\n`,
        );
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    async function build(plugins: RollupOptions['plugins']): Promise<string> {
        const bundle = await rollup({
            input: path.join(dir, 'entry.js'),
            plugins,
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        return output.map((o) => ('code' in o ? o.code : '')).join('\n');
    }

    it('inlines an @inline export from a package that is in scope (include)', async () => {
        const code = await build([
            resolveMathcat(path.join(dir, 'mathcat.js')),
            compilecat({ include: [/.*/] }), // donor in scope → read + inlined
        ]);
        expect(code).not.toContain('inc('); // call inlined across the package boundary
        expect(code).toContain('x + 1'); // ONE folded by the cleanup pipeline
    });

    it('leaves the package call alone when the package is out of scope', async () => {
        const code = await build([
            resolveMathcat(path.join(dir, 'mathcat.js')),
            // Consumer is in scope, but the donor (mathcat.js) is not → not read.
            compilecat({ include: [/entry\.js$/] }),
        ]);
        expect(code).toContain('inc(x)'); // not inlined
    });

    it('follows a re-export barrel (gl-matrix shape) end-to-end', async () => {
        // package barrel re-exports a submodule as a namespace; the plugin must
        // follow `export * as vec3 from './glvec3.js'` to find the @inline donor.
        writeFileSync(path.join(dir, 'glindex.js'), `export * as vec3 from "./glvec3.js";\n`);
        writeFileSync(
            path.join(dir, 'glvec3.js'),
            `const EPSILON = 1e-6;\n/* @inline */ export function add(a, b) { return a + b; }\n`,
        );
        writeFileSync(
            path.join(dir, 'glentry.js'),
            `import { vec3 } from "glmatrix";\n/* @optimize */ export function step(x) { return vec3.add(x, 1); }\n`,
        );
        const bundle = await rollup({
            input: path.join(dir, 'glentry.js'),
            plugins: [
                {
                    name: 'resolve-glmatrix',
                    resolveId(source: string) {
                        return source === 'glmatrix' ? path.join(dir, 'glindex.js') : null;
                    },
                },
                compilecat({ include: [/.*/] }),
            ],
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code).not.toContain('vec3.add'); // member call inlined across the barrel
        expect(code).toContain('x + 1');
    });

    it('inlines namespace member calls from a package (vec.add)', async () => {
        // The realistic library shape: `import * as vec from "mathvec"` then
        // `vec.add(...)`. Donor has a module const exercised via the member call.
        writeFileSync(
            path.join(dir, 'vec.js'),
            `const EPSILON = 1e-6;\n/* @inline */ export function add(a, b) { return a + b; }\n/* @inline */ export function near(a, b) { return Math.abs(a - b) < EPSILON; }\n`,
        );
        writeFileSync(
            path.join(dir, 'nsentry.js'),
            `import * as vec from "mathvec";\n/* @optimize */ export function step(x) { return vec.add(x, 1); }\n`,
        );
        const bundle = await rollup({
            input: path.join(dir, 'nsentry.js'),
            plugins: [
                {
                    name: 'resolve-mathvec',
                    resolveId(source: string) {
                        return source === 'mathvec' ? path.join(dir, 'vec.js') : null;
                    },
                },
                compilecat({ include: [/.*/] }),
            ],
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code).not.toContain('vec.add'); // member call inlined
        expect(code).toContain('x + 1');
    });
});

// ── (d) HMR wiring: donor changes re-transform the consumer ───────────────────
// Inlining removes the import, so the bundler's module graph no longer links
// consumer→donor. `this.addWatchFile(donor)` is what re-runs the consumer's
// transform when a donor changes; assert the plugin registers it.

describe('plugin HMR wiring: addWatchFile registers donors', () => {
    it('watches the resolved donor file', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'cc-hmr-'));
        writeFileSync(path.join(dir, 'math.js'), `/* @inline */ export function add(a, b) { return a + b; }\n`);
        const watched: string[] = [];
        const ctx = {
            resolve: async (spec: string) => ({
                id: path.join(dir, spec.replace(/^\.\//, '')),
                external: false,
            }),
            addWatchFile: (f: string) => {
                watched.push(f);
            },
        };
        const plugin = compilecat({ include: [/.*/] });
        const consumer = `import { add } from "./math.js";\nexport function step(x) { return add(x, 1); }`;
        // `transform` is an object hook ({ filter, handler }); invoke its handler.
        await plugin.transform.handler.call(ctx, consumer, path.join(dir, 'entry.js'));
        expect(watched).toContain(path.join(dir, 'math.js'));
        rmSync(dir, { recursive: true, force: true });
    });
});

// ── (e) rolldown smoke: the plugin works through rolldown (the real target) ───

describe('rolldown smoke: cross-module inline through a real rolldown build', () => {
    it('inlines across modules in rolldown', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'cc-rd-'));
        writeFileSync(path.join(dir, 'math.js'), `/* @inline */ export function add(a, b) { return a + b; }\n`);
        writeFileSync(
            path.join(dir, 'entry.js'),
            `import { add } from "./math.js";\nexport function step(x) { return add(x, 1); }\n`,
        );
        const bundle = await rolldown({
            input: path.join(dir, 'entry.js'),
            plugins: [compilecat({ include: [/.*/] })],
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code).toContain('x + 1');
        expect(code).not.toContain('add(x, 1)');
        rmSync(dir, { recursive: true, force: true });
    });
});
