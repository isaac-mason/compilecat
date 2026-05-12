import generate from '@babel/generator';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { runPeepholeRemoveDeadCode } from '../src/compiler/peephole-remove-dead-code';

function rm(code: string): { code: string; removed: number } {
    const file = parse(code, { plugins: ['typescript'] });
    const r = runPeepholeRemoveDeadCode(file);
    const out = (generate as unknown as (n: t.Node) => { code: string })(file).code.replace(/\s+/g, ' ').trim();
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

    it('flips empty-consequent if into negated if', () => {
        // Closure tryFoldIf rule: `if (x) {} else { Y }` → `if (!x) { Y }`.
        // Post-inline shape: contact-constraints' `if (part.totalLambda === 0) return;`
        // collapses the early-return into an empty consequent, leaving the
        // body to run unconditionally — but with this rule it stays guarded.
        const r = rm('function f(x) { if (x === 0) {} else { use(x); } }');
        expect(r.code).toContain('if (x !== 0)');
        expect(r.code).toContain('use(x)');
        expect(r.code).not.toMatch(/else\s*\{/);
    });

    it('flips empty-consequent if with EmptyStatement form', () => {
        // The post-FunctionToBlockMutator shape is literally `if (X) ; else { Y }`.
        const r = rm('function f(x) { if (x === 0) ; else { use(x); } }');
        expect(r.code).toContain('if (x !== 0)');
        expect(r.code).toContain('use(x)');
    });

    it('drops empty else branch', () => {
        // Closure tryFoldIf: `if (x) { ... } else {}` → `if (x) { ... }`.
        const r = rm('function f(x) { if (x) { use(x); } else {} }');
        expect(r.code).toContain('if (x)');
        expect(r.code).not.toMatch(/else\s*\{/);
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

    it('drops bare-member-access expression statement (assumeGettersArePure)', () => {
        // Closure AstAnalyzer with default `assumeGettersArePure=true` treats
        // `Number.POSITIVE_INFINITY` as side-effect-free, so foldExpressionStatement
        // collapses it. Regression: orphan RHS left by DAE on
        // `bounds_0 = Number.POSITIVE_INFINITY` followed by an overwrite.
        const r = rm('function f() { Number.POSITIVE_INFINITY; return 1; }');
        expect(r.code).not.toContain('POSITIVE_INFINITY');
        expect(r.code).toContain('return 1');
    });

    it('drops nested-member-access expression statement', () => {
        const r = rm('function f() { a.b.c; return 1; }');
        expect(r.code).not.toContain('a.b.c');
    });

    it('keeps member access whose object has side effects', () => {
        // `foo().bar` — the call itself is impure, so the whole expr must stay.
        const r = rm('function f() { foo().bar; return 1; }');
        expect(r.code).toContain('foo()');
    });
});

describe('PeepholeRemoveDeadCode — tryFoldLabel', () => {
    // Closure PRDC.java:138-177 + RenameLabels.java:222-232. Surfaces after the
    // FunctionToBlockMutator's labeled wrapper has its only `break L;` minimised
    // away by PeepholeMinimizeConditions — the label is dead and should drop so
    // the inner block can merge into its parent scope.
    it('drops empty labeled statement', () => {
        const r = rm('function f() { L: ; }');
        expect(r.code).not.toContain('L:');
    });

    it('drops labeled empty block', () => {
        const r = rm('function f() { L: {} }');
        expect(r.code).not.toContain('L:');
    });

    it('drops labeled single-break-self block', () => {
        const r = rm('function f() { L: { break L; } }');
        expect(r.code).not.toContain('L:');
        expect(r.code).not.toContain('break');
    });

    it('drops label when body has no break/continue to it (unwraps)', () => {
        const r = rm('function f() { L: { foo(); bar(); } }');
        expect(r.code).not.toContain('L:');
        expect(r.code).toContain('foo()');
        expect(r.code).toContain('bar()');
    });

    it('keeps label when body still references it', () => {
        const r = rm('function f(x) { L: { foo(); if (x) break L; bar(); } }');
        expect(r.code).toContain('L:');
        expect(r.code).toContain('break L');
    });

    it('keeps label when continue targets it from inside a loop', () => {
        const r = rm('function f() { L: while (x) { if (y) continue L; foo(); } }');
        expect(r.code).toContain('L:');
    });

    it('does not unwrap label when nested loop continue targets it', () => {
        const r = rm('function f() { L: while (a) { while (b) { continue L; } } }');
        expect(r.code).toContain('L:');
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
