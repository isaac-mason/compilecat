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
 * Per-function α-rename, ContextualRenamer-style
 * (MakeDeclaredNamesUnique.java:265-380). Walks nested scopes inside `fnPath`
 * top-down; for every owned binding whose base name has already been declared
 * *anywhere* within this function (ancestor OR sibling scope visited earlier),
 * renames it via Babel's `scope.rename` so the name becomes globally unique
 * inside the function subtree.
 *
 * This eager uniqueness is the invariant Closure's `isASTNormalized()`
 * actually promises, and it's what lets `tryMergeBlock` splice a nested
 * block into its parent with `ignoreBlockScopedDeclarations=true` without
 * any further collision checks — sibling collisions can't exist by
 * construction.
 *
 * Cost: more `__N` suffixes in intermediate output (Closure pays the same
 * cost). Since we feed a downstream bundler/minifier the suffix-noise is
 * absorbed at the next stage.
 *
 * Nested functions are skipped; they're renamed by their own invocation.
 */
export declare function renameForFlatten(fnPath: NodePath<t.Function>): number;
