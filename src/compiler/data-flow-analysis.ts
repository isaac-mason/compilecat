// Port of jscomp/DataFlowAnalysis.java
//
// A worklist-driven fixpoint engine over a CFG. Callers describe their
// analysis as a set of plain functions (`flowThrough`, `joinFlows`, `equals`,
// `bottom`, `entry`); the engine handles iteration, change-detection, and the
// step-cap divergence guard.
//
// Closure's class collapses to:
//   - DataFlowConfig<L>       — static description of the analysis
//   - LinearFlowState<L>      — IN/OUT/step-count per CFG node
//   - analyze(cfg, config)    — drives the worklist
//
// Branched analyses (per-edge branch flows) keep the second annotation slot
// on edges. computeEscaped (for free vars in functions) is a Closure helper
// that uses Scope/ScopeCreator; we'll port that on demand later when an
// analysis actually needs it.

import type { Branch } from './control-flow-graph';
import type { ControlFlowGraph, CfgNode } from './control-flow-graph';
import type { DiGraphEdge, DiGraphNode } from './graph/di-graph';
import type { LatticeElement } from './graph/lattice-element';

export const MAX_STEPS_PER_NODE = 20000;

export type DataFlowDirection = 'forward' | 'backward';

export type DataFlowConfig<L extends LatticeElement> = {
    direction: DataFlowDirection;
    /** Whether this analysis tracks per-edge branched flow states. */
    branched?: boolean;
    /** Output state given input state at a CFG node. */
    flowThrough: (node: CfgNode, input: L) => L;
    /** Reduce two predecessor outputs into one input. Must be commutative
     *  and associative. Called only when there are multiple predecessors. */
    joinFlows: (a: L, b: L) => L;
    /** Lattice equality — used to detect fixpoint per node. */
    equals: (a: L, b: L) => boolean;
    /** The bottom (initial-estimate) lattice element. Returned fresh each
     *  call so that mutating callers don't get aliasing. */
    bottom: () => L;
    /** Lattice value flowing INTO the entry. */
    entry: () => L;
    /** Required iff `branched: true`. Given the post-flow output state at
     *  `node`, return the per-edge state for `branch`. */
    branchFlow?: (node: CfgNode, output: L, branch: Branch) => L;
};

/** Per-CFG-node IN/OUT/step state. Stored on node.annotation by analyze(). */
export type LinearFlowState<L> = {
    in: L;
    out: L;
    stepCount: number;
};

/** Run the analysis to fixpoint. Mutates `cfg` annotations:
 *   - Each node.annotation becomes a LinearFlowState<L>.
 *   - For branched analyses, each edge.annotation becomes the per-edge L. */
export function analyze<L extends LatticeElement>(cfg: ControlFlowGraph, config: DataFlowConfig<L>): void {
    if (config.branched && config.direction !== 'forward') {
        throw new Error('Dataflow: branched analysis must be forward.');
    }
    if (config.branched && config.branchFlow === undefined) {
        throw new Error('Dataflow: branched analysis requires branchFlow.');
    }

    initialize(cfg, config);

    const queue = new UniqueQueue<CfgNode>(byPriorityAsc);
    for (const node of cfg.nodes.values()) {
        if (node !== cfg.implicitReturn) queue.add(node);
    }

    while (!queue.isEmpty()) {
        const cur = queue.removeFirst();
        const state = cur.annotation as LinearFlowState<L>;
        if (state.stepCount++ > MAX_STEPS_PER_NODE) {
            throw new Error('Dataflow analysis appears to diverge.');
        }

        joinInputs(cfg, config, cur);

        if (flow(config, cur)) {
            const next =
                config.direction === 'forward' ? cur.outEdges.map((e) => e.destination) : cur.inEdges.map((e) => e.source);
            for (const n of next) {
                if (n !== cfg.implicitReturn) queue.add(n);
            }
        }
    }

    if (config.direction === 'forward') {
        joinInputs(cfg, config, cfg.implicitReturn);
    }
}

// --- internals ---

function initialize<L extends LatticeElement>(cfg: ControlFlowGraph, config: DataFlowConfig<L>): void {
    for (const node of cfg.nodes.values()) {
        const state: LinearFlowState<L> = {
            in: config.bottom(),
            out: config.bottom(),
            stepCount: 0,
        };
        node.annotation = state;
    }
    if (config.branched) {
        for (const node of cfg.nodes.values()) {
            for (const edge of node.outEdges) {
                edge.annotation = config.bottom();
            }
        }
    }
}

function joinInputs<L extends LatticeElement>(cfg: ControlFlowGraph, config: DataFlowConfig<L>, node: CfgNode): void {
    const state = node.annotation as LinearFlowState<L>;
    if (config.direction === 'forward' && node === cfg.entry) {
        state.in = config.entry();
        return;
    }
    const inEdges = config.direction === 'forward' ? node.inEdges : node.outEdges;
    if (inEdges.length === 0) return;

    let result: L;
    if (inEdges.length === 1) {
        result = getInputFromEdge(cfg, config, inEdges[0]);
    } else {
        result = getInputFromEdge(cfg, config, inEdges[0]);
        for (let i = 1; i < inEdges.length; i++) {
            result = config.joinFlows(result, getInputFromEdge(cfg, config, inEdges[i]));
        }
    }

    if (config.direction === 'forward') {
        state.in = result;
    } else {
        state.out = result;
    }
}

function getInputFromEdge<L extends LatticeElement>(
    cfg: ControlFlowGraph,
    config: DataFlowConfig<L>,
    edge: DiGraphEdge<unknown, Branch>,
): L {
    if (config.branched) {
        return edge.annotation as L;
    }
    if (config.direction === 'forward') {
        const srcState = edge.source.annotation as LinearFlowState<L>;
        return srcState.out;
    }
    // backward: pull IN from successor; implicit-return contributes the entry
    // value (which for a backward analysis represents the function-end state).
    const dstState = edge.destination.annotation as LinearFlowState<L> | undefined;
    if (edge.destination === cfg.implicitReturn) return config.entry();
    return (dstState as LinearFlowState<L>).in;
}

function flow<L extends LatticeElement>(config: DataFlowConfig<L>, node: CfgNode): boolean {
    const state = node.annotation as LinearFlowState<L>;
    if (config.direction === 'forward') {
        const before = state.out;
        state.out = config.flowThrough(node, state.in);
        let changed = !config.equals(before, state.out);

        if (config.branched) {
            const branchFlow = config.branchFlow!;
            for (const edge of node.outEdges) {
                const before2 = edge.annotation as L;
                const next = branchFlow(node, state.out, edge.value);
                edge.annotation = next;
                if (!changed) changed = !config.equals(before2, next);
            }
        }
        return changed;
    }
    // backward
    const before = state.in;
    state.in = config.flowThrough(node, state.out);
    return !config.equals(before, state.in);
}

// ---------------------------------------------------------------------------
// UniqueQueue — like Closure's. Priority queue + dedupe set. Comparator is
// optional; absent => FIFO.

type Comparator<T> = (a: T, b: T) => number;

function byPriorityAsc(a: DiGraphNode<unknown, Branch>, b: DiGraphNode<unknown, Branch>): number {
    return a.priority - b.priority;
}

class UniqueQueue<T> {
    private items: T[] = [];
    private seen = new Set<T>();
    constructor(private cmp: Comparator<T> | null = null) {}

    isEmpty(): boolean {
        return this.items.length === 0;
    }

    add(item: T): void {
        if (this.seen.has(item)) return;
        this.seen.add(item);
        if (this.cmp === null) {
            this.items.push(item);
            return;
        }
        // Naive sorted-insert. For our scale (per-function CFGs typically
        // <500 nodes) this is fine; if it ever shows up in profiles, swap to
        // a binary-heap.
        let i = 0;
        while (i < this.items.length && this.cmp(this.items[i], item) <= 0) i++;
        this.items.splice(i, 0, item);
    }

    removeFirst(): T {
        const item = this.items.shift();
        if (item === undefined) throw new Error('UniqueQueue: empty');
        this.seen.delete(item);
        return item;
    }
}
