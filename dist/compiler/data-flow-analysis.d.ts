import { Branch } from './control-flow-graph';
import type { ControlFlowGraph, CfgNode } from './control-flow-graph';
import type { LatticeElement } from './graph/lattice-element';
export declare const MAX_STEPS_PER_NODE = 20000;
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
export declare function analyze<L extends LatticeElement>(cfg: ControlFlowGraph, config: DataFlowConfig<L>): void;
