// TS-first gate: the pipeline is TS→TS — it must
//   (a) preserve TypeScript syntax in the output (no stripping), and
//   (b) stay behaviorally equivalent.
//
// `eval` can't run TS, so for the behavioral check we strip types *for the test
// only* (via esbuild) and eval both sides:
//   eval(stripTS(source)) === eval(stripTS(compiler output))
// The actual pipeline output stays TS — verified by the "preserves types" cases.

import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { createCompiler } from '../src/compiler';

const compiler = createCompiler();

function stripTS(code: string): string {
    return transformSync(code, { loader: 'ts' }).code;
}

function run(code: string, call: string): unknown {
    // Strip types AND ESM exports so `new Function` can eval (the entry is
    // compiled as exported so remove-unused-code keeps it).
    const js = stripTS(code)
        .replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '')
        .replace(/\bexport\s+/g, '');
    return new Function(`${js}\nreturn (${call});`)();
}

/** Append `export { … }` for every top-level value binding so they survive DCE
 *  (the entry the test calls may be nested in the call expr). */
function withExports(code: string): string {
    const names = new Set<string>();
    for (const m of code.matchAll(/(?:^|\n)[^\S\n]*(?:\/\*.*?\*\/[^\S\n]*)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g))
        names.add(m[1]);
    for (const m of code.matchAll(/(?:^|\n)[^\S\n]*class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of code.matchAll(/(?:^|\n)[^\S\n]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    return names.size ? `${code}\nexport { ${[...names].join(', ')} };` : code;
}

// ── (a) behavioral equivalence on typed input ────────────────────────────────

type BCase = {
    name: string;
    code: string;
    call: string;
};

// Behavioral cases here focus on TYPE-DRIVEN optimization (SROA arity/fields
// resolved from TS types, enum/as semantics). The untyped equivalents — plain
// inline/sroa/unroll on JS — live in equivalence.test.ts; we don't re-test them
// with annotations bolted on.
const BEHAVIORAL: BCase[] = [
    {
        // type-aware SROA: the Vec3 TYPE (not a literal) gives the arity, so the
        // opaque `mk()` initializer is destructured into scalars.
        name: 'sroa-type-aware-tuple',
        code: `type Vec3 = [number, number, number];\nfunction mk(): Vec3 { return [1, 2, 3]; }\n/* @sroa */ function f(): number { const v: Vec3 = mk(); v[0] = v[1] + v[2]; return v[0]; }`,
        call: 'f()',
    },
    {
        // type-aware SROA via an INLINE tuple type (no alias) + a side-effecting
        // initializer called once.
        name: 'sroa-type-aware-inline-tuple',
        code: `let calls = 0;\nfunction mk(): [number, number] { calls++; return [calls, 10]; }\n/* @sroa */ function f(): number { const v: [number, number] = mk(); return v[0] + v[1]; }`,
        call: 'f() * 1000 + calls',
    },
    {
        // object-literal SROA: `{ x, y, z }` → named scalars, `.x` rewritten.
        name: 'sroa-object-literal',
        code: `/* @sroa */ function f(): number { const v = { x: 1, y: 2, z: 3 }; v.x = v.y + v.z; return v.x; }`,
        call: 'f()',
    },
    {
        // type-aware object SROA: the interface gives the field set, so the opaque
        // `mk()` initializer is destructured into named scalars.
        name: 'sroa-type-aware-object',
        code: `interface Vec3 { x: number; y: number; z: number }\nfunction mk(): Vec3 { return { x: 4, y: 5, z: 6 }; }\n/* @sroa */ function f(): number { const v: Vec3 = mk(); v.x = v.y + v.z; return v.x; }`,
        call: 'f()',
    },
    {
        // object destructure must evaluate the initializer exactly once.
        name: 'sroa-type-aware-object-eval-once',
        code: `let calls = 0;\ninterface P { a: number; b: number }\nfunction mk(): P { calls++; return { a: calls, b: 10 }; }\n/* @sroa */ function f(): number { const v: P = mk(); return v.a + v.b; }`,
        call: 'f() * 1000 + calls',
    },
    {
        // record shape from a `type X = { … }` object-type alias (not interface).
        name: 'sroa-type-aware-object-type-alias',
        code: `type Vec3 = { x: number; y: number; z: number };\nfunction mk(): Vec3 { return { x: 4, y: 5, z: 6 }; }\n/* @sroa */ function f(): number { const v: Vec3 = mk(); v.x = v.y + v.z; return v.x; }`,
        call: 'f()',
    },
    {
        // intersection `A & B` — the resolver merges the two record field sets.
        name: 'sroa-intersection-record',
        code: `type A = { x: number; y: number };\ntype B = { z: number };\nfunction mk(): A & B { return { x: 1, y: 2, z: 3 }; }\n/* @sroa */ function f(): number { const v: A & B = mk(); v.x = v.y + v.z; return v.x; }`,
        call: 'f()',
    },
    {
        // interface `extends` — own + inherited fields merged.
        name: 'sroa-interface-extends',
        code: `interface A { x: number }\ninterface B { y: number }\ninterface C extends A, B { z: number }\nfunction mk(): C { return { x: 1, y: 2, z: 3 }; }\n/* @sroa */ function f(): number { const v: C = mk(); v.x = v.y + v.z; return v.x; }`,
        call: 'f()',
    },
    {
        name: 'enum-and-as',
        code: `enum E { A = 2, B = 3 }\nfunction f(x: unknown): number { return (x as number) + E.A + E.B; }`,
        call: 'f(5)',
    },
];

describe('TS behavioral equivalence (strip-for-eval)', () => {
    for (const c of BEHAVIORAL) {
        it(c.name, () => {
            const expected = run(c.code, c.call);
            const compiled = compiler.compileChunk(`${c.name}.ts`, withExports(c.code), {}).code;
            expect(run(compiled, c.call)).toEqual(expected);
        });
    }
});

// ── (b) types are preserved in the TS→TS output ──────────────────────────────

type PCase = {
    name: string;
    code: string;
    /** Substrings that MUST survive in the output (the pipeline keeps types). */
    keep: string[];
};

const PRESERVE: PCase[] = [
    {
        name: 'param-return-types',
        code: `function add(a: number, b: number): number { return a + b; }`,
        keep: ['a: number', 'b: number', '): number'],
    },
    {
        name: 'interface',
        code: `interface Foo { x: number; y: string; }\nfunction f(o: Foo): number { return o.x; }`,
        keep: ['interface Foo', 'x: number', 'o: Foo'],
    },
    {
        name: 'type-alias',
        code: `type Vec = [number, number];\nfunction f(v: Vec): number { return v[0]; }`,
        keep: ['type Vec', 'v: Vec'],
    },
    {
        name: 'enum',
        code: `enum Color { Red, Green, Blue }\nfunction f(): Color { return Color.Green; }`,
        keep: ['enum Color', 'Color.Green'],
    },
    { name: 'generics', code: `function id<T>(x: T): T { return x; }`, keep: ['id<T>', 'x: T', '): T'] },
    { name: 'as-cast', code: `function f(x: unknown): number { return (x as number) + 1; }`, keep: ['as number', 'x: unknown'] },
];

describe('TS-first: types preserved in output', () => {
    for (const c of PRESERVE) {
        it(c.name, () => {
            // Export the function so remove-unused-code keeps it (and the types
            // it references) — these cases assert types survive on live code.
            const src = c.code.replace('function ', 'export function ');
            const out = compiler.compileChunk(`${c.name}.ts`, src, {}).code;
            for (const k of c.keep) {
                expect(out).toContain(k);
            }
        });
    }
});
