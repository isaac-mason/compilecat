// Port of jscomp/PeepholeRemoveDeadCode.java (subset).
//
// Removes statically-dead nodes the constant folder leaves behind. Operates
// bottom-up; safe to repeat at the fixpoint level alongside
// PeepholeFoldConstants.
//
// Covered:
//   - if (true) A else B → A;  if (false) A else B → B (or empty)
//   - cond ? A : B with literal cond → A or B
//   - while (false) X → empty;  do X while (false) → X (single iteration)
//   - empty / pure-only statements inside blocks dropped
//   - statements after return/throw/break/continue dropped
//   - comma expression with pure left side: (pure, x) → x
//   - empty `if` / empty `else` cleanup
//
// Not covered (deferred):
//   - switch case folding
//   - try/catch/finally optimization
//   - label removal (classic dce.ts handles unused labels via scope)
//   - optional-chain folding
//   - var/let hoisting through dead branches
//
// Closure runs this in the simplifier loop right after fold-constants. We do
// the same.

import * as t from '@babel/types';

import { mayHaveSideEffects } from './ast-analyzer';
import { getSlot, setSlot, tryMergeBlock } from './node-util';
import { getBooleanValue, TRI_UNKNOWN, triToBoolean } from './tri';

export type RemoveResult = {
    /** Number of statements/expressions deleted or simplified. */
    removed: number;
};

export type RemoveOptions = {
    /** Mirrors Closure's `isASTNormalized()` flag passed through to
     *  NodeUtil.tryMergeBlock as `ignoreBlockScopedDeclarations`. When true,
     *  block-flatten is allowed even when the inner block has let/const/class/
     *  function declarations — safe because Normalize has already uniquified
     *  every declared name across the whole file. See
     *  NodeUtil.java:2483-2508. */
    normalized?: boolean;
};

export function runPeepholeRemoveDeadCode(
    root: t.Node,
    options: RemoveOptions = {},
): RemoveResult {
    const ctx: Ctx = { removed: 0, normalized: options.normalized === true };
    walk(root, null, '', undefined, ctx);
    return { removed: ctx.removed };
}

type Ctx = { removed: number; normalized: boolean };

function walk(
    n: t.Node,
    parent: t.Node | null,
    key: string,
    index: number | undefined,
    ctx: Ctx,
): void {
    // Bottom-up.
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

    // Block-level cleanups (operate on the array directly).
    if (t.isBlockStatement(n) || t.isProgram(n)) {
        cleanBlockBody(n, ctx);
    }

    if (parent === null) return;
    const replacement = tryRemove(n);
    if (replacement === undefined) return;
    setSlot(parent, key, index, replacement);
    ctx.removed++;
}

// ---------------------------------------------------------------------------
// Per-node simplifier. Returns:
//   undefined → no change
//   t.Node    → replacement
//   null      → caller should treat as removed (only safe in array contexts)

function tryRemove(n: t.Node): t.Node | null | undefined {
    if (t.isIfStatement(n)) return foldIfStatement(n);
    if (t.isConditionalExpression(n)) return foldConditional(n);
    if (t.isWhileStatement(n)) return foldWhile(n);
    if (t.isDoWhileStatement(n)) return foldDoWhile(n);
    if (t.isExpressionStatement(n)) return foldExpressionStatement(n);
    if (t.isSequenceExpression(n)) return foldSequence(n);
    return undefined;
}

// ---------------------------------------------------------------------------
// If / Conditional

function foldIfStatement(n: t.IfStatement): t.Node | null | undefined {
    const b = asBoolean(n.test);
    if (b === true) {
        if (mayHaveSideEffects(n.test)) return undefined;
        return n.consequent;
    }
    if (b === false) {
        if (mayHaveSideEffects(n.test)) return undefined;
        if (n.alternate) return n.alternate;
        return t.emptyStatement();
    }
    // Empty consequent + no alternate → just evaluate test (preserve effects).
    if (isEmpty(n.consequent) && (n.alternate == null || isEmpty(n.alternate))) {
        if (!mayHaveSideEffects(n.test)) return t.emptyStatement();
        return t.expressionStatement(n.test);
    }
    return undefined;
}

function foldConditional(n: t.ConditionalExpression): t.Node | undefined {
    const b = asBoolean(n.test);
    if (b === true && !mayHaveSideEffects(n.test)) return n.consequent;
    if (b === false && !mayHaveSideEffects(n.test)) return n.alternate;
    return undefined;
}

// ---------------------------------------------------------------------------
// Loops

function foldWhile(n: t.WhileStatement): t.Node | undefined {
    const b = asBoolean(n.test);
    if (b === false && !mayHaveSideEffects(n.test)) return t.emptyStatement();
    return undefined;
}

function foldDoWhile(n: t.DoWhileStatement): t.Node | undefined {
    const b = asBoolean(n.test);
    if (b === false && !mayHaveSideEffects(n.test)) {
        // Body runs exactly once.
        return n.body;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Expression statements / sequence

function foldExpressionStatement(n: t.ExpressionStatement): t.Node | undefined {
    if (!mayHaveSideEffects(n.expression)) return t.emptyStatement();
    return undefined;
}

function foldSequence(n: t.SequenceExpression): t.Node | undefined {
    // Drop pure prefix items: (pure, pure, x) → x
    const exprs = n.expressions;
    let firstImpure = -1;
    for (let i = 0; i < exprs.length - 1; i++) {
        if (mayHaveSideEffects(exprs[i])) {
            firstImpure = i;
            break;
        }
    }
    if (firstImpure === -1) {
        // All but last are pure; drop them.
        if (exprs.length === 1) return undefined;
        return exprs[exprs.length - 1];
    }
    if (firstImpure === 0) return undefined;
    // Keep [firstImpure..end].
    const remaining = exprs.slice(firstImpure);
    if (remaining.length === 1) return remaining[0];
    return t.sequenceExpression(remaining);
}

// ---------------------------------------------------------------------------
// Block cleanup

function cleanBlockBody(n: t.BlockStatement | t.Program, ctx: Ctx): void {
    // Port of PeepholeRemoveDeadCode.tryOptimizeBlock's child-merge step
    // (PeepholeRemoveDeadCode.java:937-946 → NodeUtil.tryMergeBlock,
    // NodeUtil.java:2490). For each direct child that is itself a BLOCK,
    // attempt the merge with `ignoreBlockScopedDeclarations = isASTNormalized`.
    // Done first so the terminator scan that follows sees the post-merge shape.
    const body = n.body as t.Statement[];
    let flattened = 0;
    for (let i = 0; i < body.length; i++) {
        const s = body[i];
        if (!t.isBlockStatement(s)) continue;
        const inserted = tryMergeBlock(s, body, i, n, ctx.normalized);
        if (inserted === 0) continue;
        flattened++;
        i += inserted - 1;
    }
    if (flattened > 0) ctx.removed += flattened;

    // Port of PeepholeRemoveDeadCode.tryOptimizeConditionalAfterAssign
    // (PRDC.java:1026-1102). For consecutive `<assign>; <conditional>`
    // pairs where the condition is just the freshly-assigned name, replace
    // the condition with a constant derived from the RHS. Pairs with
    // PeepholeFoldConstants downstream to fully fold the conditional.
    for (let i = 0; i < body.length - 1; i++) {
        if (tryOptimizeConditionalAfterAssign(body[i], body[i + 1])) {
            ctx.removed++;
        }
    }

    let write = 0;
    let removed = 0;
    let unreachable = false;
    for (let read = 0; read < body.length; read++) {
        const stmt = body[read];

        // Drop EmptyStatement.
        if (t.isEmptyStatement(stmt)) {
            removed++;
            continue;
        }

        // Drop unreachable statements after a terminator.
        if (unreachable) {
            // Hoist var declarations (without initializers in the simple case)
            // — but to keep this conservative we only drop non-declarations.
            if (containsVarDeclaration(stmt) || t.isFunctionDeclaration(stmt)) {
                body[write++] = stmt;
                continue;
            }
            removed++;
            continue;
        }

        body[write++] = stmt;

        if (isTerminator(stmt)) unreachable = true;
    }
    if (write !== body.length) {
        body.length = write;
        ctx.removed += removed;
    }
}

function isTerminator(s: t.Statement): boolean {
    return (
        t.isReturnStatement(s) ||
        t.isThrowStatement(s) ||
        t.isBreakStatement(s) ||
        t.isContinueStatement(s)
    );
}

function containsVarDeclaration(s: t.Statement): boolean {
    if (t.isVariableDeclaration(s) && s.kind === 'var') return true;
    return t.traverseFast(s, (n) => {
        if (t.isFunction(n)) return t.traverseFast.skip;
        if (t.isVariableDeclaration(n) && n.kind === 'var') return t.traverseFast.stop;
        return undefined;
    });
}

// ---------------------------------------------------------------------------
// Helpers

function isEmpty(n: t.Node): boolean {
    if (t.isEmptyStatement(n)) return true;
    if (t.isBlockStatement(n) && n.body.length === 0) return true;
    return false;
}

function asBoolean(node: t.Node): boolean | null {
    if (t.isBooleanLiteral(node)) return node.value;
    if (t.isNumericLiteral(node)) return node.value !== 0;
    if (t.isStringLiteral(node)) return node.value.length > 0;
    if (t.isNullLiteral(node)) return false;
    if (t.isIdentifier(node) && node.name === 'undefined') return false;
    return null;
}

// ---------------------------------------------------------------------------
// Port of PeepholeRemoveDeadCode.tryOptimizeConditionalAfterAssign
// (PRDC.java:1026-1102).
//
// Recognizes:
//
//     <assign>;
//     if (<name>) ...           → if (<bool>) ...
//     <name> ? a : b;           → <bool> ? a : b
//     <name> && f();            → <bool> && f()
//     <name> || f();            → <bool> || f()
//     <name> ?? f();            → undefined ?? f()  // when rhs known nullish
//                              or  0 ?? f()         // when rhs known non-nullish
//
// Where <assign> is either `name = RHS;` or `var/let/const name = RHS;`.
//
// Returns true when the condition was replaced.

function tryOptimizeConditionalAfterAssign(
    assignStmt: t.Statement,
    conditionalStmt: t.Statement,
): boolean {
    const lhsName = simpleAssignmentLhsName(assignStmt);
    if (lhsName === null) return false;
    const rhs = simpleAssignmentRhs(assignStmt);
    if (rhs === null) return false;

    const cr = conditionalRoot(conditionalStmt);
    if (cr === null) return false;
    const condition = conditionalRootCondition(cr);
    if (!t.isIdentifier(condition) || condition.name !== lhsName) return false;

    // COALESCE (??): use known value type rather than truthiness.
    if (t.isLogicalExpression(cr.root) && cr.root.operator === '??') {
        const nullish = isKnownNullish(rhs);
        if (nullish === true) {
            cr.replaceCondition(t.unaryExpression('void', t.numericLiteral(0)));
            return true;
        }
        if (nullish === false) {
            cr.replaceCondition(t.numericLiteral(0));
            return true;
        }
        return false;
    }

    // IF / HOOK / AND / OR — boolean coercion.
    const tri = getBooleanValue(rhs);
    if (tri === TRI_UNKNOWN) return false;
    cr.replaceCondition(t.booleanLiteral(triToBoolean(tri, true)));
    return true;
}

/** Returns the LHS name iff `n` is a simple assignment / single-init decl. */
function simpleAssignmentLhsName(n: t.Statement): string | null {
    if (t.isExpressionStatement(n) && t.isAssignmentExpression(n.expression)) {
        const a = n.expression;
        if (a.operator !== '=') return null;
        if (!t.isIdentifier(a.left)) return null;
        return a.left.name;
    }
    if (t.isVariableDeclaration(n) && n.declarations.length === 1) {
        const d = n.declarations[0];
        if (!t.isIdentifier(d.id)) return null;
        if (d.init === null || d.init === undefined) return null;
        return d.id.name;
    }
    return null;
}

function simpleAssignmentRhs(n: t.Statement): t.Expression | null {
    if (t.isExpressionStatement(n) && t.isAssignmentExpression(n.expression)) {
        return n.expression.right;
    }
    if (t.isVariableDeclaration(n) && n.declarations.length === 1) {
        return n.declarations[0].init ?? null;
    }
    return null;
}

type ConditionalRoot = {
    /** The IfStatement, ConditionalExpression, or LogicalExpression root. */
    root: t.IfStatement | t.ConditionalExpression | t.LogicalExpression;
    /** Replace the condition slot in-place. */
    replaceCondition(replacement: t.Expression): void;
};

function conditionalRoot(s: t.Statement): ConditionalRoot | null {
    if (t.isIfStatement(s)) {
        const node = s;
        return {
            root: node,
            replaceCondition(r) {
                node.test = r;
            },
        };
    }
    if (t.isExpressionStatement(s)) {
        const e = s.expression;
        if (t.isConditionalExpression(e)) {
            return {
                root: e,
                replaceCondition(r) {
                    e.test = r;
                },
            };
        }
        if (
            t.isLogicalExpression(e) &&
            (e.operator === '&&' || e.operator === '||' || e.operator === '??')
        ) {
            return {
                root: e,
                replaceCondition(r) {
                    e.left = r;
                },
            };
        }
    }
    return null;
}

function conditionalRootCondition(cr: ConditionalRoot): t.Expression {
    if (t.isIfStatement(cr.root)) return cr.root.test;
    if (t.isConditionalExpression(cr.root)) return cr.root.test;
    return cr.root.left;
}

/** Returns true if RHS is statically known to be nullish (null or undefined),
 *  false if statically known to be non-nullish, null if unknown. Subset of
 *  Closure's `NodeUtil.getKnownValueType` collapsed to the only distinction
 *  the COALESCE branch needs. */
function isKnownNullish(n: t.Node): boolean | null {
    if (t.isNullLiteral(n)) return true;
    if (t.isIdentifier(n) && n.name === 'undefined') return true;
    if (t.isUnaryExpression(n) && n.operator === 'void') return true;
    if (
        t.isNumericLiteral(n) ||
        t.isStringLiteral(n) ||
        t.isBooleanLiteral(n) ||
        t.isBigIntLiteral(n) ||
        t.isObjectExpression(n) ||
        t.isArrayExpression(n) ||
        t.isFunction(n) ||
        t.isRegExpLiteral(n) ||
        t.isTemplateLiteral(n)
    ) {
        return false;
    }
    return null;
}
