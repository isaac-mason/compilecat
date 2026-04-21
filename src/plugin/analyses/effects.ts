import * as t from '@babel/types';

/**
 * Expression purity classifier. Answers: "can this expression be safely
 * deleted or duplicated without changing observable program behavior inside
 * an opt-in zone?"
 *
 * Inside opt-in zones (@cc-inline/@cc-sroa/@cc-unroll) we assume:
 *   - no effectful getters / setters on property access
 *   - no proxies intercepting reads
 *   - no Symbol.toPrimitive tricks on arithmetic
 *
 * With those assumptions, a pure expression has no observable side effects
 * and re-evaluating it yields the same value. Transforms use this to decide
 * whether a declaration/assignment can be deleted (DCE) or a right-hand side
 * can be duplicated (copyprop).
 *
 * Scope is deliberately narrow: leaf-level classification. Function purity
 * (is `foo()` pure?) is a different problem we'll solve when a transform
 * actually needs it; for now any CallExpression / NewExpression is impure.
 */

export type State = ReturnType<typeof init>;

export function init() {
    return {
        cache: new WeakMap<t.Node, boolean>(),
    };
}

export function invalidateAll(state: State): void {
    state.cache = new WeakMap();
}

/**
 * True iff `expr` is side-effect-free under opt-in-zone assumptions. Use this
 * when deciding whether to delete a declaration whose RHS is `expr` or
 * duplicate `expr` at another site.
 */
export function isPure(state: State, expr: t.Expression | t.PrivateName): boolean {
    const cached = state.cache.get(expr);
    if (cached !== undefined) return cached;
    const result = classify(state, expr);
    state.cache.set(expr, result);
    return result;
}

function classify(state: State, node: t.Expression | t.PrivateName): boolean {
    // Primitives and bindings: always pure. We enumerate the specific literal
    // types rather than using t.isLiteral, because TemplateLiteral is also in
    // that group and has embedded expressions we need to classify recursively.
    if (
        t.isIdentifier(node) ||
        t.isPrivateName(node) ||
        t.isStringLiteral(node) ||
        t.isNumericLiteral(node) ||
        t.isBooleanLiteral(node) ||
        t.isNullLiteral(node) ||
        t.isRegExpLiteral(node) ||
        t.isBigIntLiteral(node) ||
        t.isDecimalLiteral(node) ||
        t.isThisExpression(node) ||
        t.isSuper(node as t.Node)
    ) {
        return true;
    }

    // Member access: pure under opt-in-zone assumptions. `obj.prop` doesn't
    // throw for well-typed obj (typeof obj !== 'null' | 'undefined') which we
    // trust inside zones. Computed keys must also be pure.
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        if (!isPure(state, node.object as t.Expression)) return false;
        if (node.computed) return isPure(state, node.property as t.Expression);
        return true;
    }

    // Unary: typeof/void/!/-/+/~ have no side effects aside from evaluating
    // their argument. `delete` mutates — impure.
    if (t.isUnaryExpression(node)) {
        if (node.operator === 'delete') return false;
        return isPure(state, node.argument);
    }

    // Binary/logical: pure iff both sides are pure. Arithmetic in opt-in
    // zones doesn't trigger Symbol.toPrimitive side effects.
    if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
        const left = node.left as t.Expression | t.PrivateName;
        return isPure(state, left) && isPure(state, node.right);
    }

    // Conditional: pure iff test and both branches are pure.
    if (t.isConditionalExpression(node)) {
        return (
            isPure(state, node.test) &&
            isPure(state, node.consequent) &&
            isPure(state, node.alternate)
        );
    }

    // Array/Object literal: allocates memory, but allocation itself has no
    // observable side effect beyond identity. Safe to delete; copyprop won't
    // duplicate these because its RHS must be an Identifier.
    if (t.isArrayExpression(node)) {
        return node.elements.every((el) => el === null || isPureElement(state, el));
    }
    if (t.isObjectExpression(node)) {
        return node.properties.every((p) => isPureObjectProperty(state, p));
    }

    // Template literals: in opt-in zones, embedded expressions' toString is
    // assumed side-effect-free. Pure iff every embedded expression is pure.
    if (t.isTemplateLiteral(node)) {
        return node.expressions.every((e) =>
            t.isTSType(e) ? true : isPure(state, e as t.Expression),
        );
    }

    // Sequence: pure iff every sub-expression is pure. Rare in generated
    // code but cheap to handle.
    if (t.isSequenceExpression(node)) {
        return node.expressions.every((e) => isPure(state, e));
    }

    // Parenthesized: unwrap.
    if (t.isParenthesizedExpression(node)) {
        return isPure(state, node.expression);
    }

    // TS type assertion wrappers: look through.
    if (
        t.isTSAsExpression(node) ||
        t.isTSTypeAssertion(node) ||
        t.isTSNonNullExpression(node) ||
        t.isTSSatisfiesExpression(node)
    ) {
        return isPure(state, node.expression);
    }

    // Anything else — calls, assignments, updates, yield, await, new,
    // tagged templates, spread, JSX, etc. — conservatively impure.
    return false;
}

function isPureElement(
    state: State,
    el: t.Expression | t.SpreadElement,
): boolean {
    if (t.isSpreadElement(el)) {
        // Spread invokes the iterator protocol — side-effecting in general.
        return false;
    }
    return isPure(state, el);
}

function isPureObjectProperty(
    state: State,
    p: t.ObjectProperty | t.ObjectMethod | t.SpreadElement,
): boolean {
    if (t.isSpreadElement(p)) return false;
    if (t.isObjectMethod(p)) return true; // method definition; no call, just a function value
    if (p.computed && !isPure(state, p.key as t.Expression)) return false;
    const v = p.value;
    if (t.isPatternLike(v) && !t.isExpression(v)) return false;
    return isPure(state, v as t.Expression);
}
