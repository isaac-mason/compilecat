// Port of jscomp/Normalize.java + jscomp/MakeDeclaredNamesUnique.java
// (InlineRenamer-style subset).
//
// Two stages:
//
//   1. Structural normalizations (Closure NormalizeStatements):
//      - Rewrite blockless arrow function bodies to block-with-return
//        (Normalize.java:387-397). Downstream analyses can then assume every
//        function body is a BlockStatement.
//      - Split multi-declarator var/let/const into one statement per
//        declarator (Normalize.java:645-661). Lets DAE / flow-inline / fold
//        treat each binding independently.
//      - Hoist for-loop initializers out of the loop header
//        (Normalize.java:558-632). `for (var a=0; …)` →
//        `var a=0; for (; …)`. Frees the CFG builder from special-casing
//        for-init liveness. Skipped for `let`/`const`/`class`/`function`
//        per-iteration block-scoped semantics.
//
//   2. Demand-driven α-rename (`renameForFlatten`, run per-function from the
//      simplifier — not from this file's entry):
//      Models Closure's InlineRenamer (MakeDeclaredNamesUnique.java:497-562):
//      rename only where a collision is actually possible. Closure's
//      ContextualRenamer (file-wide eager rename) sprays `__N` suffixes
//      across every function that happens to share a name with any other
//      function's locals — even when those names will never end up in the
//      same scope. The output noise (`cp__3`, `i__7`) makes the intermediate
//      code we ship to a bundler much harder to read.
//
//      Instead, we rename only within a single function's own subtree, and
//      only when a nested block's binding would clash with an ancestor binding
//      *within that same function*. Cross-function name reuse is left alone
//      — distinct function scopes can never collide.
//
//      After the rename, every let/const/class/fn-decl owned by a nested
//      scope inside the function is unique with respect to the function
//      scope and every other nested scope. This is the invariant that
//      `NodeUtil.tryMergeBlock`'s `ignoreBlockScopedDeclarations=true` flag
//      (Closure's `isASTNormalized()`) relies on — flattening any nested
//      block into its parent can't introduce duplicate let/const bindings.
//
// Marker:
//   The exported `markFileNormalized` / `isFileNormalized` pair records that
//   structural normalization ran. It does *not* imply that names have been
//   uniquified — call `renameForFlatten` on a specific function before
//   relaxing block-merge safety for that function.

import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

import { traverse } from './babel-interop';

// Closure's literal constant is `$jscomp$` (MakeDeclaredNamesUnique.java:697).
// We diverge intentionally for readability: double-underscore is shorter,
// reads as a "compiler-generated" marker in any JS code, and avoids `$` so
// the suffix can't be visually mistaken for template-literal `${…}` syntax.
const UNIQUE_ID_SEPARATOR = '__';

const NORMALIZED = new WeakSet<t.Node>();

export function isFileNormalized(file: t.Node): boolean {
    return NORMALIZED.has(file);
}

export function markFileNormalized(file: t.Node): void {
    NORMALIZED.add(file);
}

export type NormalizeResult = {
    /** Always 0 — rename moved out of the file-level entry point. */
    renamed: number;
};

export function makeDeclaredNamesUnique(file: t.File): NormalizeResult {
    structuralNormalize(file);
    markFileNormalized(file);
    return { renamed: 0 };
}

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
export function renameForFlatten(fnPath: NodePath<t.Function>): number {
    let renamed = 0;

    const fnScope = fnPath.scope;

    // Stack-shaped: `active` holds names that are visible at the current
    // traversal position — i.e. declared by some ancestor scope (within
    // this function). Synthetic-suffix counter is global per function so
    // `__1`, `__2` don't collide across distinct rename sites.
    const active = new Set<string>();
    const allNames = new Set<string>();
    for (const name of Object.keys(fnScope.bindings)) {
        active.add(name);
        allNames.add(name);
    }

    type Frame = { added: string[] };
    const frames = new WeakMap<t.Node, Frame>();

    fnPath.traverse({
        Scope: {
            enter(p) {
                // Inner functions own their own rename pass; don't descend.
                if (p.isFunction()) {
                    p.skip();
                    return;
                }
                // Function-body Block / Program / etc. that share fnScope
                // are already in `active`.
                if (p.scope === fnScope) return;

                const added: string[] = [];
                const bindings = p.scope.bindings;
                for (const baseName of Object.keys(bindings)) {
                    const binding = bindings[baseName];
                    if (binding === undefined) continue;
                    if (binding.scope !== p.scope) continue;
                    // Catch-clause params show up here. They never participate
                    // in block-flatten, so leaving them as-is is safe.
                    if (binding.kind === 'param') continue;

                    if (allNames.has(baseName)) {
                        // Already declared somewhere in this function
                        // (ancestor or earlier-visited sibling) — rename.
                        const newName = pickFreshName(baseName, allNames);
                        p.scope.rename(baseName, newName);
                        active.add(newName);
                        allNames.add(newName);
                        added.push(newName);
                        renamed++;
                    } else {
                        active.add(baseName);
                        allNames.add(baseName);
                        added.push(baseName);
                    }
                }
                if (added.length > 0) frames.set(p.node, { added });
            },
            exit(p) {
                const frame = frames.get(p.node);
                if (frame === undefined) return;
                for (const n of frame.added) active.delete(n);
                frames.delete(p.node);
            },
        },
    });

    return renamed;
}

function pickFreshName(baseName: string, allNames: Set<string>): string {
    let id = 1;
    let candidate = `${baseName}${UNIQUE_ID_SEPARATOR}${id}`;
    while (allNames.has(candidate)) {
        id++;
        candidate = `${baseName}${UNIQUE_ID_SEPARATOR}${id}`;
    }
    return candidate;
}

// ---------------------------------------------------------------------------
// Structural normalizations.
//
// Mirrors Closure's NormalizeStatements callback (Normalize.java:215+).
// Each helper is a literal port of the corresponding Java method; see
// referenced line numbers.

function structuralNormalize(file: t.File): void {
    // Two visitors so we don't have to coordinate insertions during traversal:
    //   1. visitFunction — arrow→block (Normalize.java:387-397).
    //   2. statementBlockPasses — split decls + extract for-init.
    //
    // Babel's traverse will revisit hoisted nodes appropriately; we use enter
    // for arrow rewrite (so its body is then visited normally) and exit-time
    // mutation for the others to avoid invalidating the iteration.

    traverse(file, {
        ArrowFunctionExpression(path) {
            const node = path.node;
            if (!t.isBlockStatement(node.body)) {
                const body = node.body;
                node.body = t.blockStatement([t.returnStatement(body)]);
            }
        },
    });

    // Split + for-init extraction. Closure runs both at the statement-block
    // level (Normalize.java:404-416). We walk Program/BlockStatement bodies
    // directly so we can splice without invalidating Babel paths.
    //
    // Closure also runs extractForInitializer when the parent is a LABEL
    // (Normalize.java:407, isStatementBlock || isLabel). We handle that via
    // the LabeledStatement visitor below — the hoisted var is inserted into
    // the *grandparent* statement list, so we mutate via an enclosing
    // wrapper-block rewrite when needed.
    traverse(file, {
        Program: { exit: (p) => normalizeStatementList(p.node.body) },
        BlockStatement: { exit: (p) => normalizeStatementList(p.node.body) },
    });

    // Labeled-for: if a `LABEL: for (var i=0;…)` survives, the for is the
    // label's only body. Wrap as `{ var i=0; LABEL: for (;…) }` only if the
    // label's parent already is a statement-block — otherwise leave it alone
    // (rare; semantics-preserving fallback).
    traverse(file, {
        LabeledStatement: {
            exit(p) {
                const node = p.node;
                let extracted: t.Statement | null = null;
                if (t.isForStatement(node.body)) {
                    extracted = extractForInitializer(node.body);
                } else if (t.isForInStatement(node.body) || t.isForOfStatement(node.body)) {
                    extracted = extractForInOfInitializer(node.body);
                }
                if (extracted === null) return;
                const parent = p.parent;
                const parentBody = (parent as { body?: t.Statement[] }).body;
                if (Array.isArray(parentBody)) {
                    const idx = parentBody.indexOf(node);
                    if (idx >= 0) {
                        parentBody.splice(idx, 0, extracted);
                        return;
                    }
                }
                // Fallback: replace label with `{ extracted; label }`.
                p.replaceWith(t.blockStatement([extracted, node]));
            },
        },
    });
}

/** Mirrors Closure's loop in `extractForInitializer` + `splitVarDeclarations`
 *  applied to a single statement list (Normalize.java:558-661). Mutates the
 *  list in place. */
function normalizeStatementList(list: t.Statement[]): void {
    // Pass A — extract for-init. Closure runs this before splitVarDeclarations
    // (Normalize.java:407-416) so the hoisted-out var-statement gets split in
    // pass B if it's multi-declarator.
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (t.isForStatement(s)) {
            const inserted = extractForInitializer(s);
            if (inserted !== null) {
                list.splice(i, 0, inserted);
                i++; // skip the just-inserted node
            }
        } else if (t.isForInStatement(s) || t.isForOfStatement(s)) {
            const inserted = extractForInOfInitializer(s);
            if (inserted !== null) {
                list.splice(i, 0, inserted);
                i++;
            }
        }
    }

    // Pass B — split multi-declarator decls.
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!t.isVariableDeclaration(s)) continue;
        if (s.declarations.length <= 1) continue;
        const split: t.VariableDeclaration[] = s.declarations.map((d) =>
            t.variableDeclaration(s.kind, [d]),
        );
        list.splice(i, 1, ...split);
        i += split.length - 1;
    }
}

/** Port of Normalize.java:604-628 (FOR case). Returns the new statement to
 *  insert before the for, or null if no extraction. Mutates `loop.init`. */
function extractForInitializer(loop: t.ForStatement): t.Statement | null {
    const init = loop.init;
    if (init === null || init === undefined) return null;

    if (t.isVariableDeclaration(init)) {
        // Closure skips block-scoped (let/const/class/function) initializers
        // — their per-iteration semantics matter (Normalize.java:608-610).
        if (init.kind !== 'var') return null;
        loop.init = null;
        return init;
    }
    // Expression initializer — wrap in ExprStatement.
    loop.init = null;
    return t.expressionStatement(init);
}

/** Port of Normalize.java:566-602 (FOR_IN/FOR_OF case). Only handles
 *  `for (var x in/of y)` → `var x; for (x in/of y);`. Returns the new
 *  statement, or null if no extraction. Mutates `loop.left`. */
function extractForInOfInitializer(
    loop: t.ForInStatement | t.ForOfStatement,
): t.Statement | null {
    const left = loop.left;
    if (!t.isVariableDeclaration(left)) return null;
    if (left.kind !== 'var') return null;
    if (left.declarations.length !== 1) return null;
    const decl = left.declarations[0];
    if (!t.isIdentifier(decl.id)) return null;
    // Closure clones the name into the for-head and inserts the original VAR
    // before the loop (Normalize.java:597-599). We do the same with a fresh
    // Identifier.
    loop.left = t.identifier(decl.id.name);
    // Strip any initializer — semantically valid only on the rare
    // `for (var x = 0 in obj)` legacy form (Babel parses it; we drop the
    // initializer when hoisting since `for-in` doesn't initialize).
    return t.variableDeclaration('var', [t.variableDeclarator(t.identifier(decl.id.name))]);
}
