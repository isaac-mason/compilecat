import * as t from '@babel/types';
/**
 * Find every parameter (by name) that is reassigned anywhere in the body.
 * Reassignment includes `=`, compound assigns (`+=` etc.), `++`/`--`, and
 * destructuring writes. Property writes (`out[0] = ...`, `out.x = ...`) are
 * NOT reassignments — they mutate the referent, not the binding.
 */
export declare function gatherModifiedParameters(body: t.BlockStatement, paramNames: ReadonlySet<string>): Set<string>;
export type ArgClassification = {
    /** Set of param names that require a `let X = arg;` temp binding. Params
     *  not in this set are substituted directly into the body. */
    needsTemp: Set<string>;
};
export declare function gatherCallArgumentsNeedingTemps(body: t.BlockStatement, paramNames: readonly string[], args: readonly t.Expression[], modifiedParameters: ReadonlySet<string>): ArgClassification;
/**
 * Substitute each Identifier reference matching a key in `replacements` with
 * a deep clone of the corresponding expression. Mirrors Closure's
 * FunctionArgumentInjector.inject — declaration-id contexts and nested-scope
 * shadowing are respected.
 */
export declare function injectArguments(body: t.BlockStatement, replacements: Map<string, t.Expression>): void;
