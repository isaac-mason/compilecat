// Port of jscomp/Normalize.java + jscomp/MakeDeclaredNamesUnique.java
// (ContextualRenamer subset).
//
// Two-stage pass mirroring Closure's NormalizeStatements + ContextualRenamer:
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
//   2. Renaming (ContextualRenamer):
//      Every locally-declared name is uniquified across the whole program.
//      After this pass, downstream passes (block-flatten, let→var lowering)
//      can act on the assumption that hoisting a binding out of an inner
//      block can never collide with another binding — the assumption Closure
//      encodes via NodeUtil.tryMergeBlock's `ignoreBlockScopedDeclarations`
//      flag passed as `isASTNormalized()`.
//
// Algorithm (mirrors ContextualRenamer in MakeDeclaredNamesUnique.java:683):
//
//   - Maintain a shared `nameUsage` Map<string, count> for the whole file —
//     tracks how many times each base name has been declared anywhere.
//   - Walk every scope top-down. For each binding declared directly in the
//     scope:
//       * If scope is the file's program (global) → reserve name as-is.
//         Closure leaves global names unchanged so external references stay
//         valid.
//       * Otherwise → increment count for the base name. If new count is 1
//         (first occurrence anywhere) keep the name; if > 1 generate
//         `name__<id>` and reserve. If the generated name itself
//         collides, retry with an incremented id (mirrors Closure's
//         `while (nameUsage.contains(newName))` retry loop).
//   - Use Babel's `scope.rename(oldName, newName)` to update the binding and
//     every reference atomically. Babel's scope analysis handles the
//     reference-following Closure does manually via its renamer stack.
//
// Departures from Closure:
//   - We rely on Babel scope analysis instead of porting Closure's
//     ScopedCallback + Renamer-stack machinery. The semantic outcome is the
//     same: every local binding is uniquely named after the pass.
//   - `ARGUMENTS` is irrelevant — Babel doesn't surface it as a binding.
//   - No `assertOnChange` / `markChanges` modes — those are Closure
//     pass-management concerns.
//
// Marker:
//   The exported `markFileNormalized` / `isFileNormalized` pair lets later
//   passes check `isASTNormalized()`-equivalent state. Backed by a WeakSet
//   keyed on the File node.

import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

import { traverse } from './babel-interop';

// Closure's literal constant is `$jscomp$` (MakeDeclaredNamesUnique.java:697).
// We diverge intentionally for readability: double-underscore is shorter,
// reads as a "compiler-generated" marker in any JS code, and avoids `$` so
// the suffix can't be visually mistaken for template-literal `${…}` syntax.
// User code rarely contains `foo__1`; the collision-retry loop in
// `pickReplacement` covers the rare case where it does.
const UNIQUE_ID_SEPARATOR = '__';

const NORMALIZED = new WeakSet<t.Node>();

export function isFileNormalized(file: t.Node): boolean {
    return NORMALIZED.has(file);
}

export function markFileNormalized(file: t.Node): void {
    NORMALIZED.add(file);
}

export type NormalizeResult = {
    /** Number of bindings renamed. */
    renamed: number;
};

export function makeDeclaredNamesUnique(file: t.File): NormalizeResult {
    // Stage 1: structural normalizations. These run before the rename pass so
    // that the rename pass sees the post-split / post-hoist binding shape (and
    // so that scope.crawl picks up bindings hoisted out of for-headers).
    structuralNormalize(file);

    const nameUsage = new Map<string, number>();
    let renamed = 0;

    // Reserve every name that appears at the program (global) scope first, so
    // child scopes never pick a generated name that shadows a global.
    traverse(file, {
        Program(programPath) {
            for (const name of Object.keys(programPath.scope.bindings)) {
                reserveName(nameUsage, name);
            }
            programPath.skip();
        },
    });

    // Then visit every nested scope top-down and rename collisions.
    traverse(file, {
        Scope(path) {
            // The Program scope was handled above (names reserved, no rename).
            if (path.isProgram()) return;

            const bindings = path.scope.bindings;
            for (const baseName of Object.keys(bindings)) {
                const binding = bindings[baseName];
                if (binding === undefined) continue;
                // Only rename bindings owned by *this* scope. Babel surfaces
                // some inherited entries on `bindings` only for the owning
                // scope itself, but be defensive.
                if (binding.scope !== path.scope) continue;

                // Skip function parameters. Closure's ContextualRenamer exists
                // to make hoist-friendly names for later block-flatten / let→
                // var lowering — those passes never cross function boundaries,
                // so the param contract is already isolated. Renaming params
                // here pollutes the output with `__N` suffixes on names the
                // user authored, and (more importantly) belongs to the
                // inliner's `InlineRenamer`-equivalent — which renames a
                // callee's params at the call site as part of inlining, not
                // here.
                if (binding.kind === 'param') {
                    // Reserve the param's name so synthetic `name__N` later
                    // can't shadow it accidentally.
                    reserveName(nameUsage, baseName);
                    continue;
                }

                const newName = pickReplacement(nameUsage, baseName);
                if (newName === null) {
                    // First occurrence anywhere — keep the name, just count it.
                    continue;
                }
                renameBinding(path, baseName, newName);
                renamed++;
            }
        },
    });

    markFileNormalized(file);
    return { renamed };
}

function reserveName(nameUsage: Map<string, number>, name: string): void {
    if ((nameUsage.get(name) ?? 0) < 1) nameUsage.set(name, 1);
}

/** Returns the new name, or null if the base name is still free. */
function pickReplacement(nameUsage: Map<string, number>, baseName: string): string | null {
    const prev = nameUsage.get(baseName) ?? 0;
    nameUsage.set(baseName, prev + 1);
    if (prev === 0) {
        // First time we've seen this name anywhere — keep it as-is.
        return null;
    }
    // Collision: produce `baseName__<id>`. If that itself collides
    // (another scope already used or reserved that synthetic name), bump.
    let id = prev;
    let candidate = `${baseName}${UNIQUE_ID_SEPARATOR}${id}`;
    while ((nameUsage.get(candidate) ?? 0) > 0) {
        id++;
        candidate = `${baseName}${UNIQUE_ID_SEPARATOR}${id}`;
    }
    nameUsage.set(candidate, 1);
    // Keep the base counter consistent with the id we ultimately picked so
    // the next collision starts from a higher number.
    if (id > prev) nameUsage.set(baseName, id + 1);
    return candidate;
}

function renameBinding(path: NodePath, oldName: string, newName: string): void {
    // Babel's scope.rename updates the binding identifier plus every
    // reference to it within this scope. It also updates child scopes'
    // bindings/references because they share the parent's reference set.
    path.scope.rename(oldName, newName);
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
