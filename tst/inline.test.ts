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
        expect(r.code).toMatch(/_inline_0|_r_0/);
    });

    it('BLOCK with discarded result drops the temp', () => {
        const r = inl(`
            /** @inline */
            function noisy(x) { if (x < 0) return; effect(x); }
            noisy(p);
        `);
        expect(r.succeeded).toBe(1);
        expect(r.code).toContain('_inline_0');
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
        const r = inl(`
            /** @inline */
            function ins(dbvt, leaf) { dbvt.x = leaf; }
            function add(dbvt, leaf) { ins(dbvt, leaf); }
        `);
        expect(r.succeeded).toBe(1);
        // The inlined block must not contain a same-name self-binding.
        expect(r.code).not.toMatch(/let dbvt\s*=\s*dbvt\b/);
        expect(r.code).not.toMatch(/let leaf\s*=\s*leaf\b/);
        // Renamed params should appear with the call's args bound through them.
        expect(r.code).toMatch(/let dbvt\$p\d+_\d+\s*=\s*dbvt\b/);
    });

    it('falls back to BLOCK when DIRECT side-effect arg used twice', () => {
        const r = inl(`
            /** @inline */
            function dbl(x) { return x + x; }
            var v = dbl(getX());
        `);
        // DIRECT would re-execute getX(); BLOCK binds it to a temp.
        expect(r.succeeded).toBe(1);
        expect(r.code).toContain('_inline_0');
    });
});
