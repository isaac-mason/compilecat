// Port of jscomp/PeepholeMinimizeConditions.java (subset).
//
// Boolean control-flow minimization. Operates bottom-up; safe to repeat at
// the fixpoint level alongside fold-constants and remove-dead-code.
//
// Covered:
//   - !(a CMP b) → a NEG_CMP b for ==, ===, !=, !==, <, <=, >, >=
//   - !(!x)      → x   (the inner negation has the boolean coercion already)
//   - cond ? a : a → a  (when cond is pure)
//   - cond ? true : false → !!cond (preserved as ConditionalExpression
//     against !cond when cond isn't already boolean — see helper)
//   - cond ? false : true → !cond
//   - if (c) return X; else return Y;        → return c ? X : Y;
//   - if (c) return X; (followed by) return Y → return c ? X : Y; (collapses
//     across siblings in the same block)
//   - if (c) X = A; else X = B; → X = c ? A : B; (same target identifier)
//
// Not covered:
//   - de Morgan's full rewrite
//   - if/else with mixed return + non-return
//   - swap-conditional based on cost (Closure tries both shapes)
//   - exhaustive HOOK-flattening
//
// Closure runs this in the simplifier pass-list. We invoke it from the
// fixpoint loop via Simplifier.

import * as t from '@babel/types';

import { mayHaveSideEffects } from './ast-analyzer';
import { getSlot, setSlot } from './node-util';

export type MinimizeResult = {
    minimized: number;
};

export function runPeepholeMinimizeConditions(root: t.Node): MinimizeResult {
    const ctx: Ctx = { minimized: 0 };
    walk(root, null, '', undefined, ctx);
    return { minimized: ctx.minimized };
}

type Ctx = { minimized: number };

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

    // Statement-list-level rewrites (block scope) — operate on the array.
    if (t.isBlockStatement(n) || t.isProgram(n)) {
        if (collapseIfReturnPair(n, ctx)) {
            // mutated; safe to keep walking.
        }
    }

    if (parent === null) return;
    const replacement = tryMinimize(n);
    if (replacement === undefined) return;
    setSlot(parent, key, index, replacement);
    ctx.minimized++;
}

// ---------------------------------------------------------------------------
// Per-node minimizer.

function tryMinimize(n: t.Node): t.Node | undefined {
    if (t.isUnaryExpression(n) && n.operator === '!') return minimizeNot(n);
    if (t.isConditionalExpression(n)) return minimizeConditional(n);
    if (t.isIfStatement(n)) return minimizeIfReturnElse(n);
    return undefined;
}

// ---------------------------------------------------------------------------
// !(...) rewrites.

const COMPARISON_NEGATION: Record<string, string> = {
    '==': '!=',
    '!=': '==',
    '===': '!==',
    '!==': '===',
    '<': '>=',
    '<=': '>',
    '>': '<=',
    '>=': '<',
};

function minimizeNot(n: t.UnaryExpression): t.Node | undefined {
    const arg = n.argument;
    // !(!x) → x   ('!' is boolean-typed, so the outer ! can't change x's value)
    if (t.isUnaryExpression(arg) && arg.operator === '!') {
        return arg.argument;
    }
    // !(a CMP b) → a NEG_CMP b
    if (t.isBinaryExpression(arg) && COMPARISON_NEGATION[arg.operator] !== undefined) {
        if (t.isPrivateName(arg.left)) return undefined;
        return t.binaryExpression(
            COMPARISON_NEGATION[arg.operator] as t.BinaryExpression['operator'],
            arg.left,
            arg.right,
        );
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Conditional (?:) rewrites.

function minimizeConditional(n: t.ConditionalExpression): t.Node | undefined {
    // cond ? a : a → a (when cond is pure)
    if (sameNode(n.consequent, n.alternate) && !mayHaveSideEffects(n.test)) {
        return n.consequent;
    }
    // cond ? true : false → cond  (only when cond is already boolean-typed —
    // we don't have type info, so wrap as `!!cond` via two negations).
    if (
        t.isBooleanLiteral(n.consequent) &&
        n.consequent.value === true &&
        t.isBooleanLiteral(n.alternate) &&
        n.alternate.value === false
    ) {
        return t.unaryExpression('!', t.unaryExpression('!', n.test));
    }
    // cond ? false : true → !cond
    if (
        t.isBooleanLiteral(n.consequent) &&
        n.consequent.value === false &&
        t.isBooleanLiteral(n.alternate) &&
        n.alternate.value === true
    ) {
        return t.unaryExpression('!', n.test);
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// if (c) return X; else return Y;  →  return c ? X : Y;

function minimizeIfReturnElse(n: t.IfStatement): t.Node | undefined {
    const cons = singleReturn(n.consequent);
    const alt = n.alternate ? singleReturn(n.alternate) : null;
    if (cons !== null && alt !== null) {
        return t.returnStatement(
            t.conditionalExpression(
                n.test,
                cons.argument ?? t.identifier('undefined'),
                alt.argument ?? t.identifier('undefined'),
            ),
        );
    }
    // if (c) X = A; else X = B;  →  X = c ? A : B;
    const consAssign = singleAssign(n.consequent);
    const altAssign = n.alternate ? singleAssign(n.alternate) : null;
    if (consAssign !== null && altAssign !== null) {
        if (
            t.isIdentifier(consAssign.left) &&
            t.isIdentifier(altAssign.left) &&
            consAssign.left.name === altAssign.left.name &&
            consAssign.operator === altAssign.operator
        ) {
            return t.expressionStatement(
                t.assignmentExpression(
                    consAssign.operator,
                    t.cloneNode(consAssign.left, true),
                    t.conditionalExpression(n.test, consAssign.right, altAssign.right),
                ),
            );
        }
    }
    return undefined;
}

function singleReturn(s: t.Statement): t.ReturnStatement | null {
    if (t.isReturnStatement(s)) return s;
    if (t.isBlockStatement(s) && s.body.length === 1 && t.isReturnStatement(s.body[0])) {
        return s.body[0];
    }
    return null;
}

function singleAssign(s: t.Statement): t.AssignmentExpression | null {
    if (
        t.isExpressionStatement(s) &&
        t.isAssignmentExpression(s.expression) &&
        s.expression.operator === '='
    ) {
        return s.expression;
    }
    if (t.isBlockStatement(s) && s.body.length === 1) return singleAssign(s.body[0]);
    return null;
}

// ---------------------------------------------------------------------------
// Statement-list collapses.
//
// if (c) return X;        if (c) return X;
// return Y;          →    return c ? X : Y;

function collapseIfReturnPair(block: t.BlockStatement | t.Program, ctx: Ctx): boolean {
    const body = block.body as t.Statement[];
    let changed = false;
    for (let i = 0; i < body.length - 1; i++) {
        const a = body[i];
        const b = body[i + 1];
        if (
            t.isIfStatement(a) &&
            a.alternate == null &&
            t.isReturnStatement(b)
        ) {
            const cons = singleReturn(a.consequent);
            if (cons === null) continue;
            const merged = t.returnStatement(
                t.conditionalExpression(
                    a.test,
                    cons.argument ?? t.identifier('undefined'),
                    b.argument ?? t.identifier('undefined'),
                ),
            );
            body.splice(i, 2, merged);
            ctx.minimized++;
            changed = true;
            // Do not advance i — re-check at this position.
            i--;
        }
    }
    return changed;
}

// ---------------------------------------------------------------------------

function sameNode(a: t.Node, b: t.Node): boolean {
    if (a.type !== b.type) return false;
    if (t.isIdentifier(a) && t.isIdentifier(b)) return a.name === b.name;
    if (t.isNumericLiteral(a) && t.isNumericLiteral(b)) return a.value === b.value;
    if (t.isStringLiteral(a) && t.isStringLiteral(b)) return a.value === b.value;
    if (t.isBooleanLiteral(a) && t.isBooleanLiteral(b)) return a.value === b.value;
    if (t.isNullLiteral(a) && t.isNullLiteral(b)) return true;
    return false;
}
