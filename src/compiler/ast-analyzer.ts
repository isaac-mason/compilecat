// Port of jscomp/AstAnalyzer.java (subset — purity / side-effect predicate).
//
// AstAnalyzer in Closure provides the side-effect predicates other passes
// consult before reordering or dropping expressions. We port the
// conservative core: `mayHaveSideEffects(node)` returns true unless the
// node provably has no observable effect.
//
// What we DO recognize as effect-free:
//   - literals
//   - reads of pure local identifiers
//   - pure arithmetic / comparison / logical expressions over effect-free
//     operands
//   - object / array literals composed of effect-free values
//   - typeof / void / unary ! / unary - / unary + over effect-free operands
//
// What is conservatively impure (returns true):
//   - any call / new
//   - any assignment / update (++ -- compound assigns)
//   - delete
//   - yield / await / throw
//   - tagged templates
//   - everything we don't recognise — Closure errs on the side of "may have
//     side effects" and we follow.
//
// Member access (`obj.prop`, `obj[k]`, optional-chain variants) is treated
// as pure when the object (and computed key, if any) is itself pure. This
// matches Closure's AstAnalyzer with `assumeGettersArePure=true` — its
// default mode (AstAnalyzer.java:434-437). The risk is user-defined
// getters firing as side effects; Closure documents the alternative —
// flagging every getprop impure — as having "completely unacceptable" code
// size cost. We follow that policy, especially since the downstream bundler
// or minifier (esbuild, terser) makes the same assumption.

import * as t from '@babel/types';

import { isLiteralValue } from './node-util';
import { getBooleanValue, type Tri, TRI_UNKNOWN } from './tri';

export function mayHaveSideEffects(node: t.Node): boolean {
    return !isPure(node);
}

/**
 * Closure's `getSideEffectFreeBooleanValue` — returns the boolean value the
 * expression would evaluate to (as a Tri) but only when the expression has no
 * side effects; UNKNOWN otherwise. Used in cond rewriting to gate moves like
 * `x || true → true` (only safe when `x` is pure).
 */
export function getSideEffectFreeBooleanValue(node: t.Node): Tri {
    if (mayHaveSideEffects(node)) return TRI_UNKNOWN;
    return getBooleanValue(node);
}

export function isPure(node: t.Node): boolean {
    if (isLiteralValue(node, /* includeFunctions */ true)) return true;
    if (t.isIdentifier(node)) return true;
    if (t.isThisExpression(node)) return true;
    if (t.isSuper(node)) return true;

    if (t.isUnaryExpression(node)) {
        switch (node.operator) {
            case '!':
            case '+':
            case '-':
            case '~':
            case 'typeof':
            case 'void':
                return isPure(node.argument);
            case 'delete':
            case 'throw':
                return false;
        }
    }

    if (t.isBinaryExpression(node)) {
        if (node.operator === 'in' || node.operator === 'instanceof') return false;
        // `node.left` is an Expression here in practice; PrivateName only
        // appears for `in` which we already rejected.
        if (t.isPrivateName(node.left)) return false;
        return isPure(node.left) && isPure(node.right);
    }

    if (t.isLogicalExpression(node)) {
        return isPure(node.left) && isPure(node.right);
    }

    if (t.isConditionalExpression(node)) {
        return isPure(node.test) && isPure(node.consequent) && isPure(node.alternate);
    }

    if (t.isSequenceExpression(node)) {
        return node.expressions.every(isPure);
    }

    if (t.isArrayExpression(node)) {
        return node.elements.every((el) => el === null || (!t.isSpreadElement(el) && isPure(el)));
    }

    if (t.isObjectExpression(node)) {
        for (const prop of node.properties) {
            if (t.isSpreadElement(prop)) return false;
            if (t.isObjectMethod(prop)) continue; // method definitions don't run
            if (t.isObjectProperty(prop)) {
                if (prop.computed && !isPure(prop.key)) return false;
                if (!t.isExpression(prop.value)) return false;
                if (!isPure(prop.value)) return false;
                continue;
            }
            return false;
        }
        return true;
    }

    if (t.isTemplateLiteral(node)) {
        // Untagged template — no effects from the template itself, only the
        // inserted expressions matter.
        return node.expressions.every((e) => t.isExpression(e) && isPure(e));
    }

    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        // Closure AstAnalyzer.java:434-437 (GETPROP/OPTCHAIN_GETPROP) and
        // :432 (GETELEM/OPTCHAIN_GETELEM): with assumeGettersArePure (the
        // default), a property read is pure iff the children are pure.
        if (!isPure(node.object as t.Node)) return false;
        if (node.computed && !isPure(node.property as t.Node)) return false;
        return true;
    }

    return false;
}
