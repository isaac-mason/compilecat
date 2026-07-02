import { describe, expect, it } from 'vitest';

import { createFilter, globToRegExp } from '../src/filter';

describe('globToRegExp', () => {
    it('`**` crosses path separators', () => {
        const re = globToRegExp('/p/src/**');
        expect(re.test('/p/src/a.ts')).toBe(true);
        expect(re.test('/p/src/a/b/c.ts')).toBe(true);
        expect(re.test('/p/lib/a.ts')).toBe(false);
    });

    it('`*` stays within a single segment', () => {
        const re = globToRegExp('/p/*.ts');
        expect(re.test('/p/a.ts')).toBe(true);
        expect(re.test('/p/a/b.ts')).toBe(false);
    });

    it('`?` matches exactly one non-slash char', () => {
        const re = globToRegExp('/p/?.ts');
        expect(re.test('/p/a.ts')).toBe(true);
        expect(re.test('/p/ab.ts')).toBe(false);
    });

    it('`**/` matches zero or more leading segments', () => {
        const re = globToRegExp('/p/**/mathcat/**');
        expect(re.test('/p/mathcat/vec3.ts')).toBe(true); // zero segments
        expect(re.test('/p/a/b/mathcat/vec3.ts')).toBe(true);
        expect(re.test('/p/mathcatx/vec3.ts')).toBe(false);
    });

    it('escapes regex metacharacters as literals', () => {
        const re = globToRegExp('/p/a.b+c');
        expect(re.test('/p/a.b+c')).toBe(true);
        expect(re.test('/p/aXbXc')).toBe(false);
    });
});

describe('createFilter', () => {
    it('matches RegExp include patterns (the crashcat shape)', () => {
        const f = createFilter([/\/src\//, /\/node_modules\/mathcat\//]);
        expect(f('/proj/src/engine/step.ts')).toBe(true);
        expect(f('/proj/node_modules/mathcat/vec3.ts')).toBe(true);
        expect(f('/proj/node_modules/three/three.ts')).toBe(false);
    });

    it('empty include matches everything not excluded', () => {
        const f = createFilter(undefined, /\/dist\//);
        expect(f('/p/src/a.ts')).toBe(true);
        expect(f('/p/dist/a.ts')).toBe(false);
    });

    it('exclude wins over include', () => {
        const f = createFilter(/\/src\//, /\/src\/generated\//);
        expect(f('/p/src/a.ts')).toBe(true);
        expect(f('/p/src/generated/a.ts')).toBe(false);
    });

    it('absolute glob include', () => {
        const f = createFilter('/proj/src/**');
        expect(f('/proj/src/a/b.ts')).toBe(true);
        expect(f('/proj/lib/a.ts')).toBe(false);
    });

    it('globstar-leading glob matches wherever the file lives', () => {
        const f = createFilter('**/mathcat/**');
        expect(f('/any/where/mathcat/vec3.ts')).toBe(true);
        expect(f('/any/three/cube.ts')).toBe(false);
    });

    it('normalises Windows separators before matching', () => {
        const f = createFilter(/\/src\//);
        expect(f('C:\\proj\\src\\a.ts')).toBe(true);
    });
});
