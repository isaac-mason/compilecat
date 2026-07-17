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
    // Strip module syntax BEFORE esbuild, so a combined dependency+consumer (which
    // has both `import { add }` and `function add`) doesn't trip a redeclare.
    const noModule = code.replace(/^\s*import[^\n]*\n?/gm, '').replace(/\bexport\s+/g, '');
    return new Function(`${stripTS(noModule)}\nreturn (${call});`)();
}

// ── (a) core cross-file behavioral equivalence ───────────────────────────────

describe('cross-file inline: core behavioral equivalence', () => {
    it('inlines an imported @inline dependency + drops the import', () => {
        const consumer = `import { add } from "./math";\nexport function step(x: number): number { return add(x, 1); }`;
        const dependency = `/* @inline */ export function add(a: number, b: number): number { return a + b; }`;

        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './math', path: '/p/math.ts', code: dependency, resolved: [] }],
            {},
        ).code;

        // import gone, call inlined
        expect(out).not.toContain('import');
        expect(out).toContain('return x + 1');

        // behavioral: compiler output ≡ original (dependency + consumer combined)
        const expected = ev(`${dependency}\n${consumer}`, 'step(41)');
        const actual = ev(out, 'step(41)');
        expect(actual).toEqual(expected);
    });

    it('renames a cross-file BLOCK dependency param colliding with a host param', () => {
        // Regression (gjkClosestPoints-class miscompile): a cross-file @inline
        // dependency whose param is `out` — same name as the @optimize host's param —
        // inlines via the BLOCK path with a `let out = <arg>` prologue. If that
        // isn't renamed away from the host param, it shadows it and the host's
        // EARLIER `out` use throws "Cannot access 'out' before initialization".
        // Caught only by RUNNING the cross-file output (a structural check misses
        // the TDZ).
        // The dependency's `out` param is inlined with an ARG that references the
        // host's `out` (`cp(out.axis, …)`), so a missed rename yields
        // `let out = out.axis` whose own RHS is in the shadow's dead zone.
        const dependency = `/* @inline */ export function cp(out: number[], a: number[]): void {\n  out[0] = a[0];\n  out[1] = a[1];\n}`;
        const consumer = `import { cp } from "./d";\nconst src = [10, 20];\n/* @optimize */ export function host(out: { axis: number[]; ok: boolean }): number {\n  cp(out.axis, src);\n  out.ok = true;\n  return out.axis[0] + out.axis[1];\n}`;

        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './d', path: '/p/d.ts', code: dependency, resolved: [] }],
            {},
        ).code;

        const arg = '{ axis: [0, 0], ok: false }';
        const expected = ev(`${dependency}\n${consumer}`, `host(${arg})`);
        const actual = ev(out, `host(${arg})`); // throws TDZ if the dependency `out` shadows the host param
        expect(actual).toEqual(expected);
    });

    it('resolves an imported tuple type for cross-module SROA', () => {
        // `Vec3` lives in the dependency; the consumer imports it and types an opaque
        // aggregate with it. Cross-module type resolution gives the arity so SROA
        // destructures `mk()` into scalars — behaviorally identical.
        const consumer = `import { Vec3 } from "./math";
function mk(): Vec3 { return [10, 20, 30]; }
/* @sroa */ export function f(): number { const v: Vec3 = mk(); v[0] = v[1] + v[2]; return v[0]; }`;
        const dependency = `export type Vec3 = [number, number, number];`;

        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './math', path: '/p/math.ts', code: dependency, resolved: [] }],
            {},
        ).code;

        // SROA fired (scalars present, indexing gone) — driven by the imported type.
        expect(out).toContain('v_0');
        expect(out).not.toContain('v[1]');

        const expected = ev(`${dependency}\n${consumer}`, 'f()');
        expect(ev(out, 'f()')).toEqual(expected);
        expect(expected).toEqual(50);
    });

    it('resolves an imported interface for cross-module object SROA', () => {
        // `Vec3` is an interface in the dependency; the consumer imports it and types
        // an opaque aggregate. Cross-module resolution gives the field set so SROA
        // destructures `mk()` into named scalars.
        const consumer = `import { Vec3 } from "./math";
function mk(): Vec3 { return { x: 4, y: 5, z: 6 }; }
/* @sroa */ export function f(): number { const v: Vec3 = mk(); v.x = v.y + v.z; return v.x; }`;
        const dependency = `export interface Vec3 { x: number; y: number; z: number }`;

        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './math', path: '/p/math.ts', code: dependency, resolved: [] }],
            {},
        ).code;

        expect(out).toContain('v_x');
        expect(out).not.toContain('v.x');

        const expected = ev(`${dependency}\n${consumer}`, 'f()');
        expect(ev(out, 'f()')).toEqual(expected);
        expect(expected).toEqual(11);
    });

    it('hoists a dependency module const and folds it (copy-then-clean)', () => {
        const consumer = `import { scale } from "./m";\nexport function f(x: number): number { return scale(x); }`;
        const dependency = `const FACTOR = 3;\n/* @inline */ export function scale(v: number): number { return v * FACTOR; }`;
        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './m', path: '/p/m.ts', code: dependency, resolved: [] }],
            {},
        ).code;
        // inlined; literal const folded away by the cleanup pipeline; import gone
        expect(out).not.toContain('import');
        expect(out).not.toContain('scale');
        expect(out).toContain('x * 3');

        const expected = ev(`${dependency}\n${consumer}`, 'f(14)');
        const actual = ev(out, 'f(14)');
        expect(actual).toEqual(expected);
    });

    it('copies a non-literal const dep and stays behaviorally equivalent', () => {
        const consumer = `import { origin } from "./m";\nexport function f(): number[] { return origin(); }`;
        const dependency = `const ZERO = [0, 0, 0];\n/* @inline */ export function origin(): number[] { return ZERO; }`;
        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './m', path: '/p/m.ts', code: dependency, resolved: [] }],
            {},
        ).code;
        // array const isn't foldable → copied into the consumer, still referenced
        expect(out).not.toContain('origin(');
        expect(out).toContain('ZERO');

        const expected = ev(`${dependency}\n${consumer}`, 'JSON.stringify(f())');
        const actual = ev(out, 'JSON.stringify(f())');
        expect(actual).toEqual(expected);
    });

    it('forwards a bare-specifier import dep the dependency body needs', () => {
        const consumer = `import { norm } from "./m";\nexport function f(x: number): number { return norm(x); }`;
        const dependency = `import { clamp } from "math-utils";\n/* @inline */ export function norm(v: number): number { return clamp(v); }`;
        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './m', path: '/p/m.ts', code: dependency, resolved: [] }],
            {},
        ).code;
        // inlined, and the bare import forwarded verbatim (one shared binding)
        expect(out).not.toContain('norm(');
        expect(out).toContain('clamp(x)');
        expect(out).toContain('from "math-utils"');
    });

    it('rebases a relative import dep to the consumer location', () => {
        const consumer = `import { norm } from "../lib/m";\nexport function f(x: number): number { return norm(x); }`;
        const dependency = `import { clamp } from "./util";\n/* @inline */ export function norm(v: number): number { return clamp(v); }`;
        const out = compiler.compileFileCross(
            '/proj/app/entry.ts',
            consumer,
            [{ specifier: '../lib/m', path: '/proj/lib/m.ts', code: dependency, resolved: [] }],
            {},
        ).code;
        expect(out).toContain('clamp(x)');
        // ./util next to the dependency (/proj/lib) seen from /proj/app → ../lib/util
        expect(out).toContain('from "../lib/util"');
    });

    it('does not hoist an inline call out of a bare if-branch (cross-file, pre-normalize)', () => {
        // Found by the cross-file fuzzer. The cross-file path inlines BEFORE the
        // local pipeline's normalize, so a consumer @inline helper with a BARE
        // (non-block) `if (c) return d(...)` branch hit the inliner un-block-wrapped.
        // Inlining `d` there hoisted its eval-once `_inl_arg` temp to BEFORE the
        // `if` (unconditional) — and since the call was recursive, every call
        // recursed → "Maximum call stack size exceeded". The Inliner now sets
        // `no_hoist` inside bare conditional statement positions.
        const dependency = `/* @inline */ export function d1(a, b) { return Math.max(Math.abs(b), b); }`;
        const consumer = `import { d1 } from "./dependency";
/* @inline */ function h0(a, b) { if (a < (d1(b, 4) <= d1(b, a) ? a : 1)) return d1(Math.max(4, b), h0(b, 7)); return 7; }
/* @optimize */ export function entry(p, q) { p *= q; return (5 >= h0(7, p) ? Math.max(p, 6) : Math.max(0, p)); }`;
        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [{ specifier: './dependency', path: '/p/dependency.ts', code: dependency, resolved: [] }],
            {},
        ).code;
        const expected = ev(`${dependency}\n${consumer}`, 'entry(7, 3)');
        const actual = ev(`${dependency}\n${out}`, 'entry(7, 3)');
        expect(actual).toEqual(expected);
    });
});

// ── (a2) cross-file behavioral matrix — every BLOCK/DIRECT body shape, RUN the
//     output (a TDZ/shadow miscompile only throws at execution; structural
//     assertions miss it). This is the coverage gap that let the gjkClosestPoints
//     `let out` shadow ship. Each case: inline a `./d` dependency into an `@optimize`
//     host, then assert compiled-output ≡ original by evaluating both. ──────────

type XfCase = { name: string; dependency: string; host: string; call: string };

const XF_MATRIX: XfCase[] = [
    {
        name: 'single-return object literal, field-read',
        dependency: `/* @inline */ export function mk(a: number, b: number) { return { x: a, y: b }; }`,
        host: `import { mk } from "./d";\n/* @optimize */ export function f(p: number): number { const v = mk(p, p + 1); return v.x * v.y; }`,
        call: 'f(4)',
    },
    {
        name: 'single-return with prologue (normalize shape)',
        dependency: `/* @inline */ export function norm(a: { x: number; y: number }) { const l = Math.abs(a.x) + Math.abs(a.y) || 1; return { x: a.x / l, y: a.y / l }; }`,
        host: `import { norm } from "./d";\n/* @optimize */ export function f(px: number, py: number): number { const d = norm({ x: px, y: py }); return d.x + d.y; }`,
        call: 'f(3, 5)',
    },
    {
        name: 'multi-return body (genuinely deferred)',
        dependency: `/* @inline */ export function pick(c: boolean, a: number, b: number) { if (c) return { v: a }; return { v: b }; }`,
        host: `import { pick } from "./d";\n/* @optimize */ export function f(c: boolean, n: number): number { const r = pick(c, n, -n); return r.v * 2; }`,
        call: 'f(true, 7)',
    },
    {
        name: 'void dependency mutating an out param',
        dependency: `/* @inline */ export function cp(out: number[], a: number[]): void { out[0] = a[0]; out[1] = a[1]; }`,
        host: `import { cp } from "./d";\n/* @optimize */ export function f(): number { const o = [0, 0]; cp(o, [10, 20]); return o[0] + o[1]; }`,
        call: 'f()',
    },
    {
        name: 'PARAM COLLISION: dependency param `out` == host param `out`',
        dependency: `/* @inline */ export function neg(out: number[], a: number[]): void { out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; }`,
        host: `import { neg } from "./d";\nconst scratch = [1, 2, 3];\n/* @optimize */ export function host(out: { axis: number[]; started: boolean }): number { out.started = true; neg(out.axis, scratch); return out.axis[0] + out.axis[1] + out.axis[2] + (out.started ? 0 : 99); }`,
        call: 'host({ axis: [0, 0, 0], started: false })',
    },
    {
        name: 'PARAM COLLISION + arg references the host param',
        dependency: `/* @inline */ export function cp(out: number[], a: number[]): void { out[0] = a[0]; out[1] = a[1]; }`,
        host: `import { cp } from "./d";\nconst src = [10, 20];\n/* @optimize */ export function host(out: { axis: number[]; ok: boolean }): number { out.ok = true; cp(out.axis, src); return out.axis[0] + out.axis[1] + (out.ok ? 0 : 99); }`,
        call: 'host({ axis: [0, 0], ok: false })',
    },
    {
        name: 'PARAM COLLISION used BEFORE and AFTER the inlined call (TDZ-prone)',
        dependency: `/* @inline */ export function setLen(out: { v: number }, k: number): void { const t = k + 1; out.v = t * 2; }`,
        host: `import { setLen } from "./d";\n/* @optimize */ export function host(out: { v: number; seen: number }): number { out.seen = out.v; setLen(out, 5); return out.seen + out.v; }`,
        call: 'host({ v: 3, seen: 0 })',
    },
    {
        name: 'two inlined calls in one host (id/rename uniqueness)',
        dependency: `/* @inline */ export function add(a: { x: number }, b: { x: number }) { return { x: a.x + b.x }; }`,
        host: `import { add } from "./d";\n/* @optimize */ export function f(): number { const p = add({ x: 1 }, { x: 2 }); const q = add({ x: 10 }, { x: 20 }); return p.x + q.x; }`,
        call: 'f()',
    },
    {
        name: 'early-return guard then value',
        dependency: `/* @inline */ export function safe(x: number) { if (x < 0) return { v: 0 }; return { v: x * 2 }; }`,
        host: `import { safe } from "./d";\n/* @optimize */ export function f(n: number): number { const r = safe(n); return r.v; }`,
        call: 'f(-3)',
    },
    {
        name: 'return array (tuple)',
        dependency: `/* @inline */ export function pair(a: number, b: number): [number, number] { return [a + 1, b + 1]; }`,
        host: `import { pair } from "./d";\n/* @optimize */ export function f(a: number, b: number): number { const v = pair(a, b); return v[0] * v[1]; }`,
        call: 'f(2, 3)',
    },
    {
        name: 'return scalar (no aggregate)',
        dependency: `/* @inline */ export function len2(a: { x: number; y: number }): number { const s = a.x * a.x + a.y * a.y; return s; }`,
        host: `import { len2 } from "./d";\n/* @optimize */ export function f(x: number, y: number): number { const r = len2({ x, y }); return r + 1; }`,
        call: 'f(3, 4)',
    },
    {
        name: 'inlined-result used as an arg to a second inlined call (chain)',
        dependency: `/* @inline */ export function sub(a: { x: number }, b: { x: number }) { return { x: a.x - b.x }; }\n/* @inline */ export function scale(a: { x: number }, s: number) { return { x: a.x * s }; }`,
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
                [{ specifier: './d', path: '/p/d.ts', code: c.dependency, resolved: [] }],
                {},
            ).code;
            const expected = ev(`${c.dependency}\n${c.host}`, c.call);
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
            // Consumer opts in with `@optimize` — under the demand-driven pull model
            // the frontier only gathers dependencies a directive references, so the caller
            // must carry a directive (the old push-from-a-directiveless-caller is gone).
            `import { add } from "./math.js";\n/* @optimize */ export function step(x) { return add(x, 1); }\n`,
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

    it('inlines an in-project @inline def at a DIRECTIVE-LESS caller (mark once, inline everywhere)', async () => {
        // The C++-`inline`-style ergonomic: `./h` marks `helper` `/* @inline */`, and a
        // consumer with NO directive of its own that merely CALLS `helper` still gets it
        // inlined. The build-start `@inline`-def index (scanRoot = this dir) lets the gate
        // through and feeds the frontier so `./h` is gathered and the body spliced.
        writeFileSync(path.join(dir, 'h.js'), `/* @inline */ export function helper(a) { return a * 2; }\n`);
        writeFileSync(
            path.join(dir, 'defentry.js'),
            `import { helper } from "./h.js";\nexport function f(x) { return helper(x) + 1; }\n`,
        );
        const bundle = await rollup({
            input: path.join(dir, 'defentry.js'),
            plugins: [compilecat({ include: [/.*/], scanRoot: dir })],
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code, `helper should inline at the directive-less caller:\n${code}`).not.toContain('helper(');
        expect(code).toContain('x * 2 + 1'); // helper body spliced into f
    });

    it('leaves a call alone when the callee is NOT @inline (control)', async () => {
        // A directive-less consumer calling a NON-`@inline` `plain` export must NOT
        // inline — `plain` isn't in the def index, so the gate short-circuits the
        // consumer and the call survives.
        writeFileSync(path.join(dir, 'plain.js'), `export function plain(a) { return a * 2; }\n`);
        writeFileSync(
            path.join(dir, 'plainentry.js'),
            `import { plain } from "./plain.js";\nexport function f(x) { return plain(x) + 1; }\n`,
        );
        const bundle = await rollup({
            input: path.join(dir, 'plainentry.js'),
            plugins: [compilecat({ include: [/.*/], scanRoot: dir })],
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code, `plain (non-@inline) stays a call:\n${code}`).toContain('plain(x)');
    });

    it('inlines an @inline def marked with a multi-line JSDoc block (the production form)', async () => {
        // crashcat's real markers are multi-line JSDoc (`* @inline` on its own line, then
        // `*/`, then `export function`), NOT the single-line `/* @inline */` form. The
        // index regex must catch it — this is the exact shape the shipped code relies on.
        writeFileSync(
            path.join(dir, 'jh.js'),
            `/**\n * Doubles its argument.\n *\n * @inline\n */\nexport function helper(a) { return a * 2; }\n`,
        );
        writeFileSync(
            path.join(dir, 'jentry.js'),
            `import { helper } from "./jh.js";\nexport function f(x) { return helper(x) + 1; }\n`,
        );
        const bundle = await rollup({
            input: path.join(dir, 'jentry.js'),
            plugins: [compilecat({ include: [/.*/], scanRoot: dir })],
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code, `JSDoc-marked @inline def should inline:\n${code}`).not.toContain('helper(');
        expect(code).toContain('x * 2 + 1');
    });

    it('inlines an @inline def declared as a const arrow', async () => {
        writeFileSync(path.join(dir, 'ah.js'), `/* @inline */ export const helper = (a) => a * 2;\n`);
        writeFileSync(
            path.join(dir, 'aentry.js'),
            `import { helper } from "./ah.js";\nexport function f(x) { return helper(x) + 1; }\n`,
        );
        const bundle = await rollup({
            input: path.join(dir, 'aentry.js'),
            plugins: [compilecat({ include: [/.*/], scanRoot: dir })],
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code, `const-arrow @inline def should inline:\n${code}`).not.toContain('helper(');
        expect(code).toContain('x * 2 + 1');
    });

    it('inlines an @inline def at MULTIPLE call-sites and across MULTIPLE directive-less callers', async () => {
        // "mark once, inline everywhere" — the def is inlined at every call, in every
        // directive-less consumer that imports it, not just the first site.
        writeFileSync(path.join(dir, 'mh.js'), `/* @inline */ export function helper(a) { return a * 2; }\n`);
        writeFileSync(
            path.join(dir, 'mentry.js'),
            `import { helper } from "./mh.js";\nimport { g } from "./mcaller.js";\n` +
                `export function f(x) { return helper(x) + helper(x + 1); }\nexport { g };\n`,
        );
        writeFileSync(
            path.join(dir, 'mcaller.js'),
            `import { helper } from "./mh.js";\nexport function g(y) { return helper(y) - 3; }\n`,
        );
        const bundle = await rollup({
            input: path.join(dir, 'mentry.js'),
            plugins: [compilecat({ include: [/.*/], scanRoot: dir })],
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code, `every helper call across both callers should inline:\n${code}`).not.toContain('helper(');
        expect(code).toContain('x * 2 + (x + 1) * 2'); // both sites in f
        expect(code).toContain('y * 2 - 3'); // the site in g
    });

    it('does NOT inline an @inline def when a local param SHADOWS its name (soundness)', async () => {
        // The gate fires on the NAME `helper`, but at the call site `helper` is the
        // parameter, not the imported @inline def — the call must be left alone. Inlining
        // the def here would silently discard the caller's own argument.
        writeFileSync(path.join(dir, 'sh.js'), `/* @inline */ export function helper(a) { return a * 2; }\n`);
        writeFileSync(
            path.join(dir, 'sentry.js'),
            `import { helper } from "./sh.js";\nexport function f(helper) { return helper(10); }\n`,
        );
        const bundle = await rollup({
            input: path.join(dir, 'sentry.js'),
            plugins: [compilecat({ include: [/.*/], scanRoot: dir })],
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code, `shadowed local helper must stay a call, not inline the def:\n${code}`).toContain('helper(10)');
        expect(code).not.toContain('10 * 2');
    });

    it('forwards a dependency import dep and the bundler resolves it', async () => {
        // dependency (mathlib) needs `clamp` from a sibling file; after inlining norm
        // into entry, the forwarded `./clamp.js` import must still resolve+bundle.
        writeFileSync(path.join(dir, 'clamp.js'), `export function clamp(v) { return Math.max(0, v); }\n`);
        writeFileSync(
            path.join(dir, 'mathlib.js'),
            `import { clamp } from "./clamp.js";\n/* @inline */ export function norm(v) { return clamp(v) + 1; }\n`,
        );
        writeFileSync(
            path.join(dir, 'entry2.js'),
            `import { norm } from "./mathlib.js";\n/* @optimize */ export function step(x) { return norm(x); }\n`,
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

// ── (c) library inlining: bare-specifier (node_modules) dependencies ───────────────

describe('library inline: bare-specifier dependencies (via include scope)', () => {
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
        // A node_modules-shaped dependency with a module const, exercising the full
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
            compilecat({ include: [/.*/] }), // dependency in scope → read + inlined
        ]);
        expect(code).not.toContain('inc('); // call inlined across the package boundary
        expect(code).toContain('x + 1'); // ONE folded by the cleanup pipeline
    });

    it('leaves the package call alone when the package is out of scope', async () => {
        const code = await build([
            resolveMathcat(path.join(dir, 'mathcat.js')),
            // Consumer is in scope, but the dependency (mathcat.js) is not → not read.
            compilecat({ include: [/entry\.js$/] }),
        ]);
        expect(code).toContain('inc(x)'); // not inlined
    });

    it('follows a re-export barrel (gl-matrix shape) end-to-end', async () => {
        // package barrel re-exports a submodule as a namespace; the plugin must
        // follow `export * as vec3 from './glvec3.js'` to find the @inline dependency.
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

    it('follows a re-exported imported binding (mathcat quat-as-vec4) end-to-end', async () => {
        // The value-side of the re-export graph: a submodule re-binds another
        // submodule's function under its own exported name (`import { set as
        // set$1 } from './qvec4.js'; const set = set$1; export { set }` — exactly
        // how mathcat's quat re-uses vec4's componentwise ops). The plugin must
        // follow that PLAIN import (not just re-export edges) so the defining
        // module is read as a dependency, and the core must follow the const-alias to
        // the real function. Neither happened before: the call survived, pinning
        // the scratch as a module array.
        writeFileSync(
            path.join(dir, 'qvec4.js'),
            `export function set(out, x, y, z, w) { out[0] = x; out[1] = y; out[2] = z; out[3] = w; return out; }\n`,
        );
        writeFileSync(
            path.join(dir, 'qquat.js'),
            `import { set as set$1 } from "./qvec4.js";\nconst set = set$1;\nexport { set };\n`,
        );
        writeFileSync(
            path.join(dir, 'qentry.js'),
            `import { set } from "qmat";\nconst s = [0, 0, 0, 0];\n/* @optimize */ export function step() { set(s, 1, 2, 3, 4); return s[0] + s[3]; }\n`,
        );
        const bundle = await rollup({
            input: path.join(dir, 'qentry.js'),
            plugins: [
                {
                    name: 'resolve-qmat',
                    resolveId(source: string) {
                        return source === 'qmat' ? path.join(dir, 'qquat.js') : null;
                    },
                },
                compilecat({ include: [/.*/] }),
            ],
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code, `set() should inline across the re-binding:\n${code}`).not.toContain('set(');
        // Call inlined → scratch `s` scalarized → arithmetic folded to a constant.
        expect(code).toContain('return 5');
    });

    it('follows a MINIFIED re-exported imported binding end-to-end (AST dependency edges)', async () => {
        // The brittleness fix: the SAME quat-as-vec4 value re-bind as above, but
        // MINIFIED — no spaces, on fewer lines (`import{set as set$1}from"./mv.js";
        // const set=set$1;export{set}`). The OLD `reexportedImportSources` regex
        // (`import\s+{`) MISSED this, so `./mv.js` was never read as a dependency and the
        // call survived. The core's AST-based `dependencyEdges` now finds the edge, so the
        // defining module is gathered and the call is inlined through a real rollup build.
        writeFileSync(
            path.join(dir, 'mv.js'),
            `export function set(out, x, y, z, w) { out[0] = x; out[1] = y; out[2] = z; out[3] = w; return out; }\n`,
        );
        // Minified barrel: no whitespace inside the import clause, single line, no
        // trailing `;` after the export clause (ASI) — every shape the regex missed.
        writeFileSync(path.join(dir, 'mquat.js'), `import{set as set$1}from"./mv.js";const set=set$1;export{set}`);
        writeFileSync(
            path.join(dir, 'mentry.js'),
            `import { set } from "mmat";\nconst s = [0, 0, 0, 0];\n/* @optimize */ export function step() { set(s, 1, 2, 3, 4); return s[0] + s[3]; }\n`,
        );
        const bundle = await rollup({
            input: path.join(dir, 'mentry.js'),
            plugins: [
                {
                    name: 'resolve-mmat',
                    resolveId(source: string) {
                        return source === 'mmat' ? path.join(dir, 'mquat.js') : null;
                    },
                },
                compilecat({ include: [/.*/] }),
            ],
            onwarn: () => {},
        });
        const { output } = await bundle.generate({ format: 'es' });
        const code = output.map((o) => ('code' in o ? o.code : '')).join('\n');
        expect(code, `minified re-bind should inline (AST dependency edges):\n${code}`).not.toContain('set(');
        expect(code).toContain('return 5');
    });

    it('inlines namespace member calls from a package (vec.add)', async () => {
        // The realistic library shape: `import * as vec from "mathvec"` then
        // `vec.add(...)`. Dependency has a module const exercised via the member call.
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

// ── (d) HMR wiring: dependency changes re-transform the consumer ───────────────────
// Inlining removes the import, so the bundler's module graph no longer links
// consumer→dependency. `this.addWatchFile(dependency)` is what re-runs the consumer's
// transform when a dependency changes; assert the plugin registers it.

describe('plugin HMR wiring: addWatchFile registers dependencies', () => {
    it('watches the resolved dependency file', async () => {
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
        // `@optimize` opts the consumer into gathering — the pull model only reads
        // dependencies a directive references, so the dependency is watched only then.
        const consumer = `import { add } from "./math.js";\n/* @optimize */ export function step(x) { return add(x, 1); }`;
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
            `import { add } from "./math.js";\n/* @optimize */ export function step(x) { return add(x, 1); }\n`,
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
