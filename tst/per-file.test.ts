import { describe, expect, it } from 'vitest';

import { createFileCache } from '../src/compiler/file-index';
import { Mode, transform } from '../src/compiler/pipeline';
import type { FileReader } from '../src/compiler/resolve';

function norm(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

function makeReader(files: Record<string, string>): FileReader {
    return (abs) =>
        Object.prototype.hasOwnProperty.call(files, abs) ? files[abs] : null;
}

describe('Pipeline (PerFile)', () => {
    it('inlines a donor-side @inline export across files', () => {
        const files = {
            '/proj/util.ts': `
                /* @inline */
                export function double(x: number): number { return x * 2; }
            `,
            '/proj/main.ts': `
                import { double } from './util';
                const r = double(7);
                console.log(r);
            `,
        };
        const r = transform(files['/proj/main.ts'], {
            filename: '/proj/main.ts',
            mode: Mode.PerFile,
            fileCache: createFileCache(),
            fileReader: makeReader(files),
        });
        expect(norm(r.code)).toContain('console.log(14)');
        expect(r.stats.inlined).toBe(1);
        expect(r.donorPaths.has('/proj/util.ts')).toBe(true);
    });

    it('hoists a donor module-var the spliced body needs', () => {
        const files = {
            '/proj/util.ts': `
                const TABLE = new Map<string, number>();
                /* @inline */
                export function lookup(k: string): number | undefined { return TABLE.get(k); }
            `,
            '/proj/main.ts': `
                import { lookup } from './util';
                export function consumer(k: string) { return lookup(k); }
            `,
        };
        const r = transform(files['/proj/main.ts'], {
            filename: '/proj/main.ts',
            mode: Mode.PerFile,
            fileCache: createFileCache(),
            fileReader: makeReader(files),
        });
        expect(r.code).toContain('TABLE');
        expect(r.code).toMatch(/new\s+Map\b/);
        expect(r.stats.inlined).toBe(1);
    });

    it('leaves untouched code alone in PerFile mode (no directives)', () => {
        const r = transform('export const x = 1 + 2;', {
            filename: '/proj/plain.ts',
            mode: Mode.PerFile,
            fileCache: createFileCache(),
        });
        expect(norm(r.code)).toContain('x = 3');
        expect(r.donorPaths.size).toBe(0);
    });
});
