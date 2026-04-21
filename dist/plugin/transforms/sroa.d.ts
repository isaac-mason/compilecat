import * as t from '@babel/types';
/**
 * Scalar Replacement of Aggregates (SROA).
 *
 * Converts `const v = [a, b, c]` + constant-index accesses (`v[0]`, `v[1]`,
 * `v[2]`) into scalar locals `let v_0 = a, v_1 = b, v_2 = c` with the
 * accesses rewritten. This is purely a readability/codegen win for hot loops
 * that manipulate tuple-shaped data (vec3, quat, mat4) — downstream V8 can
 * keep the components in registers rather than as array slots.
 *
 * Opt-in via `/* @cc-sroa *​/` annotation on either:
 *   - the VariableDeclaration itself, or
 *   - an enclosing function / arrow-bound const.
 * File-level annotation is intentionally not supported — pick a scope.
 *
 * Safety is guarded by escape analysis on the declaring scope only (so a
 * same-name variable in another function doesn't create false escapes). A
 * candidate escapes on any non-indexed reference, spread, passing to a
 * function, assigning to another name, using a non-constant/out-of-bounds
 * index, or accessing a member property like `.length`.
 */
export type SroaOptions = Record<string, never>;
export declare function applySroa(ast: t.File): boolean;
