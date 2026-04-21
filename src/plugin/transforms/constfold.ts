import { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as Effects from '../analyses/effects';
import * as Zones from '../analyses/zones';
import { traverse } from '../util/babel';

/**
 * Constant folding inside opt-in zones.
 *
 * v1 scope:
 *   - Literal-literal arithmetic on numbers: +, -, *, /, % (skip /0 and %0).
 *   - Arithmetic identities: x+0, 0+x, x-0, x*1, 1*x, x/1 → x (x must be pure).
 *   - Unary negation of a numeric literal is recognized as a numeric operand
 *     (so `-5 + 2` folds to `-3`).
 *
 * Not yet handled:
 *   - String concat or BigInt.
 *   - Bitwise, shift, comparison, or short-circuit operators.
 *   - x*0, 0*x → 0 (unsafe in the general case: NaN/Infinity propagation).
 *   - Double-negation collapse.
 */

export type Options = {
    zones: Zones.State;
    effects: Effects.State;
};

const AGGRESSIVE_ZONES = ['sroa', 'inline', 'unroll'] as const;

function inAggressiveZone(state: Zones.State, path: NodePath): boolean {
    const zones = Zones.activeZones(state, path);
    return AGGRESSIVE_ZONES.some((z) => zones.has(z));
}

/** Read a numeric literal, possibly wrapped in a single unary `-`. */
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

function numericLiteral(value: number): t.Expression {
    if (value < 0) {
        return t.unaryExpression('-', t.numericLiteral(-value));
    }
    return t.numericLiteral(value);
}

export function applyConstfold(ast: t.File, options: Options): boolean {
    let changed = false;
    traverse(ast, {
        BinaryExpression: {
            exit(path) {
                if (!inAggressiveZone(options.zones, path)) return;
                if (fold(path, options.effects)) changed = true;
            },
        },
    });
    return changed;
}

function fold(path: NodePath<t.BinaryExpression>, effects: Effects.State): boolean {
    const { operator, left, right } = path.node;
    if (t.isPrivateName(left)) return false;

    const lv = asNumeric(left);
    const rv = asNumeric(right);

    // literal-literal fold
    if (lv !== null && rv !== null) {
        const folded = evalBinary(operator, lv, rv);
        if (folded !== null && Number.isFinite(folded)) {
            path.replaceWith(numericLiteral(folded));
            return true;
        }
    }

    // identities — the variable side must be pure so dropping side effects is safe
    if (operator === '+' && rv === 0 && Effects.isPure(effects, left)) {
        path.replaceWith(left);
        return true;
    }
    if (operator === '+' && lv === 0 && Effects.isPure(effects, right)) {
        path.replaceWith(right);
        return true;
    }
    if (operator === '-' && rv === 0 && Effects.isPure(effects, left)) {
        path.replaceWith(left);
        return true;
    }
    if (operator === '*' && rv === 1 && Effects.isPure(effects, left)) {
        path.replaceWith(left);
        return true;
    }
    if (operator === '*' && lv === 1 && Effects.isPure(effects, right)) {
        path.replaceWith(right);
        return true;
    }
    if (operator === '/' && rv === 1 && Effects.isPure(effects, left)) {
        path.replaceWith(left);
        return true;
    }
    return false;
}

function evalBinary(op: string, l: number, r: number): number | null {
    switch (op) {
        case '+':
            return l + r;
        case '-':
            return l - r;
        case '*':
            return l * r;
        case '/':
            if (r === 0) return null;
            return l / r;
        case '%':
            if (r === 0) return null;
            return l % r;
        default:
            return null;
    }
}
