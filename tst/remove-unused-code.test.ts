import _generate from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { removeUnusedCode } from '../src/compiler/remove-unused-code';

// biome-ignore lint/suspicious/noExplicitAny: babel CJS interop
const generate: typeof _generate = (_generate as any).default ?? _generate;

function run(code: string): { out: string; stats: ReturnType<typeof removeUnusedCode> } {
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
    const stats = removeUnusedCode(ast);
    const out = (generate as unknown as (n: t.Node) => { code: string })(ast).code.trim();
    return { out, stats };
}

describe('removeUnusedCode', () => {
    it('removes a `let x = 1;` whose binding is unread', () => {
        const { out, stats } = run(`let x = 1; const used = 2; console.log(used);`);
        expect(out).not.toMatch(/\blet x\b/);
        expect(out).toContain('const used = 2');
        expect(stats.removedDeclarators).toBe(1);
    });

    it('keeps a declarator whose init has side effects', () => {
        const { out, stats } = run(`let x = sideEffect();`);
        expect(out).toContain('let x = sideEffect()');
        expect(stats.removedDeclarators).toBe(0);
    });

    it('removes one declarator from a multi-declarator statement', () => {
        const { out, stats } = run(`let a = 1, b = 2; console.log(b);`);
        expect(out).not.toMatch(/\ba\s*=/);
        expect(out).toContain('b = 2');
        expect(stats.removedDeclarators).toBe(1);
    });

    it('removes an unused function declaration', () => {
        const { out, stats } = run(`function dead() { return 1; } function live() { return 2; } live();`);
        expect(out).not.toMatch(/function dead/);
        expect(out).toMatch(/function live/);
        expect(stats.removedFunctionDecls).toBe(1);
    });

    it('iterates to fixpoint: chained dead refs', () => {
        // a is only used to build b; b is only used to build c; c is unused.
        const { out, stats } = run(`const a = 1; const b = a + 1; const c = b + 1;`);
        expect(out).toBe('');
        expect(stats.removedDeclarators).toBe(3);
    });

    it('drops an unused named import specifier', () => {
        const { out, stats } = run(`import { used, unused } from 'foo'; console.log(used);`);
        expect(out).toMatch(/import \{ used \} from ['"]foo['"]/);
        expect(out).not.toMatch(/\bunused\b/);
        expect(stats.removedImportSpecifiers).toBe(1);
    });

    it('drops the entire import when all specifiers are unused', () => {
        const { out, stats } = run(`import { a, b } from 'foo'; const x = 1; x;`);
        expect(out).not.toMatch(/from ['"]foo['"]/);
        expect(stats.removedImportDeclarations).toBe(1);
        expect(stats.removedImportSpecifiers).toBe(2);
    });

    it('preserves side-effect-only imports', () => {
        const { out, stats } = run(`import 'side-effects'; const x = used(); console.log(x);`);
        expect(out).toMatch(/import ['"]side-effects['"]/);
        expect(stats.removedImportDeclarations).toBe(0);
    });

    it('preserves exported declarations even when unused locally', () => {
        const { out } = run(`export const x = 1; export function foo() {}`);
        expect(out).toContain('export const x = 1');
        expect(out).toMatch(/export function foo/);
    });

    it('preserves a write-only variable (DAE handles those)', () => {
        const { out } = run(`let x = 1; x = 2; x = 3;`);
        expect(out).toContain('let x = 1');
    });

    it('removes a recursive function whose only reference is the self-call', () => {
        // Closure's testRecursiveFunction1 — the self-recursive call counts
        // as a reference on Babel's binding, so this verifies whether we
        // catch the case (we currently don't, and that's documented behavior).
        const { out, stats } = run(`function rec() { return rec(); } const used = 1; console.log(used);`);
        // v1 limitation: Babel counts the self-ref. We document by asserting
        // current behavior — change this to expect removal if/when we add
        // recursive-only detection.
        expect(out).toMatch(/function rec/);
        expect(stats.removedFunctionDecls).toBe(0);
    });

    it('removes a declarator nested inside a block', () => {
        const { out, stats } = run(`{ let x = 1; } const used = 2; console.log(used);`);
        expect(out).not.toMatch(/\blet x\b/);
        expect(stats.removedDeclarators).toBe(1);
    });

    it('removes an unused class declaration', () => {
        const { out, stats } = run(`class Dead { foo() {} } const used = 1; console.log(used);`);
        expect(out).not.toMatch(/class Dead/);
        expect(stats.removedFunctionDecls).toBe(1);
    });

    it('preserves an unused class with a static side-effect field', () => {
        const { out } = run(`class Live { static x = sideEffect(); } const u = 1; console.log(u);`);
        expect(out).toMatch(/class Live/);
    });

    it('preserves an unused class with a static initialization block', () => {
        const { out } = run(`class Live { static { sideEffect(); } } const u = 1; console.log(u);`);
        expect(out).toMatch(/class Live/);
    });

    it('preserves an unused class whose superclass call has side effects', () => {
        const { out } = run(`class Live extends sideEffect() {} const u = 1; console.log(u);`);
        expect(out).toMatch(/class Live/);
    });

    it('skips destructuring declarators (v1 conservative bail)', () => {
        const { out, stats } = run(`const { a, b } = obj; console.log(a);`);
        expect(out).toContain('const {');
        expect(stats.removedDeclarators).toBe(0);
    });

    it('drops default + namespace imports when unreferenced', () => {
        const { out, stats } = run(`
            import def from './a';
            import * as ns from './b';
            const used = 1; console.log(used);
        `);
        expect(out).not.toMatch(/from ['"]\.\/a['"]/);
        expect(out).not.toMatch(/from ['"]\.\/b['"]/);
        expect(stats.removedImportDeclarations).toBe(2);
    });
});
