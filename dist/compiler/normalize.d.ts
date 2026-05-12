import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
export declare function isFileNormalized(file: t.Node): boolean;
export declare function markFileNormalized(file: t.Node): void;
export type NormalizeResult = {
    /** Always 0 — rename moved out of the file-level entry point. */
    renamed: number;
};
export declare function makeDeclaredNamesUnique(file: t.File): NormalizeResult;
/**
 * Per-function demand-driven α-rename. Walks nested scopes inside `fnPath`
 * top-down; for every owned binding whose base name is already declared by
 * an *ancestor* scope (within this function), renames it via Babel's
 * `scope.rename` so the binding doesn't shadow the ancestor name.
 *
 * Sibling scopes are intentionally NOT renamed against each other: two
 * sibling `if`-consequents can both declare `const dx` and never collide
 * because neither block ever ends up in the other's lexical scope. The
 * authored names are preserved for readability.
 *
 * If two sibling blocks both could be flattened into a shared statement-
 * block ancestor (rare: requires both siblings to be plain BlockStatements
 * sitting in the same parent statement list, not if/loop bodies), the
 * resulting name collision is caught at merge time by `tryMergeBlock`'s
 * sibling-collision guard — that block-merge is rejected instead.
 *
 * Nested functions are skipped; they're renamed by their own invocation.
 */
export declare function renameForFlatten(fnPath: NodePath<t.Function>): number;
