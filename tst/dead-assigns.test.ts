import generate from '@babel/generator';
import { parse } from '@babel/parser';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { traverse } from '../src/compiler/babel-interop';
import { buildControlFlowGraph } from '../src/compiler/control-flow-analysis';
import { eliminateDeadAssignments } from '../src/compiler/dead-assignments-elimination';
import { runLiveVariablesAnalysis } from '../src/compiler/live-variables-analysis';
import { buildLocalVariableTable } from '../src/compiler/local-variable-table';

function parseFn(code: string): { fn: t.FunctionDeclaration; path: NodePath<t.Function> } {
    const file = parse(code, { plugins: ['typescript'] });
    const stmt = file.program.body[0];
    if (!t.isFunctionDeclaration(stmt)) throw new Error('expected function declaration');
    let path: NodePath<t.Function> | null = null;
    traverse(file, {
        FunctionDeclaration(p) {
            if (path === null) path = p;
            p.skip();
        },
    });
    if (path === null) throw new Error('no function path');
    return { fn: stmt, path };
}

function runDae(code: string): { code: string; removed: number; ran: boolean } {
    const { fn, path } = parseFn(code);
    const cfg = buildControlFlowGraph({ root: fn.body });
    if (cfg === null) return { code: gen(fn), removed: 0, ran: false };
    const table = buildLocalVariableTable(path);
    const live = runLiveVariablesAnalysis(cfg, table);
    const r = eliminateDeadAssignments(fn, cfg, live);
    return { code: gen(fn), removed: r.removed, ran: r.ran };
}

function gen(n: t.Node): string {
    return (generate as unknown as (n: t.Node) => { code: string })(n).code.replace(/\s+/g, ' ').trim();
}

describe('DeadAssignmentsElimination', () => {
    it('drops a simple dead store', () => {
        // `var x = 1` is dead — it's overwritten by `x = 2` before any read.
        // `x = 2` survives because `return x` reads it.
        const r = runDae('function f() { var x = 1; x = 2; return x; }');
        expect(r.removed).toBeGreaterThanOrEqual(1);
        expect(r.code).toContain('return x');
        expect(r.code).toMatch(/var x;/);
        expect(r.code).toMatch(/x = 2/);
    });

    it('keeps a store that is read on at least one branch', () => {
        const r = runDae(
            'function f(cond) { var x = 1; if (cond) { x = 2; } return x; }',
        );
        // x = 2 is live-out via the join with the else-branch pass-through.
        expect(r.code).toMatch(/x = 2/);
    });

    it('preserves an impure RHS by hoisting it for var inits (effects retained)', () => {
        const r = runDae(
            'function f() { var x = sideEffect(); }',
        );
        // x is dead, but sideEffect() must still run. Closure hoists into a
        // sibling expr stmt — we do the same.
        expect(r.code).toContain('sideEffect()');
    });

    it('drops dead stores inside a loop body', () => {
        const r = runDae(
            'function f() { for (var i = 0; i < 10; i++) { var t = compute(i); } }',
        );
        // `var t = compute(i);` — t is dead. compute(i) must remain.
        expect(r.code).toContain('compute(i)');
    });

    it('does not eliminate stores when a closure escapes the variable', () => {
        // Closure capture → DAE bails the whole function.
        const r = runDae(
            'function f() { var x = 1; x = 2; return function() { return x; }; }',
        );
        expect(r.ran).toBe(false);
        expect(r.code).toMatch(/x = 2/);
    });

    it('bails when the function has too many variables', () => {
        const decls = Array.from({ length: 105 }, (_, i) => `var v${i} = 0;`).join(' ');
        const r = runDae(`function f() { ${decls} }`);
        expect(r.ran).toBe(false);
    });

    it('skips functions that contain a try/catch (CFG bails)', () => {
        const r = runDae(
            'function f() { var x = 1; try { x = 2; } catch (e) {} return x; }',
        );
        expect(r.ran).toBe(false);
    });

    it('removes identity assignment a = a unconditionally', () => {
        const r = runDae('function f() { var a = 1; a = a; return a; }');
        expect(r.removed).toBeGreaterThanOrEqual(1);
        expect(r.code).not.toMatch(/a = a/);
    });

    it('removes a dead increment in expression-statement position', () => {
        // Closure: testDeadIncrement. `x++;` whose value isn't observed and
        // x is dead after → drop.
        const r = runDae('function f() { var x = 0; x++; return 5; }');
        expect(r.removed).toBeGreaterThanOrEqual(1);
        expect(r.code).not.toMatch(/x\+\+/);
    });

    it('keeps an increment whose result is observed', () => {
        // Closure: testIncDecInSubExpressions. `use(x++)` — the value
        // produced by `x++` is read.
        const r = runDae('function f() { var x = 0; use(x++); return 5; }');
        expect(r.code).toMatch(/x\+\+/);
    });

    it('does not delete an outer init when an inner block shadows the same name', () => {
        // Regression: name-keyed analysis would conflate the outer `let x = a()`
        // with the inner block-scoped `let x`, see the inner `x = c` as a
        // killing redefinition, and (incorrectly) delete the outer init.
        // Binding-keyed analysis treats them as distinct slots, so the outer
        // `x` stays alive into `use(x)`.
        const r = runDae(
            'function f() { let x = a(); { let x = b(); x = c(); use(x); } use(x); }',
        );
        expect(r.code).toContain('a()');
        expect(r.code).toContain('b()');
        expect(r.code).toContain('c()');
    });

    it('drops the dead lhs of an assignment chain', () => {
        // Closure: testAssignmentChain. `a = b = 5;` where a is dead but
        // b is read → drop the outer assign, keep the inner.
        const r = runDae('function f() { var a, b; a = b = 5; return b; }');
        // `a =` becomes dead; `b = 5` survives.
        expect(r.code).not.toMatch(/\ba\s*=\s*b\s*=/);
    });
});
