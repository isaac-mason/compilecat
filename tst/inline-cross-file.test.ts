import generate from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { createFileCache } from '../src/compiler/file-index';
import { inlineFunctions } from '../src/compiler/inline-functions';
import type { FileReader } from '../src/compiler/resolve';

// biome-ignore lint/suspicious/noExplicitAny: babel CJS interop
const gen: typeof generate = (generate as any).default ?? generate;

function runProject(files: Record<string, string>, entry: string): string {
    const reader: FileReader = (abs) =>
        Object.prototype.hasOwnProperty.call(files, abs) ? files[abs] : null;
    const cache = createFileCache();
    const ast = parse(files[entry], { sourceType: 'module', plugins: ['typescript'] });
    inlineFunctions(ast, {
        consumerPath: entry,
        fileCache: cache,
        fileReader: reader,
    });
    return (gen as unknown as (n: t.Node, o?: unknown) => { code: string })(ast, {
        retainLines: false,
        comments: false,
    }).code.trim();
}

describe('InlineFunctions — cross-file', () => {
    it('inlines a decl-annotated imported function', () => {
        const files = {
            '/proj/util.ts': `
                /* @inline */
                export function double(x) { return x * 2; }
            `,
            '/proj/main.ts': `
                import { double } from './util';
                const r = double(7);
            `,
        };
        const out = runProject(files, '/proj/main.ts');
        expect(out).toContain('const r = 7 * 2');
    });

    it('inlines a non-annotated import when the callsite opts in', () => {
        const files = {
            '/proj/util.ts': `
                export function triple(x) { return x * 3; }
            `,
            '/proj/main.ts': `
                import { triple } from './util';
                const r = /* @inline */ triple(7);
                const s = triple(8);
            `,
        };
        const out = runProject(files, '/proj/main.ts');
        expect(out).toContain('7 * 3');
        expect(out).toContain('triple(8)');
    });

    it('inlines through namespace member access when opted in', () => {
        const files = {
            '/proj/util.ts': `
                export function neg(x) { return -x; }
            `,
            '/proj/main.ts': `
                import * as util from './util';
                const r = /* @inline */ util.neg(value);
            `,
        };
        const out = runProject(files, '/proj/main.ts');
        expect(out).toContain('-value');
    });

    it('hoists donor module-vars into the consumer', () => {
        const files = {
            '/proj/util.ts': `
                const K = 42;
                /* @inline */
                export function getK() { return K; }
            `,
            '/proj/main.ts': `
                import { getK } from './util';
                const r = getK();
            `,
        };
        const out = runProject(files, '/proj/main.ts');
        expect(out).toContain('const K = 42');
        expect(out).toContain('const r = K');
    });

    it('hoists donor imports into the consumer', () => {
        const files = {
            '/proj/shared.ts': `
                export function helper(x) { return x + 1; }
            `,
            '/proj/util.ts': `
                import { helper } from './shared';
                /* @inline */
                export function boost(x) { return helper(x); }
            `,
            '/proj/main.ts': `
                import { boost } from './util';
                const r = boost(3);
            `,
        };
        const out = runProject(files, '/proj/main.ts');
        expect(out).toMatch(/from ['"]\.\/shared['"]/);
        expect(out).toContain('helper(3)');
    });

    it('inlines `import { ns } from pkg` where pkg re-exports ns via `export * as`', () => {
        const files = {
            '/proj/mathcat/vec3.ts': `
                /* @inline */
                export function add(out, a, b) {
                    out[0] = a[0] + b[0];
                    out[1] = a[1] + b[1];
                    out[2] = a[2] + b[2];
                }
            `,
            '/proj/mathcat/index.ts': `
                export * as vec3 from './vec3';
            `,
            '/proj/main.ts': `
                import { vec3 } from './mathcat/index';
                vec3.add(out, a, b);
            `,
        };
        const out = runProject(files, '/proj/main.ts');
        // Args here are simple identifiers → FunctionArgumentInjector substitutes
        // them directly, no param renames needed; the body pattern survives in
        // shape: `<o>[0] = <a>[0] + <b>[0]`.
        expect(out).toMatch(/[\w$]+\[0\]\s*=\s*[\w$]+\[0\]\s*\+\s*[\w$]+\[0\]/);
        expect(out).not.toMatch(/\bvec3\.add\b/);
    });

    it('inlines `import { ns } from pkg` where pkg uses `import * as ns; export { ns };`', () => {
        const files = {
            '/proj/mathcat/mat4.ts': `
                /* @inline */
                export function create() {
                    return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
                }
            `,
            '/proj/mathcat/index.ts': `
                import * as mat4 from './mat4';
                export { mat4 };
            `,
            '/proj/main.ts': `
                import { mat4 } from './mathcat/index';
                const m = mat4.create();
            `,
        };
        const out = runProject(files, '/proj/main.ts');
        expect(out).toContain('const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]');
        expect(out).not.toMatch(/\bmat4\.create\b/);
    });

    it('inlines a default-exported function via `import foo from "./donor"`', () => {
        const files = {
            '/proj/util.ts': `
                /* @inline */
                export default function square(x) { return x * x; }
            `,
            '/proj/main.ts': `
                import square from './util';
                const r = square(5);
            `,
        };
        const out = runProject(files, '/proj/main.ts');
        expect(out).toContain('const r = 5 * 5');
    });
});
