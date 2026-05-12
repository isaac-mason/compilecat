import generate from '@babel/generator';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { unrollLoops } from '../src/compiler/loop-unroller';

function un(code: string): { code: string; unrolled: number } {
    const file = parse(code, { plugins: ['typescript'] });
    const r = unrollLoops(file);
    const out = (generate as unknown as (n: t.Node) => { code: string })(file).code.replace(/\s+/g, ' ').trim();
    return { code: out, unrolled: r.unrolled };
}

describe('LoopUnroller', () => {
    it('unrolls a simple counted for loop', () => {
        const r = un(`
            /** @unroll */
            for (let i = 0; i < 3; i++) { f(i); }
        `);
        expect(r.unrolled).toBe(1);
        expect(r.code).toContain('f(0)');
        expect(r.code).toContain('f(1)');
        expect(r.code).toContain('f(2)');
        expect(r.code).not.toContain('for ');
    });

    it('honors inclusive upper bound', () => {
        const r = un(`
            /** @unroll */
            for (let i = 1; i <= 3; i++) { f(i); }
        `);
        expect(r.code).toContain('f(1)');
        expect(r.code).toContain('f(3)');
    });

    it('handles step += N', () => {
        const r = un(`
            /** @unroll */
            for (let i = 0; i < 6; i += 2) { f(i); }
        `);
        expect(r.code).toContain('f(0)');
        expect(r.code).toContain('f(2)');
        expect(r.code).toContain('f(4)');
        expect(r.code).not.toContain('f(6)');
    });

    it('unrolls for-of over an array literal', () => {
        const r = un(`
            /** @unroll */
            for (const x of [10, 20, 30]) { f(x); }
        `);
        expect(r.unrolled).toBe(1);
        expect(r.code).toContain('f(10)');
        expect(r.code).toContain('f(20)');
        expect(r.code).toContain('f(30)');
    });

    it('skips loop with non-literal bound', () => {
        const r = un(`
            /** @unroll */
            for (let i = 0; i < n; i++) { f(i); }
        `);
        expect(r.unrolled).toBe(0);
        expect(r.code).toContain('for ');
    });

    it('skips loop with break in body', () => {
        const r = un(`
            /** @unroll */
            for (let i = 0; i < 3; i++) { if (i == 1) break; f(i); }
        `);
        expect(r.unrolled).toBe(0);
    });

    it('does not substitute under inner shadowing scope', () => {
        const r = un(`
            /** @unroll */
            for (let i = 0; i < 2; i++) {
                let i = 99;
                f(i);
            }
        `);
        expect(r.unrolled).toBe(1);
        // f(i) should remain unchanged: the inner `let i = 99` shadows the
        // loop counter, so substitution must not occur.
        expect(r.code).toContain('f(i)');
        expect(r.code).not.toContain('f(0)');
        expect(r.code).not.toContain('f(1)');
    });

    it('drops loop with empty range', () => {
        const r = un(`
            /** @unroll */
            for (let i = 0; i < 0; i++) { f(i); }
        `);
        expect(r.code).not.toContain('for ');
        expect(r.code).not.toContain('f(');
    });

    it('leaves unannotated loops alone', () => {
        const r = un('for (let i = 0; i < 3; i++) { f(i); }');
        expect(r.unrolled).toBe(0);
    });

    it('unrolls nested @unroll loops', () => {
        const r = un(`
            /** @unroll */
            for (let i = 0; i < 2; i++) {
                /** @unroll */
                for (let j = 0; j < 2; j++) { f(i, j); }
            }
        `);
        expect(r.code).toContain('f(0, 0)');
        expect(r.code).toContain('f(0, 1)');
        expect(r.code).toContain('f(1, 0)');
        expect(r.code).toContain('f(1, 1)');
    });
});
