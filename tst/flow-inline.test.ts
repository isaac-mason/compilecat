import generate from '@babel/generator';
import { parse } from '@babel/parser';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { traverse } from '../src/compiler/babel-interop';
import { buildControlFlowGraph } from '../src/compiler/control-flow-analysis';
import { runFlowSensitiveInlineVariables } from '../src/compiler/flow-sensitive-inline-variables';
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

function run(code: string): { code: string; inlined: number; ran: boolean } {
    const { fn, path } = parseFn(code);
    const cfg = buildControlFlowGraph({ root: fn.body });
    if (cfg === null) return { code: gen(fn), inlined: 0, ran: false };
    const table = buildLocalVariableTable(path);
    const r = runFlowSensitiveInlineVariables(fn, cfg, table);
    return { code: gen(fn), inlined: r.inlined, ran: r.ran };
}

function gen(n: t.Node): string {
    return (generate as unknown as (n: t.Node) => { code: string })(n).code.replace(/\s+/g, ' ').trim();
}

describe('FlowSensitiveInlineVariables', () => {
    it('inlines a single def into a single use', () => {
        // Closure FlowSensitiveInlineVariables.inlineVariable (NameDeclaration
        // branch) detaches the rhs but leaves the bare declarator `var x;` so
        // any later reassignments still have a target. DAE/RemoveUnusedCode
        // clean it up downstream when the whole chain is dead.
        const r = run('function f() { var x = 1; return x; }');
        expect(r.inlined).toBe(1);
        expect(r.code).toContain('return 1');
        expect(r.code).toContain('var x;');
    });

    it('inlines a top-level assign def', () => {
        const r = run('function f(p) { var x; x = p + 1; return x; }');
        expect(r.inlined).toBe(1);
        expect(r.code).toContain('return p + 1');
    });

    it('preserves the bare declarator so a subsequent write still binds', () => {
        // Regression: closure-aligned inlineVariable must not orphan the
        // subsequent `firstLinkTo = ...` writes by removing the declarator.
        // The first use is inlined; the trailing write must still have a
        // binding to target — i.e. `let firstLinkTo;` survives the removal
        // of the init.
        const r = run(
            `function f(a, b) {
                let firstLinkTo = a;
                use(firstLinkTo);
                firstLinkTo = b;
            }`,
        );
        expect(r.inlined).toBe(1);
        expect(r.code).toMatch(/let firstLinkTo;/);
        expect(r.code).toContain('use(a)');
        expect(r.code).toContain('firstLinkTo = b');
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

    it('does not inline an outer def into an inner-block use of the same name', () => {
        // Regression for binding-identity: the outer `var x = p + 1` and the
        // inner-block `let x` are different bindings. Name-keyed analysis
        // could (depending on impl) wrongly fold the outer RHS into the
        // inner read, producing `sink(p + 1)`. With slot-keyed identity the
        // inner read isn't a use of the outer slot, so no inline happens.
        const r = run(
            'function f(p) { var x = p + 1; { let x = 7; sink(x); } return x; }',
        );
        // The inner sink must read 7, not p + 1.
        expect(r.code).toContain('sink(7)');
    });

    it('bails when CFG construction bails (try/catch)', () => {
        const r = run('function f() { try { var x = 1; return x; } catch (e) {} }');
        expect(r.ran).toBe(false);
    });

    it('does not inline across a scope boundary (RHS reads block-let)', () => {
        // Regression for the "out__pN_M" bug we hit in crashcat: the inliner used
        // to substitute `_r = inner` followed by `return _r` outside the inner
        // block, producing `return inner` — but `inner` is `let`-scoped to the
        // block and out of scope at the return. Closure's
        // FlowSensitiveInlineVariables.isRhsSafeToInline rejects this; we now
        // mirror that.
        //
        // We give `inner` an impure init so it can't first be inlined into the
        // `_r = inner` assignment. That forces the buggy substitution path.
        const r = run(
            `function f() {
                let _r;
                {
                    let inner = compute();
                    _r = inner;
                }
                return _r;
            }`,
        );
        // `_r = inner` must NOT be inlined into `return inner` — `inner` is
        // out of scope at the return.
        expect(r.code).not.toMatch(/return inner/);
    });
});
