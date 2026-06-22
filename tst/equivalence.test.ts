// Behavioral-equivalence gate (the PRIMARY correctness gate): compilecat's
// optimized output must compute the same value as the original source.
//
// Each case is a self-contained chunk whose `call` returns a value. We eval the
// raw source and the compiled output and assert they agree.

import { describe, expect, it } from 'vitest';

import { createCompiler } from '../src/compiler';

const compiler = createCompiler();

function run(code: string, call: string): unknown {
    // Strip ESM exports so `new Function` can eval. We compile the entry as
    // exported (so remove-unused-code keeps it — it's the module's API); here we
    // drop the export syntax to run it.
    const js = code.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
    return new Function(`${js}\nreturn (${call});`)();
}

/** Every top-level value binding declared in `code` — exported so
 *  remove-unused-code treats them as live module API (the entry the test calls
 *  may be nested in the call expr, e.g. `JSON.stringify(f(3))`). */
function topLevelDecls(code: string): string[] {
    const names = new Set<string>();
    for (const m of code.matchAll(/(?:^|\n)[^\S\n]*(?:\/\*.*?\*\/[^\S\n]*)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g))
        names.add(m[1]);
    for (const m of code.matchAll(/(?:^|\n)[^\S\n]*class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of code.matchAll(/(?:^|\n)[^\S\n]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    return [...names];
}

/** Append `export { … }` for every top-level binding so they survive DCE. */
function withExports(code: string): string {
    const names = topLevelDecls(code);
    return names.length ? `${code}\nexport { ${names.join(', ')} };` : code;
}

type Case = {
    name: string;
    code: string;
    call: string;
};

const CASES: Case[] = [
    {
        name: 'inline-direct',
        code: `/* @inline */ function add(a, b) { return a + b; }\nfunction step(x) { return add(x, 1); }`,
        call: 'step(41)',
    },
    {
        name: 'inline-reused-pure-arg',
        code: `/* @inline */ function twice(a) { return a + a; }\nfunction f(y) { return twice(y); }`,
        call: 'f(21)',
    },
    {
        // Regression: an inlined-result object used only INSIDE a conditional
        // block, as an arg to another inlined helper. The 'corr' binding was
        // dropped while its corr.x/.y uses survived → ReferenceError.
        name: 'inline-result-arg-in-conditional',
        code: `function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function scale(a, s) { return { x: a.x * s, y: a.y * s }; }
/* @optimize */ function f(a, s, p) { const corr = scale(a, s); if (p) { const na = sub(a, corr); a.x = na.x; a.y = na.y; } return a; }`,
        call: 'JSON.stringify(f({ x: 10, y: 4 }, 2, true))',
    },
    {
        name: 'sroa-tuple',
        code: `/* @sroa */ function f() { const v = [1, 2, 3]; v[0] = v[1] + v[2]; return v[0]; }`,
        call: 'f()',
    },
    {
        name: 'sroa-exported',
        code: `/* @sroa */ function f() { const p = [10, 20]; return p[0] + p[1]; }`,
        call: 'f()',
    },
    {
        name: 'unroll-for',
        code: `function sum() { let s = 0; /* @unroll */ for (let i = 0; i < 4; i++) s += i; return s; }`,
        call: 'sum()',
    },
    {
        // @optimize no longer implies unrolling (R2): the loop is left intact,
        // but behavior must still be preserved by the other @optimize passes.
        name: 'optimize-fn-loop-preserved',
        code: `/* @optimize */ function g() { let s = 1; for (let i = 1; i <= 4; i++) s *= i; return s; }`,
        call: 'g()',
    },
    {
        name: 'unroll-for-of',
        code: `function h() { let s = 0; /* @unroll */ for (const x of [3, 5, 7]) s += x; return s; }`,
        call: 'h()',
    },
    {
        name: 'fold-and-inline-vars',
        code: `function f() { const a = 1 + 2; const b = a * 3; return b; }`,
        call: 'f()',
    },
    {
        name: 'multi-declarator-inline',
        code: `function f() { let a = 1, b = 2; a = a + 10; return a + b; }`,
        call: 'f()',
    },
    {
        name: 'dead-code-literal-if',
        code: `function f(x) { if (true) return x + 1; else return x - 1; }`,
        call: 'f(10)',
    },
    {
        name: 'sroa-residue-feeds-computation',
        code: `/* @sroa */ function f(k) { const v = [1, 2, 3]; v[0] = v[1] + v[2]; return v[0] * k; }`,
        call: 'f(2)',
    },
    {
        name: 'sroa-with-user-var-and-control-flow',
        code: `/* @sroa */ function f(c) { const v = [1, 2]; let r = v[0]; if (c) r = v[1]; return r; }`,
        call: 'f(0)',
    },
    {
        name: 'block-inline-void-helper',
        code: `/* @inline */ function init(out, a) { out.x = a; out.y = a * 2; }\nfunction setup() { const v = {}; init(v, 5); return v.x + v.y; }`,
        call: 'setup()',
    },
    {
        name: 'block-inline-multi-callsite',
        code: `/* @inline */ function push(arr, x) { arr.push(x); arr.push(x + 1); }\nfunction build() { const a = []; push(a, 1); push(a, 10); return a.length; }`,
        call: 'build()',
    },
    {
        // BLOCK body WITH an early return, inlined at an init-position call.
        name: 'block-inline-early-return-init',
        code: `/* @inline */ function clampPos(a) { if (a < 0) return 0; return a; }\nfunction f(x) { let v = clampPos(x); return v + 1; }`,
        call: 'f(-5)',
    },
    {
        name: 'block-inline-early-return-init-pos',
        code: `/* @inline */ function clampPos(a) { if (a < 0) return 0; return a; }\nfunction f(x) { let v = clampPos(x); return v + 1; }`,
        call: 'f(7)',
    },
    {
        // BLOCK at an assignment-position call.
        name: 'block-inline-assign-position',
        code: `/* @inline */ function dbl(a) { const t = a * 2; return t; }\nfunction f(x) { let v = 0; v = dbl(x); return v; }`,
        call: 'f(9)',
    },
    {
        // DIRECT→BLOCK fallback: impure arg used twice must evaluate once.
        name: 'inline-direct-to-block-fallback',
        code: `/* @inline */ function twice(a) { return a + a; }\nfunction f() { let c = 0; const inc = () => ++c; let v = twice(inc()); return v * 10 + c; }`,
        call: 'f()',
    },
    {
        // α-rename: args reference the param names.
        name: 'block-inline-alpha-rename',
        code: `/* @inline */ function scale(v, k) { v = v * k; return v; }\nfunction f(v, k) { let r = scale(v, k); return r; }`,
        call: 'f(3, 4)',
    },
    {
        // multiple interior returns through the labeled-break machinery.
        name: 'block-inline-multi-return',
        code: `/* @inline */ function sign(a) { if (a > 0) return 1; if (a < 0) return -1; return 0; }\nfunction f(x) { let s = sign(x); return s * 100; }`,
        call: 'f(-7)',
    },
    {
        // BLOCK body in EXPRESSION position (`return sq(x) + 1`) — hoisted temp.
        name: 'block-inline-expression-position',
        code: `/* @inline */ function sq(a) { const t = a * a; return t; }\nfunction f(x) { return sq(x) + 1; }`,
        call: 'f(4)',
    },
    {
        // BLOCK call nested as an argument (`use(sq(x))`).
        name: 'block-inline-nested-arg',
        code: `/* @inline */ function sq(a) { const t = a * a; return t; }\nfunction f(x) { return [sq(x), sq(x + 1)]; }`,
        call: 'JSON.stringify(f(3))',
    },
    {
        // @flatten: calls inside the host inline even though the callee isn't @inline.
        name: 'flatten-inlines-host-calls',
        code: `function add(a, b) { return a + b; }\nfunction mul(a, b) { return a * b; }\n/* @flatten */ function host(x) { return add(mul(x, 2), 1); }`,
        call: 'host(5)',
    },
    {
        // call-site /* @inline */ on a non-@inline callee — only that call inlines.
        name: 'callsite-inline',
        code: `function dbl(a) { return a * 2; }\nfunction f(x) { return /* @inline */ dbl(x) + dbl(x); }`,
        call: 'f(6)',
    },
    {
        // init-position reuse is UNSAFE: the donor body free-refs `base` (the
        // module const), which matches the consumer's `let base`. Naive reuse
        // (`let base; { …base… }`) would read the TDZ var — must demote to a
        // fresh temp so `a + base` still binds the module const (100).
        name: 'block-init-unsafe-reuse-demotes',
        code: `const base = 100;\n/* @inline */ function calc(a) { const t = a + base; return t; }\nfunction f() { let base = calc(5); return base; }`,
        call: 'f()',
    },
    {
        // Baseline (must keep working): a single-level void helper inlined into an
        // @optimize host's loop body, referencing the per-iteration binding.
        name: 'flatten-void-helper-in-loop',
        code: `function zeroForces(e) { e.fx = 0; e.fy = 0; }\n/* @optimize */ function reset(arr) { for (let i = 0; i < arr.length; i++) { zeroForces(arr[i]); } return arr[0].fx + arr[0].fy; }`,
        call: 'reset([{ fx: 9, fy: 9 }])',
    },
    {
        // The reported bug shape: an @optimize host inlines `integrate`, whose
        // BODY makes statement-position calls to other helpers (limitV/wrapPos).
        // Those inner bodies must land at the call site — after `let e = arr[i]` —
        // not hoisted to the host top (which would ReferenceError on `e`).
        name: 'flatten-two-level-statement-calls-in-loop',
        code: `function limitV(e, vmax) { if (e.vx > vmax) e.vx = vmax; }\nfunction wrapPos(e) { if (e.x > 100) e.x -= 100; }\nfunction integrate(e, vmax) { e.x = e.x + e.vx; limitV(e, vmax); wrapPos(e); }\n/* @optimize */ function step(arr) { for (let i = 0; i < arr.length; i++) { integrate(arr[i], 2); } return arr[0].x + arr[0].vx; }`,
        call: 'step([{ x: 99, vx: 5 }])',
    },
    {
        // Same two-level shape via @flatten, non-loop, with void helpers that
        // mutate a shared object through nested statement-position calls.
        name: 'flatten-two-level-void-helpers',
        code: `function accum(s, x) { s.total = s.total + x; }\nfunction process(s, x) { accum(s, x); accum(s, x * 2); }\n/* @flatten */ function compute(x) { const s = { total: 0 }; process(s, x); return s.total; }`,
        call: 'compute(5)',
    },
    {
        // Three-level chain: top → outer → twice → bump. Each level's inlined body
        // contains statement-position calls to the next; placement must compose.
        name: 'flatten-three-level-chain',
        code: `function bump(o) { o.v = o.v + 1; }\nfunction twice(o) { bump(o); bump(o); }\nfunction outer(o) { twice(o); twice(o); }\n/* @optimize */ function top() { const o = { v: 0 }; outer(o); return o.v; }`,
        call: 'top()',
    },
    {
        // Nested call whose arguments are locals the outer helper's inlined body
        // just computed — those locals must be bound before the inner body that
        // reads them is spliced (statement-placement / scope ordering).
        name: 'flatten-nested-call-uses-inlined-binding',
        code: `function dist2(dx, dy) { return dx * dx + dy * dy; }\nfunction measure(ax, ay, bx, by) { const dx = bx - ax; const dy = by - ay; return dist2(dx, dy); }\n/* @optimize */ function run() { return measure(0, 0, 3, 4); }`,
        call: 'run()',
    },
    {
        // Regression: object-literal args inlined as `let a = {…}; let b = {…}`
        // both carry SPAN(0,0); SROA keyed its declaration rewrite by span, so the
        // two aliased — only one scalarized while both names' accesses were
        // rewritten, leaving `a_x` referenced but undeclared (ReferenceError).
        // Fixed by keying on the declaration's arena Address.
        name: 'inline-object-args-then-sroa',
        code: `function dist2(p) { return p.dx * p.dx + p.dy * p.dy; }\nfunction measure(a, b) { const p = { dx: b.x - a.x, dy: b.y - a.y }; return dist2(p); }\n/* @optimize */ function run() { return measure({ x: 0, y: 0 }, { x: 3, y: 4 }); }`,
        call: 'run()',
    },
    {
        // Fixed (was task #29): an @optimize host that BLOCK-inlines a callee in
        // INIT position (`const r = callee(...)`) used to have its entire inlined
        // body deleted by flow-inline applying two chained, conflicting edits in
        // one pass — returned undefined. Now flow-inline defers the conflicting
        // edit to the next fixpoint iteration.
        name: 'optimize-block-inline-init-position',
        code: `/* @inline */ function callee(a, b) { let jv; if (a > b) { jv = a - b; } else { jv = b - a; } return jv; }\n/* @optimize */ function consumer(x, y) { const r = callee(x, y); return r; }`,
        call: 'consumer(5, 3)',
    },
    {
        // Harden collapse_result_temps: a multi-statement (BLOCK) callee whose
        // RETURN value has a side effect, read in non-leading position (right of
        // `+`). collapse moves E back to the call's slot, so eval order must be
        // preserved (mk('a') before mk('b')).
        name: 'collapse-side-effecting-return-eval-order',
        code: `let log = [];\nfunction mk(n, k) { const z = n; return { v: (log.push(k), z) }; }\n/* @optimize */ function f() { const s = mk(1, 'a').v + mk(2, 'b').v; return s + ':' + log.join(','); }`,
        call: 'f()',
    },
    {
        // Harden: the cloth shape end-to-end — multiple independent result temps,
        // a multi-statement callee (`norm`) calling a single-return helper (`len`)
        // that the 2nd DIRECT pass must inline, then SROA scalarizes everything.
        name: 'collapse-cloth-nested-multi-temp',
        code: `function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }\nfunction scale(a, s) { return { x: a.x * s, y: a.y * s }; }\nfunction len(a) { return Math.abs(a.x) + Math.abs(a.y); }\nfunction norm(a) { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; }\n/* @optimize */ function f(px, py) { const p = { x: px, y: py }; const d = norm(sub(p, { x: 1, y: 1 })); const sc = scale(d, 2); return sc.x + sc.y; }`,
        call: 'f(7, 3)',
    },
    {
        // Harden: a result temp collapsed inside a nested (if) block, not the
        // function top level.
        name: 'collapse-temp-in-nested-block',
        code: `function mk(n) { const z = n + 1; return { v: z, w: z * 2 }; }\n/* @optimize */ function f(c, n) { let out = 0; if (c) { const r = mk(n); out = r.v + r.w; } return out; }`,
        call: 'f(true, 5)',
    },
    {
        // Harden: a recursive callee under @optimize — the 2nd DIRECT pass must
        // stay bounded (inline a level, leave the residual self-call) and remain
        // correct, never expand forever.
        name: 'recursive-callee-bounded',
        code: `function fact(n) { if (n <= 1) return 1; return n * fact(n - 1); }\n/* @optimize */ function f() { return fact(5); }`,
        call: 'f()',
    },
    {
        // Conservatism: a deferred temp read field-wise more than once is not a
        // single-use alias → collapse must skip it (this is the documented
        // use-def-SROA follow-up). Behavior must be preserved regardless.
        name: 'deferred-temp-multi-read-preserved',
        code: `/* @optimize */ function f(p, q) { let v; v = { x: p + q, y: p - q }; const a = v.x; const b = v.y; return a * b; }`,
        call: 'f(5, 2)',
    },
    {
        // Conservatism: the read is not adjacent to the assignment (a statement
        // sits between) → collapse must skip and preserve behavior.
        name: 'deferred-temp-nonadjacent-read',
        code: `/* @optimize */ function f(p) { let v; v = { x: p }; const noop = p + 1; return v.x + noop; }`,
        call: 'f(9)',
    },
    {
        // SROA Stage 1: a deferred-init aggregate (single store, a statement
        // between decl and store, read field-wise twice) merges to init position
        // and scalarizes. Behavior must be identical.
        name: 'deferred-init-merge-scalarizes',
        code: `/* @optimize */ function f(p) { let v; const k = p + 1; v = { x: k, y: k * 2 }; return v.x + v.y; }`,
        call: 'f(5)',
    },
    {
        // Conservatism: a conditionally-stored aggregate has TWO stores → Stage 1
        // merge must skip it (Stage 3 / CFG territory). Behavior preserved.
        name: 'deferred-init-conditional-not-merged',
        code: `/* @optimize */ function f(c, n) { let v; if (c) { v = { x: n, y: 1 }; } else { v = { x: -n, y: 2 }; } return v.x + v.y; }`,
        call: 'f(true, 7)',
    },
    {
        // Conservatism: a deferred aggregate captured by a closure — relocating the
        // declaration could change when the closure can observe it, so the merge
        // must bail. Behavior preserved.
        name: 'deferred-init-closure-capture-not-merged',
        code: `/* @optimize */ function f(p) { let v; const get = () => v.x + v.y; v = { x: p, y: p + 1 }; return get(); }`,
        call: 'f(4)',
    },
    {
        // Two independent deferred aggregates in one scope — the merge loop must
        // handle both.
        name: 'deferred-init-multiple-aggregates',
        code: `/* @optimize */ function f(p, q) { let a; let b; a = { x: p, y: p + 1 }; b = { x: q, y: q - 1 }; return a.x * b.y + a.y * b.x; }`,
        call: 'f(3, 5)',
    },
    {
        // A field-write after the store — SROA must still scalarize across the
        // merged init + the in-place field assignment.
        name: 'deferred-init-then-field-write',
        code: `/* @optimize */ function f(n) { let v; v = { x: n, y: n * 2 }; v.x = v.x + 10; return v.x + v.y; }`,
        call: 'f(4)',
    },
    {
        // Conservatism: `var` (function-scoped/hoisted) is not relocated by the
        // merge (only `let`) — behavior preserved.
        name: 'deferred-init-var-not-merged',
        code: `/* @optimize */ function f(n) { var v; v = { x: n, y: n + 1 }; return v.x + v.y; }`,
        call: 'f(6)',
    },
    {
        // Conservatism: a multi-declarator `let a, b;` deferred init isn't merged
        // (the merge requires a single declarator) — behavior preserved.
        name: 'deferred-init-multi-declarator-not-merged',
        code: `/* @optimize */ function f(p, q) { let a, b; a = { x: p, y: 1 }; b = { x: q, y: 2 }; return a.x + b.y; }`,
        call: 'f(3, 5)',
    },
];

describe('behavioral equivalence: compiler output ≡ source', () => {
    for (const c of CASES) {
        it(c.name, () => {
            const expected = run(c.code, c.call);
            // Export entries so remove-unused-code treats them as live API.
            const compiled = compiler.compileChunk(`${c.name}.ts`, withExports(c.code), {}).code;
            const actual = run(compiled, c.call);
            expect(actual).toEqual(expected);
        });
    }
});
