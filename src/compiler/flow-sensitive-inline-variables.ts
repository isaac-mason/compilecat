// Port of jscomp/FlowSensitiveInlineVariables.java
//
// Replaces a single read of a local variable with that variable's defining
// RHS, when:
//   1. There is exactly one definition that must reach the read.
//   2. The defining RHS itself has exactly one reachable use (this read).
//   3. The RHS is safe to inline:
//        - no observable side effects
//        - no member/element access (would change semantics under aliasing)
//        - no class / array / object / regex / new (changes object identity)
//   4. No interfering side effect lies between def and use:
//        - in the def's own CFG-node expression, after the def
//        - in the use's own CFG-node expression, before the use
//        - on any CFG path between the def-cfg-node and the use-cfg-node
//          (skipped when the two CFG nodes are immediate siblings in a
//          statement list, the common case)
//   5. The use is not inside a loop (would inline N times into N iterations).
//
// Variable identity is by binding-slot — see local-variable-table.ts. We never
// compare names; only slot equality. This is correctness-critical when the
// same name is shadowed across nested scopes.
//
// Drives MustBeReachingVariableDef + MaybeReachingVariableUse + the
// CheckPathsBetweenNodes graph utility.

import * as t from '@babel/types';

import { isEnteringNewCfgNode } from './control-flow-graph';
import type { CfgNode, ControlFlowGraph } from './control-flow-graph';
import { mayHaveSideEffects } from './ast-analyzer';
import { getSlot, setSlot } from './node-util';
import {
    allPathsSatisfyPredicate,
    somePathsSatisfyPredicate,
} from './graph/check-paths-between-nodes';
import { runMaybeReachingUse } from './maybe-reaching-variable-use';
import {
    type Definition,
    dependsOnOuterScopeVars,
    type MustDef,
    runMustReachingDef,
} from './must-be-reaching-variable-def';
import type { LocalVariableTable } from './local-variable-table';

// Suppress unused-import warning while keeping the doc-comment reference.
void allPathsSatisfyPredicate;

// ---------------------------------------------------------------------------
// Public entry

export type FlowInlineResult = {
    ran: boolean;
    inlined: number;
};

export function runFlowSensitiveInlineVariables(
    fn: t.Function,
    cfg: ControlFlowGraph,
    table: LocalVariableTable,
): FlowInlineResult {
    if (table.size === 0) return { ran: true, inlined: 0 };

    const reachDef = runMustReachingDef(fn, cfg, table);
    const reachUse = runMaybeReachingUse(cfg, table);
    const parents = buildParentMap(fn);

    const candidates = gatherCandidates(fn, cfg, table, reachDef.getDef, parents);

    let inlined = 0;
    for (const c of candidates) {
        if (canInline(c, fn, cfg, table, reachUse.getUsesAfterSlot, parents)) {
            performInline(c, table, parents);
            inlined++;
        }
    }
    return { ran: true, inlined };
}

// ---------------------------------------------------------------------------
// Candidate

type Candidate = {
    slot: number;
    def: Definition;
    use: t.Identifier;
    useCfgNode: CfgNode;
};

function gatherCandidates(
    fn: t.Function,
    cfg: ControlFlowGraph,
    table: LocalVariableTable,
    getDef: (id: t.Identifier, cfgNode: CfgNode) => Definition | null | undefined,
    parents: ParentMap,
): Candidate[] {
    const out: Candidate[] = [];
    for (const cfgNode of cfg.nodes.values()) {
        if (cfgNode === cfg.implicitReturn) continue;
        if (cfgNode === cfg.entry) continue;
        const value = cfgNode.value;
        if (typeof value === 'symbol') continue;

        forEachIdentifierRead(value as t.Node, parents, (id) => {
            const slot = table.resolve(id);
            if (slot === undefined) return;
            if (table.escaped.has(slot)) return;
            const def = getDef(id, cfgNode);
            if (def === null || def === undefined) return;
            if (def.node === fn) return; // parameter sentinel — skip
            if (dependsOnOuterScopeVars(def)) return;
            out.push({ slot, def, use: id, useCfgNode: cfgNode });
        });
    }
    void fn;
    return out;
}

// ---------------------------------------------------------------------------
// canInline

function canInline(
    c: Candidate,
    fn: t.Function,
    cfg: ControlFlowGraph,
    table: LocalVariableTable,
    getUsesAfterSlot: (slot: number, cfgNode: CfgNode) => Set<t.Node>,
    parents: ParentMap,
): boolean {
    const defLoc = locateDefExpr(c.def, c.slot, table, parents);
    if (defLoc === null) return false;

    // Reject defs whose enclosing AssignmentExpression isn't the top-level of
    // its CFG node (i.e. `(x = rhs)` used as an inner subexpression).
    if (defLoc.kind === 'assign' && !defLoc.topLevel) return false;

    const rhs = defLoc.rhs;

    // 1. RHS itself impure → can't inline (might change observable order).
    if (mayHaveSideEffects(rhs)) return false;

    // 2. RHS shape — Closure's isRhsSafeToInline.
    if (!isRhsSafeToInline(rhs)) return false;

    // 3. Pre/post sibling side-effect checks on slots this def depends on.
    const slotsToCheck = c.def.depends;
    if (
        checkPostExpressions(defLoc.expr, c.def.node, slotsToCheck, table, parents) ||
        checkPreExpressions(c.use, c.useCfgNode.value as t.Node, slotsToCheck, table, parents)
    ) {
        return false;
    }

    // 4. Exactly one syntactic use of the binding behind c.slot inside the use's CFG node.
    if (countSlotUsesInCfgNode(c.useCfgNode.value as t.Node, c.slot, table, parents) !== 1) {
        return false;
    }

    // 5. Use not inside a loop.
    if (isWithinLoop(c.use, fn, parents)) return false;

    // 6. Reaching-use set at the def's CFG node has exactly one element.
    const defCfg = cfg.nodes.get(c.def.node);
    if (defCfg === undefined) return false;
    const usesAfter = getUsesAfterSlot(c.slot, defCfg);
    if (usesAfter.size !== 1) return false;
    if (!usesAfter.has(c.use)) return false;

    // 7. Path side-effect check, unless def and use are immediate siblings.
    if (!areAdjacentSiblings(c.def.node, c.useCfgNode.value as t.Node, parents)) {
        const useGraph = cfg.nodes.get(c.useCfgNode.value);
        if (useGraph === undefined) return false;
        const sideEffectOnPath = somePathsSatisfyPredicate({
            graph: cfg,
            start: defCfg,
            end: useGraph,
            nodePredicate: (v) => {
                if (typeof v === 'symbol') return false;
                return nodeHasInterferingEffect(v as t.Node, slotsToCheck, table, parents);
            },
            edgePredicate: () => true,
            inclusive: false,
        });
        if (sideEffectOnPath) return false;
    }

    // 8. Scope visibility — every free local Identifier in the RHS must be in
    //    lexical scope at the use site. Mirrors the second clause of Closure's
    //    isRhsSafeToInline (FlowSensitiveInlineVariables.java:639). Without
    //    this, we'd substitute `out$pN` (declared in an inner block) into a
    //    `return` outside the block, producing an out-of-scope reference.
    if (!rhsIdentifiersInScopeAt(rhs, c.use, table, parents)) return false;

    return true;
}

/**
 * For every free Identifier read inside `rhs` that resolves to a local slot,
 * verify that the slot's binding scope is an ancestor of `useSite`. Free
 * names that are outer-scope (table.resolve === undefined) are always safe —
 * if they were visible at the def site, they're visible at any sibling/use
 * inside the same function.
 */
function rhsIdentifiersInScopeAt(
    rhs: t.Expression,
    useSite: t.Node,
    table: LocalVariableTable,
    parents: ParentMap,
): boolean {
    const useAncestors = collectAncestorNodes(useSite, parents);
    let ok = true;
    t.traverseFast(rhs, (n) => {
        if (!ok) return;
        // Don't descend into nested functions — their free names are bound in
        // their own scope chain, not the use site's.
        if (t.isFunction(n)) return t.traverseFast.skip;
        if (!t.isIdentifier(n)) return undefined;
        const info = parents.get(n);
        if (info === undefined) return undefined;
        if (!isReferenceContext(info.parent, info.key)) return undefined;
        const slot = table.resolve(n);
        if (slot === undefined) return undefined; // outer-scope / global → safe
        const scopeNode = table.scopeNodeOfSlot(slot);
        if (scopeNode === undefined) {
            ok = false;
            return undefined;
        }
        if (!useAncestors.has(scopeNode)) ok = false;
        return undefined;
    });
    return ok;
}

function collectAncestorNodes(node: t.Node, parents: ParentMap): Set<t.Node> {
    const out = new Set<t.Node>();
    let cur: t.Node | undefined = node;
    while (cur !== undefined) {
        out.add(cur);
        cur = parents.get(cur)?.parent;
    }
    return out;
}

function isReferenceContext(parent: t.Node, key: string): boolean {
    if (t.isVariableDeclarator(parent) && key === 'id') return false;
    if (t.isFunctionDeclaration(parent) && key === 'id') return false;
    if (t.isFunctionExpression(parent) && key === 'id') return false;
    if (t.isClassDeclaration(parent) && key === 'id') return false;
    if (t.isClassExpression(parent) && key === 'id') return false;
    if (t.isLabeledStatement(parent) && key === 'label') return false;
    if (t.isBreakStatement(parent) && key === 'label') return false;
    if (t.isContinueStatement(parent) && key === 'label') return false;
    if (t.isMemberExpression(parent) && key === 'property' && !parent.computed) return false;
    if (t.isObjectProperty(parent) && key === 'key' && !parent.computed) return false;
    if (t.isObjectMethod(parent) && key === 'key' && !parent.computed) return false;
    return true;
}

// ---------------------------------------------------------------------------
// locateDefExpr — pinpoint the exact AssignmentExpression / VariableDeclarator
// inside the def's cfg node that produced the def we're inlining.

type DefLoc =
    | { kind: 'var'; expr: t.VariableDeclarator; rhs: t.Expression; decl: t.VariableDeclaration }
    | { kind: 'assign'; expr: t.AssignmentExpression; rhs: t.Expression; topLevel: boolean };

function locateDefExpr(
    def: Definition,
    slot: number,
    table: LocalVariableTable,
    parents: ParentMap,
): DefLoc | null {
    let result: DefLoc | null = null;
    const visit = (n: t.Node, parent: t.Node | null) => {
        if (result !== null) return;
        if (parent !== null && isEnteringNewCfgNode(n, parent)) return;
        if (
            t.isVariableDeclarator(n) &&
            t.isIdentifier(n.id) &&
            table.resolve(n.id) === slot &&
            n.init
        ) {
            const declInfo = parents.get(n);
            if (declInfo && t.isVariableDeclaration(declInfo.parent)) {
                result = { kind: 'var', expr: n, rhs: n.init, decl: declInfo.parent };
                return;
            }
        }
        if (
            t.isAssignmentExpression(n) &&
            n.operator === '=' &&
            t.isIdentifier(n.left) &&
            table.resolve(n.left) === slot
        ) {
            // top-level iff parent is an ExpressionStatement (ignoring labels).
            let p: t.Node | null = parents.get(n)?.parent ?? null;
            while (p !== null && t.isLabeledStatement(p)) {
                p = parents.get(p)?.parent ?? null;
            }
            const topLevel = p !== null && t.isExpressionStatement(p);
            result = { kind: 'assign', expr: n, rhs: n.right, topLevel };
            return;
        }
        for (const key of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, key);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c) visit(c, n);
                }
            } else {
                visit(child, n);
            }
        }
    };
    visit(def.node, null);
    return result;
}

// ---------------------------------------------------------------------------
// isRhsSafeToInline — Closure's banned-shape list.

function isRhsSafeToInline(rhs: t.Node): boolean {
    let unsafe = false;
    const visit = (n: t.Node) => {
        if (unsafe) return;
        if (
            t.isMemberExpression(n) ||
            t.isOptionalMemberExpression(n) ||
            t.isClass(n) ||
            t.isArrayExpression(n) ||
            t.isObjectExpression(n) ||
            t.isRegExpLiteral(n) ||
            t.isNewExpression(n)
        ) {
            unsafe = true;
            return;
        }
        if (t.isFunction(n)) return; // don't recurse into nested functions
        for (const key of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, key);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c) visit(c);
                }
            } else {
                visit(child);
            }
        }
    };
    visit(rhs);
    return !unsafe;
}

// ---------------------------------------------------------------------------
// Side-effect checks within an expression tree.

function checkPostExpressions(
    n: t.Node,
    expressionRoot: t.Node,
    slotsToCheck: Set<number>,
    table: LocalVariableTable,
    parents: ParentMap,
): boolean {
    let cur: t.Node = n;
    while (cur !== expressionRoot) {
        for (const sib of rightSiblings(cur, parents)) {
            if (subtreeHasInterferingEffect(sib, slotsToCheck, table, parents)) return true;
        }
        const info = parents.get(cur);
        if (info === undefined) return false;
        cur = info.parent;
    }
    return false;
}

function checkPreExpressions(
    n: t.Node,
    expressionRoot: t.Node,
    slotsToCheck: Set<number>,
    table: LocalVariableTable,
    parents: ParentMap,
): boolean {
    let cur: t.Node = n;
    while (cur !== expressionRoot) {
        for (const sib of leftSiblings(cur, parents)) {
            if (subtreeHasInterferingEffect(sib, slotsToCheck, table, parents)) return true;
        }
        const info = parents.get(cur);
        if (info === undefined) return false;
        cur = info.parent;
    }
    return false;
}

function subtreeHasInterferingEffect(
    n: t.Node,
    slotsToCheck: Set<number>,
    table: LocalVariableTable,
    parents: ParentMap,
): boolean {
    let yes = false;
    const visit = (m: t.Node) => {
        if (yes) return;
        if (
            t.isCallExpression(m) ||
            t.isOptionalCallExpression(m) ||
            t.isNewExpression(m)
        ) {
            yes = true;
            return;
        }
        if (t.isAssignmentExpression(m) && t.isIdentifier(m.left)) {
            const s = table.resolve(m.left);
            if (s !== undefined && slotsToCheck.has(s)) {
                yes = true;
                return;
            }
        }
        if (t.isUpdateExpression(m) && t.isIdentifier(m.argument)) {
            const s = table.resolve(m.argument);
            if (s !== undefined && slotsToCheck.has(s)) {
                yes = true;
                return;
            }
        }
        if (t.isUnaryExpression(m) && m.operator === 'delete') {
            yes = true;
            return;
        }
        if (t.isFunction(m)) return;
        for (const key of t.VISITOR_KEYS[m.type] ?? []) {
            const child = getSlot(m, key);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c) visit(c);
                }
            } else {
                visit(child);
            }
        }
    };
    visit(n);
    void parents;
    return yes;
}

function nodeHasInterferingEffect(
    cfgValue: t.Node,
    slotsToCheck: Set<number>,
    table: LocalVariableTable,
    parents: ParentMap,
): boolean {
    return subtreeHasInterferingEffect(cfgValue, slotsToCheck, table, parents);
}

// ---------------------------------------------------------------------------
// Identifier-read traversal (used to find candidate uses).

function forEachIdentifierRead(
    root: t.Node,
    parents: ParentMap,
    visit: (id: t.Identifier) => void,
): void {
    const walk = (n: t.Node, parent: t.Node | null) => {
        if (parent !== null && isEnteringNewCfgNode(n, parent)) return;
        if (t.isIdentifier(n) && parent !== null && !isWriteContext(n, parent)) {
            visit(n);
            return;
        }
        for (const key of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, key);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c) walk(c, n);
                }
            } else {
                walk(child, n);
            }
        }
    };
    walk(root, null);
    void parents;
}

function isWriteContext(id: t.Identifier, parent: t.Node): boolean {
    if (t.isAssignmentExpression(parent) && parent.left === id) return true;
    if (t.isUpdateExpression(parent) && parent.argument === id) return true;
    if (t.isVariableDeclarator(parent) && parent.id === id) return true;
    if (t.isFunctionDeclaration(parent) && parent.id === id) return true;
    if (t.isFunctionExpression(parent) && parent.id === id) return true;
    if (t.isArrayPattern(parent) || t.isObjectPattern(parent)) return true;
    if (t.isRestElement(parent) && parent.argument === id) return true;
    if (t.isAssignmentPattern(parent) && parent.left === id) return true;
    if (t.isCatchClause(parent) && parent.param === id) return true;
    if (t.isLabeledStatement(parent) && parent.label === id) return true;
    if (t.isBreakStatement(parent) && parent.label === id) return true;
    if (t.isContinueStatement(parent) && parent.label === id) return true;
    if (t.isMemberExpression(parent) && parent.property === id && !parent.computed) return true;
    if (
        t.isOptionalMemberExpression(parent) &&
        parent.property === id &&
        !parent.computed
    ) return true;
    if (t.isObjectProperty(parent) && parent.key === id && !parent.computed) return true;
    return false;
}

function countSlotUsesInCfgNode(
    cfgValue: t.Node,
    slot: number,
    table: LocalVariableTable,
    parents: ParentMap,
): number {
    let count = 0;
    forEachIdentifierRead(cfgValue, parents, (id) => {
        if (table.resolve(id) === slot) count++;
    });
    return count;
}

// ---------------------------------------------------------------------------
// isWithinLoop

function isWithinLoop(node: t.Node, fn: t.Function, parents: ParentMap): boolean {
    let cur: t.Node | null = node;
    while (cur !== null && cur !== fn) {
        if (
            t.isWhileStatement(cur) ||
            t.isDoWhileStatement(cur) ||
            t.isForStatement(cur) ||
            t.isForInStatement(cur) ||
            t.isForOfStatement(cur)
        ) {
            return true;
        }
        cur = parents.get(cur)?.parent ?? null;
    }
    return false;
}

// ---------------------------------------------------------------------------
// areAdjacentSiblings — Closure's "skip path-check when def and use are
// immediate neighbors in the same statement list."

function areAdjacentSiblings(
    defNode: t.Node,
    useNode: t.Node,
    parents: ParentMap,
): boolean {
    const di = parents.get(defNode);
    const ui = parents.get(useNode);
    if (di === undefined || ui === undefined) return false;
    if (di.parent !== ui.parent) return false;
    if (di.index === undefined || ui.index === undefined) return false;
    return ui.index === di.index + 1;
}

// ---------------------------------------------------------------------------
// performInline

function performInline(c: Candidate, table: LocalVariableTable, parents: ParentMap): void {
    const loc = locateDefExpr(c.def, c.slot, table, parents);
    if (loc === null) return;
    const rhs = loc.rhs;

    // Replace the use with a clone of rhs (rhs may still be referenced from
    // the old def location until we drop it).
    const cloned = t.cloneNode(rhs, /* deep */ true);
    replaceInParent(c.use, cloned, parents);

    // Drop the def.
    if (loc.kind === 'assign') {
        const assignParent = parents.get(loc.expr);
        if (assignParent === undefined) return;
        // Top-level assign: parent chain is (Labeled*) → ExpressionStatement.
        let stmt: t.Node = assignParent.parent;
        while (t.isLabeledStatement(stmt)) {
            const sp = parents.get(stmt);
            if (sp === undefined) break;
            stmt = sp.parent;
        }
        // Locate the ExpressionStatement enclosing the assign and remove it.
        let toRemove: t.Node = loc.expr;
        let toRemoveInfo = parents.get(toRemove);
        while (toRemoveInfo !== undefined && !t.isExpressionStatement(toRemoveInfo.parent)) {
            toRemove = toRemoveInfo.parent;
            toRemoveInfo = parents.get(toRemove);
        }
        if (toRemoveInfo !== undefined && t.isExpressionStatement(toRemoveInfo.parent)) {
            removeFromParent(toRemoveInfo.parent, parents);
        }
    } else {
        // Closure FlowSensitiveInlineVariables.inlineVariable (NameDeclaration
        // branch): detach just the rhs, leaving the bare declarator `let x;`
        // in place so any subsequent reassignments still have a binding to
        // target. DAE + RemoveUnusedCode clean up the dead chain afterwards.
        // For const, no subsequent reassignments are possible by language
        // rule, so the whole declarator can be dropped without orphaning.
        const decl = loc.decl;
        if (decl.kind === 'const') {
            if (decl.declarations.length === 1) {
                removeFromParent(decl, parents);
            } else {
                const idx = decl.declarations.indexOf(loc.expr);
                if (idx >= 0) decl.declarations.splice(idx, 1);
            }
        } else {
            loc.expr.init = null;
        }
    }
}

// ---------------------------------------------------------------------------
// Parent map + AST mutation helpers.

type ParentInfo = {
    parent: t.Node;
    key: string;
    index: number | undefined;
};

type ParentMap = WeakMap<t.Node, ParentInfo>;

function buildParentMap(root: t.Node): ParentMap {
    const map: ParentMap = new WeakMap();
    const walk = (n: t.Node, parent: t.Node | null, key: string, index: number | undefined) => {
        if (parent !== null) map.set(n, { parent, key, index });
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c) walk(c, n, k, i);
                }
            } else {
                walk(child, n, k, undefined);
            }
        }
    };
    walk(root, null, '', undefined);
    return map;
}

function rightSiblings(n: t.Node, parents: ParentMap): t.Node[] {
    const info = parents.get(n);
    if (info === undefined) return [];
    if (info.index === undefined) return [];
    const arr = getSlot(info.parent, info.key) as (t.Node | null)[];
    return arr.slice(info.index + 1).filter((x): x is t.Node => x !== null);
}

function leftSiblings(n: t.Node, parents: ParentMap): t.Node[] {
    const info = parents.get(n);
    if (info === undefined) return [];
    if (info.index === undefined) return [];
    const arr = getSlot(info.parent, info.key) as (t.Node | null)[];
    return arr.slice(0, info.index).filter((x): x is t.Node => x !== null);
}

function replaceInParent(n: t.Node, replacement: t.Node, parents: ParentMap): void {
    const info = parents.get(n);
    if (info === undefined) return;
    const { parent, key, index } = info;
    setSlot(parent, key, index, replacement);
    parents.set(replacement, { parent, key, index });
}

function removeFromParent(n: t.Node, parents: ParentMap): void {
    const info = parents.get(n);
    if (info === undefined) return;
    const { parent, key, index } = info;
    if (index !== undefined) {
        const arr = getSlot(parent, key) as (t.Node | null)[];
        arr.splice(index, 1);
        for (let i = index; i < arr.length; i++) {
            const c = arr[i];
            if (c) parents.set(c, { parent, key, index: i });
        }
    } else {
        setSlot(parent, key, undefined, null);
    }
}

// MustDef is referenced via type-only import to keep it as a public type.
void undefined as unknown as MustDef;
