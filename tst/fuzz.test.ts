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
            `const __t = [];\nconst eff = (x) => { __t.push(x); return x; };\n${js}\nreturn [(${call}), __t];`,
        )();
        return { ok: true, value };
    } catch {
        return { ok: false };
    }
}

/** Compare source-eval vs compiled-eval. Returns null if equivalent, else why. */
function diff(code: string): { call: string; compiled: string; want: unknown; got: unknown } | null {
    const call = 'entry(7, 3)';
    const want = evalProgram(code, call);
    if (!want.ok) return null; // generated program threw — not a compiler concern
    const compiled = compiler.compileChunk('fuzz.ts', withExports(code), {}).code;
    const got = evalProgram(compiled, call);
    const wv = JSON.stringify(want.value);
    const gv = got.ok ? JSON.stringify(got.value) : '<threw>';
    if (wv === gv) return null;
    return { call, compiled, want: want.value, got: got.ok ? got.value : '<threw>' };
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
    if (!want.ok) return null;
    const compiled = compiler.compileFileCross(
        'entry.ts',
        withExports(consumer),
        [{ specifier, path: '/p/donor.ts', code: donor, resolved: [] }],
        {},
    ).code;
    const got = evalProgram(`${donor}\n${compiled}`, call);
    const wv = JSON.stringify(want.value);
    const gv = got.ok ? JSON.stringify(got.value) : '<threw>';
    if (wv === gv) return null;
    return { compiled, want: want.value, got: got.ok ? got.value : '<threw>' };
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
                // Mix DIRECT (single return) and BLOCK (branch / temp) bodies.
                const shape = int(this.r, 0, 2);
                if (shape === 0) out.push(`${head}function ${h.name}(a, b) { return ${this.numExpr(s, 2)}; }`);
                else if (shape === 1)
                    out.push(`${head}function ${h.name}(a, b) { if (${this.cond(s)}) return ${this.numExpr(s, 2)}; return ${this.numExpr(s, 2)}; }`);
                else
                    out.push(`${head}function ${h.name}(a, b) { let t; if (${this.cond(s)}) { t = ${this.numExpr(s, 2)}; } else { t = ${this.numExpr(s, 2)}; } return t; }`);
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
                if (
                    orig.ok &&
                    cv.ok &&
                    JSON.stringify(cv.value) === JSON.stringify(orig.value) &&
                    diff(candidate)
                ) {
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
            expect(got.ok ? JSON.stringify(got.value) : '<threw>').toBe(JSON.stringify(want.value));
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
    // /*@__PURE__*/ lets the unused call drop, but its impure ARG still runs.
    chk(
        'pure-annotated call keeps impure arg effect',
        `function f(x) { return x; }\n/* @optimize */ function entry(p, q) { const v = /*@__PURE__*/ f(eff(7)); return q; }`,
    );

    // Cross-file: inlining a donor whose param sits in a conditional branch
    // substituted the impure arg into that branch, dropping its effect when the
    // branch wasn't taken. Now the impure arg is hoisted eager.
    it('cross-file conditional-param drop preserved', () => {
        const donor = `export function d0(a, b) { return (eff(2) > a ? (b - 9) : 5); }`;
        const consumer = `import { d0 } from "./donor";\n/* @optimize */ function entry(p, q) { return q - d0(Math.abs(99), eff(0)); }`;
        expect(crossDiff(donor, consumer, './donor')).toBe(null);
    });
});
