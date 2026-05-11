import generate from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { runPeepholeRemoveDeadCode } from '../src/compiler/peephole-remove-dead-code';

function rm(code: string): { code: string; removed: number } {
    const file = parse(code, { plugins: ['typescript'] });
    const r = runPeepholeRemoveDeadCode(file);
    const out = (generate as unknown as (n: t.Node) => { code: string })(file).code
        .replace(/\s+/g, ' ')
        .trim();
    return { code: out, removed: r.removed };
}

describe('PeepholeRemoveDeadCode', () => {
    it('removes if (true) ... else branch', () => {
        const r = rm('function f() { if (true) { return 1; } else { return 2; } }');
        expect(r.code).toContain('return 1');
        expect(r.code).not.toContain('return 2');
    });

    it('removes if (false) consequent', () => {
        const r = rm('function f() { if (false) { return 1; } else { return 2; } }');
        expect(r.code).toContain('return 2');
        expect(r.code).not.toContain('return 1');
    });

    it('removes if (false) without alternate', () => {
        const r = rm('function f() { if (false) { foo(); } return 1; }');
        expect(r.code).not.toContain('foo()');
        expect(r.code).toContain('return 1');
    });

    it('folds conditional expression with literal test', () => {
        expect(rm('var x = true ? 1 : 2;').code).toContain('var x = 1');
        expect(rm('var x = false ? 1 : 2;').code).toContain('var x = 2');
    });

    it('removes while (false)', () => {
        const r = rm('function f() { while (false) { foo(); } return 1; }');
        expect(r.code).not.toContain('while');
        expect(r.code).not.toContain('foo()');
    });

    it('unwraps do { X } while (false)', () => {
        const r = rm('function f() { do { foo(); } while (false); }');
        expect(r.code).not.toContain('do');
        expect(r.code).not.toContain('while');
        expect(r.code).toContain('foo()');
    });

    it('drops pure expression statements', () => {
        const r = rm('function f() { 1 + 2; return x; }');
        expect(r.code).not.toMatch(/1 \+ 2/);
        expect(r.code).toContain('return x');
    });

    it('keeps impure expression statements', () => {
        const r = rm('function f() { foo(); return x; }');
        expect(r.code).toContain('foo()');
    });

    it('drops statements after return', () => {
        const r = rm('function f() { return 1; bar(); baz(); }');
        expect(r.code).toContain('return 1');
        expect(r.code).not.toContain('bar()');
        expect(r.code).not.toContain('baz()');
    });

    it('drops statements after throw', () => {
        const r = rm('function f() { throw e; foo(); }');
        expect(r.code).not.toContain('foo()');
    });

    it('keeps function declarations after return (hoisted)', () => {
        const r = rm('function f() { return 1; function g() { return 2; } }');
        expect(r.code).toContain('function g');
    });

    it('keeps var declarations after return (hoisted)', () => {
        const r = rm('function f() { return 1; var x = 2; }');
        expect(r.code).toContain('var x');
    });

    it('drops pure prefix in sequence expression', () => {
        const r = rm('var x = (1, 2, foo());');
        expect(r.code).toContain('var x = foo()');
    });

    it('keeps impure prefix in sequence expression', () => {
        const r = rm('var x = (foo(), 2, bar());');
        expect(r.code).toContain('foo()');
        expect(r.code).toContain('bar()');
    });

    it('reduces if with empty body and pure test to empty', () => {
        const r = rm('function f() { if (x) {} return 1; }');
        expect(r.code).not.toContain('if');
    });

    it('does not fold if when test has side effects', () => {
        const r = rm('function f() { if (foo()) { return 1; } else { return 2; } }');
        expect(r.code).toContain('foo()');
        expect(r.code).toContain('if');
    });
});

describe('PeepholeRemoveDeadCode — tryOptimizeConditionalAfterAssign', () => {
    it('folds `a = 1; if (a) ...` to `if (true) ...`', () => {
        const r = rm('function f() { var a; a = 1; if (a) { sink(); } }');
        expect(r.code).toContain('if (true)');
    });

    it('folds `var a = /re/; if (a)` to true (regexp is truthy)', () => {
        const r = rm('function f() { var a = /re/; if (a) { sink(); } }');
        expect(r.code).toContain('if (true)');
    });

    it('folds `a = 0; if (a)` to false', () => {
        const r = rm('function f() { var a; a = 0; if (a) { sink(); } }');
        expect(r.code).toContain('if (false)');
    });

    it('folds `a = 0; a ? f() : g()` ternary expr-stmt', () => {
        const r = rm('function f() { var a; a = 0; a ? p() : q(); }');
        expect(r.code).toMatch(/false \? p\(\) : q\(\)/);
    });

    it('folds `a = 1; a && f()`', () => {
        const r = rm('function f() { var a; a = 1; a && p(); }');
        expect(r.code).toMatch(/true && p\(\)/);
    });

    it('leaves unknown rhs alone', () => {
        const r = rm('function f(x) { var a; a = x; if (a) { sink(); } }');
        expect(r.code).toMatch(/if \(a\)/);
    });

    it('does not fold when condition is not exactly the assigned name', () => {
        const r = rm('function f() { var a, b; a = 1; if (b) { sink(); } }');
        expect(r.code).toMatch(/if \(b\)/);
    });

    it('folds `a = null; a ?? f()` to `void 0 ?? f()`', () => {
        const r = rm('function f() { var a; a = null; a ?? p(); }');
        expect(r.code).toMatch(/void 0 \?\? p\(\)/);
    });

    it('folds `a = 1; a ?? f()` to `0 ?? f()` (known non-nullish)', () => {
        const r = rm('function f() { var a; a = 1; a ?? p(); }');
        expect(r.code).toMatch(/0 \?\? p\(\)/);
    });
});
