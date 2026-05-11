import generate from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { inlineFunctions } from '../src/compiler/inline-functions';

function inl(code: string): { code: string; succeeded: number; calls: number } {
    const file = parse(code, { plugins: ['typescript'] });
    const r = inlineFunctions(file);
    const out = (generate as unknown as (n: t.Node) => { code: string })(file).code
        .replace(/\s+/g, ' ')
        .trim();
    return { code: out, succeeded: r.succeeded, calls: r.calls };
}

describe('InlineFunctions', () => {
    it('DIRECT inlines a single-return function (decl-annotated)', () => {
        const r = inl(`
            /** @inline */
            function add(a, b) { return a + b; }
            var x = add(1, 2);
        `);
        expect(r.succeeded).toBe(1);
        expect(r.code).toContain('var x = 1 + 2');
        expect(r.code).not.toContain('function add');
    });

    it('DIRECT inlines based on callsite annotation', () => {
        const r = inl(`
            function add(a, b) { return a + b; }
            var x = /* @inline */ add(1, 2);
        `);
        expect(r.succeeded).toBe(1);
        expect(r.code).toContain('var x = 1 + 2');
        // Decl not stripped (no decl-annotation).
        expect(r.code).toContain('function add');
    });

    it('skips inline without any annotation', () => {
        const r = inl(`
            function add(a, b) { return a + b; }
            var x = add(1, 2);
        `);
        expect(r.succeeded).toBe(0);
        expect(r.code).toContain('add(1, 2)');
    });

    it('BLOCK inlines a function with early return', () => {
        const r = inl(`
            /** @inline */
            function abs(x) { if (x < 0) return -x; return x; }
            var v = abs(p);
        `);
        expect(r.succeeded).toBe(1);
        // Either contains the labeled block or its post-simplifier reduction.
        expect(r.code).toMatch(/_compilecat_inline_label_abs_0|_abs__result_0/);
    });

    it('BLOCK with discarded result drops the temp', () => {
        const r = inl(`
            /** @inline */
            function noisy(x) { if (x < 0) return; effect(x); }
            noisy(p);
        `);
        expect(r.succeeded).toBe(1);
        expect(r.code).toContain('_compilecat_inline_label_noisy_0');
    });

    it('rejects async / generator functions', () => {
        const r = inl(`
            /** @inline */
            async function fetchOnce() { return 1; }
            var v = fetchOnce();
        `);
        expect(r.succeeded).toBe(0);
    });

    it('rejects this-using functions', () => {
        const r = inl(`
            /** @inline */
            function getProp() { return this.p; }
            var v = getProp();
        `);
        expect(r.succeeded).toBe(0);
    });

    it('rejects arguments-using functions', () => {
        const r = inl(`
            /** @inline */
            function variadic() { return arguments[0]; }
            var v = variadic(1);
        `);
        expect(r.succeeded).toBe(0);
    });

    it('@flatten propagates @inline to all calls inside', () => {
        const r = inl(`
            function add(a, b) { return a + b; }
            /** @flatten */
            function f(x, y) { return add(x, y); }
            var z = f(1, 2);
        `);
        // f's call to add inlines (flatten propagation), and f itself inlines
        // at the top-level call (matches classic: @flatten is also @inline).
        expect(r.succeeded).toBe(2);
        expect(r.code).toContain('var z = 1 + 2');
    });

    it('inlines arrow function via const decl', () => {
        const r = inl(`
            /** @inline */
            const id = (x) => x;
            var v = id(5);
        `);
        expect(r.succeeded).toBe(1);
        expect(r.code).toContain('var v = 5');
    });

    it('alpha-renames params so they cannot shadow outer-scope free vars in args', () => {
        // Regression: inlining `insertLeaf(dbvt, leafIndex)` inside a caller
        // whose own params are also `dbvt` and `leafIndex` previously emitted
        // `let dbvt = dbvt;` (TDZ on RHS), which the simplifier later stripped
        // to `let dbvt;` — leaving outer-scope reads bound to undefined.
        //
        // Post-FunctionArgumentInjector port: simple Identifier args get
        // substituted directly into the body, so there's no prologue at all.
        // The shape is just `dbvt.x = leaf;` — which proves the same-name
        // self-binding bug can't reappear (no `let` exists to rebind).
        const r = inl(`
            /** @inline */
            function ins(dbvt, leaf) { dbvt.x = leaf; }
            function add(dbvt, leaf) { ins(dbvt, leaf); }
        `);
        expect(r.succeeded).toBe(1);
        // The inlined block must not contain a same-name self-binding.
        expect(r.code).not.toMatch(/let dbvt\s*=\s*dbvt\b/);
        expect(r.code).not.toMatch(/let leaf\s*=\s*leaf\b/);
        // No alpha-rename leftover when args substitute directly.
        expect(r.code).not.toMatch(/dbvt__/);
        // Body uses the outer-scope names directly post-substitution.
        expect(r.code).toMatch(/dbvt\.x\s*=\s*leaf/);
    });

    it('substitutes simple-identifier args directly (no prologue temp)', () => {
        // Closure parity: when arg is an Identifier and the param isn't
        // reassigned, the body gets the arg substituted in directly. No
        // `let X = arg;` binding, no wrapper-block-needed-for-prologue.
        const r = inl(`
            /** @inline */
            function empty(out) {
                out[0] = 1; out[1] = 2; out[2] = 3;
                out[3] = 4; out[4] = 5; out[5] = 6;
            }
            function caller(target) { empty(target); }
        `);
        expect(r.succeeded).toBe(1);
        // No `let out = target;` prologue.
        expect(r.code).not.toMatch(/let out\b/);
        // All six writes must appear with `target` substituted in.
        expect(r.code).toMatch(/target\[0\]\s*=\s*1/);
        expect(r.code).toMatch(/target\[5\]\s*=\s*6/);
    });

    it('keeps a temp for impure args even when used once', () => {
        // `getX()` must run exactly once even though `x` is used twice.
        // Arg doesn't reference `x` as a free var → no param rename → the
        // prologue uses the original param name.
        const r = inl(`
            /** @inline */
            function dbl(x) { sink(x); sink(x); }
            function caller() { dbl(getX()); }
        `);
        expect(r.succeeded).toBe(1);
        expect(r.code).toMatch(/let x\s*=\s*getX\(\)/);
    });

    it('keeps a temp for object-literal args (fresh-state semantics)', () => {
        // Substituting `{}` directly would create a new object per use.
        const r = inl(`
            /** @inline */
            function use(o) { sink(o); sink(o); }
            function caller() { use({}); }
        `);
        expect(r.succeeded).toBe(1);
        expect(r.code).toMatch(/let o\s*=\s*\{\s*\}/);
    });

    it('falls back to BLOCK when DIRECT side-effect arg used twice', () => {
        const r = inl(`
            /** @inline */
            function dbl(x) { return x + x; }
            var v = dbl(getX());
        `);
        // DIRECT would re-execute getX(); BLOCK binds it to a temp. With the
        // hasReturnAtExit optimization the trailing `return x + x` is rewritten
        // as `v = x + x;` (no break) so no label wrapper is emitted.
        expect(r.succeeded).toBe(1);
        expect(r.code).toMatch(/let x\s*=\s*getX\(\)/);
        expect(r.code).toMatch(/v\s*=\s*x\s*\+\s*x/);
        expect(r.code).not.toContain('_compilecat_inline_label_dbl_0');
    });

    it('renames param when an arg references it as a free var', () => {
        // The shadow class: arg `x.method()` references the same name as the
        // param `x`. Without rename, splice would emit `let x = x.method();`
        // where the RHS resolves to the new inner binding (TDZ on let). The
        // injector detects this and renames the param.
        const r = inl(`
            /** @inline */
            function inner(x) { sink(x); sink(x); }
            function outer(x) { inner(x.method()); }
        `);
        expect(r.succeeded).toBe(1);
        // Param `x` renamed to `x__inner`; arg's `x.method()` reads outer x.
        expect(r.code).toMatch(/let x__inner\s*=\s*x\.method\(\)/);
        // No same-name self-binding leaked through.
        expect(r.code).not.toMatch(/let x\s*=\s*x\.method/);
    });
});
