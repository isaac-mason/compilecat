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

    // Regression: inlining a TS callee whose body declares a typed local
    // (`let jv: number;`) was producing output where the type annotation
    // survived on the inlined declaration. Downstream consumers expecting JS
    // after compilecat (or even further TS transform via `ts.transpileModule`)
    // could then trip when the annotation slipped through. We don't expect
    // every TS construct to be stripped — compilecat doesn't run the
    // TS-to-JS transformer — but inlined-from-callee declarations have to
    // come out shaped like the consumer authored them: bare bindings, no
    // dangling type annotations.
    it('does not leak TS type annotations on inlined locals', () => {
        const r = transform(
            `
            /** @inline */
            export function callee(a: number, b: number): number {
                let jv: number;
                if (a > b) {
                    jv = a - b;
                } else {
                    jv = b - a;
                }
                return jv;
            }
            export function consumer(x: number, y: number): number {
                /* @inline */
                const r = callee(x, y);
                return r;
            }
        `,
            { filename: 'test.ts' },
        );
        // The inlined-into-consumer copy of `let jv` must not retain its
        // `: number` annotation.
        expect(r.code).not.toMatch(/let\s+jv[\w$]*\s*:\s*number/);
    });

    // Regression: param renaming should not produce inconsistent output
    // across functions that all declare same-named params. Specifically,
    // callers shouldn't see `function f(a, b__1, c)` mixed with `function
    // g(a__1, b, c__1)` — that pattern is a hint that the Normalize pass is
    // doing inline-style renaming on function parameters that were never
    // inlined.
    it('does not rename declared function parameters', () => {
        const r = transform(
            `
            export function f(rA: number, rB: number, rC: number): number {
                return rA + rB + rC;
            }
            export function g(rA: number, rB: number): number {
                return rA - rB;
            }
            export function h(rA: number): number {
                return rA * 2;
            }
        `,
            { filename: 'test.ts' },
        );
        // No suffix on any param identifier.
        expect(r.code).not.toMatch(/\brA__\d/);
        expect(r.code).not.toMatch(/\brB__\d/);
        expect(r.code).not.toMatch(/\brC__\d/);
    });
});
