import * as t from '@babel/types';
import type { DiGraph, DiGraphNode } from './graph/di-graph';
/** Edge kind on a CFG. */
export declare enum Branch {
    /** Edge taken when the controlling condition is true. */
    ON_TRUE = "ON_TRUE",
    /** Edge taken when the controlling condition is false. */
    ON_FALSE = "ON_FALSE",
    /** Unconditional branch. */
    UNCOND = "UNCOND",
    /**
     * Exception-handling edge. Conflates "thrown into catch/finally" with
     * "finally finishes and passes to outer handler". v1 of the CFG builder
     * does not emit ON_EX edges (try/catch is bailed at construction); the
     * enum value exists so DataFlowAnalysis can be polymorphic over it later.
     */
    ON_EX = "ON_EX",
    /** Synthetic edge for folded-away template/control-flow constructs. */
    SYN_BLOCK = "SYN_BLOCK"
}
export declare function isConditional(b: Branch): boolean;
/**
 * Sentinel node value for the implicit return. Distinct symbol so it cannot
 * collide with any real Babel AST node. Closure uses `null`; we use a Symbol
 * because TS Maps can't key on null cleanly when the rest of the keys are
 * objects.
 */
export declare const IMPLICIT_RETURN: unique symbol;
export type ImplicitReturn = typeof IMPLICIT_RETURN;
/** A CFG node value is either a Babel AST node or the implicit-return sentinel. */
export type CfgNodeValue = t.Node | ImplicitReturn;
export type CfgNode = DiGraphNode<CfgNodeValue, Branch>;
export type ControlFlowGraph = DiGraph<CfgNodeValue, Branch> & {
    entry: CfgNode;
    implicitReturn: CfgNode;
};
export declare function createControlFlowGraph(entryNode: t.Node): ControlFlowGraph;
export declare function isImplicitReturn(cfg: ControlFlowGraph, node: CfgNode): boolean;
export declare function isEnteringNewCfgNode(node: t.Node, parent: t.Node | null): boolean;
