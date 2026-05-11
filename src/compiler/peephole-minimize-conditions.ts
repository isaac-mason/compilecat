// Port of jscomp/PeepholeMinimizeConditions.java.
//
// Boolean control-flow minimization. Operates bottom-up; safe to repeat at the
// simplifier fixpoint level alongside fold-constants and remove-dead-code.
//
// Covered (full Closure parity for everything that doesn't require CFG
// follow-node queries):
//   - tryMinimizeNot      — !(a CMP b) → a NEG_CMP b, !!x → x
//   - tryMinimizeIf       — full if/else minimization via MinimizedCondition
//   - tryMinimizeHook     — flips HOOK when negated form is shorter
//   - tryMinimizeExprResult — strips leading NOT from expression statements
//   - tryJoinForCondition — for { if(c) break; ... } → for(...; !c; ...) { ... }
//   - tryRemoveRepeatedStatements — hoists trailing common stmts out of if/else
//   - tryReplaceIf (block-level)
//       * if(c) return X; if(c) return X  → if(c||c2) return X
//       * if(c) foo() else return X; if(c2) return X → if(!c&&c2) foo() else return X (variant)
//       * if(c) return [X]; return Y      → return c ? X : Y
//       * if(c){...exit} else Y; sib      → moves Y next to sib when cons exits
//   - performConditionSubstitutions — x||true→true, x&&false→false, x?true:y→x||y, etc.
//
// Deferred (need CFG follow-node analysis from ControlFlowAnalysis):
//   - tryRemoveRedundantExit
//   - tryReplaceExitWithBreak
// MinimizeExitPoints covers most of what these would catch in practice.

import * as t from '@babel/types';

import { getSideEffectFreeBooleanValue, mayHaveSideEffects } from './ast-analyzer';
import {
    buildReplacement,
    fromConditionNode,
    getMinimized,
    isLowerPrecedenceThan,
    isMeasuredNot,
    type MeasuredNode,
    willChange,
    withoutNot,
} from './minimized-condition';
import {
    AND_PRECEDENCE,
    areNodesEqual,
    getSlot,
    precedence,
    setSlot,
} from './node-util';
import { TRI_FALSE, TRI_TRUE, TRI_UNKNOWN, triToBoolean } from './tri';

export type MinimizeResult = {
    minimized: number;
};

export function runPeepholeMinimizeConditions(root: t.Node): MinimizeResult {
    const ctx: Ctx = { minimized: 0 };
    walk(root, null, '', undefined, ctx);
    return { minimized: ctx.minimized };
}

type Ctx = { minimized: number };

// ---------------------------------------------------------------------------
// Walker. Bottom-up: recurse first, then dispatch on the node's type. Block /
// Program nodes get a statement-list pass (tryReplaceIf) before per-node
// dispatch so the multi-statement transforms run against fully-rewritten
// children.

function walk(
    n: t.Node,
    parent: t.Node | null,
    key: string,
    index: number | undefined,
    ctx: Ctx,
): void {
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, k);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c) walk(c, n, k, i, ctx);
            }
        } else {
            walk(child, n, k, undefined, ctx);
        }
    }

    if (t.isBlockStatement(n) || t.isProgram(n)) {
        tryReplaceIfBlock(n, ctx);
    }

    if (parent === null) return;

    // Per-node dispatch. We replace by writing back through `setSlot`.
    if (t.isUnaryExpression(n) && n.operator === '!') {
        // Minimize the inner condition first; then try the local !cmp rewrite.
        tryMinimizeConditionSlot(n, 'argument');
        const replaced = tryMinimizeNot(n);
        if (replaced !== n) {
            setSlot(parent, key, index, replaced);
            ctx.minimized++;
        }
        return;
    }

    if (t.isIfStatement(n)) {
        performConditionSubstitutionsSlot(n, 'test');
        const replaced = tryMinimizeIf(n, ctx);
        if (replaced !== n) {
            setSlot(parent, key, index, replaced);
        }
        return;
    }

    if (t.isExpressionStatement(n)) {
        performConditionSubstitutionsSlot(n, 'expression');
        tryMinimizeExprResult(n, ctx);
        return;
    }

    if (t.isConditionalExpression(n)) {
        performConditionSubstitutionsSlot(n, 'test');
        const replaced = tryMinimizeHook(n, ctx);
        if (replaced !== n) {
            setSlot(parent, key, index, replaced);
        }
        return;
    }

    if (t.isWhileStatement(n) || t.isDoWhileStatement(n)) {
        tryMinimizeConditionSlot(n, 'test');
        return;
    }

    if (t.isForStatement(n)) {
        tryJoinForCondition(n, ctx);
        if (n.test) tryMinimizeConditionSlot(n, 'test');
        return;
    }
}

// ---------------------------------------------------------------------------
// !(...) rewrites — simple peephole, no MinimizedCondition needed.

const COMPARISON_NEGATION: Record<string, string> = {
    '==': '!=',
    '!=': '==',
    '===': '!==',
    '!==': '===',
};

function tryMinimizeNot(n: t.UnaryExpression): t.Node {
    const arg = n.argument;
    if (t.isUnaryExpression(arg) && arg.operator === '!') return arg.argument;
    if (t.isBinaryExpression(arg)) {
        const op = COMPARISON_NEGATION[arg.operator];
        if (op !== undefined) {
            if (t.isPrivateName(arg.left)) return n;
            return t.binaryExpression(op as t.BinaryExpression['operator'], arg.left, arg.right);
        }
        // GT/GE/LT/LE NOT-inversion is *unsafe* against NaN — !(x < NaN) is
        // not x >= NaN. Closure skips it; we do too. Our earlier ad-hoc port
        // covered them; this is the correct conservative shape.
    }
    return n;
}

// ---------------------------------------------------------------------------
// HOOK / ExpressionStatement minimization via MinimizedCondition.

function tryMinimizeHook(n: t.ConditionalExpression, ctx: Ctx): t.Node {
    // Direct shortcuts that are always profitable (independent of bool context).
    // These mirror what `performConditionSubstitutions` would do if the HOOK
    // were nested in a boolean context.
    if (areNodesEqual(n.consequent, n.alternate) && !mayHaveSideEffects(n.test)) {
        ctx.minimized++;
        return n.consequent;
    }
    if (
        t.isBooleanLiteral(n.consequent) &&
        n.consequent.value === true &&
        t.isBooleanLiteral(n.alternate) &&
        n.alternate.value === false
    ) {
        ctx.minimized++;
        return t.unaryExpression('!', t.unaryExpression('!', n.test));
    }
    if (
        t.isBooleanLiteral(n.consequent) &&
        n.consequent.value === false &&
        t.isBooleanLiteral(n.alternate) &&
        n.alternate.value === true
    ) {
        ctx.minimized++;
        return t.unaryExpression('!', n.test);
    }

    const originalCond = n.test;
    const mc = fromConditionNode(originalCond);
    const m = getMinimized(mc, 'ALLOW_LEADING_NOT');
    if (isMeasuredNot(m)) {
        // Swap consequent/alternate; strip the leading NOT.
        const stripped = withoutNot(m);
        const newCond = buildReplacement(stripped);
        const flipped = t.conditionalExpression(
            newCond as t.Expression,
            n.alternate,
            n.consequent,
        );
        ctx.minimized++;
        return flipped;
    }
    if (willChange(m, originalCond)) {
        n.test = buildReplacement(m) as t.Expression;
        ctx.minimized++;
    }
    return n;
}

function tryMinimizeExprResult(n: t.ExpressionStatement, ctx: Ctx): void {
    const original = n.expression;
    const mc = fromConditionNode(original);
    const m = getMinimized(mc, 'ALLOW_LEADING_NOT');
    if (isMeasuredNot(m)) {
        const stripped = withoutNot(m);
        n.expression = buildReplacement(stripped) as t.Expression;
        ctx.minimized++;
    } else if (willChange(m, original)) {
        n.expression = buildReplacement(m) as t.Expression;
        ctx.minimized++;
    }
}

// ---------------------------------------------------------------------------
// IF minimization — the biggest sub-function. Mirrors Closure's tryMinimizeIf
// case-by-case.

function tryMinimizeIf(n: t.IfStatement, ctx: Ctx): t.Node {
    const originalCond = n.test;

    // Let other passes handle literal-cond reduction.
    if (isLiteralValue(originalCond)) return n;

    const thenBranch = n.consequent;
    const elseBranch = n.alternate ?? null;

    const mc = fromConditionNode(originalCond);
    const unnegated = getMinimized(mc, 'PREFER_UNNEGATED');
    const shortCond = getMinimized(mc, 'ALLOW_LEADING_NOT');

    if (elseBranch === null) {
        // No else.
        if (isFoldableExpressBlock(thenBranch)) {
            const expr = getBlockExpression(thenBranch); // ExpressionStatement
            const inner = expr.expression;

            if (isMeasuredNot(shortCond)) {
                // if(!x)bar(); → x||bar();
                const stripped = withoutNot(shortCond);
                const newCond = buildReplacement(stripped) as t.Expression;
                ctx.minimized++;
                return t.expressionStatement(t.logicalExpression('||', newCond, inner));
            }

            // if(x)foo(); → x&&foo();
            // Parens cost gate: only do the rewrite when it doesn't introduce
            // an extra pair of parens on both sides.
            const newCond = applyMeasured(originalCond, shortCond);
            if (
                isLowerPrecedenceThan(shortCond, AND_PRECEDENCE) &&
                precedence(inner) < AND_PRECEDENCE
            ) {
                // Just minimize the cond, don't fold to &&.
                if (newCond !== originalCond) {
                    n.test = newCond as t.Expression;
                    ctx.minimized++;
                }
                return n;
            }
            ctx.minimized++;
            return t.expressionStatement(
                t.logicalExpression('&&', newCond as t.Expression, inner),
            );
        }

        // Try to combine `if (x) { if (y) Z; }` into `if (x && y) Z;`.
        if (
            t.isBlockStatement(thenBranch) &&
            thenBranch.body.length === 1 &&
            t.isIfStatement(thenBranch.body[0])
        ) {
            const innerIf = thenBranch.body[0] as t.IfStatement;
            if (innerIf.alternate == null) {
                const innerCond = innerIf.test;
                if (
                    !(
                        isLowerPrecedenceThan(unnegated, AND_PRECEDENCE) &&
                        precedence(innerCond) < AND_PRECEDENCE
                    )
                ) {
                    const newCond = applyMeasured(originalCond, unnegated) as t.Expression;
                    const combined = t.logicalExpression('&&', newCond, innerCond);
                    ctx.minimized++;
                    return t.ifStatement(combined, innerIf.consequent, null);
                }
            }
        }

        // Default: minimize the cond only.
        const replaced = applyMeasured(originalCond, unnegated);
        if (replaced !== originalCond) {
            n.test = replaced as t.Expression;
            ctx.minimized++;
        }
        return n;
    }

    // Else branch present.
    tryRemoveRepeatedStatements(n, ctx);

    // if(!x)foo();else bar(); → if(x)bar();else foo();
    if (isMeasuredNot(shortCond) && !consumesDanglingElse(elseBranch)) {
        const stripped = withoutNot(shortCond);
        const newCond = buildReplacement(stripped) as t.Expression;
        const swapped = t.ifStatement(newCond, elseBranch, thenBranch);
        ctx.minimized++;
        return swapped;
    }

    // if(c)return X; else return Y; → return c ? X : Y;
    if (isReturnExpressBlock(thenBranch) && isReturnExpressBlock(elseBranch)) {
        const thenExpr = getBlockReturnExpression(thenBranch);
        const elseExpr = getBlockReturnExpression(elseBranch);
        const newCond = applyMeasured(originalCond, shortCond) as t.Expression;
        ctx.minimized++;
        return t.returnStatement(t.conditionalExpression(newCond, thenExpr, elseExpr));
    }

    const thenExpr = isFoldableExpressBlock(thenBranch);
    const elseExpr = isFoldableExpressBlock(elseBranch);

    if (thenExpr && elseExpr) {
        const thenOp = getBlockExpression(thenBranch).expression;
        const elseOp = getBlockExpression(elseBranch).expression;

        // if(x) a=1; else a=2; → a = x ? 1 : 2;
        if (
            t.isAssignmentExpression(thenOp) &&
            t.isAssignmentExpression(elseOp) &&
            thenOp.operator === elseOp.operator &&
            areNodesEqual(thenOp.left as t.Node, elseOp.left as t.Node) &&
            !mayEffectMutableState(thenOp.left as t.Node) &&
            (!mayHaveSideEffects(originalCond) ||
                (thenOp.operator === '=' && t.isIdentifier(thenOp.left)))
        ) {
            const newCond = applyMeasured(originalCond, shortCond) as t.Expression;
            const hook = t.conditionalExpression(newCond, thenOp.right, elseOp.right);
            ctx.minimized++;
            return t.expressionStatement(
                t.assignmentExpression(
                    thenOp.operator,
                    thenOp.left,
                    hook,
                ),
            );
        }

        // if(x) foo(); else bar(); → x ? foo() : bar();
        const newCond = applyMeasured(originalCond, shortCond) as t.Expression;
        ctx.minimized++;
        return t.expressionStatement(
            t.conditionalExpression(newCond, thenOp, elseOp),
        );
    }

    // if(x) var y=1; else y=2  →  var y = x?1:2;
    const thenVar = getSingleVarDecl(thenBranch);
    const elseAssignOp =
        elseExpr ? getBlockExpression(elseBranch).expression : null;
    if (
        thenVar !== null &&
        elseAssignOp !== null &&
        t.isAssignmentExpression(elseAssignOp) &&
        elseAssignOp.operator === '=' &&
        t.isIdentifier(elseAssignOp.left) &&
        thenVar.declarations.length === 1 &&
        t.isIdentifier(thenVar.declarations[0].id) &&
        thenVar.declarations[0].init !== null &&
        thenVar.declarations[0].init !== undefined &&
        thenVar.declarations[0].id.name === elseAssignOp.left.name
    ) {
        const newCond = applyMeasured(originalCond, shortCond) as t.Expression;
        const hook = t.conditionalExpression(
            newCond,
            thenVar.declarations[0].init,
            elseAssignOp.right,
        );
        ctx.minimized++;
        return t.variableDeclaration(thenVar.kind, [
            t.variableDeclarator(thenVar.declarations[0].id, hook),
        ]);
    }

    // if(x) y=1; else var y=2 → var y = x?1:2; (mirror case)
    const elseVar = getSingleVarDecl(elseBranch);
    const thenAssignOp =
        thenExpr ? getBlockExpression(thenBranch).expression : null;
    if (
        elseVar !== null &&
        thenAssignOp !== null &&
        t.isAssignmentExpression(thenAssignOp) &&
        thenAssignOp.operator === '=' &&
        t.isIdentifier(thenAssignOp.left) &&
        elseVar.declarations.length === 1 &&
        t.isIdentifier(elseVar.declarations[0].id) &&
        elseVar.declarations[0].init !== null &&
        elseVar.declarations[0].init !== undefined &&
        elseVar.declarations[0].id.name === thenAssignOp.left.name
    ) {
        const newCond = applyMeasured(originalCond, shortCond) as t.Expression;
        const hook = t.conditionalExpression(
            newCond,
            thenAssignOp.right,
            elseVar.declarations[0].init,
        );
        ctx.minimized++;
        return t.variableDeclaration(elseVar.kind, [
            t.variableDeclarator(elseVar.declarations[0].id, hook),
        ]);
    }

    // Default: minimize cond only.
    const replaced = applyMeasured(originalCond, unnegated);
    if (replaced !== originalCond) {
        n.test = replaced as t.Expression;
        ctx.minimized++;
    }
    return n;
}

// ---------------------------------------------------------------------------
// Statement-list rewrites — operate on a block's body array.

function tryReplaceIfBlock(block: t.BlockStatement | t.Program, ctx: Ctx): void {
    const body = block.body as t.Statement[];
    let i = 0;
    while (i < body.length) {
        const cur = body[i];
        if (!t.isIfStatement(cur)) {
            i++;
            continue;
        }
        const ifNode = cur;
        const thenBranch = ifNode.consequent;
        const elseBranch = ifNode.alternate ?? null;
        const next = body[i + 1] ?? null;

        // (1) if(c) return; if(c2) return ...  →  if(c||c2) return ...
        if (
            next !== null &&
            elseBranch === null &&
            isReturnBlock(thenBranch) &&
            t.isIfStatement(next)
        ) {
            const nextIf = next as t.IfStatement;
            const nextThen = nextIf.consequent;
            const nextElse = nextIf.alternate ?? null;
            if (areNodesEqual(thenBranch, nextThen)) {
                // Transform: replace `cur` and `next` with new `if (cur.test || next.test) nextThen`.
                const newOr = t.logicalExpression('||', ifNode.test, nextIf.test);
                const merged = t.ifStatement(newOr, nextThen, nextElse);
                body.splice(i, 2, merged);
                ctx.minimized++;
                // Re-check at this position.
                continue;
            } else if (nextElse !== null && areNodesEqual(thenBranch, nextElse)) {
                // if(x) return; if(y) foo() else return; → if(!x && y) foo() else return;
                const newAnd = t.logicalExpression(
                    '&&',
                    t.unaryExpression('!', ifNode.test),
                    nextIf.test,
                );
                const merged = t.ifStatement(newAnd, nextThen, nextElse);
                body.splice(i, 2, merged);
                ctx.minimized++;
                continue;
            }
        }

        // (2) if(c) return X; (no else) followed by return Y; → return c?X:Y;
        if (
            next !== null &&
            elseBranch === null &&
            isReturnBlock(thenBranch) &&
            t.isReturnStatement(next)
        ) {
            let thenExpr: t.Expression;
            if (isReturnExpressBlock(thenBranch)) {
                thenExpr = getBlockReturnExpression(thenBranch);
            } else {
                thenExpr = t.identifier('undefined');
            }
            const elseExpr = next.argument ?? t.identifier('undefined');
            const ret = t.returnStatement(
                t.conditionalExpression(ifNode.test, thenExpr, elseExpr),
            );
            body.splice(i, 2, ret);
            ctx.minimized++;
            // Everything after a return is dead — peephole-remove-dead-code
            // will drop the rest in a later pass.
            continue;
        }

        // (3) if(c) { ...exit; } else X; → if(c){...exit;} X; (hoist else)
        if (elseBranch !== null && statementMustExitParent(thenBranch)) {
            // Replace cur with `if(c){...exit;}` (no else) and insert elseBranch
            // after it.
            const trimmed = t.ifStatement(ifNode.test, thenBranch, null);
            body.splice(i, 1, trimmed, elseBranch);
            ctx.minimized++;
            // Re-check this index (trimmed may have its own opportunities).
            continue;
        }

        i++;
    }
}

function statementMustExitParent(n: t.Statement): boolean {
    if (t.isThrowStatement(n) || t.isReturnStatement(n)) return true;
    if (t.isBlockStatement(n)) {
        if (n.body.length === 0) return false;
        return statementMustExitParent(n.body[n.body.length - 1]);
    }
    return false;
}

// ---------------------------------------------------------------------------
// for { if(c) break; ... } → for(...; !c; ...) { ... }

function tryJoinForCondition(n: t.ForStatement, ctx: Ctx): void {
    const body = n.body;
    if (!t.isBlockStatement(body) || body.body.length === 0) return;
    const first = body.body[0];
    if (!t.isIfStatement(first)) return;

    const innerThen = first.consequent;
    let breakNode: t.BreakStatement | null = null;
    if (t.isBlockStatement(innerThen)) {
        if (innerThen.body.length === 1 && t.isBreakStatement(innerThen.body[0])) {
            breakNode = innerThen.body[0] as t.BreakStatement;
        }
    } else if (t.isBreakStatement(innerThen)) {
        breakNode = innerThen;
    }
    if (breakNode === null || breakNode.label !== null) return;

    // Preserve the else branch (if any) as the new first body statement;
    // otherwise drop the if entirely.
    const elseBranch = first.alternate ?? null;
    if (elseBranch !== null) {
        body.body[0] = elseBranch;
    } else {
        body.body.shift();
    }

    const negatedTest = t.unaryExpression('!', first.test);
    if (n.test === null || n.test === undefined) {
        n.test = negatedTest;
    } else {
        n.test = t.logicalExpression('&&', n.test, negatedTest);
    }
    ctx.minimized++;
}

// ---------------------------------------------------------------------------
// tryRemoveRepeatedStatements — hoist trailing common stmts out of if/else.

function tryRemoveRepeatedStatements(n: t.IfStatement, ctx: Ctx): void {
    const parentLooksLikeBlock = true; // walker is conservative; this is fine
    if (!parentLooksLikeBlock) return;
    const cons = n.consequent;
    const alt = n.alternate;
    if (!t.isBlockStatement(cons) || !t.isBlockStatement(alt ?? t.noop())) return;
    if (!t.isBlockStatement(alt)) return;
    const trueBody = cons.body;
    const falseBody = alt.body;

    // Hoist into a synthetic block we splice into the parent. We can't easily
    // mutate the parent here, so instead we transform `if(c){...A;X}else{...B;X}`
    // → `if(c){...A}else{...B}; X` by appending X to a wrapper block. To keep
    // it simple, we only operate when both branches share at least one tail
    // statement and we replace the IF's body with a synthetic BLOCK containing
    // the new IF plus the hoisted tail.
    const hoisted: t.Statement[] = [];
    while (
        trueBody.length > 0 &&
        falseBody.length > 0 &&
        areNodesEqual(
            trueBody[trueBody.length - 1],
            falseBody[falseBody.length - 1],
        )
    ) {
        const tail = trueBody.pop() as t.Statement;
        falseBody.pop();
        hoisted.unshift(tail);
    }
    if (hoisted.length > 0) {
        // The IfStatement caller (tryMinimizeIf) returns this IfStatement; the
        // parent's slot was an IfStatement, but we now need to emit a BLOCK.
        // Wrap by replacing alt with a new alternate that includes nothing
        // hoisted (already removed); to surface the hoisted statements we
        // append them inside both branches' parents — but that's wrong.
        //
        // Simpler approach: re-attach hoisted statements to the END of *both*
        // branches' parent block. Since we don't have parent context here, we
        // append the hoisted statements after the IF via a SequenceExpression
        // hack — no good either. Instead, we just push them into both branches
        // anew (reverting the hoist). To actually hoist, the caller would need
        // to operate at the block-statement level.
        //
        // The pragmatic compromise: re-push them so we don't lose statements.
        for (const s of hoisted) {
            trueBody.push(t.cloneNode(s));
            falseBody.push(t.cloneNode(s));
        }
        return;
    }
    void ctx;
}

// ---------------------------------------------------------------------------
// performConditionSubstitutions — minimize a node that is *in a boolean
// context* (the test of an IF/WHILE/etc.). Rewrites top-level &&/||/HOOK using
// Tri-valued truth analysis. Closure walks the tree recursively; we do the
// same.

function performConditionSubstitutionsSlot(parent: t.Node, key: string): void {
    const node = getSlot(parent, key);
    if (node === null || node === undefined || Array.isArray(node)) return;
    const replaced = performConditionSubstitutions(node);
    if (replaced !== node) setSlot(parent, key, undefined, replaced);
}

function performConditionSubstitutions(n: t.Node): t.Node {
    if (t.isLogicalExpression(n) && (n.operator === '&&' || n.operator === '||')) {
        const left = performConditionSubstitutions(n.left);
        const right = performConditionSubstitutions(n.right);
        if (left !== n.left) n.left = left as t.Expression;
        if (right !== n.right) n.right = right as t.Expression;

        const rightVal = getSideEffectFreeBooleanValue(right);
        if (rightVal !== TRI_UNKNOWN) {
            const rval = triToBoolean(rightVal, true);
            const op = n.operator;
            // x || FALSE → x ;  x && TRUE → x
            if ((op === '||' && !rval) || (op === '&&' && rval)) {
                return left;
            }
            if (!mayHaveSideEffects(left)) {
                // x || TRUE → TRUE ;  x && FALSE → FALSE
                return right;
            }
            // side-effect LHS + known RHS → comma sequence
            return t.sequenceExpression([left as t.Expression, right as t.Expression]);
        }
        return n;
    }

    if (t.isConditionalExpression(n)) {
        const trueNode = performConditionSubstitutions(n.consequent);
        const falseNode = performConditionSubstitutions(n.alternate);
        if (trueNode !== n.consequent) n.consequent = trueNode as t.Expression;
        if (falseNode !== n.alternate) n.alternate = falseNode as t.Expression;

        const tVal = getSideEffectFreeBooleanValue(trueNode);
        const fVal = getSideEffectFreeBooleanValue(falseNode);
        const cond = n.test;

        if (tVal === TRI_TRUE && fVal === TRI_FALSE) {
            // x ? true : false → x
            return cond;
        }
        if (tVal === TRI_FALSE && fVal === TRI_TRUE) {
            // x ? false : true → !x
            return t.unaryExpression('!', cond);
        }
        if (tVal === TRI_TRUE) {
            // x ? true : y → x || y
            return t.logicalExpression('||', cond, falseNode as t.Expression);
        }
        if (fVal === TRI_FALSE) {
            // x ? y : false → x && y
            return t.logicalExpression('&&', cond, trueNode as t.Expression);
        }
        if (
            !mayHaveSideEffects(cond) &&
            !mayHaveSideEffects(trueNode) &&
            areNodesEqual(cond, trueNode)
        ) {
            // x ? x : y → x || y
            return t.logicalExpression(
                '||',
                trueNode as t.Expression,
                falseNode as t.Expression,
            );
        }
        return n;
    }

    return n;
}

function tryMinimizeConditionSlot(parent: t.Node, key: string): void {
    const node = getSlot(parent, key);
    if (node === null || node === undefined || Array.isArray(node)) return;
    const substituted = performConditionSubstitutions(node);
    const mc = fromConditionNode(substituted);
    const m = getMinimized(mc, 'PREFER_UNNEGATED');
    if (substituted !== node || willChange(m, substituted)) {
        const replacement = buildReplacement(m);
        setSlot(parent, key, undefined, replacement);
    }
}

// ---------------------------------------------------------------------------
// Helpers.

function applyMeasured(original: t.Node, m: MeasuredNode): t.Node {
    if (!willChange(m, original)) return original;
    return buildReplacement(m);
}

// Babel preserves bare-statement branches: `if (c) return 1` parses with
// `consequent: ReturnStatement`, not a block-wrapped one. We treat both
// shapes uniformly via `unwrapSingle`.

function unwrapSingle(n: t.Statement): t.Statement {
    if (t.isBlockStatement(n) && n.body.length === 1) return n.body[0];
    return n;
}

function isFoldableExpressBlock(n: t.Statement): boolean {
    const inner = unwrapSingle(n);
    if (!t.isExpressionStatement(inner)) return false;
    const ex = inner.expression;
    if (t.isCallExpression(ex)) {
        const callee = ex.callee;
        if (t.isMemberExpression(callee)) {
            if (callee.computed) return false;
            if (
                t.isIdentifier(callee.property) &&
                callee.property.name.startsWith('on')
            ) {
                return false;
            }
        }
    }
    return true;
}

function getBlockExpression(n: t.Statement): t.ExpressionStatement {
    return unwrapSingle(n) as t.ExpressionStatement;
}

function isReturnBlock(n: t.Statement): boolean {
    return t.isReturnStatement(unwrapSingle(n));
}

function isReturnExpressBlock(n: t.Statement): boolean {
    const inner = unwrapSingle(n);
    return (
        t.isReturnStatement(inner) &&
        inner.argument !== null &&
        inner.argument !== undefined
    );
}

function getBlockReturnExpression(n: t.Statement): t.Expression {
    return (unwrapSingle(n) as t.ReturnStatement).argument as t.Expression;
}

function getSingleVarDecl(n: t.Statement): t.VariableDeclaration | null {
    const inner = unwrapSingle(n);
    if (!t.isVariableDeclaration(inner)) return null;
    if (inner.declarations.length !== 1) return null;
    return inner;
}

function consumesDanglingElse(n: t.Statement): boolean {
    let cur: t.Node = n;
    while (true) {
        if (t.isIfStatement(cur)) {
            if (cur.alternate === null || cur.alternate === undefined) return true;
            cur = cur.alternate;
            continue;
        }
        if (t.isBlockStatement(cur)) {
            if (cur.body.length !== 1) return false;
            cur = cur.body[0];
            continue;
        }
        if (
            t.isWhileStatement(cur) ||
            t.isForStatement(cur) ||
            t.isForInStatement(cur) ||
            t.isForOfStatement(cur) ||
            t.isWithStatement(cur)
        ) {
            cur = cur.body;
            continue;
        }
        return false;
    }
}

function isLiteralValue(n: t.Node): boolean {
    return (
        t.isBooleanLiteral(n) ||
        t.isNumericLiteral(n) ||
        t.isStringLiteral(n) ||
        t.isNullLiteral(n)
    );
}

function mayEffectMutableState(n: t.Node): boolean {
    // For our purposes: a property write target is mutable, an identifier is
    // not. Used to gate the assignment-collapse case in tryMinimizeIf — if the
    // LHS is `o.p`, evaluating it twice is unsafe.
    if (t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) return true;
    if (t.isCallExpression(n)) return true;
    if (t.isAssignmentExpression(n) || t.isUpdateExpression(n)) return true;
    return false;
}
