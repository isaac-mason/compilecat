import generate from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { simplifyAll } from '../src/compiler/simplifier';

function simp(code: string): { code: string; iters: number; folded: number; inlined: number; removed: number } {
    const file = parse(code, { plugins: ['typescript'] });
    const s = simplifyAll(file);
    const out = (generate as unknown as (n: t.Node) => { code: string })(file).code
        .replace(/\s+/g, ' ')
        .trim();
    return { code: out, iters: s.iterations, folded: s.folded, inlined: s.inlined, removed: s.removed };
}

describe('Simplifier (fixpoint)', () => {
    it('folds + inlines + removes in one pass', () => {
        // var x = 1 + 2 → folds; return x → inlines. Closure-aligned FSI
        // detaches the rhs but leaves the bare `var x;` declarator behind —
        // RemoveUnusedCode (a separate post-simplifier pass) is what strips
        // the dead binding.
        const r = simp('function f() { var x = 1 + 2; return x; }');
        expect(r.code).toContain('return 3');
        expect(r.code).toContain('var x;');
    });

    it('reaches a fixpoint of literal folding through inlining', () => {
        const r = simp('function f() { var a = 2; var b = 3; return a + b; }');
        expect(r.code).toContain('return 5');
    });

    it('eliminates dead branches after fold', () => {
        const r = simp('function f() { if (1 < 2) { return 1; } else { return 2; } }');
        expect(r.code).toContain('return 1');
        expect(r.code).not.toContain('return 2');
    });

    it('drops unreachable code after fold-then-return-on-true', () => {
        const r = simp('function f() { if (true) { return 1; } bar(); }');
        expect(r.code).toContain('return 1');
        expect(r.code).not.toContain('bar()');
    });

    it('simplifies nested functions independently', () => {
        const r = simp('function f() { return function g() { var x = 1 + 2; return x; }; }');
        expect(r.code).toContain('return 3');
    });

    it('terminates on a function with no opportunities', () => {
        const r = simp('function f(a, b) { return a + b; }');
        expect(r.iters).toBeLessThanOrEqual(2);
        expect(r.folded).toBe(0);
        expect(r.inlined).toBe(0);
    });

    it('unwinds a small chain through multiple iterations', () => {
        // var a = 1; var b = a + 1; var c = b + 1; return c;
        // After enough iterations, returns 3.
        const r = simp('function f() { var a = 1; var b = a + 1; var c = b + 1; return c; }');
        expect(r.code).toContain('return 3');
    });
});
