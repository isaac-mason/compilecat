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

    it('inverts ! over numeric comparison', () => {
        expect(mn('var b = !(a < 1);').code).toContain('a >= 1');
        expect(mn('var b = !(a <= 1);').code).toContain('a > 1');
        expect(mn('var b = !(a > 1);').code).toContain('a <= 1');
        expect(mn('var b = !(a >= 1);').code).toContain('a < 1');
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

    it('collapses if/else with return', () => {
        const r = mn('function f(c) { if (c) return 1; else return 2; }');
        expect(r.code).toContain('return c ? 1 : 2');
    });

    it('collapses if/return + tail return into ternary', () => {
        const r = mn('function f(c) { if (c) return 1; return 2; }');
        expect(r.code).toContain('return c ? 1 : 2');
    });

    it('collapses if/else assigning same target', () => {
        const r = mn('function f(c) { if (c) x = 1; else x = 2; }');
        expect(r.code).toContain('x = c ? 1 : 2');
    });

    it('keeps unrelated assignments alone', () => {
        const r = mn('function f(c) { if (c) x = 1; else y = 2; }');
        expect(r.minimized).toBe(0);
        expect(r.code).toContain('if');
    });
});
