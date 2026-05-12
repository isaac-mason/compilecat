import generate from '@babel/generator';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { applySroa } from '../src/compiler/scalar-replace-aggregates';

function sroa(code: string): { code: string; sroad: number } {
    const file = parse(code, { plugins: ['typescript'] });
    const r = applySroa(file);
    const out = (generate as unknown as (n: t.Node) => { code: string })(file).code.replace(/\s+/g, ' ').trim();
    return { code: out, sroad: r.sroad };
}

describe('ScalarReplaceAggregates', () => {
    it('rewrites a 3-tuple with index reads/writes', () => {
        const r = sroa(`
            /** @sroa */
            function f() {
                const v = [1, 2, 3];
                v[0] = v[1] + v[2];
                return v[0];
            }
        `);
        expect(r.sroad).toBe(1);
        expect(r.code).toContain('v_0');
        expect(r.code).toContain('v_1');
        expect(r.code).toContain('v_2');
        expect(r.code).not.toContain('[1, 2, 3]');
    });

    it('skips when binding escapes via plain reference', () => {
        const r = sroa(`
            /** @sroa */
            function f() {
                const v = [1, 2, 3];
                use(v);
                return v[0];
            }
        `);
        expect(r.sroad).toBe(0);
    });

    it('skips when index is non-numeric or non-literal', () => {
        const r = sroa(`
            /** @sroa */
            function f(i) {
                const v = [1, 2, 3];
                return v[i];
            }
        `);
        expect(r.sroad).toBe(0);
    });

    it('skips when index out of bounds', () => {
        const r = sroa(`
            /** @sroa */
            function f() {
                const v = [1, 2, 3];
                return v[5];
            }
        `);
        expect(r.sroad).toBe(0);
    });

    it('respects scope: identical name in another function does not block', () => {
        const r = sroa(`
            /** @sroa */
            function f() {
                const v = [1, 2, 3];
                return v[0] + v[1];
            }
            function g(v) { return v.length; }
        `);
        expect(r.sroad).toBe(1);
        expect(r.code).toContain('v_0');
    });

    it('skips singleton arrays (no gain)', () => {
        const r = sroa(`
            /** @sroa */
            function f() { const v = [1]; return v[0]; }
        `);
        expect(r.sroad).toBe(0);
    });

    it('honors decl-level annotation without function annotation', () => {
        const r = sroa(`
            function f() {
                /** @sroa */
                const v = [1, 2, 3];
                return v[0] + v[1] + v[2];
            }
        `);
        expect(r.sroad).toBe(1);
        expect(r.code).toContain('v_0');
    });

    it('leaves unannotated arrays alone', () => {
        const r = sroa(`
            function f() {
                const v = [1, 2, 3];
                return v[0];
            }
        `);
        expect(r.sroad).toBe(0);
        expect(r.code).toContain('[1, 2, 3]');
    });
});
