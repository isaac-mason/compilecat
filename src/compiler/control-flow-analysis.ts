// Port of jscomp/ControlFlowAnalysis.java (subset).
//
// Builds a ControlFlowGraph for a single CFG root (a function body or a
// top-level Program/BlockStatement). Closure's algorithm:
//
//   1. Walk the AST recording astPosition for every node that will become a
//      CFG node (= source-order index).
//   2. Per node, dispatch to a handleX function. handleX adds the outbound
//      edges for that node, often calling `computeFollowNode` to find where
//      "next" is.
//   3. Compute a priority for each node by BFS over the CFG using the AST
//      position as tie-break — this gives the dataflow worklist a stable
//      forward-flow ordering.
//
// v1 BAILOUTS — buildControlFlowGraph returns null:
//   - TryStatement (no exception edges yet — matches plan)
//   - WithStatement (don't bother)
//   - generator function (.generator)
//   - async function (.async) — for-await also caught here transitively
//   - YieldExpression / AwaitExpression anywhere inside the CFG root
//
// Skipped vs Closure: ON_EX edges, finallyMap, connectToPossibleExceptionHandler.
// The Branch enum keeps ON_EX for forward compat with later phases.

import * as t from '@babel/types';

import {
    Branch,
    type CfgNode,
    type CfgNodeValue,
    type ControlFlowGraph,
    createControlFlowGraph,
} from './control-flow-graph';
import {
    connect,
    createNode,
    isConnectedInDirection,
} from './graph/linked-directed-graph';
import { getSlot, isLoop } from './node-util';

type Cfa = {
    cfg: ControlFlowGraph;
    root: t.Node;
    astPosition: Map<CfgNodeValue, number>;
    astPositionCounter: number;
    /** Functions encountered nested inside the CFG root — not traversed. */
    shouldTraverseFunctions: boolean;
};

export type BuildCfgOptions = {
    /** The CFG root — typically a function body (BlockStatement) or a Program. */
    root: t.Node;
    /**
     * If true, walk into nested functions and assign them priorities (still
     * separate CFG nodes, treated atomically from the outer CFG's perspective).
     * Defaults to false. Closure default also false.
     */
    shouldTraverseFunctions?: boolean;
};

/**
 * Build a CFG for `root`. Returns null if `root` contains constructs we bail
 * on (try/with/yield/await/generator/async). The caller should treat that as
 * "skip this function for any analysis that needs a CFG".
 */
export function buildControlFlowGraph(opts: BuildCfgOptions): ControlFlowGraph | null {
    if (containsBailout(opts.root)) return null;

    const cfg = createControlFlowGraph(opts.root);
    const cfa: Cfa = {
        cfg,
        root: opts.root,
        astPosition: new Map(),
        astPositionCounter: 0,
        shouldTraverseFunctions: opts.shouldTraverseFunctions ?? false,
    };

    walk(cfa, opts.root, null);

    // Implicit return is positioned last.
    cfa.astPosition.set(cfg.implicitReturn.value, cfa.astPositionCounter++);

    prioritize(cfa);

    return cfg;
}

// ---------------------------------------------------------------------------
// Bailout scan
//
// We need this to refuse the root entirely BEFORE building the partial CFG —
// otherwise edges leading into a try block etc. would be silently wrong.

function containsBailout(node: t.Node): boolean {
    let bail = false;
    walkBail(node, null, (n) => {
        if (
            t.isTryStatement(n) ||
            t.isWithStatement(n) ||
            t.isYieldExpression(n) ||
            t.isAwaitExpression(n)
        ) {
            bail = true;
            return false;
        }
        if (t.isFunction(n) && n !== node) {
            // Don't descend into nested functions — they have their own CFG.
            // Their async/generator-ness only matters when we build that CFG.
            return false;
        }
        if (t.isFunction(n) && n === node) {
            if (n.async || n.generator) {
                bail = true;
                return false;
            }
        }
        if (t.isForOfStatement(n) && n.await) {
            bail = true;
            return false;
        }
        return true;
    });
    return bail;
}

function walkBail(
    node: t.Node,
    parent: t.Node | null,
    visit: (n: t.Node, parent: t.Node | null) => boolean,
): void {
    if (!visit(node, parent)) return;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        const child = getSlot(node, key);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c) walkBail(c, node, visit);
            }
        } else {
            walkBail(child, node, visit);
        }
    }
}

// ---------------------------------------------------------------------------
// Main walk
//
// For each node we visit we (a) record its astPosition, (b) descend into the
// children we care about, and (c) on the way back up call the per-token
// handler to emit edges.

function walk(cfa: Cfa, node: t.Node, parent: t.Node | null): void {
    if (!shouldTraverseIntoChildren(cfa, node, parent)) {
        // Still record position for non-traversed children that are part of
        // the CFG (e.g. for-init / for-update appear as CFG nodes even though
        // the walker doesn't recurse into their subtrees).
        if (parent !== null && positionWanted(parent, node)) {
            ensurePosition(cfa, node);
        }
        return;
    }

    ensurePosition(cfa, node);

    // Recurse into the children determined by the node type.
    for (const child of childrenToTraverse(node)) {
        walk(cfa, child, node);
    }

    visit(cfa, node, parent);
}

function ensurePosition(cfa: Cfa, n: t.Node): void {
    if (!cfa.astPosition.has(n)) cfa.astPosition.set(n, cfa.astPositionCounter++);
}

/** Whether `child` should get an astPosition entry as a non-traversed child of
 *  `parent`. We do this for for-init/cond/update so they receive priorities. */
function positionWanted(parent: t.Node, child: t.Node): boolean {
    if (t.isForStatement(parent)) {
        return child === parent.init || child === parent.test || child === parent.update;
    }
    return false;
}

function shouldTraverseIntoChildren(cfa: Cfa, n: t.Node, parent: t.Node | null): boolean {
    if (t.isFunction(n)) {
        // Only traverse the function we were asked about (the CFG root).
        return cfa.shouldTraverseFunctions || n === cfa.root;
    }

    if (parent === null) return true;

    // Mirrors Closure's shouldTraverseIntoChildren switch on parent.token.
    if (
        t.isForStatement(parent) ||
        t.isForInStatement(parent) ||
        t.isForOfStatement(parent)
    ) {
        // Only descend into the body.
        return n === parent.body;
    }
    if (t.isDoWhileStatement(parent)) {
        // Don't descend into the test; only the body.
        return n === parent.body;
    }
    if (
        t.isIfStatement(parent) ||
        t.isWhileStatement(parent) ||
        t.isWithStatement(parent) ||
        t.isSwitchStatement(parent)
    ) {
        // Skip the condition; descend into anything that's NOT the test.
        if (t.isIfStatement(parent)) return n !== parent.test;
        if (t.isWhileStatement(parent)) return n !== parent.test;
        if (t.isWithStatement(parent)) return n !== parent.object;
        if (t.isSwitchStatement(parent)) return n !== parent.discriminant;
    }
    if (t.isSwitchCase(parent)) {
        // Skip the case test; descend into the consequents.
        return n !== parent.test;
    }
    if (t.isCatchClause(parent)) {
        return n !== parent.param;
    }
    if (t.isLabeledStatement(parent)) {
        return n === parent.body;
    }
    if (t.isFunction(parent)) {
        return n === parent.body;
    }
    // Closure refuses to descend into a handful of expression-bearing
    // statements where the children are pure expressions with no control
    // flow we model. Babel encodes this differently; skipping the whole
    // subtree of these mirrors Closure's intent.
    if (
        t.isExpressionStatement(parent) ||
        t.isVariableDeclaration(parent) ||
        t.isVariableDeclarator(parent) ||
        t.isReturnStatement(parent) ||
        t.isThrowStatement(parent) ||
        t.isBreakStatement(parent) ||
        t.isContinueStatement(parent)
    ) {
        return false;
    }
    return true;
}

function childrenToTraverse(node: t.Node): t.Node[] {
    if (t.isFunction(node)) {
        return [node.body];
    }
    if (t.isIfStatement(node)) {
        return node.alternate ? [node.consequent, node.alternate] : [node.consequent];
    }
    if (t.isWhileStatement(node) || t.isDoWhileStatement(node)) {
        return [node.body];
    }
    if (t.isForStatement(node) || t.isForInStatement(node) || t.isForOfStatement(node)) {
        return [node.body];
    }
    if (t.isSwitchStatement(node)) {
        return node.cases;
    }
    if (t.isSwitchCase(node)) {
        return node.consequent;
    }
    if (t.isLabeledStatement(node)) {
        return [node.body];
    }
    if (t.isBlockStatement(node)) {
        return node.body;
    }
    if (t.isProgram(node)) {
        return node.body;
    }
    if (t.isFile(node)) {
        return [node.program];
    }
    return [];
}

// ---------------------------------------------------------------------------
// Per-node visit dispatch (post-order edge emission)

function visit(cfa: Cfa, n: t.Node, _parent: t.Node | null): void {
    if (t.isIfStatement(n)) handleIf(cfa, n);
    else if (t.isWhileStatement(n)) handleWhile(cfa, n);
    else if (t.isDoWhileStatement(n)) handleDo(cfa, n);
    else if (t.isForStatement(n)) handleFor(cfa, n);
    else if (t.isForInStatement(n) || t.isForOfStatement(n)) handleEnhancedFor(cfa, n);
    else if (t.isSwitchStatement(n)) handleSwitch(cfa, n);
    else if (t.isSwitchCase(n)) handleSwitchCase(cfa, n);
    else if (t.isBlockStatement(n) || t.isProgram(n)) handleStmtList(cfa, n);
    else if (t.isFile(n)) {
        /* File doesn't get its own CFG node; Program does. */
    } else if (t.isFunction(n)) handleFunction(cfa, n);
    else if (t.isExpressionStatement(n)) handleExpr(cfa, n);
    else if (t.isThrowStatement(n)) handleThrow(cfa, n);
    else if (t.isBreakStatement(n)) handleBreak(cfa, n);
    else if (t.isContinueStatement(n)) handleContinue(cfa, n);
    else if (t.isReturnStatement(n)) handleReturn(cfa, n);
    else if (t.isLabeledStatement(n)) {
        /* Label is transparent; its body emits the edges. */
    } else if (t.isStatement(n)) handleStmt(cfa, n);
}

function parentOf(cfa: Cfa, n: t.Node): t.Node | null {
    return getParentMap(cfa).get(n) ?? null;
}

const PARENT_MAP = new WeakMap<Cfa, WeakMap<t.Node, t.Node>>();
function getParentMap(cfa: Cfa): WeakMap<t.Node, t.Node> {
    let pm = PARENT_MAP.get(cfa);
    if (pm === undefined) {
        pm = new WeakMap();
        const populate = (n: t.Node, parent: t.Node | null) => {
            if (parent !== null) pm!.set(n, parent);
            for (const key of t.VISITOR_KEYS[n.type] ?? []) {
                const child = getSlot(n, key);
                if (child === null || child === undefined) continue;
                if (Array.isArray(child)) {
                    for (const c of child) {
                        if (c) populate(c, n);
                    }
                } else {
                    populate(child, n);
                }
            }
        };
        populate(cfa.root, null);
        PARENT_MAP.set(cfa, pm);
    }
    return pm;
}

// ---------------------------------------------------------------------------
// Handlers — direct ports of Closure's handleX (sans exception handling).

function handleIf(cfa: Cfa, node: t.IfStatement): void {
    createEdge(cfa, node, Branch.ON_TRUE, computeFallThrough(node.consequent));
    if (node.alternate) {
        createEdge(cfa, node, Branch.ON_FALSE, computeFallThrough(node.alternate));
    } else {
        createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
    }
}

function handleWhile(cfa: Cfa, node: t.WhileStatement): void {
    createEdge(cfa, node, Branch.ON_TRUE, computeFallThrough(node.body));
    if (!isLiteralTrue(node.test)) {
        createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
    }
}

function handleDo(cfa: Cfa, node: t.DoWhileStatement): void {
    createEdge(cfa, node, Branch.ON_TRUE, computeFallThrough(node.body));
    if (!isLiteralTrue(node.test)) {
        createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
    }
}

function handleFor(cfa: Cfa, node: t.ForStatement): void {
    if (node.init) {
        createEdge(cfa, node.init, Branch.UNCOND, node);
    }
    createEdge(cfa, node, Branch.ON_TRUE, computeFallThrough(node.body));
    if (node.test && !isLiteralTrue(node.test)) {
        createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
    }
    if (node.update) {
        createEdge(cfa, node.update, Branch.UNCOND, node);
    }
}

function handleEnhancedFor(cfa: Cfa, node: t.ForInStatement | t.ForOfStatement): void {
    // Closure: collection -> forNode UNCOND, forNode -> body ON_TRUE,
    // forNode -> follow ON_FALSE.
    createEdge(cfa, node.right, Branch.UNCOND, node);
    createEdge(cfa, node, Branch.ON_TRUE, computeFallThrough(node.body));
    createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
}

function handleSwitch(cfa: Cfa, node: t.SwitchStatement): void {
    // Switch goes to the first non-default case; if no cases, to the default;
    // if neither, to follow.
    const firstNonDefault = node.cases.find((c) => c.test !== null) ?? null;
    if (firstNonDefault !== null) {
        createEdge(cfa, node, Branch.UNCOND, firstNonDefault);
    } else {
        const dflt = node.cases.find((c) => c.test === null);
        if (dflt) {
            const target =
                dflt.consequent.length > 0
                    ? computeFallThrough(dflt.consequent[0])
                    : computeFollowNode(cfa, node, node);
            createEdge(cfa, node, Branch.UNCOND, target);
        } else {
            createEdge(cfa, node, Branch.UNCOND, computeFollowNode(cfa, node, node));
        }
    }
}

function handleSwitchCase(cfa: Cfa, node: t.SwitchCase): void {
    if (node.test === null) {
        // default case — emit-handled by handleSwitch when no real cases match
        // it; but a default that's reached fall-through goes to its first stmt.
        if (node.consequent.length > 0) {
            createEdge(cfa, node, Branch.UNCOND, computeFallThrough(node.consequent[0]));
        } else {
            createEdge(cfa, node, Branch.UNCOND, computeFollowNode(cfa, node, node));
        }
        return;
    }

    // Real case: ON_TRUE -> first consequent stmt (or follow if empty).
    if (node.consequent.length > 0) {
        createEdge(cfa, node, Branch.ON_TRUE, computeFallThrough(node.consequent[0]));
    } else {
        createEdge(cfa, node, Branch.ON_TRUE, computeFollowNode(cfa, node, node));
    }

    // ON_FALSE: next CASE (skipping default), or default (if any), or follow.
    const parent = parentOf(cfa, node);
    if (!t.isSwitchStatement(parent)) {
        createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
        return;
    }
    const idx = parent.cases.indexOf(node);
    let nextCase: t.SwitchCase | undefined;
    for (let i = idx + 1; i < parent.cases.length; i++) {
        if (parent.cases[i].test !== null) {
            nextCase = parent.cases[i];
            break;
        }
    }
    if (nextCase) {
        createEdge(cfa, node, Branch.ON_FALSE, nextCase);
    } else {
        const dflt = parent.cases.find((c) => c.test === null);
        if (dflt) {
            createEdge(cfa, node, Branch.ON_FALSE, dflt);
        } else {
            createEdge(cfa, node, Branch.ON_FALSE, computeFollowNode(cfa, node, node));
        }
    }
}

function handleStmtList(cfa: Cfa, node: t.BlockStatement | t.Program): void {
    // First non-function child is where control transfers; if none, to follow.
    const body = node.body;
    let first: t.Node | undefined;
    for (const child of body) {
        if (!t.isFunctionDeclaration(child)) {
            first = child;
            break;
        }
    }
    if (first) {
        createEdge(cfa, node, Branch.UNCOND, computeFallThrough(first));
    } else {
        createEdge(cfa, node, Branch.UNCOND, computeFollowNode(cfa, node, node));
    }
}

function handleFunction(cfa: Cfa, node: t.Function): void {
    // From the Function node, transfer to its body.
    createEdge(cfa, node, Branch.UNCOND, computeFallThrough(node.body));
}

function handleExpr(cfa: Cfa, node: t.ExpressionStatement): void {
    createEdge(cfa, node, Branch.UNCOND, computeFollowNode(cfa, node, node));
}

function handleThrow(_cfa: Cfa, _node: t.ThrowStatement): void {
    // No exception handling in v1 — throw has no out-edge (effectively
    // terminates the function silently). The implicit-return path remains
    // valid because nothing routes through the throw.
}

function handleBreak(cfa: Cfa, node: t.BreakStatement): void {
    const target = findBreakTarget(cfa, node, node.label?.name ?? null);
    if (target === null) return; // malformed source — ignore (matches "canContinueAfterErrors")
    createEdge(cfa, node, Branch.UNCOND, computeFollowNode(cfa, node, target));
}

function handleContinue(cfa: Cfa, node: t.ContinueStatement): void {
    const target = findContinueTarget(cfa, node, node.label?.name ?? null);
    if (target === null) return;
    // For a vanilla for, continue goes to the update slot (parent.update);
    // for other loops, continue goes back to the loop node itself.
    let to: t.Node = target;
    if (t.isForStatement(target) && target.update) {
        to = target.update;
    }
    createEdge(cfa, node, Branch.UNCOND, to);
}

function handleReturn(cfa: Cfa, node: t.ReturnStatement): void {
    createEdge(cfa, node, Branch.UNCOND, null);
}

function handleStmt(cfa: Cfa, node: t.Statement): void {
    createEdge(cfa, node, Branch.UNCOND, computeFollowNode(cfa, node, node));
}

// ---------------------------------------------------------------------------
// computeFollowNode / computeFallThrough — direct ports.

function computeFollowNode(
    cfa: Cfa,
    fromNode: t.Node,
    node: t.Node,
): t.Node | null {
    const parent = parentOf(cfa, node);
    if (parent === null || t.isFunction(parent) || node === cfa.root) return null;

    if (t.isIfStatement(parent)) {
        return computeFollowNode(cfa, fromNode, parent);
    }
    if (t.isSwitchCase(parent)) {
        // After a case body, control passes to the next case's body
        // (fall-through) — case condition is skipped.
        const grand = parentOf(cfa, parent);
        if (!t.isSwitchStatement(grand)) {
            return computeFollowNode(cfa, fromNode, parent);
        }
        const idx = grand.cases.indexOf(parent);
        const nextCase = grand.cases[idx + 1];
        if (nextCase) {
            if (nextCase.consequent.length > 0) {
                return computeFallThrough(nextCase.consequent[0]);
            }
            // Empty case — fall through again.
            return computeFollowNode(cfa, fromNode, nextCase);
        }
        return computeFollowNode(cfa, fromNode, parent);
    }
    if (t.isForStatement(parent)) {
        // After body, go to update; if no update, back to the for itself.
        return parent.update ?? parent;
    }
    if (
        t.isWhileStatement(parent) ||
        t.isDoWhileStatement(parent) ||
        t.isForInStatement(parent) ||
        t.isForOfStatement(parent)
    ) {
        return parent;
    }
    if (t.isLabeledStatement(parent)) {
        return computeFollowNode(cfa, fromNode, parent);
    }

    // Now the ordinary case: walk to the next sibling in a statement list,
    // skipping function declarations. If no sibling, recurse upward.
    const siblings = siblingListOf(parent);
    if (siblings !== null) {
        const idx = siblings.indexOf(node as t.Statement);
        for (let i = idx + 1; i < siblings.length; i++) {
            const s = siblings[i];
            if (s && !t.isFunctionDeclaration(s)) return computeFallThrough(s);
        }
        return computeFollowNode(cfa, fromNode, parent);
    }

    return computeFollowNode(cfa, fromNode, parent);
}

/** Returns the statement-list array that `parent` directly contains, if any. */
function siblingListOf(parent: t.Node): t.Statement[] | null {
    if (t.isBlockStatement(parent) || t.isProgram(parent)) return parent.body;
    if (t.isSwitchCase(parent)) return parent.consequent;
    return null;
}

export function computeFallThrough(n: t.Node): t.Node {
    if (t.isDoWhileStatement(n)) return computeFallThrough(n.body);
    if (t.isForStatement(n)) {
        if (n.init) return computeFallThrough(n.init);
        return n;
    }
    if (t.isForInStatement(n) || t.isForOfStatement(n)) {
        // Closure: getSecondChild() — i.e. the iterable. Babel: .right.
        return n.right;
    }
    if (t.isLabeledStatement(n)) return computeFallThrough(n.body);
    return n;
}

// ---------------------------------------------------------------------------
// Edge construction

function createEdge(cfa: Cfa, fromNode: t.Node, branch: Branch, toNode: t.Node | null): void {
    const from = createNode(cfa.cfg, fromNode);
    const to =
        toNode === null
            ? cfa.cfg.implicitReturn
            : createNode(cfa.cfg, toNode);
    if (!isConnectedInDirection(from, to, (b) => b === branch)) {
        connect(cfa.cfg, from.value, branch, to.value);
    }
}

// ---------------------------------------------------------------------------
// Break/continue target resolution

function findBreakTarget(cfa: Cfa, from: t.Node, label: string | null): t.Node | null {
    let cur: t.Node | null = from;
    while (cur !== null) {
        if (isBreakTargetFor(cfa, cur, label)) return cur;
        cur = parentOf(cfa, cur);
    }
    return null;
}

function findContinueTarget(cfa: Cfa, from: t.Node, label: string | null): t.Node | null {
    let cur: t.Node | null = from;
    while (cur !== null) {
        if (isLoop(cur) && labelMatches(cfa, cur, label)) return cur;
        cur = parentOf(cfa, cur);
    }
    return null;
}

function isBreakTargetFor(cfa: Cfa, node: t.Node, label: string | null): boolean {
    if (label === null) {
        // Unlabeled break: any loop or switch.
        return isLoop(node) || t.isSwitchStatement(node);
    }
    // Labeled break: any statement whose enclosing label-chain includes label.
    return labelMatches(cfa, node, label);
}

function labelMatches(cfa: Cfa, target: t.Node, label: string | null): boolean {
    if (label === null) return true;
    let cur: t.Node | null = parentOf(cfa, target);
    while (cur !== null && t.isLabeledStatement(cur)) {
        if (cur.label.name === label) return true;
        cur = parentOf(cfa, cur);
    }
    return false;
}

// ---------------------------------------------------------------------------
// Misc

function isLiteralTrue(expr: t.Expression): boolean {
    return t.isBooleanLiteral(expr) && expr.value === true;
}

// ---------------------------------------------------------------------------
// Priority assignment — BFS from entry, AST-position-ordered, then unreached
// nodes get priorities last and the implicit-return is dead last.

function prioritize(cfa: Cfa): void {
    let counter = 0;
    const setPriority = (n: CfgNode) => {
        if (n.priority < 0) n.priority = ++counter;
    };

    prioritizeFromEntry(cfa, cfa.cfg.entry, setPriority);

    if (cfa.shouldTraverseFunctions) {
        for (const node of cfa.cfg.nodes.values()) {
            if (node.value !== cfa.cfg.implicitReturn.value && t.isFunction(node.value as t.Node)) {
                prioritizeFromEntry(cfa, node, setPriority);
            }
        }
    }

    for (const node of cfa.cfg.nodes.values()) {
        setPriority(node);
    }
    // Implicit return is last — re-stamp.
    cfa.cfg.implicitReturn.priority = ++counter;
}

function prioritizeFromEntry(
    cfa: Cfa,
    entry: CfgNode,
    setPriority: (n: CfgNode) => void,
): void {
    // Closure uses a min-priority-queue keyed by AST position. We approximate
    // by collecting reachable nodes, sorting by ast position, and stamping.
    const reached: CfgNode[] = [];
    const seen = new Set<CfgNode>();
    const stack: CfgNode[] = [entry];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        reached.push(cur);
        for (const e of cur.outEdges) stack.push(e.destination);
    }
    reached.sort((a, b) => {
        const pa = cfa.astPosition.get(a.value) ?? Number.POSITIVE_INFINITY;
        const pb = cfa.astPosition.get(b.value) ?? Number.POSITIVE_INFINITY;
        return pa - pb;
    });
    for (const n of reached) setPriority(n);
}
