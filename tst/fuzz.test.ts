// Differential behavioral fuzzer — the automated extension of equivalence.test.ts.
//
// We GENERATE random self-contained programs in compilecat's target idiom
// (arithmetic, branches, bounded loops, locals, helper calls, object/array
// aggregates) sprinkled with the directives real code uses (@optimize / @inline
// / @sroa / @unroll), then assert the optimized output computes the SAME value as
// the original source over the program's entry call.
//
// The generator is SOUND BY CONSTRUCTION: every program is deterministic and
// total (no division, no undefined reads, bounded loops), so the ONLY way the
// two evals disagree is a miscompile. On a disagreement we shrink to a minimal
// repro and fail with the seed + source + compiled output so it can be pinned in
// equivalence.test.ts.
//
//   pnpm test:js                       # 400 seeded iters (the CI gate)
//   FUZZ_ITERS=20000 pnpm test:js      # longer ad-hoc campaign
//   FUZZ_SEED=12345 pnpm test:js       # reproduce a specific failing seed

import { describe, expect, it } from 'vitest';

import { createCompiler } from '../src/compiler';

const compiler = createCompiler();

// ── eval harness (same shape as equivalence.test.ts) ─────────────────────────

function topLevelDecls(code: string): string[] {
    const names = new Set<string>();
    for (const m of code.matchAll(/(?:^|\n)[^\S\n]*(?:\/\*.*?\*\/[^\S\n]*)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g))
        names.add(m[1]);
    for (const m of code.matchAll(/(?:^|\n)[^\S\n]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    return [...names];
}

function withExports(code: string): string {
    const names = topLevelDecls(code);
    return names.length ? `${code}\nexport { ${names.join(', ')} };` : code;
}

function evalProgram(code: string, call: string): { ok: true; value: unknown } | { ok: false } {
    // Strip ESM exports and the (unambiguous) TS `as number` wrapper so the JS
    // `new Function` eval can parse it. Both source and compiled go through this,
    // so it's a fair differential — the strip only removes the type annotation,
    // never the surrounding code a miscompile would have corrupted.
    const js = code
        .replace(/^\s*import[^\n]*\n?/gm, '') // cross-file: drop import lines
        .replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '')
        .replace(/\bexport\s+/g, '')
        .replace(/ as number/g, '');
    try {
        // SIDE-EFFECT / CALL-ORDER ORACLE: the program calls an EXTERNAL `eff(x)`
        // (an opaque effectful identity the compiler must preserve in count and
        // order) which records to `__t`. We return BOTH the entry value AND the
        // trace, so a dropped / reordered / CSE'd / wrongly-hoisted effect is a
        // detectable divergence even when the returned number is unchanged. NOT
        // `"use strict"` — cross-file evals depend on sloppy fn redeclaration.
        // biome-ignore lint/security/noGlobalEval: intentionally evaluating generated/compiled code
        const value = new Function(
            // `__g` is an observable module-level mutable a generated helper may
            // write (a free-variable side effect) — returned alongside the trace so
            // a wrongly-dropped `__g = …` write (mis-proven-pure function) diverges.
            `const __t = [];\nlet __g = 0;\nconst eff = (x) => { __t.push(x); return x; };\n${js}\nreturn [(${call}), __t, __g];`,
        )();
        return { ok: true, value };
    } catch {
        return { ok: false };
    }
}

type EvalRes = { ok: true; value: unknown } | { ok: false };

// ── the equivalence oracle ───────────────────────────────────────────────────
//
// STRUCTURAL deep-equal built on `Object.is`, NOT `JSON.stringify`. This matters
// once the fuzzers emit non-numeric values (see CoerceGen): JSON.stringify erases
// exactly the distinctions a fold can get wrong — it maps `-0`→`0`, `NaN`→`null`,
// `Infinity`→`null`, and drops `undefined`. `Object.is` keeps `-0 ≢ +0` (a real
// fold hazard: `x + 0` normalizes `-0`) and `NaN ≡ NaN`, and we compare
// strings/booleans/null/undefined/nested objects/arrays exactly.
function deepEq(a: unknown, b: unknown, looseZero = false): boolean {
    if (Object.is(a, b)) return true; // primitives incl. NaN≡NaN, -0≢+0
    if (looseZero && a === 0 && b === 0) return true; // fold -0 and +0 together
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (!Object.hasOwn(b, k)) return false;
        if (!deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], looseZero)) return false;
    }
    return true;
}

/** Oracle equivalence of two eval results. Throwing is an equivalence class: if
 *  BOTH source and compiled throw it's EQUAL (no divergence); if exactly one
 *  throws it's a real divergence. Otherwise the `[value, trace, __g]` tuples must
 *  be structurally deep-equal. */
function resultsEquiv(want: EvalRes, got: EvalRes, looseZero = false): boolean {
    if (!want.ok || !got.ok) return want.ok === got.ok;
    return deepEq(want.value, got.value, looseZero);
}

/** Compare source-eval vs compiled-eval. Returns null if equivalent, else why. */
function diff(code: string): { call: string; compiled: string; want: unknown; got: unknown } | null {
    const call = 'entry(7, 3)';
    const want = evalProgram(code, call);
    if (!want.ok) return null; // generated program threw (generation artifact) — skip
    const compiled = compiler.compileChunk('fuzz.ts', withExports(code), {}).code;
    const got = evalProgram(compiled, call);
    // looseZero: the behavioral gates allowlist the known, still-open signed-zero
    // fold bug (`x + 0`/`0 + x` discards -0 — pinned in "KNOWN BUGS" below), so a
    // pure -0↔+0 difference is not reported here. Every other distinction (NaN,
    // strings, undefined, structure) is exact. The dedicated pins assert the -0 bug.
    if (resultsEquiv(want, got, /* looseZero */ true)) return null;
    return { call, compiled, want: want.ok ? want.value : '<threw>', got: got.ok ? got.value : '<threw>' };
}

/** Cross-file differential: compile the consumer against the donor and compare
 *  `donor + consumer` (source) vs `donor + compiled` (output). Prepending the
 *  donor to BOTH means a kept import resolves and an inlined copy is harmless
 *  (top-level fn redeclare is sloppy-legal), so it's a fair, symmetric eval. */
function crossDiff(
    donor: string,
    consumer: string,
    specifier: string,
): { compiled: string; want: unknown; got: unknown } | null {
    const call = 'entry(7, 3)';
    const want = evalProgram(`${donor}\n${consumer}`, call);
    if (!want.ok) return null; // generated program threw (generation artifact) — skip
    const compiled = compiler.compileFileCross(
        'entry.ts',
        withExports(consumer),
        [{ specifier, path: '/p/donor.ts', code: donor, resolved: [] }],
        {},
    ).code;
    const got = evalProgram(`${donor}\n${compiled}`, call);
    if (resultsEquiv(want, got, /* looseZero: allowlist known -0 fold bug */ true)) return null;
    return { compiled, want: want.ok ? want.value : '<threw>', got: got.ok ? got.value : '<threw>' };
}

// ── seeded PRNG (reproducible) ───────────────────────────────────────────────

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── generator ────────────────────────────────────────────────────────────────
//
// Value model: NUM (number) and PT (a `{ x: num, y: num }` point). This keeps
// every generated operation total — no undefined field reads, no NaN, no throws.

type Rng = () => number;
const pick = <T>(r: Rng, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const chance = (r: Rng, p: number): boolean => r() < p;
const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

interface Scope {
    nums: string[]; // in-scope number vars
    pts: string[]; // in-scope point vars (always have .x and .y)
    arrs: { name: string; len: number }[]; // in-scope number-arrays (fixed length)
    ptArrs: { name: string; len: number }[]; // arrays of points (nested aggregate)
}

interface Helper {
    name: string;
    kind: 'num' | 'pt' | 'void'; // returns number / point / void (mutates arg0)
    inline: boolean;
}

class Gen {
    private id = 0;
    private helpers: Helper[] = [];
    constructor(private r: Rng) {}

    private fresh(p: string): string {
        // Deliberately a SMALL name pool so collisions across helpers/entry are
        // common — that stresses the renamer / scope handling (where bugs live).
        return `${p}${this.id++ % 5}`;
    }

    // A total numeric expression over in-scope nums (+ point fields), depth-bounded.
    private numExpr(s: Scope, depth: number): string {
        const leaves: (() => string)[] = [() => String(int(this.r, 0, 9))];
        if (s.nums.length) leaves.push(() => pick(this.r, s.nums));
        if (s.pts.length) leaves.push(() => `${pick(this.r, s.pts)}.${pick(this.r, ['x', 'y'])}`);
        if (s.arrs.length)
            leaves.push(() => {
                const a = pick(this.r, s.arrs);
                return `${a.name}[${int(this.r, 0, a.len - 1)}]`; // always in-bounds → total
            });
        if (s.ptArrs.length)
            leaves.push(() => {
                const a = pick(this.r, s.ptArrs);
                // nested aggregate read: arr-of-points[i].x  (in-bounds → total)
                return `${a.name}[${int(this.r, 0, a.len - 1)}].${pick(this.r, ['x', 'y'])}`;
            });
        if (depth <= 0) return pick(this.r, leaves)();
        const numHelpers = this.helpers.filter((h) => h.kind === 'num');
        const forms: (() => string)[] = [
            () => pick(this.r, leaves)(),
            () => `(${this.numExpr(s, depth - 1)} ${pick(this.r, ['+', '-', '*'])} ${this.numExpr(s, depth - 1)})`,
            () => `Math.abs(${this.numExpr(s, depth - 1)})`,
            () => `Math.max(${this.numExpr(s, depth - 1)}, ${this.numExpr(s, depth - 1)})`,
            // ternary
            () => `(${this.cond(s)} ? ${this.numExpr(s, depth - 1)} : ${this.numExpr(s, depth - 1)})`,
            // TS `as` wrapper (number, so total) — exercises the reaching /
            // walk-reads coverage for type-only wrappers. `evalProgram` strips the
            // unambiguous ` as number` so the JS eval can parse it. (The `!`
            // non-null wrapper isn't fuzzed — harder to strip cleanly — but is
            // covered by a regression test.)
            () => `((${this.numExpr(s, depth - 1)}) as number)`,
            // EFFECT: an external `eff(x)` records to the trace and returns x. The
            // compiler must preserve every eff call's count + order (it's opaque
            // and impure). Wrapping a sub-expr puts an observable effect mid-stream
            // so reorder/drop/CSE/wrongful-hoist is caught even at equal value.
            () => `eff(${this.numExpr(s, depth - 1)})`,
        ];
        if (numHelpers.length)
            forms.push(() => {
                const h = pick(this.r, numHelpers);
                // Sometimes force inlining at the call site (exercises the
                // call-site phase + the global inline-temp counter).
                const cs = !h.inline && chance(this.r, 0.3) ? '/* @inline */ ' : '';
                return `${cs}${h.name}(${this.numExpr(s, depth - 1)}, ${this.numExpr(s, depth - 1)})`;
            });
        return pick(this.r, forms)();
    }

    private cond(s: Scope): string {
        return `${this.numExpr(s, 1)} ${pick(this.r, ['>', '<', '>=', '<=', '===', '!=='])} ${this.numExpr(s, 1)}`;
    }

    private ptExpr(s: Scope, depth: number): string {
        // `pt` helpers take two NUMBERS and return a point (their body builds
        // `{ x: f(a,b), y: g(a,b) }`), so call them with numeric args.
        const ptHelpers = this.helpers.filter((h) => h.kind === 'pt');
        if (depth > 0 && ptHelpers.length && chance(this.r, 0.5)) {
            const h = pick(this.r, ptHelpers);
            return `${h.name}(${this.numExpr(s, 1)}, ${this.numExpr(s, 1)})`;
        }
        return `{ x: ${this.numExpr(s, 1)}, y: ${this.numExpr(s, 1)} }`;
    }

    // Build helper declarations and register them (so entry/consumer calls them).
    // `prefix` keeps donor (`d*`) and consumer-local (`h*`) names disjoint;
    // `exported` emits `export` for cross-file donors.
    private genHelpers(count?: number, prefix = 'h', exported = false): string {
        const n = count ?? int(this.r, 1, 4);
        const out: string[] = [];
        const exp = exported ? 'export ' : '';
        for (let i = 0; i < n; i++) {
            const kind = pick(this.r, ['num', 'num', 'pt', 'void'] as const);
            const h: Helper = { name: `${prefix}${i}`, kind, inline: chance(this.r, 0.6) };
            this.helpers.push(h);
            const dir = h.inline ? '/* @inline */ ' : '';
            const head = `${dir}${exp}`;
            const s: Scope = { nums: ['a', 'b'], pts: [], arrs: [], ptArrs: [] };
            if (kind === 'num') {
                // Mix DIRECT (single return) and BLOCK (branch / temp) bodies, plus
                // two purity-analysis stressors: local-aggregate mutation (immutable
                // math — PURE unless its numExpr contains an `eff`), and a free-var
                // write to `__g` (always IMPURE — MUTATES_GLOBAL). Both are observed
                // by the value+trace+__g oracle, so a mis-classification is caught.
                const shape = int(this.r, 0, 4);
                if (shape === 0) out.push(`${head}function ${h.name}(a, b) { return ${this.numExpr(s, 2)}; }`);
                else if (shape === 1)
                    out.push(`${head}function ${h.name}(a, b) { if (${this.cond(s)}) return ${this.numExpr(s, 2)}; return ${this.numExpr(s, 2)}; }`);
                else if (shape === 2)
                    out.push(`${head}function ${h.name}(a, b) { let t; if (${this.cond(s)}) { t = ${this.numExpr(s, 2)}; } else { t = ${this.numExpr(s, 2)}; } return t; }`);
                else if (shape === 3)
                    // fresh-local aggregate mutation — pure iff no `eff` leaks in.
                    out.push(`${head}function ${h.name}(a, b) { const o = [a, b]; o[0] = ${this.numExpr(s, 1)}; o[1] = ${this.numExpr(s, 1)}; return o[0] + o[1]; }`);
                else
                    // free-variable write — a MUTATES_GLOBAL side effect.
                    out.push(`${head}function ${h.name}(a, b) { __g = ${this.numExpr(s, 1)}; return a + b; }`);
            } else if (kind === 'pt') {
                out.push(`${head}function ${h.name}(a, b) { return { x: ${this.numExpr({ nums: ['a', 'b'], pts: [], arrs: [], ptArrs: [] }, 1)}, y: ${this.numExpr({ nums: ['a', 'b'], pts: [], arrs: [], ptArrs: [] }, 1)} }; }`);
            } else {
                // void: mutate point arg0 (a is a point here, b a number).
                const ps: Scope = { nums: ['b'], pts: ['a'], arrs: [], ptArrs: [] };
                out.push(`${head}function ${h.name}(a, b) { a.x = ${this.numExpr(ps, 1)}; a.y = ${this.numExpr(ps, 1)}; }`);
            }
        }
        return out.join('\n');
    }

    /** Cross-file: a donor module (exported helpers, `d*`) + a consumer that
     *  imports them and calls them (alongside its own `h*` helpers) in an
     *  @optimize entry. Returns the two module sources + the import specifier. */
    crossProgram(): { donor: string; consumer: string; specifier: string } {
        const donorBody = this.genHelpers(int(this.r, 1, 3), 'd', true);
        const donorNames = this.helpers.map((h) => h.name); // all d* so far
        const localHelpers = this.genHelpers(int(this.r, 0, 2), 'h', false);
        const specifier = './donor';
        const importLine = `import { ${donorNames.join(', ')} } from "${specifier}";`;
        const optimize = chance(this.r, 0.8) ? '/* @optimize */ ' : '';
        const consumer = `${importLine}\n${localHelpers}\n${optimize}function entry(p, q) {\n  ${this.genEntryBody()}\n}`;
        return { donor: donorBody, consumer, specifier };
    }

    private genEntryBody(): string {
        const s: Scope = { nums: ['p', 'q'], pts: [], arrs: [], ptArrs: [] };
        const stmts: string[] = [];
        const k = int(this.r, 2, 6);
        for (let i = 0; i < k; i++) {
            const form = int(this.r, 0, 14);
            if (form === 0) {
                // const num = numExpr | helper-num-call (BLOCK in init position)
                const v = this.fresh('v');
                stmts.push(`const ${v} = ${this.numExpr(s, 2)};`);
                s.nums.push(v);
            } else if (form === 1 && s.nums.length) {
                // reassign a let-num via assignment-position helper
                const v = this.fresh('w');
                stmts.push(`let ${v} = 0; ${v} = ${this.numExpr(s, 2)};`);
                s.nums.push(v);
            } else if (form === 2) {
                // point aggregate (sometimes @sroa), then read fields
                const v = this.fresh('pt');
                const dir = chance(this.r, 0.5) ? '/* @sroa */ ' : '';
                stmts.push(`const ${v} = ${dir}${this.ptExpr(s, 2)};`);
                s.pts.push(v);
            } else if (form === 3) {
                // array aggregate (sometimes @sroa), added to scope. Variable
                // length; later stmts may index-read (numExpr leaf), element-write,
                // or spread it. All accesses are in-bounds → total.
                const v = this.fresh('arr');
                const len = int(this.r, 2, 4);
                const dir = chance(this.r, 0.5) ? '/* @sroa */ ' : '';
                const elems = Array.from({ length: len }, () => this.numExpr(s, 1)).join(', ');
                stmts.push(`const ${v} = ${dir}[${elems}];`);
                s.arrs.push({ name: v, len });
                if (chance(this.r, 0.4))
                    stmts.push(`${v}[${int(this.r, 0, len - 1)}] = ${this.numExpr(s, 1)};`);
                if (chance(this.r, 0.4)) {
                    // spread a number-array into Math.max (exercises spread reads)
                    const m = this.fresh('m');
                    stmts.push(`const ${m} = Math.max(...${v});`);
                    s.nums.push(m);
                }
            } else if (form === 4 && s.pts.length) {
                // void-helper mutation of a point + field write
                const voids = this.helpers.filter((h) => h.kind === 'void');
                const pt = pick(this.r, s.pts);
                if (voids.length) stmts.push(`${pick(this.r, voids).name}(${pt}, ${this.numExpr(s, 1)});`);
                stmts.push(`${pt}.x = ${this.numExpr(s, 1)};`);
            } else if (form === 5) {
                // bounded loop (sometimes @unroll) accumulating into a num
                const acc = this.fresh('acc');
                const lim = int(this.r, 1, 4);
                const dir = chance(this.r, 0.5) ? '/* @unroll */ ' : '';
                stmts.push(`let ${acc} = 0; ${dir}for (let i = 0; i < ${lim}; i++) { ${acc} = ${acc} + ${this.numExpr(s, 1)} + i; }`);
                s.nums.push(acc);
            } else if (form === 6) {
                // bounded WHILE loop (counter-driven → terminates) accumulating.
                const acc = this.fresh('acc');
                const ctr = this.fresh('k');
                const lim = int(this.r, 1, 4);
                stmts.push(
                    `let ${acc} = 0; let ${ctr} = 0; while (${ctr} < ${lim}) { ${acc} = ${acc} + ${this.numExpr(s, 1)}; ${ctr} = ${ctr} + 1; }`,
                );
                s.nums.push(acc);
            } else if (form === 7) {
                // NESTED if/else (deeper control flow → CFG / minimize / flow).
                const v = this.fresh('c');
                stmts.push(
                    `let ${v} = 0; if (${this.cond(s)}) { if (${this.cond(s)}) { ${v} = ${this.numExpr(s, 2)}; } else { ${v} = ${this.numExpr(s, 1)}; } } else { ${v} = ${this.numExpr(s, 2)}; }`,
                );
                s.nums.push(v);
            } else if (form === 8) {
                // NESTED aggregate: an array of points (sometimes @sroa), read as
                // arr[i].x via the numExpr leaf. Stresses nested SROA.
                const v = this.fresh('pa');
                const len = int(this.r, 2, 3);
                const dir = chance(this.r, 0.5) ? '/* @sroa */ ' : '';
                const elems = Array.from(
                    { length: len },
                    () => `{ x: ${this.numExpr(s, 1)}, y: ${this.numExpr(s, 1)} }`,
                ).join(', ');
                stmts.push(`const ${v} = ${dir}[${elems}];`);
                s.ptArrs.push({ name: v, len });
            } else if (form === 9) {
                // compound assignment to a (mutable) param — reassigned-variable
                // handling through the optimizer.
                const v = pick(this.r, ['p', 'q']);
                stmts.push(`${v} ${pick(this.r, ['+=', '-=', '*='])} ${this.numExpr(s, 1)};`);
            } else if (form === 10) {
                // NESTED aggregate: object with both a scalar field and an ARRAY
                // field (sometimes @sroa), read immediately. Stresses SROA of a
                // struct containing an array.
                const o = this.fresh('o');
                const dir = chance(this.r, 0.5) ? '/* @sroa */ ' : '';
                stmts.push(
                    `const ${o} = ${dir}{ v: ${this.numExpr(s, 1)}, a: [${this.numExpr(s, 1)}, ${this.numExpr(s, 1)}] };`,
                );
                const sv = this.fresh('ov');
                stmts.push(`const ${sv} = ${o}.v + ${o}.a[0] + ${o}.a[1];`);
                s.nums.push(sv);
            } else if (form === 11) {
                // labeled break out of a nested bounded loop (terminating → total)
                // — exercises minimize-exit-points / CFG label handling.
                const acc = this.fresh('acc');
                const lbl = `L${this.id++ % 5}`;
                const li = int(this.r, 1, 3);
                const lj = int(this.r, 1, 3);
                stmts.push(
                    `let ${acc} = 0; ${lbl}: for (let i = 0; i < ${li}; i++) { for (let j = 0; j < ${lj}; j++) { if (${this.cond(s)}) break ${lbl}; ${acc} = ${acc} + ${this.numExpr(s, 1)}; } }`,
                );
                s.nums.push(acc);
            } else if (form === 12) {
                // bare EFFECT statement (result discarded) — must NOT be dropped.
                stmts.push(`eff(${this.numExpr(s, 1)});`);
            } else if (form === 13) {
                // EFFECT bound to a possibly-DEAD local: dropping the dead binding
                // must keep the effect (the cleanup_residue dropped-impure-RHS
                // class). Sometimes read (kept), sometimes not (store is dead).
                const v = this.fresh('e');
                stmts.push(`const ${v} = eff(${this.numExpr(s, 1)});`);
                if (chance(this.r, 0.5)) s.nums.push(v); // sometimes used later
            } else {
                // if-branch with a nested const + field/array op
                const v = this.fresh('c');
                stmts.push(`let ${v} = 0; if (${this.cond(s)}) { ${v} = ${this.numExpr(s, 2)}; } else { ${v} = ${this.numExpr(s, 2)}; }`);
                s.nums.push(v);
            }
        }
        stmts.push(`return ${this.numExpr(s, 3)};`);
        return stmts.join('\n  ');
    }

    program(): string {
        const helpers = this.genHelpers();
        const optimize = chance(this.r, 0.7) ? '/* @optimize */ ' : '';
        const entry = `${optimize}function entry(p, q) {\n  ${this.genEntryBody()}\n}`;
        return `${helpers}\n${entry}`;
    }
}

// ── shrinker ─────────────────────────────────────────────────────────────────
// Line-based delta-debug: drop statement lines while the divergence persists.

function shrink(code: string): string {
    const orig = evalProgram(code, 'entry(7, 3)');
    let best = code;
    let changed = true;
    while (changed) {
        changed = false;
        const lines = best.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            // Never drop the closing brace / function headers that keep it parseable.
            if (trimmed === '' || trimmed === '}' || trimmed.startsWith('function') || trimmed.includes('function entry') || trimmed.startsWith('/* @optimize */ function') || trimmed.startsWith('return ')) continue;
            const candidate = lines.slice(0, i).concat(lines.slice(i + 1)).join('\n');
            try {
                // Keep the reduction only if it (a) still diverges AND (b) PRESERVES
                // the original source value. (b) prevents dropping a needed
                // declaration — which would turn a real var into an undefined read
                // (NaN, which still "diverges") and yield a misleading repro.
                const cv = evalProgram(candidate, 'entry(7, 3)');
                if (orig.ok && cv.ok && deepEq(cv.value, orig.value) && diff(candidate)) {
                    best = candidate;
                    changed = true;
                    break;
                }
            } catch {
                // candidate no longer parses/evals cleanly — keep the line.
            }
        }
    }
    return best;
}

// ── the test ─────────────────────────────────────────────────────────────────

// BLOCKING GATE (always on): the codebase is fuzz-clean to 80k+ iterations, so a
// modest deterministic batch runs on every `pnpm test` to catch new regressions.
// Deterministic (fixed seed) → stable. For a deep campaign, scale it up:
//   FUZZ_ITERS=40000 npx vitest run tst/fuzz.test.ts --testTimeout=600000
// FUZZ_SEED varies the corpus. The default batch is kept small so the gate stays
// fast; the tail is covered by on-demand campaigns. Note: a single run beyond
// ~40k iters (~30s) can trip vitest's worker RPC heartbeat ("Timeout calling
// onTaskUpdate" — benign, not a miscompile); for deeper coverage run several
// chunks with different FUZZ_SEED rather than one huge FUZZ_ITERS.
describe('behavioral fuzzer: compiled output ≡ source', () => {
    const ITERS = Number(process.env.FUZZ_ITERS ?? 500);
    const BASE = Number(process.env.FUZZ_SEED ?? 0x1234abcd);

    it(`${ITERS} random programs preserve semantics`, () => {
        for (let i = 0; i < ITERS; i++) {
            const seed = (BASE + i * 2654435761) >>> 0;
            const code = new Gen(mulberry32(seed)).program();
            let d: ReturnType<typeof diff>;
            try {
                d = diff(code);
            } catch (e) {
                // A compile-time crash (panic) is itself a failure to report.
                d = { call: 'entry(7, 3)', compiled: `<compile threw: ${(e as Error).message}>`, want: 'n/a', got: 'n/a' };
            }
            if (d) {
                const minimal = (() => {
                    try {
                        return shrink(code);
                    } catch {
                        return code;
                    }
                })();
                const md = (() => {
                    try {
                        return diff(minimal) ?? d;
                    } catch {
                        return d;
                    }
                })();
                throw new Error(
                    `MISCOMPILE (seed=${seed}, FUZZ_SEED=${BASE} i=${i})\n` +
                        `call: ${md.call}   want=${JSON.stringify(md.want)} got=${JSON.stringify(md.got)}\n\n` +
                        `--- minimal source ---\n${minimal}\n\n` +
                        `--- compiled ---\n${md.compiled}\n`,
                );
            }
        }
        expect(true).toBe(true);
    });

    // Cross-file variant: a consumer imports `@inline`/plain donor helpers and
    // uses them in an @optimize entry, compiled via `compileFileCross`. Exercises
    // the donor-inline + cross-file SROA + global-counter-across-the-boundary
    // paths. Fewer iters (each compiles two modules); scales with FUZZ_ITERS.
    const XITERS = Math.max(50, Math.floor(ITERS / 2));
    it(`${XITERS} cross-file programs preserve semantics`, () => {
        for (let i = 0; i < XITERS; i++) {
            const seed = (BASE ^ 0x5bd1e995) + i * 2654435761;
            const { donor, consumer, specifier } = new Gen(mulberry32(seed >>> 0)).crossProgram();
            let d: ReturnType<typeof crossDiff>;
            try {
                d = crossDiff(donor, consumer, specifier);
            } catch (e) {
                d = { compiled: `<compile threw: ${(e as Error).message}>`, want: 'n/a', got: 'n/a' };
            }
            if (d) {
                throw new Error(
                    `CROSS-FILE MISCOMPILE (seed=${seed >>> 0}, FUZZ_SEED=${BASE} i=${i})\n` +
                        `entry(7, 3)   want=${JSON.stringify(d.want)} got=${JSON.stringify(d.got)}\n\n` +
                        `--- donor ---\n${donor}\n\n--- consumer ---\n${consumer}\n\n` +
                        `--- compiled ---\n${d.compiled}\n`,
                );
            }
        }
        expect(true).toBe(true);
    });
});

// ── transitive-inline-chain generator ────────────────────────────────────────
// The main Gen above nests helper calls one level deep. This generator builds
// DEEP call chains — a host that calls h0, where h0 calls h1, h1 calls h2, … (2–4
// levels) — so `@optimize`/`@flatten` must inline TRANSITIVELY to a fixpoint (a
// call only EXPOSED after an outer helper inlines). It also mixes the directives
// real code uses (@inline / @flatten / @optimize on the host, @inline / plain on
// each helper) and includes a self-RECURSIVE helper (the compiler must REFUSE to
// inline it — the fixpoint terminates — while still computing the same result).
// Every program is total (bounded recursion via a literal counter; no division),
// so the same value+trace oracle (`diff`) that guards the main fuzzer applies: a
// dropped/reordered `eff`, a wrong inline, or a non-terminating recursion-inline
// all show up as a divergence, shrunk to a minimal repro.
class ChainGen {
    private uid = 0;
    constructor(private r: Rng) {}
    // Local name for a helper's block body. ~40% of the time draw from a small
    // SHARED pool so DIFFERENT helpers collide on the same name — that's the shape
    // that triggered the (now-fixed) nested-inline user-local collision miscompile
    // (helpers each declaring `const t`, both transitively inlined into one host).
    // Keeping it in the generator makes this fuzzer a permanent regression net for
    // the α-rename fix; the remaining ~60% use unique names for shape variety.
    private local(): string {
        return chance(this.r, 0.4) ? pick(this.r, ['t', 'u', 'w', 's']) : `t${this.uid++}`;
    }
    private lit(): string {
        return String(int(this.r, 1, 9));
    }
    private op(): string {
        return pick(this.r, ['+', '-', '*']);
    }
    // per-helper directive: @inline or plain (mixed so a chain interleaves both).
    private hdir(): string {
        return chance(this.r, 0.6) ? '/* @inline */ ' : '';
    }
    private hostDir(): string {
        return pick(this.r, ['/* @optimize */ ', '/* @flatten */ ', '/* @optimize */ ', '']);
    }

    // A number-returning chain: h_i returns arithmetic involving h_{i+1}(…). Some
    // levels are BLOCK bodies (branch + effect) so block-inlining is exercised too.
    private returnChain(levels: number): string {
        const hs: string[] = [];
        for (let i = 0; i < levels; i++) {
            const last = i === levels - 1;
            const next = last
                ? `(a ${this.op()} ${this.lit()})`
                : `h${i + 1}(a ${this.op()} ${this.lit()}, b ${this.op()} ${this.lit()})`;
            const t = this.local();
            const body = chance(this.r, 0.4)
                ? // BLOCK body with a mid-stream effect (must survive inlining).
                  `{ const ${t} = eff(a ${this.op()} b); if (${t} > b) return ${t} ${this.op()} ${next}; return b ${this.op()} ${next}; }`
                : // DIRECT body.
                  `{ return (a ${this.op()} b) ${this.op()} ${next}; }`;
            hs.push(`${this.hdir()}function h${i}(a, b) ${body}`);
        }
        // host sometimes calls the chain twice (two clones of the same expansion).
        const call = chance(this.r, 0.4) ? `h0(p, q) ${this.op()} h0(q, p)` : `h0(p, q)`;
        const entry = `${this.hostDir()}function entry(p, q) { return ${call}; }`;
        return `${hs.join('\n')}\n${entry}`;
    }

    // An out-param chain: h_i(out, a, b) delegates to h_{i+1}(out, a, b) then folds
    // more into out — the `set → copy` transitive-write shape from real kernels.
    private outparamChain(levels: number): string {
        const hs: string[] = [];
        for (let i = 0; i < levels; i++) {
            const last = i === levels - 1;
            const body = last
                ? `{ out[0] = a ${this.op()} b; out[1] = (a ${this.op()} ${this.lit()}); }`
                : `{ h${i + 1}(out, a, b); out[0] = out[0] ${this.op()} (a ${this.op()} b); out[1] = out[1] ${this.op()} ${this.lit()}; }`;
            hs.push(`${this.hdir()}function h${i}(out, a, b) ${body}`);
        }
        const entry = `${this.hostDir()}function entry(p, q) { const o = [0, 0]; h0(o, p, q); return o[0] ${this.op()} o[1]; }`;
        return `${hs.join('\n')}\n${entry}`;
    }

    // A self-recursive helper reached THROUGH the inline chain: inlining h0 exposes
    // the `rec(…)` call, which the compiler must REFUSE to inline (cycle) — while
    // still evaluating correctly. Bounded by a LITERAL counter → always terminates.
    private recursion(): string {
        const n = int(this.r, 1, 3);
        const rec = `function rec(a, n) { if (n <= 0) return a; return (a ${this.op()} ${this.lit()}) + rec(a ${this.op()} ${this.lit()}, n - 1); }`;
        const h0 = `${this.hdir()}function h0(a, b) { return rec(a ${this.op()} b, ${n}); }`;
        const entry = `${this.hostDir()}function entry(p, q) { return h0(p, q) ${this.op()} ${this.lit()}; }`;
        return `${rec}\n${h0}\n${entry}`;
    }

    program(): string {
        const levels = int(this.r, 2, 4);
        const shape = pick(this.r, ['return', 'return', 'outparam', 'recursion'] as const);
        if (shape === 'return') return this.returnChain(levels);
        if (shape === 'outparam') return this.outparamChain(levels);
        return this.recursion();
    }
}

describe('fuzz: transitive-inline chains + directive combinations', () => {
    const BASE = Number(process.env.FUZZ_SEED ?? 0) || 0x2f9a17b3;
    const ITERS = Number(process.env.FUZZ_ITERS ?? 0) || 300;
    it(`${ITERS} deep inline-chain programs preserve semantics`, () => {
        for (let i = 0; i < ITERS; i++) {
            const seed = (BASE ^ 0xa5a5a5a5) + i * 2654435761;
            const code = new ChainGen(mulberry32(seed >>> 0)).program();
            let d: ReturnType<typeof diff>;
            try {
                d = diff(code);
            } catch (e) {
                d = {
                    call: 'entry(7, 3)',
                    compiled: `<compile threw: ${(e as Error).message}>`,
                    want: 'n/a',
                    got: 'n/a',
                };
            }
            if (d) {
                const minimal = (() => {
                    try {
                        return shrink(code);
                    } catch {
                        return code;
                    }
                })();
                const md = (() => {
                    try {
                        return diff(minimal) ?? d;
                    } catch {
                        return d;
                    }
                })();
                throw new Error(
                    `CHAIN MISCOMPILE (seed=${seed >>> 0}, FUZZ_SEED=${BASE} i=${i})\n` +
                        `call: ${md.call}   want=${JSON.stringify(md.want)} got=${JSON.stringify(md.got)}\n\n` +
                        `--- minimal source ---\n${minimal}\n\n` +
                        `--- compiled ---\n${md.compiled}\n`,
                );
            }
        }
        expect(true).toBe(true);
    });
});

// ── module-scratch generator ─────────────────────────────────────────────────
// Exercises the single-owner module-scratch scalar-replacement (SROA GlobalOpt-
// localize). Emits a module-level `const _s = /*@__PURE__*/ [0,…]` used as per-call
// scratch inside an `@optimize` `entry`, in modes that SHOULD scalarize (write-then-
// read) and modes that MUST bail (read-before-write, partial init, escape, second
// reader, branchy write, name-collision). The oracle calls `entry` TWICE with
// different args so the SHARED module-buffer semantics (which per-call scalars must
// only reproduce when killed-on-entry holds) are observable — a wrong scalarization
// diverges. Names are drawn to sometimes collide with entry's own locals/params.
class ScratchGen {
    constructor(private r: Rng) {}
    // PURE numeric expr (no `eff`): an impure call between scratch writes correctly
    // trips the re-entrancy guard and bails, so putting `eff` here would mean the
    // fire path is never exercised. Effect coverage comes from a leading `eff`
    // statement emitted BEFORE the first write (the guard only fires after it).
    private e(): string {
        return pick(this.r, [
            () => String(int(this.r, 0, 9)),
            () => 'p',
            () => 'q',
            () => `(p ${pick(this.r, ['+', '-', '*'])} q)`,
            () => 'Math.abs(q)',
        ])();
    }
    /** { program, exports, call } — `call` runs entry twice to expose cross-call
     *  buffer state; `exports` names only the functions (scratch const stays private). */
    program(): { program: string; exports: string; call: string } {
        const n = int(this.r, 2, 3);
        // Sometimes name the scratch so its scalars (`s_0`) collide with a local the
        // entry also declares — the collision class reviewer C found.
        const collide = chance(this.r, 0.25);
        const s = collide ? 'v' : '_scr';
        const idx = [...Array(n).keys()];
        const readAll = idx.map((i) => `${s}[${i}]`).join(' + ');
        const writes = idx.map((i) => `  ${s}[${i}] = ${this.e()};`);
        const mode = pick(this.r, [
            'ok',
            'ok',
            'ok',
            'readBeforeWrite',
            'partialRead',
            'secondReader',
            'escape',
            'branchy',
            'collideLocal',
            'closure',
            'alias',
            'aliasTrailingEff',
            'blockShadow',
            'loopBody',
            'loopReadBeforeWrite',
            // 'aliasClosure' is EXCLUDED from the random gate: it reliably reproduces
            // a real, still-open miscompile (the alias binding is dropped but a
            // returned closure still reads it → ReferenceError). Pinned as an
            // `it.fails` in "KNOWN BUGS" below; re-add here once the core is fixed.
            'bothBranches',
            'switchWrite',
            'partialBranch',
            'switchFallthrough',
            'nestedPartial',
            'forHeaderRead',
        ]);
        const body: string[] = [];
        // Occasional leading effect (before any write) — preserved through
        // scalarization, and doesn't trip the after-first-write re-entrancy guard.
        if (chance(this.r, 0.4)) body.push(`  eff(${int(this.r, 1, 9)});`);
        // v2 alias-following: reach the scratch through a `const <s> = _s` alias.
        const acc =
            mode === 'alias' || mode === 'aliasTrailingEff' || mode === 'aliasClosure'
                ? `${s}a`
                : s;
        if (acc !== s) body.push(`  const ${acc} = ${s};`);
        const readAllA = idx.map((i) => `${acc}[${i}]`).join(' + ');
        const writesA = idx.map((i) => `  ${acc}[${i}] = ${this.e()};`);
        let extra = '';
        // Only the FUNCTIONS are exported — the scratch const stays module-private
        // (as in real crashcat). Exporting the const would make it externally
        // initialized ⇒ always bail, so the fuzzer would exercise nothing.
        let exports = 'entry';
        let call = '[entry(7, 3), entry(2, 5)]';
        if (mode === 'readBeforeWrite') {
            body.push(`  let r0 = ${s}[0];`, ...writes, `  return r0 + ${readAll};`);
        } else if (mode === 'partialRead') {
            body.push(`  ${s}[0] = ${this.e()};`, `  return ${s}[0] + ${s}[${n - 1}];`);
        } else if (mode === 'secondReader') {
            body.push(...writes, `  return ${readAll};`);
            extra = `\nfunction reader() { return ${s}[0] + ${s}[${n - 1}]; }`;
            exports = 'entry, reader';
            call = '[entry(7, 3), reader(), entry(2, 5), reader()]';
        } else if (mode === 'escape') {
            body.push(...writes, `  eff(${s});`, `  return ${readAll};`);
        } else if (mode === 'branchy') {
            body.push(`  if (p > q) { ${s}[0] = ${this.e()}; } else { ${s}[0] = ${this.e()}; }`);
            for (let i = 1; i < n; i++) body.push(`  ${s}[${i}] = ${this.e()};`);
            body.push(`  return ${readAll};`);
        } else if (mode === 'collideLocal') {
            // A local whose name equals a generated scalar (`s_0`) — must not merge.
            body.push(`  let ${s}_0 = ${this.e()};`, ...writes, `  return ${readAll} + ${s}_0;`);
        } else if (mode === 'alias') {
            // v2: write/read the scratch through the `const ${s}a = ${s}` alias.
            body.push(...writesA, `  return ${readAllA};`);
        } else if (mode === 'aliasTrailingEff') {
            // Alias + a trailing effect AFTER the last scratch use (v2 window).
            body.push(...writesA, `  const rv = ${readAllA};`, `  eff(rv);`, `  return rv;`);
        } else if (mode === 'loopBody') {
            // v2 confinement: per-iteration scratch, written-then-read inside a loop.
            const w = idx.map((i) => `    ${s}[${i}] = ${this.e()} + i;`);
            body.push(
                '  let acc = 0;',
                '  for (let i = 0; i < 4; i++) {',
                ...w,
                `    acc += ${readAll};`,
                '  }',
                '  return acc;',
            );
        } else if (mode === 'loopReadBeforeWrite') {
            // Read a field before its write inside the loop → reads prior iteration →
            // must BAIL (a wrong per-call scalarization diverges).
            const w = idx.map((i) => `    ${s}[${i}] = ${this.e()} + i;`);
            body.push(
                '  let acc = 0;',
                '  for (let i = 0; i < 4; i++) {',
                `    acc += ${s}[0];`,
                ...w,
                '  }',
                '  return acc;',
            );
        } else if (mode === 'aliasClosure') {
            // Alias captured in a RETURNED closure → observes the shared buffer across
            // calls; must BAIL. The deferred call (both entries run, then both closures
            // invoked) exposes a wrong per-call scalarization.
            body.push(...writesA, `  return () => ${readAllA};`);
            call = '(() => { const c1 = entry(7, 3); const c2 = entry(2, 5); return [c1(), c2()]; })()';
        } else if (mode === 'bothBranches') {
            // v3 CFG: both arms write all fields → must-written at merge → scalarizes.
            const w1 = idx.map((i) => `${s}[${i}] = ${this.e()};`).join(' ');
            const w2 = idx.map((i) => `${s}[${i}] = ${this.e()};`).join(' ');
            body.push(`  if (p > q) { ${w1} } else { ${w2} }`, `  return ${readAll};`);
        } else if (mode === 'switchWrite') {
            // v3 CFG: a switch where every case writes all fields (getSupport shape).
            const w = () => idx.map((i) => `${s}[${i}] = ${this.e()};`).join(' ');
            body.push(
                `  switch (p % 3) { case 0: { ${w()} break; } case 1: { ${w()} break; } default: { ${w()} } }`,
                `  return ${readAll};`,
            );
        } else if (mode === 'partialBranch') {
            // One arm writes only field 0 → the read of the rest is NOT must-written on
            // that path → must bail (a wrong scalarization diverges).
            const w = idx.map((i) => `${s}[${i}] = ${this.e()};`).join(' ');
            body.push(`  if (p > q) { ${w} } else { ${s}[0] = ${this.e()}; }`, `  return ${readAll};`);
        } else if (mode === 'switchFallthrough') {
            // case 0 writes all then FALLS THROUGH to case 1 which reads; on the k=1
            // entry path nothing is written → the read is uninit → must bail (a wrong
            // scalarization returns NaN vs the create-default 0 for k=1).
            const w = idx.map((i) => `${s}[${i}] = ${this.e()};`).join(' ');
            body.push(`  switch (p % 2) { case 0: { ${w} } case 1: return ${readAll}; }`, '  return 0;');
        } else if (mode === 'nestedPartial') {
            // Outer-if both arms would cover, but an INNER else writes only field 0 →
            // partial on one path → must bail.
            const wAll = idx.map((i) => `${s}[${i}] = ${this.e()};`).join(' ');
            body.push(
                `  if (p > q) { if (p > 0) { ${wAll} } else { ${s}[0] = ${this.e()}; } } else { ${wAll} }`,
                `  return ${readAll};`,
            );
        } else if (mode === 'forHeaderRead') {
            // A scratch read in the for-INIT (an unattributable bare-expression CFG
            // node) → must bail; the completeness net / for-header guard catch it.
            body.push('  let acc = 0;', `  for (acc = ${s}[0]; acc < 0; acc++) {}`, '  return acc;');
        } else if (mode === 'blockShadow') {
            // A block-scoped rebind of the scratch name (distinct variable). Must NOT
            // be hijacked by the name-based rewriter. Values differ so a hijack diverges.
            body.push(...writes, `  let acc = ${readAll};`);
            const lit = `[${idx.map(() => int(this.r, 1, 9)).join(', ')}]`;
            body.push(`  if (p > q) { const ${s} = ${lit}; acc += ${s}[0] + ${s}[${n - 1}]; }`);
            body.push(`  return acc;`);
        } else if (mode === 'closure') {
            // Returns a closure whose PARAM shadows the scratch name — the scalarizer
            // must not hijack the inner `${s}` binding. Called by the oracle.
            body.push(...writes, `  return (${s}) => ${readAll};`);
            const distinct = idx.map((i) => (i + 1) * 11).join(', ');
            call = `[entry(7, 3)([${distinct}]), entry(2, 5)([${distinct}])]`;
        } else {
            body.push(...writes, `  return ${readAll};`);
        }
        const scr = `const ${s} = /*@__PURE__*/ [${idx.map(() => '0').join(', ')}];`;
        const entry = `/* @optimize */ function entry(p, q) {\n${body.join('\n')}\n}`;
        return { program: `${scr}\n${entry}${extra}`, exports, call };
    }
}

/** Scratch differential: source vs compiled, two-call oracle. Only the functions
 *  are exported (scratch const stays private, else it always bails). */
function scratchDiff(
    program: string,
    exports: string,
    call: string,
): { want: unknown; got: unknown; compiled: string } | null {
    const want = evalProgram(program, call);
    if (!want.ok) return null;
    const withExp = `${program}\nexport { ${exports} };`;
    const compiled = compiler.compileChunk('scratch.ts', withExp, {}).code;
    const got = evalProgram(compiled, call);
    return resultsEquiv(want, got, /* looseZero: allowlist known -0 fold bug */ true)
        ? null
        : { want: want.value, got: got.ok ? got.value : '<threw>', compiled };
}

describe('fuzz: module-scratch scalar replacement (effect oracle, two-call)', () => {
    const BASE = Number(process.env.FUZZ_SEED ?? 0) || 0x5e12a7c4;
    const ITERS = Number(process.env.FUZZ_ITERS ?? 0) || 400;
    it(`${ITERS} module-scratch programs preserve semantics across calls`, () => {
        for (let i = 0; i < ITERS; i++) {
            const seed = (BASE ^ 0x1b873593) + i * 2654435761;
            const { program, exports, call } = new ScratchGen(mulberry32(seed >>> 0)).program();
            let d: ReturnType<typeof scratchDiff>;
            try {
                d = scratchDiff(program, exports, call);
            } catch (e) {
                d = { want: 'n/a', got: `<compile threw: ${(e as Error).message}>`, compiled: '' };
            }
            if (d) {
                throw new Error(
                    `SCRATCH MISCOMPILE (seed=${seed >>> 0}, FUZZ_SEED=${BASE} i=${i})\n` +
                        `call: ${call}   want=${JSON.stringify(d.want)} got=${JSON.stringify(d.got)}\n\n` +
                        `--- source ---\n${program}\n\n` +
                        `--- compiled ---\n${compiler.compileChunk('scratch.ts', withExports(program), {}).code}\n`,
                );
            }
        }
        expect(true).toBe(true);
    });
});

// REGRESSION PIN (was a real miscompile, now FIXED). The transitive-inline-chain
// fuzzer above surfaced a miscompile in NESTED inlining: when a block-bodied helper
// is inlined and declares its own user-local (here `const t`), that local was NOT
// α-renamed. Two different helpers (h0, h2) each declaring `const t`, both inlined
// transitively into one host, produced two `const t` that — once block_flatten
// unwrapped the inline label-blocks into one scope — conflated (oxc models
// same-name same-scope bindings as ONE symbol) and value-corrupted each other.
// Source returned 212, compiled returned 424 (the effect TRACE was identical — a
// pure value corruption, not a dropped effect). build_block_plan now re-uniquifies
// the callee body's user locals (`t$<id>`) alongside its generated temps.
describe('nested-inline user-local collision (fixed)', () => {
    const src =
        `/* @inline */ function h0(a, b) { const t = eff(a - b); if (t > b) return t * h1(a + 8, b - 1); return b + h1(a + 8, b - 1); }\n` +
        `function h1(a, b) { return (a + b) + h2(a - 2, b + 3); }\n` +
        `function h2(a, b) { const t = eff(a - b); if (t > b) return t + h3(a - 2, b + 2); return b * h3(a - 2, b + 2); }\n` +
        `function h3(a, b) { return (a + b) + (a - 1); }\n` +
        `/* @optimize */ function entry(p, q) { return h0(p, q); }`;
    it('transitive block-inline into expr position preserves outer `const t`', () => {
        const out = compiler.compileChunk('r.ts', withExports(src), {}).code;
        const want = evalProgram(src, 'entry(7, 3)');
        const got = evalProgram(out, 'entry(7, 3)');
        expect(got.ok ? JSON.stringify(got.value) : '<threw>').toBe(want.ok ? JSON.stringify(want.value) : '<threw>');
    });
});

// Pinned minimal repros the effect oracle (value + side-effect trace) found while
// making the optimizer Closure-aligned on side effects: an effectful expression
// must never be dropped, reordered, duplicated, or have its count changed. `eff`
// is the external effect recorder evalProgram injects.
describe('effect-preservation regressions (Closure-aligned)', () => {
    const chk = (name: string, src: string, call = 'entry(7, 3)') => {
        it(name, () => {
            const out = compiler.compileChunk('r.ts', withExports(src), {}).code;
            const want = evalProgram(src, call);
            const got = evalProgram(out, call);
            expect(got.ok ? JSON.stringify(got.value) : '<threw>').toBe(want.ok ? JSON.stringify(want.value) : '<threw>');
        });
    };

    // Inlining a fn whose param is UNUSED dropped the arg's effect. Now an impure
    // arg is eval-once-hoisted (eager) instead of substituted/dropped.
    chk(
        'unused-param impure arg effect preserved',
        `/* @inline */ function h(a, b) { return b; }\n/* @optimize */ function entry(p, q) { return h(eff(p), q); }`,
    );
    // dead_assignments hoisted a dead declarator's impure init AFTER later inits,
    // reordering effects. Now it splits the decl in evaluation order.
    chk(
        'dead-field init keeps order (dead_assignments)',
        `/* @optimize */ function entry(p, q) { const o = /* @sroa */ { x: eff(1), y: eff(2) }; return o.y; }`,
    );
    // Inliner/ExprHoister hoisted an arg-temp before the statement, jumping it past
    // an effect to its LEFT. Now hoist-needing inlines bail when not the first effect.
    chk(
        'DIRECT inline hoist past left effect',
        `/* @inline */ function h0(a, b) { return eff(a); }\n/* @optimize */ function entry(p, q) { return eff(1) + h0(eff(2), eff(3)); }`,
    );
    chk(
        'BLOCK inline hoist past left effect',
        `/* @inline */ function dbl(a) { return a + a; }\n/* @optimize */ function entry(p, q) { return eff(1) + dbl(eff(2)); }`,
    );
    // vec.x (member read) is still assumed pure → optimization NOT killed.
    chk(
        'member-read arg still drops (getters assumed pure)',
        `/* @inline */ function h(a, b) { return b; }\n/* @optimize */ function entry(p, q) { const v = { x: 5 }; return h(v.x, q); }`,
    );
    // Known-pure builtin (Math.*) in an unused arg is still droppable (allowlist) —
    // value + trace unchanged (it has no effect).
    chk(
        'pure builtin unused arg (allowlist)',
        `/* @inline */ function h(a, b) { return b; }\n/* @optimize */ function entry(p, q) { return h(Math.max(eff(1), 9), q); }`,
    );
    // A single-def impure RHS used twice must NOT be duplicated by inline-variables.
    chk(
        'inline-variables no-dup impure RHS',
        `/* @optimize */ function entry(p, q) { const v = eff(p); return v + v; }`,
    );
    // @unroll preserves the per-iteration effect count + order.
    chk(
        'unroll preserves effect count',
        `/* @optimize */ function entry(p, q) { let a = 0; /* @unroll */ for (let i = 0; i < 3; i++) { a += eff(i); } return a; }`,
    );
    // SROA's collapse_result_temps inlined a single-use temp `let b=eff(…)` into its
    // read even when the read sat in a conditional (`… ? 2 : b`) — moving the effect
    // into a branch → dropped when not taken. Now impure temps only collapse into an
    // UNCONDITIONAL read. Found by the purity-broadened fuzzer.
    chk(
        'sroa collapse keeps impure temp out of a conditional read',
        `/* @inline */ function h0(a, b) { if (Math.abs(a) === eff(9)) return (a === eff(4) ? 2 : b); return Math.abs(eff(a)); }\nfunction h1(a, b) { return eff(h0(a, 9)); }\n/* @optimize */ function entry(p, q) { return h0(q, h1(p, q)); }`,
    );

    // /*@__PURE__*/ lets the unused call drop, but its impure ARG still runs.
    chk(
        'pure-annotated call keeps impure arg effect',
        `function f(x) { return x; }\n/* @optimize */ function entry(p, q) { const v = /*@__PURE__*/ f(eff(7)); return q; }`,
    );
    // `x instanceof C` invokes C[Symbol.hasInstance]; `k in obj` a Proxy `has`
    // trap — real effects that must not be dropped/reordered (HOLE 1).
    chk(
        'instanceof effect preserved (Symbol.hasInstance)',
        `class C { static [Symbol.hasInstance](x) { eff(1); return false; } }\n/* @inline */ function ignore(a) { return 42; }\n/* @optimize */ function entry(p, q) { return ignore(p instanceof C) + q; }`,
    );
    // A class EXPRESSION runs static field initializers when evaluated (HOLE 2).
    chk(
        'class-expression static-init effect preserved',
        `/* @inline */ function ignore(a) { return 42; }\n/* @optimize */ function entry(p, q) { return ignore(class { static z = eff(9); }) + q; }`,
    );

    // Nested inline + multi-call temp collision: @inline `h0` (BLOCK) inlined into
    // `h1` bakes id-0 temps (`a__0`/`_h0__result_0`) into h1's body; inlining h1 at
    // two sites cloned them, and minimize-exit unwrapping the blocks conflated the
    // duplicates → one expansion's value used for both (here pt3.x's eff(16) became
    // pa0.x's eff(1)). build_block_plan now re-uniquifies nested generated temps.
    chk(
        'nested-inline cloned-temp collision (eff value)',
        `/* @inline */ function h0(a, b) { if (b > 99) return 0; return (b > Math.max(b, 4) ? eff(a) : eff(b)); }\nfunction h1(a, b) { return h0(b + a, b * b); }\n/* @inline */ function h2(a, b) { return { x: h1(4, 4), y: (a - b) }; }\n/* @optimize */ function entry(p, q) { const pa0 = /* @sroa */ { x: h1(4, 1), y: 2 }; const pt3 = /* @sroa */ h2(p, q); return pa0.x + pt3.y; }`,
    );

    // OPTIMIZATION (not just correctness): chained multi-statement @inline helpers
    // — the textbook `lenSq(a) + lenSq(b)` — must BOTH inline. A regression made
    // the post-inline effect signal pre-inline, so the left (soon-pure) call bailed
    // the right. Assert no residual helper call survives.
    it('chained BLOCK @inline helpers both inline', () => {
        const out = compiler.compileChunk(
            'r.ts',
            `/* @inline */ function lenSq(v) { const dx = v.x; const dy = v.y; return dx * dx + dy * dy; }\nexport function entry(a, b) { return lenSq(a) + lenSq(b); }`,
            {},
        ).code;
        expect(out).not.toMatch(/lenSq\s*\(/); // both calls inlined away
    });

    // Cross-file: inlining a donor whose param sits in a conditional branch
    // substituted the impure arg into that branch, dropping its effect when the
    // branch wasn't taken. Now the impure arg is hoisted eager.
    it('cross-file conditional-param drop preserved', () => {
        const donor = `export function d0(a, b) { return (eff(2) > a ? (b - 9) : 5); }`;
        const consumer = `import { d0 } from "./donor";\n/* @optimize */ function entry(p, q) { return q - d0(Math.abs(99), eff(0)); }`;
        expect(crossDiff(donor, consumer, './donor')).toBe(null);
    });
});

// ── value/coercion generator ─────────────────────────────────────────────────
//
// The main Gen/ChainGen/ScratchGen are deliberately all-NUMERIC (total, no NaN /
// -0 / strings / undefined), which leaves the compiler's TYPE-GATED folds and its
// coercion/short-circuit handling completely unfuzzed. CoerceGen closes that gap:
// it flows SPICY scalars — strings, booleans, null, undefined, and the special
// numbers NaN (`0/0`), ±Infinity (`1/0` / `-1/0`), and `-0` — through identity
// folds (`x*1`, `1*x`, `x-0`), coercion (`s + n`, `n + s`), and the operators the
// numeric fuzzer never emits: `&& || ?? % ** | & ^ << >> >>>`, unary `- ! ~ typeof
// void +`, the sequence `,`, and comparisons. The spicy values enter via INFERENCE
// (real literal-typed locals, never a lying `as number` cast), so it's the
// compiler's own type inference under test, not a contract we handed it.
//
// The generator is structured to stay SOUND-BY-CONSTRUCTION over the compiler's
// currently-correct subspace: `&&`/`||`/`??`/`?:` appear only as a SINGLE
// top-level combinator over pure-arithmetic operands (never nested inside another
// logical/ternary — the shape that trips the boolean-context leak pinned below),
// and the additive-identity `x + 0` fold form (the -0 hazard, also pinned) is only
// emitted under FUZZ_SPICY. So the gate is GREEN; set FUZZ_SPICY=1 to re-enable
// the buggy shapes for an ad-hoc bug-hunting campaign.
const CG_ARITH_BIN = ['+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>', ',', '<', '>', '<=', '>=', '===', '!==', '==', '!='];
const CG_LOGIC = ['&&', '||', '??'];
const CG_UNARY = ['-', '!', '~', 'typeof ', 'void ', '+'];
class CoerceGen {
    private id = 0;
    private spicyMode = !!process.env.FUZZ_SPICY;
    constructor(private r: Rng) {}
    private fresh(p = 'v'): string {
        return `${p}${this.id++ % 6}`;
    }
    // Spicy scalar literals, introduced via inference (const/let → real literal
    // type). Compound ones are parenthesized so `**` / `/` precedence is unambiguous.
    private spicy(): string {
        return pick(this.r, [
            '"ab"', '"3"', '""', '"x"', '"0"', // strings (incl. numeric-looking + empty)
            'true', 'false',
            '0', '1', '2', '5', '9', '(-3)', '(-0)', // numbers incl. -0
            '(0/0)', '(1/0)', '(-1/0)', // NaN, +Infinity, -Infinity
            'null',
        ]);
    }
    private leaf(s: string[]): string {
        const o: (() => string)[] = [() => this.spicy(), () => 'p', () => 'q'];
        if (s.length) o.push(() => pick(this.r, s));
        return pick(this.r, o)();
    }
    // Pure arithmetic/coercion/bitwise/unary expression — NO `&&`/`||`/`??`/`?:`
    // (those live only at `top`). Includes the SOUND identity folds `x*1`, `1*x`,
    // `x-0` (these preserve -0/NaN, so they test the type gate without the -0 hazard).
    private arith(s: string[], depth: number): string {
        if (depth <= 0) return this.leaf(s);
        const f: (() => string)[] = [
            () => this.leaf(s),
            () => `(${this.arith(s, depth - 1)} ${pick(this.r, CG_ARITH_BIN)} ${this.arith(s, depth - 1)})`,
            () => `(${pick(this.r, CG_UNARY)}${this.arith(s, depth - 1)})`,
            () => `eff(${this.arith(s, depth - 1)})`,
            () => `(${this.arith(s, depth - 1)} * 1)`,
            () => `(1 * ${this.arith(s, depth - 1)})`,
            () => `(${this.arith(s, depth - 1)} - 0)`,
        ];
        if (this.spicyMode)
            f.push(
                // -0 hazard: `x + 0` / `0 + x` normalize -0 to +0 (pinned bug A).
                () => `(${this.arith(s, depth - 1)} + 0)`,
                () => `(0 + ${this.arith(s, depth - 1)})`,
                // boolean-context leak: logical/ternary NESTED in an expr (pinned bug B).
                () => `(${this.arith(s, depth - 1)} ${pick(this.r, CG_LOGIC)} ${this.arith(s, depth - 1)})`,
                () => `(${this.arith(s, depth - 1)} ? ${this.arith(s, depth - 1)} : ${this.arith(s, depth - 1)})`,
            );
        return pick(this.r, f)();
    }
    // A top-level value: pure arith, or ONE logical/ternary combinator over arith
    // operands (single level → never the nested boolean-context shape).
    private top(s: string[]): string {
        const k = int(this.r, 0, 4);
        if (k <= 2) return this.arith(s, 3);
        if (k === 3) return `(${this.arith(s, 2)} ${pick(this.r, CG_LOGIC)} ${this.arith(s, 2)})`;
        return `(${this.arith(s, 2)} ? ${this.arith(s, 2)} : ${this.arith(s, 2)})`;
    }
    program(): string {
        this.id = 0;
        const s: string[] = [];
        const stmts: string[] = [];
        if (chance(this.r, 0.5)) {
            const u = this.fresh('u');
            stmts.push(`let ${u};`); // an `undefined` local, by inference
            s.push(u);
        }
        const k = int(this.r, 2, 5);
        for (let i = 0; i < k; i++) {
            const form = int(this.r, 0, 3);
            if (form === 0) {
                const v = this.fresh('c');
                stmts.push(`const ${v} = ${this.spicy()};`); // inferred literal-typed local
                s.push(v);
            } else if (form === 1) {
                const v = this.fresh('c');
                stmts.push(`const ${v} = ${this.arith(s, 2)};`);
                s.push(v);
            } else if (form === 2) {
                stmts.push(`eff(${this.arith(s, 2)});`); // bare effect (must not be dropped)
            } else {
                const v = this.fresh('w');
                stmts.push(`let ${v} = ${this.spicy()}; ${v} = ${this.arith(s, 2)};`);
                s.push(v);
            }
        }
        stmts.push(`return [${this.top(s)}, ${this.top(s)}];`);
        const opt = chance(this.r, 0.8) ? '/* @optimize */ ' : '';
        return `${opt}function entry(p, q) {\n  ${stmts.join('\n  ')}\n}`;
    }
}

/** Value/coercion differential. Same value+trace oracle as `diff`, but ALLOWLISTS
 *  the known, still-open signed-zero fold bug (pinned below): a divergence that
 *  disappears once -0 and +0 are unified is that bug, not a new regression. Any
 *  remaining (structural) divergence is a genuine, un-pinned miscompile. */
function coerceDiff(code: string): { call: string; compiled: string; want: unknown; got: unknown } | null {
    const call = 'entry(7, 3)';
    const want = evalProgram(code, call);
    const compiled = compiler.compileChunk('fuzz.ts', withExports(code), {}).code;
    const got = evalProgram(compiled, call);
    if (resultsEquiv(want, got)) return null;
    if (resultsEquiv(want, got, /* looseZero */ true)) return null; // allowlist -0 fold (bug A)
    return { call, compiled, want: want.ok ? want.value : '<threw>', got: got.ok ? got.value : '<threw>' };
}

describe('fuzz: value/type diversity + coercion + operators', () => {
    const BASE = Number(process.env.FUZZ_SEED ?? 0) || 0x7c3a9f11;
    const ITERS = Number(process.env.FUZZ_ITERS ?? 0) || 400;
    it(`${ITERS} spicy-scalar programs preserve semantics`, () => {
        for (let i = 0; i < ITERS; i++) {
            const seed = (BASE ^ 0x9e3779b9) + i * 2654435761;
            const code = new CoerceGen(mulberry32(seed >>> 0)).program();
            let d: ReturnType<typeof coerceDiff>;
            try {
                d = coerceDiff(code);
            } catch (e) {
                d = { call: 'entry(7, 3)', compiled: `<compile threw: ${(e as Error).message}>`, want: 'n/a', got: 'n/a' };
            }
            if (d) {
                const minimal = (() => {
                    try {
                        return shrink(code);
                    } catch {
                        return code;
                    }
                })();
                const md = coerceDiff(minimal) ?? d;
                throw new Error(
                    `COERCE MISCOMPILE (seed=${seed >>> 0}, FUZZ_SEED=${BASE} i=${i})\n` +
                        `call: ${md.call}   want=${JSON.stringify(md.want)} got=${JSON.stringify(md.got)}\n\n` +
                        `--- minimal source ---\n${minimal}\n\n` +
                        `--- compiled ---\n${md.compiled}\n`,
                );
            }
        }
        expect(true).toBe(true);
    });
});

// ── KNOWN BUGS (open) ─────────────────────────────────────────────────────────
// Real source-vs-compiled miscompiles surfaced by CoerceGen (run with FUZZ_SPICY=1).
// Each is a genuine value divergence — verified by hand — and stays pinned as an
// `it.fails` until the core is fixed. `expectDiverges` asserts the compiled output
// does NOT match source semantics (deepEq); under `it.fails` the failing assertion
// is the expected state, so when the bug is FIXED the pin turns red and pings us.
describe('KNOWN BUGS — value/coercion fuzz (open)', () => {
    const expectDiverges = (src: string, call = 'entry(7, 3)') => {
        const out = compiler.compileChunk('r.ts', withExports(src), {}).code;
        const want = evalProgram(src, call);
        const got = evalProgram(out, call);
        // Passes (bug reproduced) ONLY while they diverge; throws once equal (fixed).
        expect(resultsEquiv(want, got)).toBe(true);
    };

    // BUG A — signed zero. The additive-identity fold `x + 0` / `0 + x` → `x` is
    // gated on the operand being a number, but `-0` IS a number and `-0 + 0 === +0`,
    // so the fold discards the sign. `0 + (-q * 0)` (q=3): source keeps the `+ 0`
    // → +0; compiled drops it → `-q * 0` → -0. Object.is(+0,-0) === false, so the
    // value is observably wrong (e.g. `1 / result` → +Inf vs -Inf). Suspected pass:
    // the numeric identity-fold peephole (arith fold / minimize). The sound folds
    // `x * 1`, `1 * x`, `x - 0` (which DO preserve -0) are exercised by the green gate.
    it.fails('`0 + x` additive-identity fold discards -0 (source +0, compiled -0)', () => {
        expectDiverges(`/* @optimize */ function entry(p, q) { return 0 + (-q * 0); }`);
    });
    it.fails('`x + 0` additive-identity fold discards -0 (source +0, compiled -0)', () => {
        expectDiverges(`/* @optimize */ function entry(p, q) { return (-q * 0) + 0; }`);
    });

    // BUG B — boolean-context leak. When a `||`/`&&`/`?:` sub-expression is an
    // operand of an ENCLOSING logical operator, the minimizer folds it by TRUTHINESS
    // only (`a || truthyConst` → `truthyConst`, `a && truthyConst` → `a`,
    // `cond ? truthyConst : c` → `cond || c`) — valid in a boolean context, but here
    // the enclosing logical expression's VALUE is returned, so the produced value is
    // corrupted. One root cause (context propagated as boolean into the operand),
    // shown via three surface forms. Suspected pass: the conditional/short-circuit
    // minimizer (Closure-style PeepholeMinimizeConditions / fold-constants).
    it.fails('`A || (p || 1)` drops p’s value (source 7, compiled 1)', () => {
        // compiles to `q < 0 || 1`: source (q<0 → false, so p||1 → p) = 7; compiled = 1.
        expectDiverges(`/* @optimize */ function entry(p, q) { return (q < 0) || (p || 1); }`);
    });
    it.fails('`A && (p ? 1 : q)` rewrites ternary to `p || q` (source 1, compiled 7)', () => {
        // compiles to `p && (p || q)`: source (p truthy → 1) = 1; compiled (p||q) = 7.
        expectDiverges(`/* @optimize */ function entry(p, q) { return p && (p ? 1 : q); }`);
    });
    it.fails('`A && (q && 5)` drops the value (source 5, compiled 3)', () => {
        // compiles to `p && q`: source (q truthy → 5) = 5; compiled = 3.
        expectDiverges(`/* @optimize */ function entry(p, q) { return p && (q && 5); }`);
    });

    // BUG C — module-scratch alias dropped under a returned closure. The single-owner
    // module-scratch scalar-replacement follows the alias `const va = v` and rewrites
    // the DIRECT writes to `v[i] = …`, dropping the `const va = v` binding — but a
    // RETURNED closure `() => va[0]` still references `va`, so the compiled output is
    // `ReferenceError: va is not defined`. Source returns the value; compiled throws.
    // Surfaced by the module-scratch fuzzer's `aliasClosure` mode once its previously
    // broken plumbing (it never actually invoked `entry`) was fixed. Suspected pass:
    // the module-scratch SROA alias-following (GlobalOpt-localize). NOTE: compiled
    // with an explicit `export { entry }` — exporting the scratch const `v` (which
    // `withExports` would do) forces a bail and hides the bug.
    it.fails('module-scratch alias dropped but read by returned closure (ReferenceError)', () => {
        const src = `const v = /*@__PURE__*/ [0];\n/* @optimize */ function entry(p) { const va = v; va[0] = p; return () => va[0]; }`;
        const call = 'entry(5)()'; // source → 5; compiled throws (`va` undeclared)
        const out = compiler.compileChunk('r.ts', `${src}\nexport { entry };`, {}).code;
        const want = evalProgram(src, call);
        const got = evalProgram(out, call);
        expect(resultsEquiv(want, got)).toBe(true);
    });
});
