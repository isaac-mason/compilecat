import * as t from '@babel/types';
import type { ControlFlowGraph } from './control-flow-graph';
import type { LiveVariablesResult } from './live-variables-analysis';
export type DeadAssignmentsResult = {
    /** Did the pass run? False if bailed (nested function, too many vars). */
    ran: boolean;
    /** How many assignments were rewritten. */
    removed: number;
};
export declare function eliminateDeadAssignments(fn: t.Function, cfg: ControlFlowGraph, live: LiveVariablesResult): DeadAssignmentsResult;
