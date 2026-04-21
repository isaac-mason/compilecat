import * as t from '@babel/types';
/**
 * Expression purity classifier. Answers: "can this expression be safely
 * deleted or duplicated without changing observable program behavior inside
 * an opt-in zone?"
 *
 * Inside opt-in zones (@inline/@sroa/@unroll) we assume:
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
export declare function init(): {
    cache: WeakMap<t.Node, boolean>;
};
export declare function invalidateAll(state: State): void;
/**
 * True iff `expr` is side-effect-free under opt-in-zone assumptions. Use this
 * when deciding whether to delete a declaration whose RHS is `expr` or
 * duplicate `expr` at another site.
 */
export declare function isPure(state: State, expr: t.Expression | t.PrivateName): boolean;
