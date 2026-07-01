// Real-world correctness (+ a place to track optimality) on code lifted from
// crashcat — the physics workloads compilecat exists to optimize. Unlike the
// synthetic fuzzer, these are authored hot kernels (dense vec3 math, out-param
// writes, branch-heavy). Each fixture is compiled and its output is checked to
// compute IDENTICAL results to the source over random inputs — a real miscompile
// on real code shows up here even if the fuzzer's grammar never generates it.

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
    return transformSync(tsCode, { loader: 'ts' }).code.replace(/\bexport\s*\{[^}]*\}\s*;?/g, '').replace(/\bexport\s+/g, '');
}

/** A deterministic PRNG in [-range, range]. */
function prng(seed: number, range: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
        return (s / 0x7fffffff) * 2 * range - range;
    };
}

describe('real-world: crashcat GJK kernels', () => {
    it('computeClosestPointOnTriangle — compiled ≡ source (10k random triangles)', () => {
        const ts = readFileSync(
            resolve(here, 'fixtures/real-world/gjk-closest-point-on-triangle.ts'),
            'utf8',
        );
        const compiled = compiler.compileChunk('gjk.ts', ts, {}).code;

        const call =
            'const out = { point: [0, 0, 0], pointSet: 0 };' +
            'computeClosestPointOnTriangle(out, A, B, Cc, must, tol); return out;';
        // biome-ignore lint/security/noGlobalEval: evaluating generated/compiled code under test
        const src = new Function('A', 'B', 'Cc', 'must', 'tol', `${toJs(ts)}\n${call}`);
        // biome-ignore lint/security/noGlobalEval: evaluating generated/compiled code under test
        const opt = new Function('A', 'B', 'Cc', 'must', 'tol', `${toJs(compiled)}\n${call}`);

        const r = prng(0xc0ffee, 2);
        for (let i = 0; i < 10000; i++) {
            const A = [r(), r(), r()];
            const B = [r(), r(), r()];
            const Cc = [r(), r(), r()];
            const must = i % 2 === 0;
            const s = src(A, B, Cc, must, 1e-12);
            const o = opt(A, B, Cc, must, 1e-12);
            expect(o, `triangle #${i} A=${A} B=${B} C=${Cc} must=${must}`).toEqual(s);
        }
    });
});

// The GJK inspection surfaced a real, concrete optimality gap: compilecat has NO
// common-subexpression-elimination / load-hoisting, so source-level redundancy
// (`cx-ax` computed as both `ac_x` and `ac2x`, `inC[0]` loaded 6×) passes through.
// It is NOT the compiler pessimizing — it just doesn't dedupe. These minimal cases
// PIN the current (pre-CSE) output; when a purity-gated CSE pass lands the counts
// drop and these asserts flip — a visible win, tracked here, not a silent gap.
describe('optimality gaps — CSE / load-hoisting (v2 target, tracked)', () => {
    const optCount = (body: string, re: RegExp): number => {
        const out = compiler.compileChunk(
            'g.ts',
            `/* @optimize */ export function f(a: number, b: number, v: number[]): number { ${body} }`,
            {},
        ).code;
        return (out.match(re) || []).length;
    };

    it('pure duplicate subexpr recomputed (v2 CSE → 1)', () => {
        // `(a-b)*(a-b) + (a-b)` — `a-b` is pure, computed 3× today.
        expect(optCount('return (a - b) * (a - b) + (a - b);', /a - b/g)).toBe(3);
    });

    it('repeated array load not hoisted (v2 load-hoist → 1)', () => {
        // `v[0]` (member read, assumed pure) loaded 3× today.
        expect(optCount('return v[0] * v[0] + v[0];', /v\[0\]/g)).toBe(3);
    });
});
