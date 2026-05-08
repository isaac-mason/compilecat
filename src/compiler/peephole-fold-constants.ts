// Port of jscomp/PeepholeFoldConstants.java (subset).
//
// Folds expressions whose value is statically computable at compile time.
// Operates on a single AST in a single bottom-up pass; safe to repeat at the
// fixpoint level.
//
// Covered:
//   - numeric arithmetic on literal-literal (+, -, *, /, %, **)
//   - bitwise / shift on literal-literal (&, |, ^, <<, >>, >>>, ~)
//   - numeric identities (x+0, 0+x, x-0, x*1, 1*x, x/1) when x is pure
//   - string concat on string-literal-literal
//   - unary - / + / ! / ~ on literals
//   - typeof of a literal value
//   - logical && / || / ?? when LHS is a known truthy/falsy/null literal
//   - optional chain on null/undefined LHS (`null?.x` → `undefined`)
//   - comparisons (==, ===, !=, !==, <, <=, >, >=) on literal-literal
//
// Not covered (deferred):
//   - bigint
//   - regex / object / array literals as operands
//   - tagged templates
//
// Closure runs this pre-DAE in the simplifier loop. We do the same.

import * as t from '@babel/types';

import { mayHaveSideEffects } from './ast-analyzer';
import { getSlot, setSlot } from './node-util';

export type FoldResult = {
    /** Number of nodes rewritten. */
    folded: number;
};

export function runPeepholeFoldConstants(root: t.Node): FoldResult {
    const ctx: Ctx = { folded: 0 };
    walk(root, null, '', undefined, ctx);
    return { folded: ctx.folded };
}

type Ctx = { folded: number };

function walk(
    n: t.Node,
    parent: t.Node | null,
    key: string,
    index: number | undefined,
    ctx: Ctx,
): void {
    // Bottom-up: recurse first.
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

    if (parent === null) return;
    const replacement = tryFold(n);
    if (replacement === null) return;
    setSlot(parent, key, index, replacement);
    ctx.folded++;
}

// ---------------------------------------------------------------------------
// Per-node fold dispatcher.

function tryFold(n: t.Node): t.Node | null {
    if (t.isUnaryExpression(n)) return foldUnary(n);
    if (t.isBinaryExpression(n)) return foldBinary(n);
    if (t.isLogicalExpression(n)) return foldLogical(n);
    if (t.isOptionalMemberExpression(n) || t.isOptionalCallExpression(n)) return foldOptionalChain(n);
    return null;
}

// ---------------------------------------------------------------------------
// Unary

function foldUnary(n: t.UnaryExpression): t.Node | null {
    if (n.operator === 'typeof') {
        const tn = typeofLiteral(n.argument);
        if (tn !== null) return t.stringLiteral(tn);
        return null;
    }
    if (n.operator === '!') {
        const b = asBoolean(n.argument);
        if (b !== null) return t.booleanLiteral(!b);
        return null;
    }
    if (n.operator === '-') {
        if (t.isNumericLiteral(n.argument)) {
            // Already canonical; leaving `-5` as `UnaryExpression(-, 5)` is the
            // standard Babel shape, so don't rewrite it.
            return null;
        }
        // -(-x) on literals → x
        if (
            t.isUnaryExpression(n.argument) &&
            n.argument.operator === '-' &&
            t.isNumericLiteral(n.argument.argument)
        ) {
            return t.numericLiteral(n.argument.argument.value);
        }
        return null;
    }
    if (n.operator === '+') {
        // +"123" → 123 (only for literal strings convertible cleanly).
        if (t.isStringLiteral(n.argument)) {
            const v = Number(n.argument.value);
            if (Number.isFinite(v)) return numericLiteral(v);
        }
        if (t.isNumericLiteral(n.argument)) return n.argument;
        if (t.isBooleanLiteral(n.argument)) return t.numericLiteral(n.argument.value ? 1 : 0);
        return null;
    }
    if (n.operator === '~') {
        const v = asNumeric(n.argument);
        if (v !== null) return numericLiteral(~toInt32(v));
    }
    return null;
}

// ---------------------------------------------------------------------------
// Binary

function foldBinary(n: t.BinaryExpression): t.Node | null {
    if (t.isPrivateName(n.left)) return null;
    const left = n.left;
    const right = n.right;
    const op = n.operator;

    // Numeric arithmetic.
    const lv = asNumeric(left);
    const rv = asNumeric(right);
    if (lv !== null && rv !== null) {
        const folded = evalNumericBinary(op, lv, rv);
        if (folded !== null && Number.isFinite(folded)) return numericLiteral(folded);
    }

    // String concat: "a" + "b" → "ab".
    if (op === '+' && t.isStringLiteral(left) && t.isStringLiteral(right)) {
        return t.stringLiteral(left.value + right.value);
    }
    // String + number → string concat (only when both literal).
    if (op === '+') {
        if (t.isStringLiteral(left) && rv !== null) return t.stringLiteral(left.value + String(rv));
        if (t.isStringLiteral(right) && lv !== null) return t.stringLiteral(String(lv) + right.value);
    }

    // Identities (require pure variable side because we drop the other side).
    if (op === '+' && rv === 0 && !mayHaveSideEffects(left)) return left;
    if (op === '+' && lv === 0 && !mayHaveSideEffects(right)) return right;
    if (op === '-' && rv === 0 && !mayHaveSideEffects(left)) return left;
    if (op === '*' && rv === 1 && !mayHaveSideEffects(left)) return left;
    if (op === '*' && lv === 1 && !mayHaveSideEffects(right)) return right;
    if (op === '/' && rv === 1 && !mayHaveSideEffects(left)) return left;

    // Comparisons on literal-literal.
    const cmp = evalComparison(op, left, right);
    if (cmp !== null) return t.booleanLiteral(cmp);

    return null;
}

// ---------------------------------------------------------------------------
// Logical: && || ??

function foldLogical(n: t.LogicalExpression): t.Node | null {
    if (n.operator === '&&') {
        const lb = asBoolean(n.left);
        if (lb === false) {
            return mayHaveSideEffects(n.left) ? null : n.left;
        }
        if (lb === true) {
            return mayHaveSideEffects(n.left) ? null : n.right;
        }
    }
    if (n.operator === '||') {
        const lb = asBoolean(n.left);
        if (lb === true) {
            return mayHaveSideEffects(n.left) ? null : n.left;
        }
        if (lb === false) {
            return mayHaveSideEffects(n.left) ? null : n.right;
        }
    }
    if (n.operator === '??') {
        if (t.isNullLiteral(n.left)) return n.right;
        if (
            t.isIdentifier(n.left) &&
            n.left.name === 'undefined'
        ) {
            return n.right;
        }
        // Any non-null/undefined literal short-circuits to the LHS.
        if (
            (t.isNumericLiteral(n.left) ||
                t.isStringLiteral(n.left) ||
                t.isBooleanLiteral(n.left)) &&
            !mayHaveSideEffects(n.left)
        ) {
            return n.left;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Helpers

function asNumeric(node: t.Node): number | null {
    if (t.isNumericLiteral(node)) return node.value;
    if (
        t.isUnaryExpression(node) &&
        node.operator === '-' &&
        t.isNumericLiteral(node.argument)
    ) {
        return -node.argument.value;
    }
    return null;
}

function asBoolean(node: t.Node): boolean | null {
    if (t.isBooleanLiteral(node)) return node.value;
    if (t.isNumericLiteral(node)) return node.value !== 0;
    if (t.isStringLiteral(node)) return node.value.length > 0;
    if (t.isNullLiteral(node)) return false;
    if (t.isIdentifier(node) && node.name === 'undefined') return false;
    return null;
}

function typeofLiteral(node: t.Node): string | null {
    if (t.isStringLiteral(node)) return 'string';
    if (t.isNumericLiteral(node)) return 'number';
    if (t.isBooleanLiteral(node)) return 'boolean';
    if (t.isNullLiteral(node)) return 'object';
    if (t.isIdentifier(node) && node.name === 'undefined') return 'undefined';
    if (t.isFunction(node)) return 'function';
    return null;
}

function numericLiteral(value: number): t.Expression {
    if (value < 0) {
        return t.unaryExpression('-', t.numericLiteral(-value));
    }
    return t.numericLiteral(value);
}

function evalNumericBinary(op: string, l: number, r: number): number | null {
    switch (op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': if (r === 0) return null; return l / r;
        case '%': if (r === 0) return null; return l % r;
        case '**': return l ** r;
        case '&': return toInt32(l) & toInt32(r);
        case '|': return toInt32(l) | toInt32(r);
        case '^': return toInt32(l) ^ toInt32(r);
        // Shift counts: JS masks the RHS to 5 bits — we let the engine do it.
        case '<<': return toInt32(l) << toInt32(r);
        case '>>': return toInt32(l) >> toInt32(r);
        case '>>>': return toUint32(l) >>> toInt32(r);
    }
    return null;
}

// JS ToInt32 (ECMA-262 §7.1.6) — fold semantics must match runtime.
function toInt32(v: number): number {
    return v | 0;
}
function toUint32(v: number): number {
    return v >>> 0;
}

// Fold `null?.x`, `null?.()`, `undefined?.x` → `undefined`. Any non-nullish
// LHS literal cancels the optional and is left to a separate pass.
function foldOptionalChain(n: t.OptionalMemberExpression | t.OptionalCallExpression): t.Node | null {
    if (!n.optional) return null;
    const head = t.isOptionalMemberExpression(n) ? n.object : n.callee;
    if (!head) return null;
    if (t.isNullLiteral(head) || (t.isIdentifier(head) && head.name === 'undefined')) {
        return t.identifier('undefined');
    }
    return null;
}

function evalComparison(op: string, left: t.Node, right: t.Node): boolean | null {
    const lv = asNumeric(left);
    const rv = asNumeric(right);
    if (lv !== null && rv !== null) {
        switch (op) {
            case '<': return lv < rv;
            case '<=': return lv <= rv;
            case '>': return lv > rv;
            case '>=': return lv >= rv;
            case '==': return lv == rv;
            case '!=': return lv != rv;
            case '===': return lv === rv;
            case '!==': return lv !== rv;
        }
    }
    if (t.isStringLiteral(left) && t.isStringLiteral(right)) {
        switch (op) {
            case '==': return left.value === right.value;
            case '!=': return left.value !== right.value;
            case '===': return left.value === right.value;
            case '!==': return left.value !== right.value;
            case '<': return left.value < right.value;
            case '<=': return left.value <= right.value;
            case '>': return left.value > right.value;
            case '>=': return left.value >= right.value;
        }
    }
    if (t.isBooleanLiteral(left) && t.isBooleanLiteral(right)) {
        switch (op) {
            case '==': return left.value === right.value;
            case '!=': return left.value !== right.value;
            case '===': return left.value === right.value;
            case '!==': return left.value !== right.value;
        }
    }
    return null;
}
