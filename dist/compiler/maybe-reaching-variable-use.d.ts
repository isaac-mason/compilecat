import * as t from '@babel/types';
import type { CfgNode, ControlFlowGraph } from './control-flow-graph';
import type { LocalVariableTable } from './local-variable-table';
export type ReachingUses = {
    /** Per-variable set of identifier nodes whose read might be reached
     *  from this program point. */
    uses: Map<string, Set<t.Node>>;
};
export type MaybeReachResult = {
    ran: boolean;
    table: LocalVariableTable;
    cfg: ControlFlowGraph;
    /** At the OUT of `cfgNode` (= just after this node executes — equivalently,
     *  the in-set of its CFG successor), which use sites of `name` might be
     *  reached? Used by FSIV to count uses of a def. */
    getUsesAfter: (name: string, cfgNode: CfgNode) => Set<t.Node>;
};
export declare function runMaybeReachingUse(cfg: ControlFlowGraph, table: LocalVariableTable): MaybeReachResult;
