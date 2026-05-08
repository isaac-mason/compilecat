import { describe, expect, it } from 'vitest';

import { transform } from '../src/compiler/pipeline';

function norm(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

describe('Pipeline (transform)', () => {
    it('inlines + simplifies in one go', () => {
        const r = transform(
            `
            /** @inline */
            function add(a, b) { return a + b; }
            const x = add(1, 2);
            console.log(x);
        `,
            { filename: 'test.js' },
        );
        expect(norm(r.code)).toContain('console.log(3)');
        expect(r.stats.inlined).toBe(1);
        expect(r.stats.folded).toBeGreaterThan(0);
    });

    it('passes through code with no directives unchanged in shape', () => {
        const r = transform('const x = 1 + 2; console.log(x);', { filename: 'test.js' });
        // Pipeline folds + inlines + drops the now-dead binding.
        expect(norm(r.code)).toContain('console.log(3)');
        expect(r.stats.inlined).toBe(0);
    });

    it('supports TypeScript syntax', () => {
        const r = transform(
            `
            /** @inline */
            function id<T>(x: T): T { return x; }
            const v: number = id(42);
            console.log(v);
        `,
            { filename: 'test.ts' },
        );
        expect(norm(r.code)).toContain('console.log(42)');
    });

    it('emits a sourcemap when requested', () => {
        const r = transform('const x = 1 + 2;', { filename: 'test.js', sourceMaps: true });
        expect(r.map).toBeTruthy();
    });
});
