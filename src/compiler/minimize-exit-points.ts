// Port of jscomp/MinimizeExitPoints.java.
//
// Transforms the AST so that explicit exits (return / break / continue) are
// replaced by implicit fall-through where possible. Most useful in shape:
//
//   _label: {
//     if (cond) { ...A; break _label; }
//     ...B;
//   }
//
// becomes
//
//   _label: {
//     if (cond) { ...A; }
//     else { ...B; }
//   }
//
// which then composes with PeepholeMinimizeConditions to collapse if/else
// into a ternary, and with PeepholeRemoveDeadCode to drop the labeled
// wrapper. This is exactly the residue our BLOCK-inliner emits, so the two
// passes together start chipping at the `_compilecat_inline_result` shape.
//
// Bails on: try/finally (we leave its exit semantics alone — see ECMA 12.14).
// We don't have isASTNormalized() — Closure uses it to gate switch-exit
// minimization; we behave as "normalized" since our pipeline runs after
// inline + simplification.

import * as t from '@babel/types';

import { getSideEffectFreeBooleanValue } from './ast-analyzer';
import { getSlot } from './node-util';
import { TRI_FALSE } from './tri';

export type ExitPointsResult = {
    minimized: number;
};

/**
 * Operates on any AST root (Program, File, Function body — anything). We use
 * a manual walker rather than @babel/traverse to avoid the scope/parentPath
 * requirement when invoked on a non-Program subtree (the simplifier passes
 * a function body here).
 */
export function runMinimizeExitPoints(root: t.Node): ExitPointsResult {
    const ctx: Ctx = { minimized: 0 };
    walk(root, ctx);
    return { minimized: ctx.minimized };
}

function walk(n: t.Node, ctx: Ctx): void {
    // Visit children first (bottom-up).
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, k);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c) walk(c, ctx);
            }
        } else {
            walk(child, ctx);
        }
    }

    // Per-node entry points mirror Closure's optimizeSubtree switch.
    if (t.isLabeledStatement(n)) {
        tryMinimizeExits(n.body, 'break', n.label.name, ctx);
        return;
    }
    if (
        t.isWhileStatement(n) ||
        t.isForStatement(n) ||
        t.isForInStatement(n) ||
        t.isForOfStatement(n)
    ) {
        tryMinimizeExits(n.body, 'continue', null, ctx);
        return;
    }
    if (t.isDoWhileStatement(n)) {
        tryMinimizeExits(n.body, 'continue', null, ctx);
        if (getSideEffectFreeBooleanValue(n.test) === TRI_FALSE) {
            tryMinimizeExits(n.body, 'break', null, ctx);
        }
        return;
    }
    if (t.isFunction(n)) {
        const body = n.body;
        if (t.isBlockStatement(body)) tryMinimizeExits(body, 'return', null, ctx);
        return;
    }
}

type Ctx = { minimized: number };

type ExitKind = 'break' | 'continue' | 'return';

// ---------------------------------------------------------------------------
// Core: identify trailing exits and convert them to implicit fall-through.

function tryMinimizeExits(
    n: t.Statement,
    exitType: ExitKind,
    labelName: string | null,
    ctx: Ctx,
): void {
    // Direct match: the node itself is an exit of the right kind.
    if (matchingExitNode(n, exitType, labelName)) {
        // Remove it from its parent. The caller (block iteration) handles
        // removal when this is invoked on a child of a block.
        return;
    }

    if (t.isIfStatement(n)) {
        tryMinimizeExits(n.consequent, exitType, labelName, ctx);
        if (n.alternate) tryMinimizeExits(n.alternate, exitType, labelName, ctx);
        return;
    }

    if (t.isTryStatement(n)) {
        tryMinimizeExits(n.block, exitType, labelName, ctx);
        if (n.handler) tryMinimizeExits(n.handler.body, exitType, labelName, ctx);
        // Don't touch finalizer.
        return;
    }

    if (t.isLabeledStatement(n)) {
        tryMinimizeExits(n.body, exitType, labelName, ctx);
        return;
    }

    if (t.isSwitchStatement(n) && (exitType !== 'break' || labelName !== null)) {
        tryMinimizeSwitchExits(n, exitType, labelName, ctx);
        return;
    }

    if (!t.isBlockStatement(n) || n.body.length === 0) return;

    // Multi-if pass: for each if(...) child, try to hoist trailing exits out
    // of its branches by moving the if's siblings into the opposite branch.
    for (let i = 0; i < n.body.length; i++) {
        const c = n.body[i];
        if (t.isIfStatement(c)) {
            tryMinimizeIfBlockExits(n, i, c, true, exitType, labelName, ctx);
            // The if may have changed structure; re-fetch the alternate.
            const cur = n.body[i] as t.IfStatement;
            if (cur.alternate) {
                tryMinimizeIfBlockExits(n, i, cur, false, exitType, labelName, ctx);
            }
        }
        if (i === n.body.length - 1) break;
    }

    // Last-child pass: recurse into the tail; if it shrinks/changes, look at
    // what's now the tail and try again.
    while (n.body.length > 0) {
        const last = n.body[n.body.length - 1];
        const before = n.body.length;
        if (matchingExitNode(last, exitType, labelName)) {
            n.body.pop();
            ctx.minimized++;
            continue;
        }
        tryMinimizeExits(last, exitType, labelName, ctx);
        if (n.body.length === before && n.body[n.body.length - 1] === last) break;
    }
}

function tryMinimizeSwitchExits(
    n: t.SwitchStatement,
    exitType: ExitKind,
    labelName: string | null,
    ctx: Ctx,
): void {
    for (let i = 0; i < n.cases.length; i++) {
        const c = n.cases[i];
        if (i !== n.cases.length - 1) {
            tryMinimizeSwitchCaseExits(c, exitType, labelName, ctx);
        } else {
            // Last case: aggressive — recurse into its block content.
            for (const stmt of c.consequent) tryMinimizeExits(stmt, exitType, labelName, ctx);
        }
    }
}

function tryMinimizeSwitchCaseExits(
    c: t.SwitchCase,
    exitType: ExitKind,
    labelName: string | null,
    ctx: Ctx,
): void {
    const body = c.consequent;
    const last = body[body.length - 1];
    if (!t.isBreakStatement(last) || last.label !== null) return;
    // Recurse on the statement just before the trailing break.
    let idx = body.length - 2;
    while (idx >= 0) {
        const stmt = body[idx];
        if (matchingExitNode(stmt, exitType, labelName)) {
            body.splice(idx, 1);
            ctx.minimized++;
            idx = body.length - 2;
            continue;
        }
        tryMinimizeExits(stmt, exitType, labelName, ctx);
        idx--;
    }
}

// ---------------------------------------------------------------------------
// If-block-exit hoisting.
//
// When an if-branch ends in a matching exit, the if's following siblings can
// be moved into the opposite branch. After this transform, the matching exit
// becomes redundant and the trailing pass drops it.

function tryMinimizeIfBlockExits(
    parentBlock: t.BlockStatement,
    ifIndex: number,
    ifNode: t.IfStatement,
    workingOnConsequent: boolean,
    exitType: ExitKind,
    labelName: string | null,
    ctx: Ctx,
): void {
    const srcBlock = workingOnConsequent ? ifNode.consequent : ifNode.alternate;
    if (srcBlock === null || srcBlock === undefined) return;
    const destBlock = workingOnConsequent ? ifNode.alternate ?? null : ifNode.consequent;

    let exitNode: t.Statement | null = null;
    let removeFromBlock: t.BlockStatement | null = null;

    if (t.isBlockStatement(srcBlock)) {
        if (srcBlock.body.length === 0) return;
        const cand = srcBlock.body[srcBlock.body.length - 1];
        if (!matchingExitNode(cand, exitType, labelName)) return;
        exitNode = cand;
        removeFromBlock = srcBlock;
    } else {
        if (!matchingExitNode(srcBlock, exitType, labelName)) return;
        exitNode = srcBlock;
    }

    // Deliberate deviation from Closure: Closure converts following-sibling
    // `let`/`const` to `var` here (keyword-homogeneity for its own emit; it
    // emits `var` everywhere). We don't. All references to those decls move
    // *into the new block together with the decl itself* (the splice below
    // takes every sibling from ifIndex+1 to end), so block-scoping is
    // preserved and the `let`/`const` semantics are unchanged. Keeping them
    // also avoids degrading the readability of compilecat's intermediate
    // output (this pass would otherwise sneak `var` back in even though we
    // dropped OptimizeLetAndConstPeephole).
    if (parentBlock.body.length - 1 - ifIndex === 0) return;

    // Determine the new destination block content.
    const moving = parentBlock.body.splice(ifIndex + 1);

    // The exit we matched can now be removed (redundant — falls into the
    // implicit exit of the enclosing structure).
    if (removeFromBlock !== null && exitNode !== null) {
        const idx = removeFromBlock.body.indexOf(exitNode);
        if (idx >= 0) removeFromBlock.body.splice(idx, 1);
    } else if (workingOnConsequent) {
        // srcBlock was a single statement; replace with an empty block.
        ifNode.consequent = t.blockStatement([]);
    } else {
        ifNode.alternate = t.blockStatement([]);
    }

    if (workingOnConsequent) {
        // Move siblings into alternate.
        if (destBlock === null) {
            ifNode.alternate = t.blockStatement(moving);
        } else if (t.isBlockStatement(destBlock)) {
            destBlock.body.push(...moving);
        } else {
            ifNode.alternate = t.blockStatement([destBlock, ...moving]);
        }
    } else {
        if (destBlock === null) {
            // Shouldn't happen — destBlock is consequent which always exists.
            ifNode.consequent = t.blockStatement(moving);
        } else if (t.isBlockStatement(destBlock)) {
            destBlock.body.push(...moving);
        } else {
            ifNode.consequent = t.blockStatement([destBlock, ...moving]);
        }
    }
    ctx.minimized++;
}

// ---------------------------------------------------------------------------
// Predicates.

function matchingExitNode(n: t.Node, type: ExitKind, labelName: string | null): boolean {
    if (type === 'return') {
        return (
            t.isReturnStatement(n) &&
            (n.argument === null || n.argument === undefined)
        );
    }
    if (type === 'break') {
        if (!t.isBreakStatement(n)) return false;
        if (labelName === null) return n.label === null;
        return !!n.label && n.label.name === labelName;
    }
    if (type === 'continue') {
        if (!t.isContinueStatement(n)) return false;
        if (labelName === null) return n.label === null;
        return !!n.label && n.label.name === labelName;
    }
    return false;
}

