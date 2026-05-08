import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { buildControlFlowGraph } from '../src/compiler/control-flow-analysis';
import { IMPLICIT_RETURN } from '../src/compiler/control-flow-graph';
import {
    analyze,
    type DataFlowConfig,
    type LinearFlowState,
    MAX_STEPS_PER_NODE,
} from '../src/compiler/data-flow-analysis';

function fnBody(code: string): t.Node {
    const file = parse(code, { plugins: ['typescript'] });
    const stmt = file.program.body[0] as t.FunctionDeclaration;
    return stmt.body;
}

describe('DataFlowAnalysis', () => {
    it('terminates on a trivial constant lattice', () => {
        // Lattice: {value: number}. flow returns input unchanged. Should hit
        // fixpoint after one pass per node.
        const cfg = buildControlFlowGraph({ root: fnBody('function f() { a; b; c; }') })!;
        type L = { value: number };
        const config: DataFlowConfig<L> = {
            direction: 'forward',
            flowThrough: (_, input) => input,
            joinFlows: (a, b) => ({ value: Math.max(a.value, b.value) }),
            equals: (a, b) => a.value === b.value,
            bottom: () => ({ value: 0 }),
            entry: () => ({ value: 1 }),
        };
        analyze(cfg, config);
        // Entry's IN should match `entry()`.
        const entryState = cfg.entry.annotation as LinearFlowState<L>;
        expect(entryState.in.value).toBe(1);
        // Implicit return's IN comes from join over predecessors. Should be ≥1.
        const ret = cfg.implicitReturn.annotation as LinearFlowState<L>;
        expect(ret.in.value).toBeGreaterThanOrEqual(1);
    });

    it('counts step caps and aborts on divergence', () => {
        // Cycle (while loop) + an equals that never reports fixpoint =>
        // the worklist re-queues forever and trips MAX_STEPS_PER_NODE.
        const cfg = buildControlFlowGraph({ root: fnBody('function f() { while (cond) { a; } }') })!;
        let counter = 0;
        const config: DataFlowConfig<{ v: number }> = {
            direction: 'forward',
            flowThrough: () => ({ v: counter++ }),
            joinFlows: (a, b) => ({ v: a.v + b.v }),
            equals: () => false,
            bottom: () => ({ v: -1 }),
            entry: () => ({ v: 0 }),
        };
        expect(() => analyze(cfg, config)).toThrow(/diverge/);
    });

    it('exposes MAX_STEPS_PER_NODE = 20000', () => {
        expect(MAX_STEPS_PER_NODE).toBe(20000);
    });

    it('keeps implicit return out of the worklist', () => {
        // Sanity: flowThrough should never be called for implicit-return.
        const cfg = buildControlFlowGraph({ root: fnBody('function f() { a; }') })!;
        const visited: Array<unknown> = [];
        analyze(cfg, {
            direction: 'forward',
            flowThrough: (node, input) => {
                visited.push(node.value);
                return input;
            },
            joinFlows: (a) => a,
            equals: () => true,
            bottom: () => ({}),
            entry: () => ({}),
        });
        expect(visited.includes(IMPLICIT_RETURN)).toBe(false);
    });
});
