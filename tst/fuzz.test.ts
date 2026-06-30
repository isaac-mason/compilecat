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
    const js = code.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
    try {
        // biome-ignore lint/security/noGlobalEval: intentionally evaluating generated/compiled code
        return { ok: true, value: new Function(`${js}\nreturn (${call});`)() };
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
        if (depth <= 0) return pick(this.r, leaves)();
        const numHelpers = this.helpers.filter((h) => h.kind === 'num');
        const forms: (() => string)[] = [
            () => pick(this.r, leaves)(),
            () => `(${this.numExpr(s, depth - 1)} ${pick(this.r, ['+', '-', '*'])} ${this.numExpr(s, depth - 1)})`,
            () => `Math.abs(${this.numExpr(s, depth - 1)})`,
            () => `Math.max(${this.numExpr(s, depth - 1)}, ${this.numExpr(s, depth - 1)})`,
        ];
        if (numHelpers.length)
            forms.push(() => {
                const h = pick(this.r, numHelpers);
                return `${h.name}(${this.numExpr(s, depth - 1)}, ${this.numExpr(s, depth - 1)})`;
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

    // Build the helper declarations first (entry calls them).
    private genHelpers(): string {
        const n = int(this.r, 1, 4);
        const out: string[] = [];
        for (let i = 0; i < n; i++) {
            const kind = pick(this.r, ['num', 'num', 'pt', 'void'] as const);
            const h: Helper = { name: `h${i}`, kind, inline: chance(this.r, 0.6) };
            this.helpers.push(h);
            const dir = h.inline ? '/* @inline */ ' : '';
            const s: Scope = { nums: ['a', 'b'], pts: [] };
            if (kind === 'num') {
                // Mix DIRECT (single return) and BLOCK (branch / temp) bodies.
                const shape = int(this.r, 0, 2);
                if (shape === 0) out.push(`${dir}function ${h.name}(a, b) { return ${this.numExpr(s, 2)}; }`);
                else if (shape === 1)
                    out.push(`${dir}function ${h.name}(a, b) { if (${this.cond(s)}) return ${this.numExpr(s, 2)}; return ${this.numExpr(s, 2)}; }`);
                else
                    out.push(`${dir}function ${h.name}(a, b) { let t; if (${this.cond(s)}) { t = ${this.numExpr(s, 2)}; } else { t = ${this.numExpr(s, 2)}; } return t; }`);
            } else if (kind === 'pt') {
                out.push(`${dir}function ${h.name}(a, b) { return { x: ${this.numExpr({ nums: ['a', 'b'], pts: [] }, 1)}, y: ${this.numExpr({ nums: ['a', 'b'], pts: [] }, 1)} }; }`);
            } else {
                // void: mutate point arg0 (a is a point here, b a number).
                const ps: Scope = { nums: ['b'], pts: ['a'] };
                out.push(`${dir}function ${h.name}(a, b) { a.x = ${this.numExpr(ps, 1)}; a.y = ${this.numExpr(ps, 1)}; }`);
            }
        }
        return out.join('\n');
    }

    private genEntryBody(): string {
        const s: Scope = { nums: ['p', 'q'], pts: [] };
        const stmts: string[] = [];
        const k = int(this.r, 2, 6);
        for (let i = 0; i < k; i++) {
            const form = int(this.r, 0, 6);
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
                // array aggregate (sometimes @sroa) + constant-index reads
                const v = this.fresh('arr');
                const dir = chance(this.r, 0.5) ? '/* @sroa */ ' : '';
                stmts.push(`const ${v} = ${dir}[${this.numExpr(s, 1)}, ${this.numExpr(s, 1)}];`);
                stmts.push(`const ${this.fresh('s')} = ${v}[0] + ${v}[1];`);
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
                if (diff(candidate)) {
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
//   FUZZ_ITERS=80000 pnpm fuzz            (raise vitest's timeout for big runs:)
//   FUZZ_ITERS=80000 npx vitest run tst/fuzz.test.ts --testTimeout=600000
// FUZZ_SEED varies the corpus. The default batch is kept small so the gate stays
// fast; the tail is covered by the on-demand campaign.
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
});
