import * as t from '@babel/types';
import * as Zones from '../analyses/zones';
/**
 * Copy propagation inside opt-in zones.
 *
 * v1 scope:
 *   - `const x = y;` where `y` is an Identifier bound in-scope and `x` is
 *     effectively-const. Every read of `x` is rewritten to a read of `y`, and
 *     the declarator (plus empty enclosing declaration) is removed.
 *
 * Safety:
 *   - `y`'s binding must itself be effectively-const (no re-assignment), so
 *     reads of `x` and `y` always see the same value.
 *   - No shadowing of `y` between the declaration and any reference of `x`.
 *     Checked by resolving `y` in the reference's scope and comparing to the
 *     original binding.
 *   - Declarator must live in a plain VariableDeclaration statement — skip
 *     for-loop init forms.
 */
export type Options = {
    zones: Zones.State;
};
export declare function applyCopyprop(ast: t.File, options: Options): boolean;
