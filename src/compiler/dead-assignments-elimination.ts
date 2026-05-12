// Port of jscomp/DeadAssignmentsElimination.java
//
// Drops assignments to local variables whose value is never read afterward.
// Driven by LiveVariablesAnalysis: at the point AFTER an assignment to `x`,
// if `x` is not in the live-out set, the assignment is useless.
//
// We mutate the AST in place using a parent+key map (Babel doesn't carry
// parent pointers on raw nodes). Returns true if anything was removed.
//
// Differs from Closure:
//   - No `compiler.hasScopeChanged` filter — we always run.
//   - `containsFunction` bailout: any nested function in the body skips the
//     whole pass (closure capture). Closure does the same heuristic.
//   - Variable identity by binding-slot (table.resolve(idNode) → slot).
//   - For inc/dec (UpdateExpression) we only replace inside an ExprStatement
//     or a vanilla-for update slot; otherwise leave it alone (the value of
//     `x++` itself can be observed by an outer expression).

import * as t from '@babel/types';
import type { ControlFlowGraph } from './control-flow-graph';
import { isEnteringNewCfgNode } from './control-flow-graph';
import type { LinearFlowState } from './data-flow-analysis';
import type { LiveVariableLattice, LiveVariablesResult } from './live-variables-analysis';
import { isLive } from './live-variables-analysis';
import type { LocalVariableTable } from './local-variable-table';
import { getConditionExpression, getSlot, setSlot } from './node-util';

// ---------------------------------------------------------------------------
// Public entry

export type DeadAssignmentsResult = {
    /** Did the pass run? False if bailed (nested function, too many vars). */
    ran: boolean;
    /** How many assignments were rewritten. */
    removed: number;
};

export function eliminateDeadAssignments(
    fn: t.Function,
    cfg: ControlFlowGraph,
    live: LiveVariablesResult,
): DeadAssignmentsResult {
    if (!live.ran) return { ran: false, removed: 0 };

    // Closure bails the entire function if any inner function exists, because
    // a closure may capture and read locals after the apparent return.
    if (containsNestedFunction(fn)) return { ran: false, removed: 0 };

    const ctx: Ctx = {
        table: live.table,
        parents: buildParentMap(fn),
        removed: 0,
    };

    for (const cfgNode of cfg.nodes.values()) {
        if (cfgNode === cfg.implicitReturn) continue;
        const value = cfgNode.value;
        if (typeof value === 'symbol') continue;
        const state = cfgNode.annotation as LinearFlowState<LiveVariableLattice> | undefined;
        if (state === undefined) continue;

        const target = pickTarget(value);
        if (target === null) continue;
        tryRemoveAssignment(ctx, target, target, state);
    }

    return { ran: true, removed: ctx.removed };
}

// ---------------------------------------------------------------------------
// Internals

type ParentInfo = {
    parent: t.Node;
    key: string;
    /** Defined when the parent slot is an array. */
    index: number | undefined;
};

type ParentMap = WeakMap<t.Node, ParentInfo>;

type Ctx = {
    table: LocalVariableTable;
    parents: ParentMap;
    removed: number;
};

function pickTarget(n: t.Node): t.Node | null {
    // Mirrors Closure's switch in tryRemoveDeadAssignments — narrows the CFG
    // node down to the expression we should actually walk.
    if (t.isIfStatement(n) || t.isWhileStatement(n) || t.isDoWhileStatement(n)) {
        return n.test;
    }
    if (t.isForStatement(n)) {
        return n.test ?? null;
    }
    if (t.isForInStatement(n) || t.isForOfStatement(n)) {
        return null;
    }
    if (t.isSwitchStatement(n)) return n.discriminant;
    if (t.isSwitchCase(n)) return n.test ?? null;
    if (t.isReturnStatement(n)) return n.argument ?? null;
    if (t.isExpressionStatement(n)) return n.expression;
    if (t.isVariableDeclaration(n)) return n;
    return n;
}

// ---------------------------------------------------------------------------
// tryRemoveAssignment — recursively walks `n` looking for assignments that
// the liveness state proves are dead. `exprRoot` is the CFG node's root: the
// liveness state is correct at that boundary, so when we ask "is x still
// live within this sub-expression after we kill it here?" we walk siblings
// up to exprRoot.

function tryRemoveAssignment(ctx: Ctx, n: t.Node, exprRoot: t.Node, state: LinearFlowState<LiveVariableLattice>): void {
    if (t.isAssignmentExpression(n)) {
        if (t.isIdentifier(n.left)) {
            // Recurse into RHS first (handles `dead_x = dead_y = 1` → drop
            // `dead_y = 1` first, then `dead_x = ...`).
            tryRemoveAssignment(ctx, n.right, exprRoot, state);
            handleAssignment(ctx, n, exprRoot, state);
            return;
        }
        // Destructuring or member assign — descend into both sides.
        tryRemoveAssignment(ctx, n.left, exprRoot, state);
        tryRemoveAssignment(ctx, n.right, exprRoot, state);
        return;
    }

    if (t.isUpdateExpression(n) && t.isIdentifier(n.argument)) {
        handleUpdate(ctx, n, exprRoot, state);
        return;
    }

    if (t.isVariableDeclaration(n)) {
        // Declarations: walk declarators left-to-right but recurse into the
        // init first per declarator, mirroring Closure's right-to-left
        // multi-declarator behavior (`var a = e1, b = e2;` → process e2's
        // assignments before deciding about a).
        for (let i = n.declarations.length - 1; i >= 0; i--) {
            const d = n.declarations[i];
            if (d.init) {
                tryRemoveAssignment(ctx, d.init, exprRoot, state);
                handleVarInit(ctx, n, d, exprRoot, state);
            }
        }
        return;
    }

    // Default — walk children that don't enter a new CFG node.
    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, key);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c && !isEnteringNewCfgNode(c, n)) {
                    tryRemoveAssignment(ctx, c, exprRoot, state);
                }
            }
        } else if (!isEnteringNewCfgNode(child, n)) {
            tryRemoveAssignment(ctx, child, exprRoot, state);
        }
    }
}

// ---------------------------------------------------------------------------
// handleAssignment — `x = expr` or `x op= expr` where `x` is an Identifier.

function handleAssignment(
    ctx: Ctx,
    n: t.AssignmentExpression,
    exprRoot: t.Node,
    state: LinearFlowState<LiveVariableLattice>,
): void {
    const lhs = n.left as t.Identifier;
    const slot = ctx.table.resolve(lhs);
    if (slot === undefined) return;
    if (ctx.table.escaped.has(slot)) return;

    // Identity assign `a = a` — always remove.
    if (n.operator === '=' && t.isIdentifier(n.right) && n.right.name === lhs.name) {
        replaceInParent(ctx, n, n.right);
        ctx.removed++;
        return;
    }

    if (isLive(state.out, slot)) return;

    if (isLive(state.in, slot) && isVariableStillLiveWithinExpression(ctx, n, exprRoot, slot)) {
        // Live-in but live-out is false: this is the killing assignment, but
        // there's still a use to its right within the same expression. We
        // can't remove it without finer-grained analysis.
        return;
    }

    if (n.operator === '=') {
        replaceInParent(ctx, n, n.right);
    } else {
        // `x += rhs` → `x + rhs`. Drops the write but keeps the read+compute
        // (which may be observed by an outer expression).
        const op = n.operator.slice(0, -1) as t.BinaryExpression['operator'];
        const replacement = t.binaryExpression(op, lhs, n.right);
        replaceInParent(ctx, n, replacement);
    }
    ctx.removed++;
}

// ---------------------------------------------------------------------------
// handleUpdate — `x++` / `--x`.

function handleUpdate(ctx: Ctx, n: t.UpdateExpression, _exprRoot: t.Node, state: LinearFlowState<LiveVariableLattice>): void {
    const arg = n.argument as t.Identifier;
    const slot = ctx.table.resolve(arg);
    if (slot === undefined) return;
    if (ctx.table.escaped.has(slot)) return;
    if (isLive(state.out, slot)) return;

    const info = ctx.parents.get(n);
    if (info === undefined) return;
    const { parent } = info;

    if (t.isExpressionStatement(parent)) {
        // `x++;` → `void 0;` (Closure: same).
        replaceInParent(ctx, n, t.unaryExpression('void', t.numericLiteral(0)));
        ctx.removed++;
        return;
    }
    if (t.isForStatement(parent) && getConditionExpression(parent) !== n && parent.update === n) {
        // for(;; x++) — replace update with empty (drops it).
        // We can't insert a real "empty" so just null the slot.
        (parent as any).update = null;
        ctx.removed++;
        return;
    }
    // Otherwise the result of `x++` may be observed; leave it alone.
}

// ---------------------------------------------------------------------------
// handleVarInit — `var x = expr` (or let / const).

function handleVarInit(
    ctx: Ctx,
    decl: t.VariableDeclaration,
    d: t.VariableDeclarator,
    exprRoot: t.Node,
    state: LinearFlowState<LiveVariableLattice>,
): void {
    if (decl.kind === 'const') return; // removing init breaks AST validity.
    if (!t.isIdentifier(d.id)) return;
    if (d.init === null || d.init === undefined) return;

    const declParentInfo = ctx.parents.get(decl);
    if (declParentInfo && t.isForStatement(declParentInfo.parent)) {
        // `for (var x = init; ...)` — no safe place to put the side-effects.
        return;
    }
    if (declParentInfo && (t.isForInStatement(declParentInfo.parent) || t.isForOfStatement(declParentInfo.parent))) {
        return;
    }

    const slot = ctx.table.resolve(d.id);
    if (slot === undefined) return;
    if (ctx.table.escaped.has(slot)) return;

    // Identity init `var a = a;` is meaningless and rare; treat as standard
    // assignment.
    if (t.isIdentifier(d.init) && ctx.table.resolve(d.init) === slot) {
        d.init = null;
        ctx.removed++;
        return;
    }

    if (isLive(state.out, slot)) return;
    if (isLive(state.in, slot) && isVariableStillLiveWithinExpression(ctx, decl, exprRoot, slot)) {
        return;
    }

    // Dead init. Closure hoists the RHS into a sibling ExpressionStatement so
    // any side-effects still run. We do the same: insert `expr;` after `decl`
    // and null the init.
    const init = d.init;
    d.init = null;
    insertAfter(ctx, decl, t.expressionStatement(init));
    ctx.removed++;
}

// ---------------------------------------------------------------------------
// isVariableStillLiveWithinExpression — left-to-right walk over ancestors of
// `n` up to `exprRoot`, asking "is there a READ of `variable` to the right
// of n before any KILL?". Direct port of Closure's algorithm.

enum VLive {
    MAYBE_LIVE = 0,
    READ = 1,
    KILL = 2,
}

function isVariableStillLiveWithinExpression(ctx: Ctx, n: t.Node, exprRoot: t.Node, slot: number): boolean {
    let cur: t.Node = n;
    while (cur !== exprRoot) {
        const info = ctx.parents.get(cur);
        if (info === undefined) return false;
        const parent = info.parent;

        let state: VLive = VLive.MAYBE_LIVE;

        if (t.isLogicalExpression(parent)) {
            // OR / AND / ??: only the second operand depends on the first.
            if (cur === parent.left) {
                state = isVariableReadBeforeKill(parent.right, slot, ctx);
                if (state === VLive.KILL) state = VLive.MAYBE_LIVE;
            }
        } else if (t.isConditionalExpression(parent)) {
            if (cur === parent.test) {
                state = checkHookBranchReadBeforeKill(parent.consequent, parent.alternate, slot, ctx);
            }
            // If cur is consequent or alternate, the other branch can be
            // ignored; siblings don't apply.
        } else {
            for (const sibling of rightSiblings(parent, cur)) {
                state = isVariableReadBeforeKill(sibling, slot, ctx);
                if (state !== VLive.MAYBE_LIVE) break;
            }
        }

        if (state === VLive.READ) return true;
        if (state === VLive.KILL) return false;
        cur = parent;
    }
    return false;
}

function isVariableReadBeforeKill(n: t.Node, slot: number, ctx: Ctx): VLive {
    if (isEnteringNewCfgNode(n, parentOfChild(n))) return VLive.MAYBE_LIVE;

    if (t.isIdentifier(n) && ctx.table.resolve(n) === slot) {
        // Conservative: treat every identifier read as READ. Closure
        // distinguishes simple-assign LHS (then evaluates RHS first to
        // detect a still-live read inside the RHS), but conservative is
        // safe here.
        return VLive.READ;
    }

    if (t.isLogicalExpression(n)) {
        const v1 = isVariableReadBeforeKill(n.left, slot, ctx);
        const v2 = isVariableReadBeforeKill(n.right, slot, ctx);
        if (v1 !== VLive.MAYBE_LIVE) return v1;
        if (v2 === VLive.READ) return VLive.READ;
        return VLive.MAYBE_LIVE;
    }

    if (t.isConditionalExpression(n)) {
        const first = isVariableReadBeforeKill(n.test, slot, ctx);
        if (first !== VLive.MAYBE_LIVE) return first;
        return checkHookBranchReadBeforeKill(n.consequent, n.alternate, slot, ctx);
    }

    for (const key of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, key);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (!c) continue;
                const r = isVariableReadBeforeKill(c, slot, ctx);
                if (r !== VLive.MAYBE_LIVE) return r;
            }
        } else {
            const r = isVariableReadBeforeKill(child, slot, ctx);
            if (r !== VLive.MAYBE_LIVE) return r;
        }
    }
    return VLive.MAYBE_LIVE;
}

function checkHookBranchReadBeforeKill(a: t.Node, b: t.Node, slot: number, ctx: Ctx): VLive {
    const v1 = isVariableReadBeforeKill(a, slot, ctx);
    const v2 = isVariableReadBeforeKill(b, slot, ctx);
    if (v1 === VLive.READ || v2 === VLive.READ) return VLive.READ;
    if (v1 === VLive.KILL && v2 === VLive.KILL) return VLive.KILL;
    return VLive.MAYBE_LIVE;
}

function parentOfChild(_n: t.Node): t.Node | null {
    // Used by isEnteringNewCfgNode in the read-before-kill walk; we don't
    // carry parent info into that recursion (the caller is walking expression
    // sub-trees freshly), so pass null and rely on isEnteringNewCfgNode's
    // null-parent fast path. Effect: we never *enter* a new CFG node from a
    // Function child here because Functions are caught explicitly by
    // VISITOR_KEYS recursion that we deliberately don't make.
    return null;
}

// ---------------------------------------------------------------------------
// AST mutation helpers

function rightSiblings(parent: t.Node, after: t.Node): t.Node[] {
    const out: t.Node[] = [];
    let seen = false;
    for (const key of t.VISITOR_KEYS[parent.type] ?? []) {
        const child = getSlot(parent, key);
        if (Array.isArray(child)) {
            for (const c of child) {
                if (!seen) {
                    if (c === after) seen = true;
                    continue;
                }
                if (c) out.push(c);
            }
        } else if (child === after) {
            seen = true;
        } else if (seen && child) {
            out.push(child);
        }
    }
    return out;
}

function replaceInParent(ctx: Ctx, n: t.Node, replacement: t.Node): void {
    const info = ctx.parents.get(n);
    if (info === undefined) return;
    const { parent, key, index } = info;
    setSlot(parent, key, index, replacement);
    // Re-parent the replacement and any of its descendants we might revisit.
    populateParents(replacement, parent, key, index, ctx.parents);
}

function insertAfter(ctx: Ctx, anchor: t.Node, inserted: t.Node): void {
    const info = ctx.parents.get(anchor);
    if (info === undefined) return;
    const { parent, key, index } = info;
    if (index === undefined) return; // anchor isn't in an array — can't insert sibling.
    const arr = getSlot(parent, key) as t.Node[];
    arr.splice(index + 1, 0, inserted);
    // Update parent map for shifted siblings.
    for (let i = index + 1; i < arr.length; i++) {
        ctx.parents.set(arr[i], { parent, key, index: i });
    }
    populateParents(inserted, parent, key, index + 1, ctx.parents);
}

// ---------------------------------------------------------------------------
// Parent map

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

function populateParents(n: t.Node, parent: t.Node, key: string, index: number | undefined, map: ParentMap): void {
    map.set(n, { parent, key, index });
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, k);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c) populateParents(c, n, k, i, map);
            }
        } else {
            populateParents(child, n, k, undefined, map);
        }
    }
}

// ---------------------------------------------------------------------------
// containsNestedFunction — Closure's bailout.

function containsNestedFunction(fn: t.Function): boolean {
    return t.traverseFast(fn.body, (n) => {
        if (t.isFunction(n)) return t.traverseFast.stop;
        return undefined;
    });
}
