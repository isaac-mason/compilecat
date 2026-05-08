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
