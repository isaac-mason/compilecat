import generate from '@babel/generator';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { runPeepholeFoldConstants } from '../src/compiler/peephole-fold-constants';

function fold(code: string): { code: string; folded: number } {
    const file = parse(code, { plugins: ['typescript'] });
    const r = runPeepholeFoldConstants(file);
    const out = (generate as unknown as (n: t.Node) => { code: string })(file).code.replace(/\s+/g, ' ').trim();
    return { code: out, folded: r.folded };
}

describe('PeepholeFoldConstants', () => {
    it('folds numeric arithmetic on literals', () => {
        const r = fold('var x = 1 + 2 * 3;');
        expect(r.code).toContain('var x = 7');
        expect(r.folded).toBeGreaterThanOrEqual(2);
    });

    it('folds subtraction with negative-literal RHS', () => {
        const r = fold('var x = 10 - -5;');
        expect(r.code).toContain('var x = 15');
    });

    it('folds string concat of two string literals', () => {
        const r = fold('var s = "ab" + "cd";');
        expect(r.code).toContain('var s = "abcd"');
    });

    it('folds string + number literal as concat', () => {
        const r = fold('var s = "n=" + 5;');
        expect(r.code).toContain('"n=5"');
    });

    it('folds typeof on literals', () => {
        expect(fold('var t = typeof "x";').code).toContain('"string"');
        expect(fold('var t = typeof 1;').code).toContain('"number"');
        expect(fold('var t = typeof true;').code).toContain('"boolean"');
        expect(fold('var t = typeof undefined;').code).toContain('"undefined"');
    });

    it('folds ! on literals', () => {
        expect(fold('var b = !0;').code).toContain('var b = true');
        expect(fold('var b = !1;').code).toContain('var b = false');
        expect(fold('var b = !"";').code).toContain('var b = true');
    });

    it('folds +"123" → 123', () => {
        const r = fold('var n = +"123";');
        expect(r.code).toContain('var n = 123');
    });

    it('does not divide by zero', () => {
        const r = fold('var x = 1 / 0;');
        expect(r.code).toContain('1 / 0');
    });

    it('applies x+0 identity for pure left side', () => {
        const r = fold('function f(p) { return p + 0; }');
        expect(r.code).toContain('return p');
    });

    it('does not apply identity when LHS may have side effects', () => {
        const r = fold('var x = call() + 0;');
        expect(r.code).toContain('call() + 0');
    });

    it('folds logical && short-circuit on literal LHS', () => {
        expect(fold('var x = false && y;').code).toContain('var x = false');
        expect(fold('var x = true && y;').code).toContain('var x = y');
    });

    it('folds logical || short-circuit on literal LHS', () => {
        expect(fold('var x = true || y;').code).toContain('var x = true');
        expect(fold('var x = 0 || y;').code).toContain('var x = y');
    });

    it('folds ?? on null/undefined LHS', () => {
        expect(fold('var x = null ?? y;').code).toContain('var x = y');
        expect(fold('var x = undefined ?? y;').code).toContain('var x = y');
        expect(fold('var x = 7 ?? y;').code).toContain('var x = 7');
    });

    it('folds comparisons on numeric literals', () => {
        expect(fold('var b = 1 < 2;').code).toContain('var b = true');
        expect(fold('var b = 2 === 2;').code).toContain('var b = true');
        expect(fold('var b = 2 !== 3;').code).toContain('var b = true');
        expect(fold('var b = 5 <= 4;').code).toContain('var b = false');
    });

    it('folds comparisons on string literals', () => {
        expect(fold('var b = "a" === "a";').code).toContain('var b = true');
        expect(fold('var b = "a" < "b";').code).toContain('var b = true');
    });

    it('collapses double-negation literal', () => {
        const r = fold('var x = -(-5);');
        expect(r.code).toContain('var x = 5');
    });

    it('leaves non-literal expressions alone', () => {
        const r = fold('function f(a, b) { return a + b; }');
        expect(r.folded).toBe(0);
        expect(r.code).toContain('return a + b');
    });

    it('folds bitwise AND/OR/XOR on literals', () => {
        expect(fold('var x = 5 & 3;').code).toContain('var x = 1');
        expect(fold('var x = 5 | 3;').code).toContain('var x = 7');
        expect(fold('var x = 5 ^ 3;').code).toContain('var x = 6');
    });

    it('folds shifts on literals using ToInt32 semantics', () => {
        expect(fold('var x = 1 << 3;').code).toContain('var x = 8');
        expect(fold('var x = -8 >> 1;').code).toContain('var x = -4');
        // unsigned shift on -1 → 0xFFFFFFFF
        expect(fold('var x = -1 >>> 0;').code).toContain('var x = 4294967295');
    });

    it('folds bitwise NOT on a literal', () => {
        expect(fold('var x = ~5;').code).toContain('var x = -6');
        expect(fold('var x = ~~5;').code).toContain('var x = 5');
    });

    it('folds optional chain on null / undefined', () => {
        expect(fold('var x = null?.foo;').code).toContain('var x = undefined');
        expect(fold('var x = undefined?.foo;').code).toContain('var x = undefined');
        expect(fold('var x = null?.();').code).toContain('var x = undefined');
    });

    it('leaves optional chain on a non-nullish literal alone', () => {
        // `({a:1})?.a` is fine; this pass doesn't drop the optional flag.
        const r = fold('var x = ({})?.foo;');
        expect(r.code).toContain('?.');
    });

    it('passes BigInt through without folding (BigInt fold is deferred)', () => {
        // Closure folds BigInt arithmetic; we don't yet. Ensure we don't
        // crash or accidentally coerce — `1n + 2n` would be ill-defined as
        // Number(1) + Number(2) since BigInt arithmetic doesn't mix.
        const r = fold('var x = 1n + 2n; var y = -5n; var b = 1n === 1n;');
        expect(r.code).toContain('1n + 2n');
        expect(r.code).toContain('-5n');
        expect(r.code).toContain('1n === 1n');
        expect(r.folded).toBe(0);
    });
});
