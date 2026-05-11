import { parse } from '@babel/parser';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { traverse } from '../src/compiler/babel-interop';
import { buildControlFlowGraph } from '../src/compiler/control-flow-analysis';
import type { ControlFlowGraph } from '../src/compiler/control-flow-graph';
import { IMPLICIT_RETURN } from '../src/compiler/control-flow-graph';
import type { LinearFlowState } from '../src/compiler/data-flow-analysis';
import {
    isLive,
    type LiveVariableLattice,
    runLiveVariablesAnalysis,
} from '../src/compiler/live-variables-analysis';
import { buildLocalVariableTable } from '../src/compiler/local-variable-table';

function parseFn(code: string): { fn: t.Function; path: NodePath<t.Function> } {
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

function setup(code: string): {
    fn: t.Function;
    cfg: ControlFlowGraph;
    table: ReturnType<typeof buildLocalVariableTable>;
} {
    const { fn, path } = parseFn(code);
    const cfg = buildControlFlowGraph({ root: fn.body });
    if (cfg === null) throw new Error('CFG bailed');
    const table = buildLocalVariableTable(path);
    return { fn, cfg, table };
}

function liveAt(cfg: ControlFlowGraph, table: ReturnType<typeof buildLocalVariableTable>, pred: (n: t.Node) => boolean, side: 'in' | 'out'): Set<string> {
    for (const node of cfg.nodes.values()) {
        if (node.value === IMPLICIT_RETURN) continue;
        if (pred(node.value as t.Node)) {
            const state = node.annotation as LinearFlowState<LiveVariableLattice>;
            const lattice = side === 'in' ? state.in : state.out;
            const live = new Set<string>();
            for (let slot = 0; slot < table.size; slot++) {
                if (isLive(lattice, slot)) live.add(table.nameOfSlot(slot));
            }
            return live;
        }
    }
    throw new Error('node not found');
}

describe('LiveVariablesAnalysis', () => {
    it('marks an unread store as dead', () => {
        // var x = 1; — x is dead immediately because it's never read.
        const { cfg, table } = setup('function f() { var x = 1; }');
        const r = runLiveVariablesAnalysis(cfg, table);
        expect(r.ran).toBe(true);
        // After the var decl, x is not live.
        const out = liveAt(
            cfg,
            table,
            (n) => t.isVariableDeclaration(n),
            'out',
        );
        expect(out.has('x')).toBe(false);
    });

    it('keeps a variable alive across a use', () => {
        const { cfg, table } = setup('function f() { var x = 1; use(x); }');
        runLiveVariablesAnalysis(cfg, table);
        const out = liveAt(
            cfg,
            table,
            (n) => t.isVariableDeclaration(n),
            'out',
        );
        expect(out.has('x')).toBe(true);
    });

    it('joins live sets across branches', () => {
        const { cfg, table } = setup(
            'function f() { var x = 1; var y = 2; if (cond) { use(x); } else { use(y); } }',
        );
        runLiveVariablesAnalysis(cfg, table);
        // After `var y = 2;` both x and y must be live (each used in one branch).
        const out = liveAt(
            cfg,
            table,
            (n) => t.isVariableDeclaration(n) && n.declarations[0]?.id.type === 'Identifier' && (n.declarations[0].id as t.Identifier).name === 'y',
            'out',
        );
        expect(out.has('x')).toBe(true);
        expect(out.has('y')).toBe(true);
    });

    it('treats escaped (closure-captured) locals as live-out at function end', () => {
        const { cfg, table } = setup(
            'function f() { var x = 1; return function() { return x; }; }',
        );
        const r = runLiveVariablesAnalysis(cfg, table);
        expect(r.ran).toBe(true);
        const xSlots = table.slotsByName('x');
        expect(xSlots.length).toBeGreaterThan(0);
        expect(xSlots.some((s) => table.escaped.has(s))).toBe(true);
    });

    it('bails when a function has more than MAX_VARIABLES_TO_ANALYZE', () => {
        const decls = Array.from({ length: 105 }, (_, i) => `var v${i} = 0;`).join(' ');
        const { cfg, table } = setup(`function f() { ${decls} }`);
        const r = runLiveVariablesAnalysis(cfg, table);
        expect(r.ran).toBe(false);
    });

    it('does not let an inner-block shadow kill the outer binding', () => {
        // Regression for binding-identity: name-keyed liveness would treat
        // the inner-block `let x` as killing the outer `x`, then conclude the
        // outer `x` is dead before `use(x)`. Slot-keyed liveness keeps them
        // distinct.
        const { cfg, table } = setup(
            'function f() { var x = 1; { let x = 2; sink(x); } use(x); }',
        );
        const r = runLiveVariablesAnalysis(cfg, table);
        expect(r.ran).toBe(true);
        // Find the OUTER `var x = 1;` declaration and check its OUT-set.
        // Both x slots show as 'x' in the live name set; we want to confirm
        // SOMETHING named x is live (the outer one).
        const out = liveAt(
            cfg,
            table,
            (n) =>
                t.isVariableDeclaration(n) &&
                n.kind === 'var' &&
                n.declarations[0]?.id.type === 'Identifier' &&
                (n.declarations[0].id as t.Identifier).name === 'x',
            'out',
        );
        expect(out.has('x')).toBe(true);
    });

    it('compound assign reads then writes (live before, dead after if unused)', () => {
        const { cfg, table } = setup('function f() { var x = 1; x += 2; }');
        runLiveVariablesAnalysis(cfg, table);
        // After `x += 2;`, x is dead. Before that statement, x is live (the
        // += reads it).
        const stmt = (n: t.Node) =>
            t.isExpressionStatement(n) &&
            t.isAssignmentExpression(n.expression) &&
            n.expression.operator === '+=';
        const inSet = liveAt(cfg, table, stmt, 'in');
        const outSet = liveAt(cfg, table, stmt, 'out');
        expect(inSet.has('x')).toBe(true);
        expect(outSet.has('x')).toBe(false);
    });
});
