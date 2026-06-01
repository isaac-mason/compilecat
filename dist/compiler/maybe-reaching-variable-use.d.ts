import * as t from '@babel/types';
import type { CfgNode, ControlFlowGraph } from './control-flow-graph';
import type { LocalVariableTable } from './local-variable-table';
/** Per-slot 3-state reach. Indexed by slot id.
 *    `undefined` = TOP (no use reaches),
 *    `Identifier` = exactly that single use might reach,
 *    `null` = BOTTOM (multiple distinct uses might reach).
 *  Flat array for fast clone (slice) and equality (index loop). */
export type ReachingUses = {
    uses: (t.Identifier | null | undefined)[];
};
export type MaybeReachResult = {
    ran: boolean;
    table: LocalVariableTable;
    cfg: ControlFlowGraph;
    /** Returns the unique Identifier that might be read for `id`'s slot at the
     *  start of `cfgNode`'s successor (= just after `cfgNode` executes), OR
     *  `null` (BOTTOM — multiple distinct uses) OR `undefined` (TOP — no use).
     *  FSIV accepts iff the returned identifier === the target use. */
    getUsesAfter: (id: t.Identifier, cfgNode: CfgNode) => t.Identifier | null | undefined;
    /** Slot-keyed variant. */
    getUsesAfterSlot: (slot: number, cfgNode: CfgNode) => t.Identifier | null | undefined;
};
export declare function runMaybeReachingUse(cfg: ControlFlowGraph, table: LocalVariableTable): MaybeReachResult;
