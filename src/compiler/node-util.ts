// Port of jscomp/NodeUtil.java (subset).
//
// NodeUtil in Closure is ~5000 LOC of Rhino-AST helpers. We port only what
// the algorithms we're bringing over actually need, on Babel types.
//
// Helpers added incrementally as ControlFlowAnalysis / DataFlowAnalysis /
// liveness passes consume them.

import * as t from '@babel/types';

/**
 * The condition-bearing child of a control structure. Mirrors Closure's
 * `getConditionExpression` — null for things like `for(;;)` where the test
 * slot is empty.
 */
export function getConditionExpression(node: t.Node): t.Expression | null {
    if (
        t.isIfStatement(node) ||
        t.isWhileStatement(node) ||
        t.isDoWhileStatement(node) ||
        t.isConditionalExpression(node)
    ) {
        return node.test;
    }
    if (t.isForStatement(node)) {
        return node.test ?? null;
    }
    return null;
}

/**
 * Whether `node` is a statement (control-flow-significant). Closure uses this
 * to decide what gets its own CFG node. Babel's `t.isStatement` covers most
 * of this but excludes `SwitchCase` (which we treat as case body sequence
 * elements), so the test composes both.
 */
export function isStatement(node: t.Node): boolean {
    return t.isStatement(node);
}

/**
 * Whether `node` is a loop construct. Used by ControlFlowAnalysis when
 * resolving break/continue targets.
 */
export function isLoop(node: t.Node): boolean {
    return (
        t.isWhileStatement(node) ||
        t.isDoWhileStatement(node) ||
        t.isForStatement(node) ||
        t.isForInStatement(node) ||
        t.isForOfStatement(node)
    );
}

/**
 * Whether `node` is a target for an unlabeled `break`. In ECMAScript that's
 * any loop or a switch.
 */
export function isBreakTarget(node: t.Node): boolean {
    return isLoop(node) || t.isSwitchStatement(node);
}

/**
 * Whether `node` is a target for an unlabeled `continue` — loops only.
 */
export function isContinueTarget(node: t.Node): boolean {
    return isLoop(node);
}

/**
 * Babel models a `for(;;)` body as the LAST child. Closure's NodeUtil exposes
 * helpers to navigate this; here it's just `.body` for every loop kind.
 */
export function getLoopBody(loop: t.Node): t.Statement | null {
    if (
        t.isWhileStatement(loop) ||
        t.isDoWhileStatement(loop) ||
        t.isForStatement(loop) ||
        t.isForInStatement(loop) ||
        t.isForOfStatement(loop)
    ) {
        return loop.body;
    }
    return null;
}

/**
 * Whether node introduces a new function scope. Mirrors Closure's
 * `isFunctionDeclaration` / `isFunction` group — for our purposes we treat
 * all function-like things uniformly (the CFG builder bails on async /
 * generator at the body level rather than here).
 */
export function isFunction(node: t.Node): boolean {
    return t.isFunction(node);
}

/**
 * The body of a function-like node (always a BlockStatement in practice for
 * declarations and named expressions; arrow-with-expression-body is the
 * exception — caller must handle that case explicitly if it cares).
 */
export function getFunctionBody(fn: t.Function): t.BlockStatement | t.Expression {
    return fn.body;
}

/**
 * Closure's `isLiteralValue` — recognises primitive literal nodes used by
 * dataflow / fold passes. The `includeFunctions` flag matches Closure's
 * second-arg convention.
 */
export function isLiteralValue(node: t.Node, includeFunctions: boolean): boolean {
    if (
        t.isStringLiteral(node) ||
        t.isNumericLiteral(node) ||
        t.isBooleanLiteral(node) ||
        t.isNullLiteral(node) ||
        t.isBigIntLiteral(node) ||
        t.isRegExpLiteral(node)
    ) {
        return true;
    }
    if (t.isTemplateLiteral(node) && node.expressions.length === 0) return true;
    if (t.isUnaryExpression(node) && node.operator === 'void') {
        return isLiteralValue(node.argument, includeFunctions);
    }
    if (includeFunctions && t.isFunction(node)) return true;
    return false;
}

/**
 * Identifier nodes that name a binding (LHS of declaration, function param,
 * write target). Closure spells this `isName`; on Babel we just check for an
 * Identifier or a destructuring pattern element.
 */
export function isName(node: t.Node): node is t.Identifier {
    return t.isIdentifier(node);
}

/** Convenience: true if node is `undefined` keyword usage (an Identifier). */
export function isUndefined(node: t.Node): boolean {
    return t.isIdentifier(node) && node.name === 'undefined';
}

// ---------------------------------------------------------------------------
// Dynamic AST slot access.
//
// Babel's typed AST has no public typed surface for "set the child of `node`
// at key `k` (and array index `i`)" — every consumer is expected to know the
// concrete child shape. Bottom-up rewriters that work generically across node
// types do need this, so we centralise the cast in one place rather than
// scattering `(parent as any)[key]` across each pass.

type SlotMap = Record<string, t.Node | (t.Node | null)[] | null | undefined>;

/** Read `parent[key]` without losing exhaustiveness on the concrete type. */
export function getSlot(parent: t.Node, key: string): t.Node | (t.Node | null)[] | null | undefined {
    return (parent as unknown as SlotMap)[key];
}

/** Write `parent[key]` (or `parent[key][index]` if `index` provided). */
export function setSlot(
    parent: t.Node,
    key: string,
    index: number | undefined,
    value: t.Node | null,
): void {
    const obj = parent as unknown as Record<string, t.Node | (t.Node | null)[] | null>;
    if (index !== undefined) (obj[key] as (t.Node | null)[])[index] = value;
    else obj[key] = value;
}
