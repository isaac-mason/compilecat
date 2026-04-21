import * as t from '@babel/types';
import * as Effects from '../analyses/effects';
import * as Zones from '../analyses/zones';
/**
 * Dead-code elimination for bindings inside opt-in zones.
 *
 * v1 scope:
 *   - A VariableDeclarator with a plain Identifier id and zero read references
 *     is dead. We delete the declarator; every write to the binding
 *     (constantViolation) is removed, or replaced by a bare expression
 *     statement if its RHS has side effects.
 *
 * Not yet handled (v2+):
 *   - Destructuring declarators with a mix of live/dead names.
 *   - Dead-store elimination (write overwritten before next read).
 *   - `let` → `const` collapse after writes are removed.
 *
 * Motivating case: post-SROA output of `getInverseInertiaForRotation` has
 * scalars like `inertiaRotMat_3, _7, _11..15` that are written (to zero) but
 * never read downstream. v1 drops these.
 */
export type Options = {
    zones: Zones.State;
    effects: Effects.State;
};
export declare function applyDce(ast: t.File, options: Options): boolean;
