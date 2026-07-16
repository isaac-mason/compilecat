import { describe, expect, it } from 'vitest';
import { declarationCandidates, specifierToSubpath, typeImportSpecifiers, typesFromExports } from '../src/type-resolve';

describe('typeImportSpecifiers', () => {
    it('detects `import type` and inline `{ type X }` (bare only)', () => {
        const code = `
            import { type Quat, quat, type Vec3, vec3 } from 'mathcat';
            import type { Foo } from 'foolib';
            import { bar } from 'barlib';
            import { type Local } from './local';
            import * as ns from 'nslib';
        `;
        expect(typeImportSpecifiers(code).sort()).toEqual(['foolib', 'mathcat']);
    });

    it('does not false-positive on a name containing "type"', () => {
        expect(typeImportSpecifiers(`import { types } from 'x';`)).toEqual([]);
        expect(typeImportSpecifiers(`import { prototype } from 'x';`)).toEqual([]);
    });

    it('does not false-positive on a VALUE named `type`, still catches `import type {`', () => {
        expect(typeImportSpecifiers(`import { type } from 'x';`)).toEqual([]);
        expect(typeImportSpecifiers(`import { type, foo } from 'x';`)).toEqual([]);
        expect(typeImportSpecifiers(`import type { X } from 'y';`)).toEqual(['y']);
        expect(typeImportSpecifiers(`import type Foo from 'z';`)).toEqual(['z']);
    });
});

describe('declarationCandidates', () => {
    it('maps runtime extensions to their .d.ts forms', () => {
        expect(declarationCandidates('/p/types.js')).toEqual(['/p/types.d.ts']);
        expect(declarationCandidates('/p/m.mjs')).toEqual(['/p/m.d.mts', '/p/m.d.ts']);
        expect(declarationCandidates('/p/m.cjs')).toEqual(['/p/m.d.cts', '/p/m.d.ts']);
        expect(declarationCandidates('/p/m.ts')).toEqual(['/p/m.d.ts']);
        expect(declarationCandidates('/p/noext')).toEqual(['/p/noext.d.ts', '/p/noext/index.d.ts']);
    });
});

describe('specifierToSubpath', () => {
    it('maps bare specifiers to exports subpaths', () => {
        expect(specifierToSubpath('mathcat')).toBe('.');
        expect(specifierToSubpath('mathcat/foo')).toBe('./foo');
        expect(specifierToSubpath('@scope/pkg')).toBe('.');
        expect(specifierToSubpath('@scope/pkg/foo/bar')).toBe('./foo/bar');
    });
});

describe('typesFromExports', () => {
    it('conditions object for "." with a types condition', () => {
        expect(typesFromExports({ types: './x.d.ts', import: './x.js' }, '.')).toBe('./x.d.ts');
    });

    it('subpath map with per-subpath types', () => {
        const exp = {
            '.': { types: './index.d.ts', import: './index.js' },
            './sub': { types: './sub.d.ts', default: './sub.js' },
        };
        expect(typesFromExports(exp, '.')).toBe('./index.d.ts');
        expect(typesFromExports(exp, './sub')).toBe('./sub.d.ts');
    });

    it('nested conditions (import → { types, default })', () => {
        const exp = { '.': { import: { types: './x.d.mts', default: './x.mjs' }, require: { default: './x.cjs' } } };
        expect(typesFromExports(exp, '.')).toBe('./x.d.mts');
    });

    it('array target — first with a types condition wins', () => {
        expect(typesFromExports({ '.': [{ default: './a.js' }, { types: './b.d.ts' }] }, '.')).toBe('./b.d.ts');
    });

    it('wildcard subpath', () => {
        const exp = { './*': { types: './types/*.d.ts', import: './*.js' } };
        expect(typesFromExports(exp, './foo')).toBe('./types/foo.d.ts');
    });

    it('overlapping wildcards — longest prefix wins (not object order)', () => {
        // `./feature/quat` matches both `./*` and `./feature/*`; Node picks the more
        // specific one. Order the broad key FIRST to prove it is not just first-match.
        const exp = {
            './*': { types: './wrong/*.d.ts' },
            './feature/*': { types: './right/*.d.ts' },
        };
        expect(typesFromExports(exp, './feature/quat')).toBe('./right/quat.d.ts');
    });

    it('string exports (only "." , no types)', () => {
        expect(typesFromExports('./index.js', '.')).toBeNull();
    });

    it('returns null when no types condition exists', () => {
        expect(typesFromExports({ '.': { import: './x.js', require: './x.cjs' } }, '.')).toBeNull();
        expect(typesFromExports({ '.': { types: './x.d.ts' } }, './missing')).toBeNull();
    });
});
