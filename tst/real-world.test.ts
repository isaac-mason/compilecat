// Real-world correctness (+ a place to track optimality) on code lifted from
// crashcat/mathcat — the physics workloads compilecat exists to optimize. Unlike
// the synthetic fuzzer, these are authored hot kernels (dense vec3 math, out-param
// writes, branch-heavy, nested @inline). Each kernel is compiled and its output is
// checked to compute IDENTICAL results to the source over random inputs — a real
// miscompile on real code shows up here even if the fuzzer's grammar never
// generates the shape. `@optimize` is added to the fixture *copies* only; the
// crashcat/mathcat sources are never modified.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { createCompiler } from '../src/compiler';

const compiler = createCompiler();
const here = dirname(fileURLToPath(import.meta.url));

/** Strip TS → runnable JS, drop the ESM export so `new Function` can eval it. */
function toJs(tsCode: string): string {
    return transformSync(tsCode, { loader: 'ts' }).code
        .replace(/\bexport\s*\{[^}]*\}\s*;?/g, '')
        .replace(/\bexport\s+/g, '');
}

/** Deterministic PRNG in [-range, range]. */
function prng(seed: number, range: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
        return (s / 0x7fffffff) * 2 * range - range;
    };
}
const v3 = (r: () => number): number[] => [r(), r(), r()];
const q4 = (r: () => number): number[] => [r(), r(), r(), r()];
const vn = (n: number) => (r: () => number): number[] => Array.from({ length: n }, r);

type Kernel = {
    name: string;
    fixture: string;
    params: string[];
    /** Statement body that calls the entry and `return`s the observable result. */
    callBody: string;
    inputs: (r: () => number, i: number) => unknown[];
};

const KERNELS: Kernel[] = [
    {
        name: 'gjk computeClosestPointOnTriangle',
        fixture: 'gjk-closest-point-on-triangle.ts',
        params: ['A', 'B', 'Cc', 'must', 'tol'],
        callBody:
            'const out = { point: [0, 0, 0], pointSet: 0 };' +
            'computeClosestPointOnTriangle(out, A, B, Cc, must, tol); return out;',
        inputs: (r, i) => [v3(r), v3(r), v3(r), i % 2 === 0, 1e-12],
    },
    {
        name: 'barycentric computeBarycentricCoordinates3d (3d → @inline 2d)',
        fixture: 'barycentric-coordinates.ts',
        params: ['A', 'B', 'Cc', 'tol'],
        callBody:
            'const out = { u: 0, v: 0, w: 0, isValid: false };' +
            'computeBarycentricCoordinates3d(out, A, B, Cc, tol); return out;',
        inputs: (r, i) => [v3(r), v3(r), v3(r), i % (2 + (i & 1)) === 0 ? 1e-12 : 1e-2],
    },
    {
        name: 'module-scratch: updatePosition (direct vec3 scratch → scalarized)',
        fixture: 'scratch-transform-point.ts',
        params: ['scm', 'quat', 'com'],
        callBody: 'const out = [0, 0, 0]; updatePosition(out, scm, quat, com); return out;',
        inputs: (r) => [v3(r), q4(r), v3(r)],
    },
    {
        name: 'module-scratch: updatePositionAliased (local-alias scratch → v1 bails)',
        fixture: 'scratch-transform-point.ts',
        params: ['scm', 'quat', 'com'],
        callBody: 'const out = [0, 0, 0]; updatePositionAliased(out, scm, quat, com); return out;',
        inputs: (r) => [v3(r), q4(r), v3(r)],
    },
    {
        name: 'module-scratch: tangent (direct vec3 cross scratch → scalarized)',
        fixture: 'scratch-transform-point.ts',
        params: ['a', 'b', 'c'],
        callBody: 'const out = [0, 0, 0]; tangent(out, a, b, c); return out;',
        inputs: (r) => [v3(r), v3(r), v3(r)],
    },
    {
        name: 'real-world: sleepTestPoints (3-way branch; vec3 scratch scalarizes, mat3 dynamic-index bails)',
        fixture: 'sleep-test-points.ts',
        params: ['com', 'aabb', 'quat'],
        callBody:
            'const o0=[0,0,0], o1=[0,0,0], o2=[0,0,0];' +
            'sleepTestPoints(o0, o1, o2, com, aabb, quat); return [o0, o1, o2];',
        inputs: (r) => [v3(r), vn(6)(r), q4(r)],
    },
    {
        name: 'real-world: closestOnSimplex (switch-dispatch → scratch scalarizes)',
        fixture: 'simplex-closest.ts',
        params: ['size', 'y'],
        callBody: 'const out = [0, 0, 0]; closestOnSimplex(out, size, y); return out;',
        inputs: (r, i) => [1 + (i % 4), vn(12)(r)],
    },
];

describe('real-world: crashcat/mathcat kernels — compiled ≡ source', () => {
    for (const k of KERNELS) {
        it(`${k.name} (10k random inputs)`, () => {
            const ts = readFileSync(resolve(here, 'fixtures/real-world', k.fixture), 'utf8');
            const compiled = compiler.compileChunk(k.fixture, ts, {}).code;
            const make = (code: string) =>
                // biome-ignore lint/security/noGlobalEval: evaluating compiled code under test
                new Function(...k.params, `${toJs(code)}\n${k.callBody}`);
            const src = make(ts);
            const opt = make(compiled);

            const r = prng(0xc0ffee, 2);
            for (let i = 0; i < 10000; i++) {
                const args = k.inputs(r, i);
                expect(opt(...args), `${k.name} #${i} args=${JSON.stringify(args)}`).toEqual(
                    src(...args),
                );
            }
        });
    }
});

// The GJK inspection surfaced a concrete pattern: compilecat has NO common-
// subexpression-elimination / value-numbering, so source-level redundancy (`cx-ax`
// as both `ac_x` and `ac2x`; `inC[0]` loaded 6×) passes through. Closure also has
// no GVN — it relies on the JIT. BUT whether that's the right call for compilecat
// is UNMEASURED and OPEN: (a) V8's load-elimination is bounded by effect analysis —
// it must reload across any call it can't prove pure, and compilecat's purity
// analysis is exactly what could CSE across a PURE call (JIT-impossible); (b) naive
// microbenchmarks of JIT load-elimination are unreliable (gave contradictory 2.1× /
// 0.95× / 0.15× results). A proper end-to-end benchmark on a real kernel is needed
// before deciding. These cases just PIN today's output so a future CSE pass is a
// visible, deliberate change — NOT a claim that skipping it is optimal.
// Module-scratch scalar replacement (SROA GlobalOpt-localize) on the real crashcat
// patterns: a module-level `const _s = /*@__PURE__*/ vec3.create()` reused as
// per-call scratch. Pins v1's coverage — what actually fires on production shapes —
// so a change (v2 alias-following, wider window) is a visible, deliberate move. The
// KERNELS above already prove these compile ≡ source; this pins the OPTIMIZATION.
describe('module-scratch scalar replacement — real crashcat patterns', () => {
    const compiledFixture = (fixture: string): string =>
        compiler.compileChunk(
            fixture,
            readFileSync(resolve(here, 'fixtures/real-world', fixture), 'utf8'),
            {},
        ).code;

    it('DIRECT scratch use scalarizes (const deleted, member reads → scalars)', () => {
        const out = compiledFixture('scratch-transform-point.ts');
        // The directly-used scratch buffers become scalar locals and their consts go.
        expect(out).toMatch(/_scratch_0/);
        expect(out).not.toContain('const _scratch =');
        expect(out).toMatch(/_scratchCross_0/);
        expect(out).not.toContain('const _scratchCross =');
    });

    it('LOCAL-ALIAS scratch use scalarizes (v2 alias-following)', () => {
        const out = compiledFixture('scratch-transform-point.ts');
        // `const s = _scratchAliased; …s[i]…` — the alias `s` is scalarized and BOTH
        // the alias decl and the module const are deleted.
        expect(out).not.toContain('const _scratchAliased');
        expect(out).toMatch(/\bs_0\b/);
    });

    it('sleepTestPoints: literal-indexed vec3 scratch scalarizes, dynamic-indexed mat3 bails', () => {
        const out = compiledFixture('sleep-test-points.ts');
        expect(out).not.toContain('const _extents'); // literal-indexed → scalarized
        expect(out).not.toContain('const _axis'); //    literal-indexed → scalarized
        expect(out).toContain('const _rot'); //          `_rot[c1]` dynamic index → bails
    });

    it('closestOnSimplex: switch-dispatch scratch scalarizes (v3 CFG)', () => {
        const out = compiledFixture('simplex-closest.ts');
        // every case writes all fields → must-written at the post-switch read.
        expect(out).not.toContain('const _closest');
        expect(out).toMatch(/_closest_0/);
    });
});

describe('optimality gaps — CSE / GVN (UNMEASURED trade-off; tracked, not yet decided)', () => {
    const optCount = (body: string, re: RegExp): number => {
        const out = compiler.compileChunk(
            'g.ts',
            `/* @optimize */ export function f(a: number, b: number, v: number[]): number { ${body} }`,
            {},
        ).code;
        return (out.match(re) || []).length;
    };

    it('pure duplicate subexpr recomputed (left to the JIT)', () => {
        expect(optCount('return (a - b) * (a - b) + (a - b);', /a - b/g)).toBe(3);
    });

    it('repeated array load not hoisted (left to the JIT)', () => {
        expect(optCount('return v[0] * v[0] + v[0];', /v\[0\]/g)).toBe(3);
    });
});
