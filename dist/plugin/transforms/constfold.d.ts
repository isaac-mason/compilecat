import * as t from '@babel/types';
import * as Effects from '../analyses/effects';
import * as Zones from '../analyses/zones';
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
export declare function applyConstfold(ast: t.File, options: Options): boolean;
