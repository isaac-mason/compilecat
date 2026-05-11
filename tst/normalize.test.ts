import generate from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { isFileNormalized, makeDeclaredNamesUnique } from '../src/compiler/normalize';

function run(code: string): { code: string; renamed: number; normalized: boolean } {
    const file = parse(code, { sourceType: 'module', plugins: ['typescript'] });
    const r = makeDeclaredNamesUnique(file);
    const out = (generate as unknown as (n: t.Node) => { code: string })(file).code
        .replace(/\s+/g, ' ')
        .trim();
    return { code: out, renamed: r.renamed, normalized: isFileNormalized(file) };
}

describe('Normalize.makeDeclaredNamesUnique', () => {
    it('leaves global names unchanged', () => {
        const r = run('var foo = 1; function bar() {}');
        expect(r.code).toContain('var foo = 1');
        expect(r.code).toContain('function bar()');
        expect(r.renamed).toBe(0);
        expect(r.normalized).toBe(true);
    });

    it('renames a local that shadows a global', () => {
        const r = run('var x = 1; function f() { var x = 2; return x; }');
        expect(r.code).toContain('var x = 1');
        // Inner x must have been renamed to x__1.
        expect(r.code).toMatch(/var x__1\s*=\s*2/);
        expect(r.code).toMatch(/return x__1/);
        expect(r.renamed).toBe(1);
    });

    it('renames the second of two same-named locals across functions', () => {
        const r = run(
            'function a() { var i = 0; return i; } function b() { var i = 1; return i; }',
        );
        // First-seen `i` keeps the name; second is suffixed.
        expect(r.code).toMatch(/var i\s*=\s*0/);
        expect(r.code).toMatch(/var i__1\s*=\s*1/);
        expect(r.renamed).toBe(1);
    });

    it('renames let/const/function-decl uniformly across scopes', () => {
        const r = run(
            `var k = 0;
             function f() {
               let k = 1;
               { const k = 2; sink(k); }
               return k;
             }
             function g() { function k() {} return k; }`,
        );
        // Four total `k` decls (global var, f's let, f's inner const, g's
        // inner function). First wins the bare name; the other three each
        // get a distinct __N suffix.
        const ks = new Set(r.code.match(/\bk__\d+/g) ?? []);
        expect(ks.size).toBe(3);
    });

    it('marks the file as normalized', () => {
        const r = run('var x = 1;');
        expect(r.normalized).toBe(true);
    });

    it('preserves references after rename (locals in nested scopes)', () => {
        const r = run(
            `function f() {
               var dup = 1;
               { let dup = 2; sink(dup); }
               return dup;
             }`,
        );
        // Inner `let dup` becomes dup__N; outer `var dup` keeps name.
        expect(r.code).toMatch(/var dup\s*=\s*1/);
        expect(r.code).toMatch(/let dup__1\s*=\s*2/);
        expect(r.code).toMatch(/sink\(dup__1\)/);
        expect(r.code).toMatch(/return dup/); // outer still readable as `dup`
    });
});

describe('Normalize structural — splitVarDeclarations', () => {
    it('splits multi-declarator var', () => {
        const r = run('function f() { var a = 1, b = 2; sink(a + b); }');
        expect(r.code).toMatch(/var a = 1; var b = 2/);
    });

    it('splits multi-declarator let and const', () => {
        const r = run(
            'function f() { let a = 1, b = 2; const x = 3, y = 4; sink(a + b + x + y); }',
        );
        expect(r.code).toMatch(/let a = 1; let b = 2/);
        expect(r.code).toMatch(/const x = 3; const y = 4/);
    });

    it('leaves single-declarator decls alone', () => {
        const r = run('function f() { var a = 1; return a; }');
        expect(r.code).toContain('var a = 1');
    });

    it('splits at program (script) level too', () => {
        const r = run('var a = 1, b = 2;');
        expect(r.code).toMatch(/var a = 1; var b = 2/);
    });
});

describe('Normalize structural — extractForInitializer', () => {
    it('hoists `for (var i = 0; …)` init out', () => {
        const r = run('function f() { for (var i = 0; i < 10; i++) sink(i); }');
        expect(r.code).toMatch(/var i = 0;\s*for\s*\(\s*;\s*i < 10/);
    });

    it('leaves `for (let i = 0; …)` alone (block-scoped)', () => {
        const r = run('function f() { for (let i = 0; i < 10; i++) sink(i); }');
        expect(r.code).toMatch(/for \(let i = 0; i < 10/);
    });

    it('hoists expression init', () => {
        const r = run('function f() { let i; for (i = 0; i < 10; i++) sink(i); }');
        expect(r.code).toMatch(/i = 0;\s*for\s*\(\s*;\s*i < 10/);
    });

    it('hoists `for (var x in y)` to `var x; for (x in y);`', () => {
        const r = run('function f(o) { for (var k in o) sink(k); }');
        expect(r.code).toMatch(/var k;\s*for\s*\(\s*k in o\s*\)/);
    });

    it('leaves `for (let x of y)` alone', () => {
        const r = run('function f(o) { for (let k of o) sink(k); }');
        expect(r.code).toMatch(/for \(let k of o\)/);
    });
});

describe('Normalize structural — arrow body to block', () => {
    it('rewrites blockless arrow expression body to block-with-return', () => {
        const r = run('var f = (x) => x + 1;');
        expect(r.code).toMatch(/x => \{\s*return x \+ 1;?\s*\}/);
    });

    it('leaves arrow with block body alone', () => {
        const r = run('var f = (x) => { return x + 1; };');
        expect(r.code).toMatch(/x => \{\s*return x \+ 1;?\s*\}/);
    });
});
