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
import { MATHCAT_COMPOSITES, MATHCAT_CORPUS } from './fixtures/corpus/mathcat';

const compiler = createCompiler();
const here = dirname(fileURLToPath(import.meta.url));

/** Strip TS → runnable JS, drop the ESM export so `new Function` can eval it. */
function toJs(tsCode: string): string {
    return transformSync(tsCode, { loader: 'ts' })
        .code.replace(/\bexport\s*\{[^}]*\}\s*;?/g, '')
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
const vn =
    (n: number) =>
    (r: () => number): number[] =>
        Array.from({ length: n }, r);

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
            'const o0=[0,0,0], o1=[0,0,0], o2=[0,0,0];' + 'sleepTestPoints(o0, o1, o2, com, aabb, quat); return [o0, o1, o2];',
        inputs: (r) => [v3(r), vn(6)(r), q4(r)],
    },
    {
        name: 'real-world: closestOnSimplex (switch-dispatch → scratch scalarizes)',
        fixture: 'simplex-closest.ts',
        params: ['size', 'y'],
        callBody: 'const out = [0, 0, 0]; closestOnSimplex(out, size, y); return out;',
        inputs: (r, i) => [1 + (i % 4), vn(12)(r)],
    },
    {
        name: 'real-world: dbvt castRay (transitive set→copy inline; multi-return rayDistanceToBox3)',
        fixture: 'dbvt-cast-ray.ts',
        params: ['origin', 'direction', 'length', 'boxes'],
        callBody: 'return castRay(origin, direction, length, boxes);',
        inputs: (r) => [v3(r), v3(r), 1 + Math.abs(r()), Array.from({ length: 5 }, () => aabb(r))],
    },
    {
        name: 'real-world: quat slerp (dot-sign-flip branch + acos/sin trig + conditional-def temps)',
        fixture: 'quat-slerp.ts',
        params: ['a', 'b', 't'],
        callBody: 'const out = [0, 0, 0, 0]; slerp(out, a, b, t); return out;',
        inputs: (r) => [q4(r), q4(r), unit(r)],
    },
    {
        name: 'real-world: rayCylinder (6-guard multiple-return cascade → labelled block on inline)',
        fixture: 'ray-cylinder.ts',
        params: ['direction', 'aPoints', 'bPoints', 'radius'],
        callBody: 'return castRayVsCylinders(direction, aPoints, bPoints, radius);',
        inputs: (r) => [v3(r), Array.from({ length: 5 }, () => v3(r)), Array.from({ length: 5 }, () => v3(r)), 1 + Math.abs(r())],
    },
    {
        name: 'real-world: quat fromEuler (string-switch dispatch over shared trig temps)',
        fixture: 'quat-from-euler.ts',
        params: ['x', 'y', 'z', 'order'],
        callBody: 'const out = [0, 0, 0, 0]; fromEuler(out, x, y, z, order); return out;',
        inputs: (r, i) => [r(), r(), r(), ['xyz', 'yxz', 'zxy', 'zyx', 'yzx', 'xzy'][i % 6]],
    },
    {
        name: 'real-world: getInverseInertiaForRotation (transitive 4-mat4 inline + mat4 scratch + mask)',
        fixture: 'inverse-inertia.ts',
        params: ['inertiaRotation', 'invInertiaDiagonal', 'allowedDegreesOfFreedom', 'bodyRotation'],
        callBody:
            'const out = new Array(16).fill(0);' +
            'getInverseInertiaForRotation(out, inertiaRotation, invInertiaDiagonal, allowedDegreesOfFreedom, bodyRotation);' +
            'return out;',
        // `(i % 8) << 3` varies the rotation-DOF mask bits, hitting the 0b111
        // skip-branch (i%8===7) and the masked branch otherwise.
        inputs: (r, i) => [q4(r), v3(r), (i % 8) << 3, vn(16)(r)],
    },
];

/** A valid AABB `[minX,minY,minZ,maxX,maxY,maxZ]` (max = min + a positive extent). */
const aabb = (r: () => number): number[] => {
    const x = r();
    const y = r();
    const z = r();
    return [x, y, z, x + 0.5 + Math.abs(r()), y + 0.5 + Math.abs(r()), z + 0.5 + Math.abs(r())];
};

/** A scalar in [0, 1] from the [-range, range] PRNG (for interpolation `t`). */
const unit = (r: () => number): number => (r() + 2) / 4;

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
                expect(opt(...args), `${k.name} #${i} args=${JSON.stringify(args)}`).toEqual(src(...args));
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
        compiler.compileChunk(fixture, readFileSync(resolve(here, 'fixtures/real-world', fixture), 'utf8'), {}).code;

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

    // The real crashcat/mathcat shape, end-to-end through `compileFileCross`: an opaque
    // `create()` scratch typed `: Quat`, where `Quat` is declared in `types.d.ts` and
    // re-exported by the package entry via a bare `export * from './types.js'`. The
    // type-shape oracle follows the wildcard re-export across the `.d.ts` donor graph
    // (`resolve_type_alias_shape`, cross_file.rs) to recover the arity so SROA fires.
    // NB: the type-source donors carry `.d.ts` paths — a `.js` path would drop the types.
    it('cross-package type re-export: mathcat-shaped .d.ts barrel resolves for SROA', () => {
        const consumer = `import { type Quat, quat } from 'mathcat';
const _s: Quat = /* @__PURE__ */ quat.create();
/* @optimize */ export function f(out: number[], a: number[]): number[] {
    _s[0] = a[0];
    _s[1] = a[1];
    _s[2] = a[2];
    _s[3] = a[3];
    out[0] = _s[0] + _s[1] + _s[2] + _s[3];
    return out;
}`;
        const out = compiler.compileFileCross(
            'entry.ts',
            consumer,
            [
                {
                    specifier: 'mathcat',
                    path: '/nm/mathcat/dist/index.d.ts',
                    code: `export * from './types.js';\nexport * as quat from './quat.js';`,
                    resolved: [
                        { specifier: './types.js', path: '/nm/mathcat/dist/types.d.ts' },
                        { specifier: './quat.js', path: '/nm/mathcat/dist/quat.js' },
                    ],
                },
                {
                    specifier: './types.js',
                    path: '/nm/mathcat/dist/types.d.ts',
                    code: `export type Quat = [x: number, y: number, z: number, w: number];`,
                    resolved: [],
                },
                {
                    specifier: './quat.js',
                    path: '/nm/mathcat/dist/quat.js',
                    code: `export const quat = { create: () => [0, 0, 0, 0] };`,
                    resolved: [],
                },
            ],
            {},
        ).code;
        expect(out).toMatch(/_s_0\b/);
        expect(out).not.toContain('const _s =');
    });

    // RESIDUAL GAP (deprioritized, `it.fails`): the type re-export fix above covers the
    // typed case (`: Quat` resolvable via the `.d.ts` graph). What's still unhandled is a
    // genuinely TYPE-LESS opaque scratch — `const _s = /*@__PURE__*/ create()` with no
    // resolvable type anywhere (a JS dep shipping no `.d.ts`). The arity is unambiguous
    // from the constant-index uses (`_s[0..3]`), so an arity-from-uses fallback COULD
    // recover it, but that's a separate, lower-value pass. Flip to a plain `it` if it lands.
    it.fails('type-less opaque scratch scalarizes from constant-index uses (arity inference)', () => {
        const out = compiler.compileChunk(
            'opaque-scratch.ts',
            `declare const quat: { create(): number[] };
const _s = /* @__PURE__ */ quat.create();
/* @optimize */ export function f(out: number[], a: number[]): number[] {
    _s[0] = a[0];
    _s[1] = a[1];
    _s[2] = a[2];
    _s[3] = a[3];
    out[0] = _s[0] + _s[1] + _s[2] + _s[3];
    return out;
}`,
            {},
        ).code;
        expect(out).toMatch(/_s_0\b/);
        expect(out).not.toContain('const _s =');
    });
});

// Transitive inlining (the `raycast3.set → vec3.copy` chain): `@optimize castRay`
// inlines `setRay`, whose body calls `copy`; that call is only EXPOSED by the
// inline, and transitive inlining resolves it to a fixpoint. Recursion cycles are
// refused (so the fixpoint terminates); there is no depth/size cap.
describe('transitive inlining — dbvt castRay', () => {
    const castRay = (): string =>
        compiler.compileChunk(
            'dbvt-cast-ray.ts',
            readFileSync(resolve(here, 'fixtures/real-world', 'dbvt-cast-ray.ts'), 'utf8'),
            {},
        ).code;

    it('inlines the directly-called helpers (setRay, rayDistanceToBox3)', () => {
        const out = castRay();
        expect(out).not.toContain('setRay(');
        expect(out).not.toContain('rayDistanceToBox3(');
    });

    it('transitively inlines copy — the call exposed by inlining setRay', () => {
        const out = castRay();
        // The `copy(...)` calls live inside setRay; only visible after it inlines.
        // Pre-transitive-inlining this left residual `copy(` calls in castRay.
        const body = out.slice(out.indexOf('function castRay'));
        expect(body).not.toContain('copy(');
    });

    it('block-inlines the multi-return rayDistanceToBox3 (labelled, callee-named)', () => {
        const out = castRay();
        expect(out).toMatch(/_inline_rayDistanceToBox3_/);
    });
});

describe('real-world: optimization pins — slerp / rayCylinder', () => {
    const compiledFixture = (fixture: string): string =>
        compiler.compileChunk(fixture, readFileSync(resolve(here, 'fixtures/real-world', fixture), 'utf8'), {}).code;

    it('slerp: control-flow shape is preserved (both ifs stay — no if→ternary)', () => {
        const out = compiledFixture('quat-slerp.ts');
        // Preserve-control-flow-shape: the sign-flip and the trig/linear branches
        // stay as `if` statements; the value semantics are unchanged.
        expect(out).toContain('if (');
        expect((out.match(/if \(/g) || []).length).toBeGreaterThanOrEqual(2);
    });

    it('rayCylinder: block-inlined, and its top-level guard cascade flattens (no label)', () => {
        const out = compiledFixture('ray-cylinder.ts');
        const body = out.slice(out.indexOf('function castRayVsCylinders'));
        expect(body).not.toContain('rayCylinder('); // inlined, no residual call
        expect(out).toMatch(/_rayCylinder__result_/); // block-inlined (result temp survives)
        // The six TOP-LEVEL `return Infinity` guards flatten via minimize-exit-points
        // into nested if/else fall-through, so all breaks vanish and no `_inline_`
        // label survives — denser but flatter than castRay's nested-return case.
        expect(out).not.toMatch(/_inline_rayCylinder_/);
    });

    it('fromEuler: string switch is preserved (no switch→if-chain rewrite)', () => {
        const out = compiledFixture('quat-from-euler.ts');
        expect(out).toContain('switch ('); // control-flow shape preserved
    });

    it('getInverseInertiaForRotation: 4 mat4 helpers transitively inline + scratch scalarizes', () => {
        const out = compiledFixture('inverse-inertia.ts');
        const body = out.slice(out.indexOf('function getInverseInertiaForRotation'));
        // (1) all four helpers are inlined (transitively) — no residual calls.
        for (const call of ['m4fromQuat(', 'm4multiply3x3(', 'm4scale(', 'm4multiply3x3RightTransposed(']) {
            expect(body).not.toContain(call);
        }
        // (2) the mat4[16] module scratches scalarize away (consts deleted).
        expect(out).not.toContain('const _inertiaRotMat');
        expect(out).not.toContain('const _rotation');
        expect(out).not.toContain('const _scaled');
    });
});

// Corpus differential — the scalable path to "confident without a crashcat build".
// Each entry is a faithful COPY of a mathcat/crashcat kernel + the arity of every
// param; the harness wraps it in `@optimize`, compiles, and asserts compiled ≡
// source over random inputs, auto-generating inputs from the declared arities.
// Adding coverage is one table row — so this scales to the whole mathcat library.
// (Random, possibly-degenerate inputs are fine: both variants compute the SAME
// thing, so NaN/Infinity compare equal via toEqual.)
type Arity = number | 'n'; // array length, or 'n' for a scalar

interface CorpusFn {
    module: string;
    fn: string;
    src: string; // faithful `function <fn>(...) {...}`
    out: number; // out-param array arity; 0 ⇒ pure return value
    args: Arity[]; // arities of the params AFTER `out`
    // Optional verbatim helper declarations to PREPEND (un-annotated so @flatten
    // inlines them). When present, the entry `fn` CALLS these — so compiling it
    // under `@optimize` exercises the (transitive) inliner on real mathcat shapes.
    deps?: string;
}

// The corpus data lives in a dedicated file (auto-extracted verbatim from mathcat);
// adding coverage is one row there. See tst/fixtures/corpus/mathcat.ts. The leaf
// corpus has no inlinable calls; the composites (a `deps` block of helper fns the
// entry transitively calls) additionally exercise the inliner on real shapes.
const CORPUS: CorpusFn[] = [...MATHCAT_CORPUS, ...MATHCAT_COMPOSITES] as unknown as CorpusFn[];

describe('corpus differential — mathcat kernels compiled ≡ source (auto-swept)', () => {
    for (const c of CORPUS) {
        it(`${c.module}.${c.fn} (${c.out ? `out[${c.out}]` : 'return'}, args ${c.args.join(',')})${c.deps ? ' [composite]' : ''}`, () => {
            const argNames = c.args.map((_, i) => `x${i}`);
            const module = `${c.deps ? `${c.deps}\n` : ''}/* @optimize */ export ${c.src}`;
            const compiled = compiler.compileChunk(`${c.fn}.ts`, module, {}).code;
            const callBody =
                c.out > 0
                    ? `const out = new Array(${c.out}).fill(0); ${c.fn}(out, ${argNames.join(', ')}); return out;`
                    : `return ${c.fn}(${argNames.join(', ')});`;
            const make = (code: string) =>
                // biome-ignore lint/security/noGlobalEval: evaluating compiled code under test
                new Function(...argNames, `${toJs(code)}\n${callBody}`);
            const src = make(module);
            const opt = make(compiled);

            const r = prng(0xc0ffee, 2);
            for (let i = 0; i < 2000; i++) {
                const inputs = c.args.map((a) => (a === 'n' ? r() : Array.from({ length: a }, r)));
                expect(opt(...inputs), `${c.module}.${c.fn} #${i}`).toEqual(src(...inputs));
            }
        });
    }
});

// Composite pins: the corpus differential above proves the composites compile ≡
// source; these assert the OPTIMIZATION actually happened — @optimize/@flatten
// inlined every helper the entry calls, leaving no residual `helper(` in the
// entry body. (A regression that silently stopped inlining would still pass the
// differential but is a real optimality loss — pinned here so it's visible.)
describe('composite inlining pins — helpers inline into the entry body', () => {
    const compileComposite = (fn: string): string => {
        const c = MATHCAT_COMPOSITES.find((x) => x.fn === fn);
        if (!c) throw new Error(`no composite ${fn}`);
        return compiler.compileChunk(`${fn}.ts`, `${c.deps}\n/* @optimize */ export ${c.src}`, {}).code;
    };
    const entryBody = (out: string, fn: string): string => out.slice(out.indexOf(`function ${fn}`));

    it('vec3.angle: the pure `dot` helper inlines into the return value', () => {
        const body = entryBody(compileComposite('angle'), 'angle');
        expect(body).not.toMatch(/\bdot\(/);
    });

    it('mat4.getRotation: the out-param `getScaling` helper inlines away', () => {
        const body = entryBody(compileComposite('getRotation'), 'getRotation');
        expect(body).not.toMatch(/\bgetScaling\(/);
    });

    it('mat4.crossProductMatrix: the 16-arg `set` helper inlines away', () => {
        const body = entryBody(compileComposite('crossProductMatrix'), 'crossProductMatrix');
        expect(body).not.toMatch(/\bset\(/);
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
