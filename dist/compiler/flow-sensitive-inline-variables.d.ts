import * as t from '@babel/types';
import type { ControlFlowGraph } from './control-flow-graph';
import type { LocalVariableTable } from './local-variable-table';
export type FlowInlineResult = {
    ran: boolean;
    inlined: number;
};
export declare function runFlowSensitiveInlineVariables(fn: t.Function, cfg: ControlFlowGraph, table: LocalVariableTable): FlowInlineResult;
