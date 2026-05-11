import * as t from '@babel/types';
import type { CfgNode, ControlFlowGraph } from './control-flow-graph';
import type { LocalVariableTable } from './local-variable-table';
export type Definition = {
    /** CFG node (or function root for parameter sentinel) where the def lives. */
    node: t.Node;
    /** Slots that this def's RHS reads from. */
    depends: Set<number>;
    /** True if RHS references a name not in our local table — we then can't
     *  reason about whether the def is invariant across reorderings. */
    unknownDependencies: boolean;
};
export type MustDef = {
    /** Per-slot reaching def. Missing key = TOP, null value = BOTTOM. */
    reachingDef: Map<number, Definition | null>;
};
export type MustReachResult = {
    /** True if the analysis ran (false if too many vars). */
    ran: boolean;
    table: LocalVariableTable;
    /** The CFG passed in, with annotations populated. */
    cfg: ControlFlowGraph;
    /** Lookup: at the start of `cfgNode`, what def reaches the binding for
     *  this identifier? */
    getDef: (id: t.Identifier, cfgNode: CfgNode) => Definition | null | undefined;
};
export declare function runMustReachingDef(fn: t.Function, cfg: ControlFlowGraph, table: LocalVariableTable): MustReachResult;
export declare function dependsOnOuterScopeVars(def: Definition): boolean;
