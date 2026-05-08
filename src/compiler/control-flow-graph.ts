// Port of jscomp/ControlFlowGraph.java
//
// A CFG is a DiGraph specialized to N = AST node, E = Branch (kind of edge).
// Adds two distinguished nodes: `entry` (function/script start) and
// `implicitReturn` (exit sentinel — every termination edge points here).
//
// `isEnteringNewCfgNode` is the rule used by traversal callbacks that walk
// inside a CFG node's subtree but stop at boundaries between CFG nodes. Ported
// to Babel's parent-relationship model below.

import * as t from '@babel/types';

import type { DiGraph, DiGraphNode } from './graph/di-graph';
import { createDiGraph, createNode } from './graph/linked-directed-graph';

/** Edge kind on a CFG. */
export enum Branch {
    /** Edge taken when the controlling condition is true. */
    ON_TRUE = 'ON_TRUE',
    /** Edge taken when the controlling condition is false. */
    ON_FALSE = 'ON_FALSE',
    /** Unconditional branch. */
    UNCOND = 'UNCOND',
    /**
     * Exception-handling edge. Conflates "thrown into catch/finally" with
     * "finally finishes and passes to outer handler". v1 of the CFG builder
     * does not emit ON_EX edges (try/catch is bailed at construction); the
     * enum value exists so DataFlowAnalysis can be polymorphic over it later.
     */
    ON_EX = 'ON_EX',
    /** Synthetic edge for folded-away template/control-flow constructs. */
    SYN_BLOCK = 'SYN_BLOCK',
}

export function isConditional(b: Branch): boolean {
    return b === Branch.ON_TRUE || b === Branch.ON_FALSE;
}

/**
 * Sentinel node value for the implicit return. Distinct symbol so it cannot
 * collide with any real Babel AST node. Closure uses `null`; we use a Symbol
 * because TS Maps can't key on null cleanly when the rest of the keys are
 * objects.
 */
export const IMPLICIT_RETURN: unique symbol = Symbol('IMPLICIT_RETURN');
export type ImplicitReturn = typeof IMPLICIT_RETURN;

/** A CFG node value is either a Babel AST node or the implicit-return sentinel. */
export type CfgNodeValue = t.Node | ImplicitReturn;

export type CfgNode = DiGraphNode<CfgNodeValue, Branch>;

export type ControlFlowGraph = DiGraph<CfgNodeValue, Branch> & {
    entry: CfgNode;
    implicitReturn: CfgNode;
};

export function createControlFlowGraph(entryNode: t.Node): ControlFlowGraph {
    const g = createDiGraph<CfgNodeValue, Branch>() as ControlFlowGraph;
    g.implicitReturn = createNode(g, IMPLICIT_RETURN);
    g.entry = createNode(g, entryNode);
    return g;
}

export function isImplicitReturn(cfg: ControlFlowGraph, node: CfgNode): boolean {
    return node === cfg.implicitReturn;
}

// ---------------------------------------------------------------------------
// isEnteringNewCfgNode
//
// Closure's version asks: when we're walking the subtree of one CFG node and
// reach `n`, is `n` the start of a NEW CFG node we should not descend into?
// Translation rules per Closure:
//
//   parent.token            => is `n` a new CFG node?
//   BLOCK, ROOT, SCRIPT,
//   TRY, SWITCH_BODY        => yes (statement-list members are each their own)
//   FUNCTION                => yes iff n is NOT the body (=> 2nd child).
//                              The function "header" (name + params) is part
//                              of the surrounding CFG; the body is its own
//                              function-scope CFG.
//   WHILE, DO, IF           => yes iff n is NOT the condition expr
//   FOR (C-style)           => yes iff n is NOT the condition expr
//   FOR_IN                  => yes iff n is NOT the loop var
//                              (the iterable expression is part of the same
//                              CFG node as the FOR_IN header)
//   CASE, CATCH, WITH       => yes iff n is NOT the first child (condition /
//                              binding pattern); body statements are new
//                              CFG nodes
//   default                 => no
//
// Babel mapping:
//   BLOCK              -> BlockStatement (body[])
//   ROOT/SCRIPT        -> File / Program (body[])
//   TRY                -> TryStatement (block / handler / finalizer) — v1 bails
//   SWITCH_BODY        -> SwitchStatement (cases[])
//   FUNCTION           -> Function* (Function/Method etc.); body is the
//                          BlockStatement (`.body`).
//   WHILE/DO/IF        -> WhileStatement/DoWhileStatement/IfStatement;
//                          condition is `.test`.
//   FOR                -> ForStatement; condition is `.test` (init/update are
//                          their own CFG nodes).
//   FOR_IN/FOR_OF      -> ForInStatement/ForOfStatement; the loop binding is
//                          `.left`, the iterable is `.right`. We treat
//                          everything except `.left` as part of the header.
//   CASE/CATCH         -> SwitchCase/CatchClause; condition / param is the
//                          first child.

export function isEnteringNewCfgNode(node: t.Node, parent: t.Node | null): boolean {
    if (parent === null) return true;

    // Statement-list parents — every direct child statement is its own CFG node.
    if (
        t.isBlockStatement(parent) ||
        t.isProgram(parent) ||
        t.isFile(parent) ||
        t.isTryStatement(parent) ||
        t.isSwitchStatement(parent)
    ) {
        return true;
    }

    if (t.isFunction(parent)) {
        // Function header (id, params) shares the surrounding CFG node; body
        // gets its own function-scope CFG.
        return node === parent.body;
    }

    if (t.isWhileStatement(parent) || t.isDoWhileStatement(parent) || t.isIfStatement(parent)) {
        return node !== parent.test;
    }

    if (t.isForStatement(parent)) {
        return node !== parent.test;
    }

    if (t.isForInStatement(parent) || t.isForOfStatement(parent)) {
        // First "child" in Closure terms is the loop-var declaration. Anything
        // else (the iterable, the body) starts a new CFG node.
        return node !== parent.left;
    }

    if (t.isSwitchCase(parent)) {
        // First child is the case test expression; consequent statements are
        // each their own CFG node.
        return node !== parent.test;
    }

    if (t.isCatchClause(parent)) {
        // First child is the param; the body is a new CFG node.
        return node !== parent.param;
    }

    return false;
}
