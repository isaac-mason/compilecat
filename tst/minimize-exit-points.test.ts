import generate from '@babel/generator';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { runMinimizeExitPoints } from '../src/compiler/minimize-exit-points';

function mep(code: string): { code: string; minimized: number } {
    const file = parse(code, { plugins: ['typescript'] });
    const r = runMinimizeExitPoints(file);
    const out = (generate as unknown as (n: t.Node) => { code: string })(file).code.replace(/\s+/g, ' ').trim();
    return { code: out, minimized: r.minimized };
}

describe('MinimizeExitPoints', () => {
    it('drops trailing return inside a function body', () => {
        const r = mep('function f() { foo(); return; }');
        expect(r.minimized).toBeGreaterThan(0);
        expect(r.code).not.toMatch(/return;/);
    });

    it('drops trailing continue inside a loop body', () => {
        const r = mep('function f() { for (var i = 0; i < 10; i++) { foo(); continue; } }');
        expect(r.minimized).toBeGreaterThan(0);
        expect(r.code).not.toMatch(/continue;/);
    });

    it('drops trailing labeled break in a labeled block', () => {
        const r = mep('function f() { foo: { bar(); break foo; } }');
        expect(r.minimized).toBeGreaterThan(0);
        expect(r.code).not.toMatch(/break foo/);
    });

    it('hoists if-trailing siblings into else when consequent exits via return', () => {
        // function f() { if (c) { return; } a(); b(); }
        //  → function f() { if (c) {} else { a(); b(); } }
        // (Then PeepholeMinimizeConditions can collapse further.)
        const r = mep('function f(c) { if (c) { return; } a(); b(); }');
        expect(r.minimized).toBeGreaterThan(0);
        expect(r.code).not.toMatch(/return;/);
        expect(r.code).toMatch(/else/);
    });

    it('inliner-shape: hoists labeled-break sibling into else (the _compilecat_inline_result residue)', () => {
        // The shape our BLOCK-inliner emits — flag-write inside an if, fall
        // through path writes the alternate, then read the flag. After
        // MinimizeExitPoints the labeled break and trailing flag-write get
        // reorganized into if/else.
        const r = mep(
            `function f(c) {
                _label: {
                    if (c) { x = 1; break _label; }
                    x = 2;
                }
            }`,
        );
        expect(r.minimized).toBeGreaterThan(0);
        expect(r.code).not.toMatch(/break _label/);
        expect(r.code).toMatch(/else/);
    });

    it('skips the finalizer block (does not minimize its exits)', () => {
        // Closure recurses into the try block but skips the finalizer — its
        // exits matter for completion-type semantics. We mirror that.
        const r = mep('function f() { try { foo(); } finally { bar(); return; } }');
        expect(r.code).toMatch(/finally\s*{\s*bar\(\);\s*return;\s*}/);
    });
});
