// Port of jscomp/base/Tri.java — three-valued logic.
//
// TRUE / FALSE behave as ordinary booleans; UNKNOWN is "could be either", so
// every operation that returns a definite Tri must yield the same result for
// both substitutions of UNKNOWN.

import * as t from '@babel/types';

export const TRI_FALSE = -1 as const;
export const TRI_UNKNOWN = 0 as const;
export const TRI_TRUE = 1 as const;

export type Tri = -1 | 0 | 1;

export function triOr(a: Tri, b: Tri): Tri {
    return (a > b ? a : b) as Tri;
}

export function triAnd(a: Tri, b: Tri): Tri {
    return (a < b ? a : b) as Tri;
}

export function triNot(a: Tri): Tri {
    return -a as Tri;
}

export function triXor(a: Tri, b: Tri): Tri {
    return (-a * b) as Tri;
}

export function triToBoolean(a: Tri, fallback: boolean): boolean {
    if (a === TRI_TRUE) return true;
    if (a === TRI_FALSE) return false;
    return fallback;
}

export function triForBoolean(b: boolean): Tri {
    return b ? TRI_TRUE : TRI_FALSE;
}

// ---------------------------------------------------------------------------
// Boolean coercion of an AST node, ignoring side effects.
//
// Used by PeepholeMinimizeConditions when massaging boolean contexts. Closure
// folds these through `NodeUtil.getBooleanValue` + a side-effect gate.

export function getBooleanValue(n: t.Node): Tri {
    if (t.isBooleanLiteral(n)) return n.value ? TRI_TRUE : TRI_FALSE;
    if (t.isNumericLiteral(n)) return n.value !== 0 ? TRI_TRUE : TRI_FALSE;
    if (t.isStringLiteral(n)) return n.value.length > 0 ? TRI_TRUE : TRI_FALSE;
    if (t.isNullLiteral(n)) return TRI_FALSE;
    if (t.isIdentifier(n) && n.name === 'undefined') return TRI_FALSE;
    if (t.isIdentifier(n) && n.name === 'NaN') return TRI_FALSE;
    if (t.isIdentifier(n) && n.name === 'Infinity') return TRI_TRUE;
    if (t.isUnaryExpression(n) && n.operator === 'void') return TRI_FALSE;
    if (t.isUnaryExpression(n) && n.operator === '!') return triNot(getBooleanValue(n.argument));
    if (t.isObjectExpression(n)) return TRI_TRUE;
    if (t.isArrayExpression(n)) return TRI_TRUE;
    if (t.isFunction(n)) return TRI_TRUE;
    if (t.isRegExpLiteral(n)) return TRI_TRUE;
    if (t.isTemplateLiteral(n) && n.expressions.length === 0) {
        const cooked = n.quasis[0]?.value.cooked ?? '';
        return cooked.length > 0 ? TRI_TRUE : TRI_FALSE;
    }
    return TRI_UNKNOWN;
}
