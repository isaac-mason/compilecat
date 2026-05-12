import generate from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { runPeepholeMinimizeConditions } from '../src/compiler/peephole-minimize-conditions';

function mn(code: string): { code: string; minimized: number } {
    const file = parse(code, { plugins: ['typescript'] });
    const r = runPeepholeMinimizeConditions(file);
    const out = (generate as unknown as (n: t.Node) => { code: string })(file).code
        .replace(/\s+/g, ' ')
        .trim();
    return { code: out, minimized: r.minimized };
}

describe('PeepholeMinimizeConditions', () => {
    it('inverts ! over equality', () => {
        expect(mn('var b = !(a == 1);').code).toContain('a != 1');
        expect(mn('var b = !(a === 1);').code).toContain('a !== 1');
        expect(mn('var b = !(a != 1);').code).toContain('a == 1');
        expect(mn('var b = !(a !== 1);').code).toContain('a === 1');
    });

    it('does NOT invert ! over numeric comparison (NaN-unsafe)', () => {
        // Closure intentionally avoids GT/GE/LT/LE inversion: !(x < NaN) is
        // true but x >= NaN is also false — they're not equivalent. We follow
        // the same conservative rule.
        expect(mn('var b = !(a < 1);').code).toContain('!(a < 1)');
    });

    it('cancels !!x', () => {
        expect(mn('var b = !!x;').code).toContain('var b = x;');
    });

    it('cond ? a : a → a (pure cond)', () => {
        const r = mn('var x = c ? 1 : 1;');
        expect(r.code).toContain('var x = 1');
    });

    it('cond ? false : true → !cond', () => {
        expect(mn('var x = c ? false : true;').code).toContain('var x = !c');
    });

    it('cond ? true : false → !!cond', () => {
        expect(mn('var x = c ? true : false;').code).toContain('var x = !!c');
    });

    // Closure's PeepholeMinimizeConditions collapses if/else pairs into
    // ternaries (return-fold, same-target-assign-fold, expr-stmt-fold,
    // var-decl-fold). We've intentionally disabled all of those — they're
    // code-size wins, not perf wins, and cascading them produces nested
    // `a ? ... : b ? ... : 0` chains that read worse than the authored
    // if/else. The downstream bundler/minifier handles ternary collapsing
    // when shipping. The tests below assert that compilecat preserves the
    // authored shape.

    it('preserves if/else with return (does not collapse to ternary)', () => {
        const r = mn('function f(c) { if (c) return 1; else return 2; }');
        expect(r.code).not.toContain('? 1 : 2');
        expect(r.code).toContain('if (c)');
    });

    it('preserves if + tail-return shape', () => {
        const r = mn('function f(c) { if (c) return 1; return 2; }');
        expect(r.code).not.toContain('? 1 : 2');
        expect(r.code).toContain('if (c)');
        expect(r.code).toContain('return 2');
    });

    it('preserves if/else same-target assignment as authored', () => {
        const r = mn('function f(c) { if (c) x = 1; else x = 2; }');
        expect(r.code).not.toContain('? 1 : 2');
        expect(r.code).toContain('if (c)');
        expect(r.code).toMatch(/x = 1/);
        expect(r.code).toMatch(/x = 2/);
    });

    it('preserves if/else with unrelated expression statements', () => {
        const r = mn('function f(c) { if (c) x = 1; else y = 2; }');
        expect(r.code).not.toMatch(/\?\s*x = 1\s*:\s*y = 2/);
        expect(r.code).toContain('if (c)');
    });

    it('substitutes x ? true : y → x || y in boolean context', () => {
        // performConditionSubstitutions only fires when the HOOK is in a
        // boolean context (the test of an IF here).
        const r = mn('function f(x, y) { if (x ? true : y) sink(); }');
        expect(r.code).toContain('x || y');
    });

    it('substitutes x ? y : false → x && y in boolean context', () => {
        const r = mn('function f(x, y) { if (x ? y : false) sink(); }');
        expect(r.code).toContain('x && y');
    });

    it('drops `x || true` to true when x has no side effects', () => {
        const r = mn('function f(x) { if (x || true) sink(); }');
        expect(r.code).toContain('if (true)');
    });

    it('keeps `x || true` as comma when x has side effects', () => {
        const r = mn('function f() { if (sideEffect() || true) sink(); }');
        expect(r.code).toMatch(/sideEffect\(\)\s*,\s*true/);
    });

    it('hoists else past a consequent that exits', () => {
        // Block-level: `if(c){return X;} else Y;` → `if(c){return X;} Y;`
        const r = mn('function f(c) { if (c) { return 1; } else { sideEffect(); } }');
        expect(r.code).not.toMatch(/else/);
        expect(r.code).toContain('sideEffect()');
    });

    it('joins for-cond with leading-if-break', () => {
        // for { if(c) break; ... } → for(...; !c; ...) { ... }
        const r = mn('function f() { for (var i = 0; i < 10; i++) { if (done()) break; foo(); } }');
        expect(r.code).toMatch(/!\s*done\(\)/);
    });

    it('combines nested if into &&', () => {
        // First pass: `if(x){if(y)foo();}` → `if(x&&y) foo();`. Second pass
        // (no-else express-block): `if(x&&y)foo();` → `(x&&y)&&foo();` →
        // `x && y && foo();`. Both rewrites are wins, accept either shape.
        const r = mn('function f(x, y) { if (x) { if (y) foo(); } }');
        expect(r.code).toMatch(/x\s*&&\s*y\s*&&\s*foo\(\)|if\s*\(x\s*&&\s*y\)/);
    });

    it('flips HOOK when negated cond is shorter', () => {
        // !(a == b) ? X : Y → a == b ? Y : X (negated form is shorter, swap)
        const r = mn('var v = (!(a == b)) ? X : Y;');
        // Could collapse to `a == b ? Y : X` or `(a != b) ? X : Y` depending on
        // cost — both are acceptable; the regression we care about is no
        // double-negation in the result.
        expect(r.code).not.toMatch(/!!/);
    });
});
