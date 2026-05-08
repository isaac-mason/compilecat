import type { ControlFlowGraph } from './control-flow-graph';
import type { LocalVariableTable } from './local-variable-table';
export declare const MAX_VARIABLES_TO_ANALYZE = 100;
export type LiveVariableLattice = {
    /** Uint32Array-backed bitset; one bit per indexed variable. */
    bits: Uint32Array;
};
export declare function isLive(l: LiveVariableLattice, idx: number): boolean;
export type LiveVariablesResult = {
    table: LocalVariableTable;
    /** True if the analysis ran. False if the function had too many vars. */
    ran: boolean;
};
/**
 * Run live-variables analysis. Annotates `cfg` nodes with LinearFlowState<L>
 * (per DataFlowAnalysis convention). Returns null if we bailed (too many
 * variables in the function).
 */
export declare function runLiveVariablesAnalysis(cfg: ControlFlowGraph, table: LocalVariableTable): LiveVariablesResult;
