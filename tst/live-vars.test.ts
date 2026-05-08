import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

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

function parseFn(code: string): t.Function {
    const file = parse(code, { plugins: ['typescript'] });
    const stmt = file.program.body[0];
    if (!t.isFunctionDeclaration(stmt)) throw new Error('expected function declaration');
    return stmt;
}

function setup(code: string): {
    fn: t.Function;
    cfg: ControlFlowGraph;
    table: ReturnType<typeof buildLocalVariableTable>;
} {
    const fn = parseFn(code);
    const cfg = buildControlFlowGraph({ root: fn.body });
    if (cfg === null) throw new Error('CFG bailed');
    const table = buildLocalVariableTable(fn);
    return { fn, cfg, table };
}

function liveAt(cfg: ControlFlowGraph, table: ReturnType<typeof buildLocalVariableTable>, pred: (n: t.Node) => boolean, side: 'in' | 'out'): Set<string> {
    for (const node of cfg.nodes.values()) {
        if (node.value === IMPLICIT_RETURN) continue;
        if (pred(node.value as t.Node)) {
            const state = node.annotation as LinearFlowState<LiveVariableLattice>;
            const lattice = side === 'in' ? state.in : state.out;
            const live = new Set<string>();
            for (const [name, idx] of table.indexByName) {
                if (isLive(lattice, idx)) live.add(name);
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
        expect(table.escaped.has('x')).toBe(true);
    });

    it('bails when a function has more than MAX_VARIABLES_TO_ANALYZE', () => {
        const decls = Array.from({ length: 105 }, (_, i) => `var v${i} = 0;`).join(' ');
        const { cfg, table } = setup(`function f() { ${decls} }`);
        const r = runLiveVariablesAnalysis(cfg, table);
        expect(r.ran).toBe(false);
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
