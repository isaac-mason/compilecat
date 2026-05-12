import generate from '@babel/generator';
import { parse } from '@babel/parser';
import traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import {
    isFileNormalized,
    makeDeclaredNamesUnique,
    renameForFlatten,
} from '../src/compiler/normalize';

function run(code: string): { code: string; renamed: number; normalized: boolean } {
    const file = parse(code, { sourceType: 'module', plugins: ['typescript'] });
    const r = makeDeclaredNamesUnique(file);
    const out = (generate as unknown as (n: t.Node) => { code: string })(file).code
        .replace(/\s+/g, ' ')
        .trim();
    return { code: out, renamed: r.renamed, normalized: isFileNormalized(file) };
}

function runRename(code: string): { code: string; renamed: number } {
    const file = parse(code, { sourceType: 'module', plugins: ['typescript'] });
    makeDeclaredNamesUnique(file);
    let totalRenamed = 0;
    (traverse as unknown as (n: t.Node, v: object) => void)(file, {
        Function: {
            exit(path: NodePath<t.Function>) {
                totalRenamed += renameForFlatten(path);
            },
        },
    });
    const out = (generate as unknown as (n: t.Node) => { code: string })(file).code
        .replace(/\s+/g, ' ')
        .trim();
    return { code: out, renamed: totalRenamed };
}

describe('Normalize.makeDeclaredNamesUnique', () => {
    it('does not rename — just structurally normalizes + marks file', () => {
        const r = run('var foo = 1; function bar() {}');
        expect(r.code).toContain('var foo = 1');
        expect(r.code).toContain('function bar()');
        expect(r.renamed).toBe(0);
        expect(r.normalized).toBe(true);
    });

    it('marks the file as normalized', () => {
        const r = run('var x = 1;');
        expect(r.normalized).toBe(true);
    });

    it('leaves cross-function name reuse alone (distinct scopes)', () => {
        // The whole point of demand-driven rename: cross-function `i`
        // never collides, so both stay as authored.
        const r = run(
            'function a() { var i = 0; return i; } function b() { var i = 1; return i; }',
        );
        expect(r.code).toMatch(/function a\(\)\s*\{\s*var i = 0/);
        expect(r.code).toMatch(/function b\(\)\s*\{\s*var i = 1/);
        expect(r.code).not.toMatch(/i__\d+/);
    });
});

describe('Normalize.renameForFlatten', () => {
    it('does not rename when no nested-scope collision exists', () => {
        const r = runRename('function f() { var x = 1; return x; }');
        expect(r.code).toMatch(/var x = 1/);
        expect(r.code).not.toMatch(/x__\d+/);
        expect(r.renamed).toBe(0);
    });

    it('renames inner let that shadows function-scope var', () => {
        const r = runRename(
            'function f() { var x = 1; { let x = 2; sink(x); } return x; }',
        );
        expect(r.code).toMatch(/var x = 1/);
        expect(r.code).toMatch(/let x__1 = 2/);
        expect(r.code).toMatch(/sink\(x__1\)/);
        expect(r.code).toMatch(/return x/);
        expect(r.renamed).toBe(1);
    });

    it('renames sibling-block let bindings to a unique name per function', () => {
        const r = runRename(
            'function f() { { let i = 1; sink(i); } { let i = 2; sink(i); } }',
        );
        // ContextualRenamer-style: every nested binding inside the function
        // is uniquified so `tryMergeBlock(ignoreBlockScopedDeclarations=true)`
        // can splice blindly without sibling-collision checks.
        expect(r.code).toMatch(/let i = 1/);
        expect(r.code).toMatch(/let i__1 = 2/);
        expect(r.code).toMatch(/sink\(i__1\)/);
        expect(r.renamed).toBe(1);
    });

    it('renames inner function-declarations that collide with an outer var', () => {
        const r = runRename(
            'function outer() { var k = 1; { function k() {} sink(k); } }',
        );
        expect(r.code).toMatch(/var k = 1/);
        expect(r.code).toMatch(/function k__1\(\)/);
        expect(r.code).toMatch(/sink\(k__1\)/);
    });

    it('does not cross function boundaries', () => {
        // Inner function `f` declares its own `i`; outer's renameForFlatten
        // must skip it entirely (the inner function gets its own pass).
        const r = runRename(
            'function outer() { var i = 1; function inner() { var i = 2; return i; } return i; }',
        );
        // Inner's own pass runs and finds no collision within `inner`.
        expect(r.code).toMatch(/function inner\(\)\s*\{\s*var i = 2/);
        expect(r.code).toMatch(/return i;\s*\}\s*return i;/);
        expect(r.code).not.toMatch(/i__\d+/);
    });

    it('leaves params alone', () => {
        const r = runRename('function f(x) { { let x = 2; sink(x); } return x; }');
        // Inner `let x` collides with param `x` — inner gets suffixed.
        expect(r.code).toMatch(/function f\(x\)/);
        expect(r.code).toMatch(/let x__1 = 2/);
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
