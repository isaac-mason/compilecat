import generate from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { buildControlFlowGraph } from '../src/compiler/control-flow-analysis';
import { runFlowSensitiveInlineVariables } from '../src/compiler/flow-sensitive-inline-variables';
import { buildLocalVariableTable } from '../src/compiler/local-variable-table';

function parseFn(code: string): t.FunctionDeclaration {
    const file = parse(code, { plugins: ['typescript'] });
    const stmt = file.program.body[0];
    if (!t.isFunctionDeclaration(stmt)) throw new Error('expected function declaration');
    return stmt;
}

function run(code: string): { code: string; inlined: number; ran: boolean } {
    const fn = parseFn(code);
    const cfg = buildControlFlowGraph({ root: fn.body });
    if (cfg === null) return { code: gen(fn), inlined: 0, ran: false };
    const table = buildLocalVariableTable(fn);
    const r = runFlowSensitiveInlineVariables(fn, cfg, table);
    return { code: gen(fn), inlined: r.inlined, ran: r.ran };
}

function gen(n: t.Node): string {
    return (generate as unknown as (n: t.Node) => { code: string })(n).code.replace(/\s+/g, ' ').trim();
}

describe('FlowSensitiveInlineVariables', () => {
    it('inlines a single def into a single use', () => {
        const r = run('function f() { var x = 1; return x; }');
        expect(r.inlined).toBe(1);
        expect(r.code).toContain('return 1');
        expect(r.code).not.toMatch(/var x/);
    });

    it('inlines a top-level assign def', () => {
        const r = run('function f(p) { var x; x = p + 1; return x; }');
        expect(r.inlined).toBe(1);
        expect(r.code).toContain('return p + 1');
    });

    it('does not inline when the var is used twice', () => {
        const r = run('function f() { var x = compute(); use(x); use(x); }');
        // Even ignoring purity, two uses → no inline.
        expect(r.inlined).toBe(0);
    });

    it('does not inline an impure RHS', () => {
        const r = run('function f() { var x = sideEffect(); return x; }');
        expect(r.inlined).toBe(0);
        expect(r.code).toContain('sideEffect()');
    });

    it('does not inline RHS that is a member expression (aliasing concern)', () => {
        const r = run('function f(o) { var x = o.p; mutate(o); return x; }');
        // o.p must not be re-evaluated after mutate(o).
        expect(r.inlined).toBe(0);
    });

    it('does not inline across a path with an interfering call', () => {
        // var x = a + b; impure(); return x; — Closure treats any call as
        // a side effect on the path, so the inline is blocked.
        const r = run('function f(a, b) { var x = a + b; impure(); return x; }');
        expect(r.inlined).toBe(0);
    });

    it('inlines across an adjacent statement with no path side-effect check', () => {
        // var x = p + 1; return x; — adjacent siblings → path check skipped.
        const r = run('function f(p) { var x = p + 1; return x; }');
        expect(r.inlined).toBe(1);
        expect(r.code).toContain('return p + 1');
    });

    it('bails when use is inside a loop', () => {
        const r = run('function f(p) { var x = p + 1; while (cond) { use(x); } }');
        expect(r.inlined).toBe(0);
    });

    it('bails when a closure captures the variable', () => {
        const r = run('function f() { var x = 1; return function() { return x; }; }');
        expect(r.inlined).toBe(0);
    });

    it('bails when CFG construction bails (try/catch)', () => {
        const r = run('function f() { try { var x = 1; return x; } catch (e) {} }');
        expect(r.ran).toBe(false);
    });
});
