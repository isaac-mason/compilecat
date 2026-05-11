import * as t from '@babel/types';
import { type Tri } from './tri';
export declare function mayHaveSideEffects(node: t.Node): boolean;
/**
 * Closure's `getSideEffectFreeBooleanValue` — returns the boolean value the
 * expression would evaluate to (as a Tri) but only when the expression has no
 * side effects; UNKNOWN otherwise. Used in cond rewriting to gate moves like
 * `x || true → true` (only safe when `x` is pure).
 */
export declare function getSideEffectFreeBooleanValue(node: t.Node): Tri;
export declare function isPure(node: t.Node): boolean;
