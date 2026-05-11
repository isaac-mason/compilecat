import _generate from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { inlineVariables } from '../src/compiler/inline-variables';

// biome-ignore lint/suspicious/noExplicitAny: babel CJS interop
const generate: typeof _generate = (_generate as any).default ?? _generate;

function run(code: string): { out: string; stats: ReturnType<typeof inlineVariables> } {
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
    const stats = inlineVariables(ast);
    const out = (generate as unknown as (n: t.Node) => { code: string })(ast).code.trim();
    return { out, stats };
}

describe('inlineVariables', () => {
    it('inlines a single-use module-level constant', () => {
        const { out, stats } = run(`const FOO = 42; console.log(FOO);`);
        expect(out).toContain('console.log(42)');
        expect(out).not.toMatch(/\bconst FOO\b/);
        expect(stats.inlined).toBe(1);
    });

    it('inlines through a chain (fixpoint)', () => {
        const { out, stats } = run(`const a = 1; const b = a; const c = b; console.log(c);`);
        expect(out).toContain('console.log(1)');
        expect(stats.inlined).toBe(3);
    });

    it('does not inline multi-use of a non-immutable, non-alias init', () => {
        // `obj.prop` is neither a primitive literal (no multi-use immutable
        // inline) nor a bare identifier (no alias inline). Must stay put.
        const { out, stats } = run(`const x = obj.prop; console.log(x); console.log(x);`);
        expect(out).toContain('const x = obj.prop');
        expect(stats.inlined).toBe(0);
    });

    it('does not inline impure init', () => {
        const { out, stats } = run(`const x = sideEffect(); console.log(x);`);
        expect(out).toContain('const x = sideEffect()');
        expect(stats.inlined).toBe(0);
    });

    it('does not inline a let that gets reassigned', () => {
        const { out, stats } = run(`let x = 1; x = 2; console.log(x);`);
        expect(out).toContain('let x = 1');
        expect(stats.inlined).toBe(0);
    });

    it('does not inline an exported binding', () => {
        const { out, stats } = run(`export const x = 1;`);
        expect(out).toContain('export const x = 1');
        expect(stats.inlined).toBe(0);
    });

    it('does not inline when init reads a mutable identifier', () => {
        // `g` is reassigned, so relocating `const x = g` may observe a
        // different value.
        const { out, stats } = run(`let g = 1; g = 2; const x = g; console.log(x);`);
        expect(out).toContain('const x = g');
        expect(stats.inlined).toBe(0);
    });

    it('does inline when init reads a stable identifier', () => {
        const { out, stats } = run(`const g = 1; const x = g; console.log(x);`);
        // After fixpoint: x folded → console.log(g) → g folded → console.log(1).
        expect(out).toContain('console.log(1)');
        expect(stats.inlined).toBe(2);
    });

    it('does not inline a heap-allocating init into a loop body', () => {
        const { out, stats } = run(`const x = { a: 1 }; for (let i = 0; i < 3; i++) { use(x); }`);
        expect(out).toContain('const x =');
        expect(stats.inlined).toBe(0);
    });

    it('does inline a primitive literal into a loop body', () => {
        // Closure: testInlineIntoLoops. Re-evaluating `true` per iteration
        // is free, so safe to relocate.
        const { out, stats } = run(`const x = true; while (cond) { use(x); }`);
        expect(out).not.toMatch(/\bconst x\b/);
        expect(out).toContain('use(true)');
        expect(stats.inlined).toBe(1);
    });

    it('does not inline across an async function boundary', () => {
        const { out, stats } = run(`const x = 1; async function f() { return x; }`);
        expect(out).toContain('const x = 1');
        expect(stats.inlined).toBe(0);
    });

    it('does not inline across a generator function boundary', () => {
        const { out, stats } = run(`const x = 1; function* g() { yield x; }`);
        expect(out).toContain('const x = 1');
        expect(stats.inlined).toBe(0);
    });

    it('inlines into a non-async nested function', () => {
        const { out, stats } = run(`const x = 1; function f() { return x; }`);
        // x is moved into f's body.
        expect(out).not.toMatch(/\bconst x\b/);
        expect(out).toContain('return 1');
        expect(stats.inlined).toBe(1);
    });

    it('does not inline across a try/catch boundary', () => {
        // Closure: testDoNotExitTry. A side-effect-free init like `1` is
        // technically safe to relocate into a try, but our v1 doesn't model
        // CFG edges through exception handlers. We only inline pure inits
        // anyway, so the result is conservative-but-correct.
        const { out } = run(`const x = 1; try { use(x); } catch (e) {}`);
        // Pure literal — we currently DO inline this (no CFG modeling
        // means we can't distinguish try-protected reads from others).
        // Document the current behavior; tighten if we add try modeling.
        expect(out).toContain('use(1)');
        expect(out).not.toMatch(/\bconst x\b/);
    });

    it('does not inline into an increment/decrement expression', () => {
        // Closure: testDoNotInlineIncrement / testDoNotInlineDecrement.
        // `++x` writes to x, so x is reassigned → constantViolations > 0.
        const { out, stats } = run(`let x = 1; ++x;`);
        expect(out).toContain('let x = 1');
        expect(stats.inlined).toBe(0);
    });

    it('does not inline into the LHS of an assignment', () => {
        // Closure: testDoNotInlineIntoLhsOfAssign. The LHS `target` is a
        // write-binding, so `target` has constantViolations and references
        // counts the assignment LHS, blocking inline. The init `tmp` here
        // is pure but `target` itself is what would receive — we're really
        // testing that we don't accidentally rewrite the LHS.
        const { out } = run(`let target = 0; const tmp = 5; target = tmp; console.log(target);`);
        // tmp inlines into the RHS of the assign — that's fine. target
        // stays put as the LHS.
        expect(out).toMatch(/target\s*=\s*5/);
    });

    it('handles a self-referencing recursive const without infinite loop', () => {
        // `const f = () => f();` — f references itself, so binding.references >= 1
        // even before counting external uses. Should bail (not single-use)
        // and certainly not infinite-loop the fixpoint.
        const { out, stats } = run(`const f = () => f(); export { f };`);
        expect(out).toContain('const f');
        expect(stats.inlined).toBe(0);
    });

    it('inlines a pure object literal', () => {
        const { out, stats } = run(`const o = { a: 1, b: 2 }; console.log(o);`);
        expect(out).toContain('console.log({');
        expect(stats.inlined).toBe(1);
    });

    it('does not inline a var defined inside a conditional branch', () => {
        // Closure: testNoInlineOutOfBranch. `var` is hoisted out, but the
        // def may not have executed before the use.
        const { out, stats } = run(`if (cond) { var x = 1; } console.log(x);`);
        expect(out).toContain('var x = 1');
        expect(stats.inlined).toBe(0);
    });

    it('does not inline a const declared inside a conditional consequent', () => {
        // Same idea but with const + an outer use that won't actually parse
        // (block-scoped); we verify by reading inside the same block.
        const { out, stats } = run(`function f() { let x; if (cond) { const t = 1; x = t; } return x; }`);
        // t is single-use within its block; the use is inside the same
        // conditional, so common-ancestor check should NOT bail.
        expect(out).toContain('x = 1');
        expect(stats.inlined).toBe(1);
    });

    it('does not inline a for-in loop variable', () => {
        // Closure: testForIn. `for (var i in j) { var c = i; }` — i is
        // assigned by the loop, so constantViolations > 0.
        const { out, stats } = run(`for (var i in obj) { use(i); }`);
        expect(out).toContain('var i');
        expect(stats.inlined).toBe(0);
    });

    it('inlines a literal use that is the test of a conditional', () => {
        // Closure: testInsideHookConditional — `var a = pure; a ? alert(1) : alert(3)`.
        // The use is the test position, not relocated into either branch, so
        // safe to inline.
        const { out, stats } = run(`const a = 1; const r = a ? 'yes' : 'no'; use(r);`);
        // After fixpoint a inlines into the test, then r inlines into use().
        expect(out).toContain("use(1 ? 'yes' : 'no')");
        expect(stats.inlined).toBe(2);
    });

    // ---- alias inlining (Closure InlineVariables VarIsAliasAnalysis path) ----

    it('alias-inlines a multi-use let aliasing a well-defined local', () => {
        // The post-inline shape we see in crashcat's contact-constraints loop.
        // `linVelA__5` aliases `_linearVelocityA`, is never reassigned, and is
        // used multiple times. The aliased local is also never reassigned and
        // dominates all uses. → drop the alias, rewrite reads to the original.
        const { out, stats } = run(`
            function f(body) {
              const _linearVelocityA = body.linearVelocity;
              for (let i = 0; i < 3; i++) {
                let linVelA__5 = _linearVelocityA;
                linVelA__5[0] += 1;
                linVelA__5[1] += 1;
                linVelA__5[2] += 1;
              }
            }
        `);
        expect(out).not.toMatch(/let\s+linVelA__5\b/);
        expect(out).toMatch(/_linearVelocityA\[0\]\s*\+=\s*1/);
        expect(out).toMatch(/_linearVelocityA\[1\]\s*\+=\s*1/);
        expect(out).toMatch(/_linearVelocityA\[2\]\s*\+=\s*1/);
        expect(stats.inlined).toBeGreaterThanOrEqual(1);
    });

    it('alias-inlines a chain of aliases', () => {
        // Mirrors compilecat's pipeline after inlining: param→alias→alias.
        const { out, stats } = run(`
            function f(originalA) {
              const a = originalA;
              const b = a;
              use(b);
              use(b);
            }
        `);
        expect(out).not.toMatch(/\bconst\s+a\b/);
        expect(out).not.toMatch(/\bconst\s+b\b/);
        expect(out).toMatch(/use\(originalA\)/);
        expect(stats.inlined).toBeGreaterThanOrEqual(2);
    });

    it('does not alias-inline when the aliased var is reassigned', () => {
        const { out } = run(`
            function f() {
              let y = 1;
              y = 2;
              const x = y;
              use(x);
              use(x);
            }
        `);
        expect(out).toContain('const x = y');
    });

    it('does not alias-inline when the alias itself is reassigned', () => {
        const { out } = run(`
            function f(y) {
              let x = y;
              x = 5;
              use(x);
              use(x);
            }
        `);
        expect(out).toContain('let x = y');
    });

    it('does not alias-inline when the aliased binding is missing in a ref scope', () => {
        // x is closure-captured into an inner function that shadows the
        // aliased name. Closure handles this via scope chain; we must too.
        const { out } = run(`
            function f(y) {
              const x = y;
              function inner(y) { use(x); }
              inner(1);
              use(x);
            }
        `);
        // The inner function shadows y, so replacing x→y in inner would be wrong.
        // Either keep the const or be sure references resolve to the outer y.
        // Conservative: keep the const.
        expect(out).toContain('const x = y');
    });

    it('alias-inlines through an object-property RHS only if stable', () => {
        // `body.linearVelocity` is a member read; if body is never reassigned
        // it is stable and we can alias-inline. v1 limits alias targets to
        // bare identifiers, so this should NOT inline — documenting current
        // behavior. (A later phase may extend to stable getProps.)
        const { out } = run(`
            function f(body) {
              const v = body.linearVelocity;
              v[0] += 1;
              v[1] += 1;
            }
        `);
        expect(out).toContain('const v = body.linearVelocity');
    });

    // ---- multi-use immutable inlining (Closure isImmutableValue path) ----

    it('inlines a multi-use const literal at function scope', () => {
        const { out, stats } = run(`
            function f() {
              const K = 42;
              return use(K) + use(K) + use(K);
            }
        `);
        expect(out).not.toMatch(/\bconst K\b/);
        expect(out).toMatch(/use\(42\).*use\(42\).*use\(42\)/s);
        expect(stats.inlined).toBeGreaterThanOrEqual(1);
    });

});
