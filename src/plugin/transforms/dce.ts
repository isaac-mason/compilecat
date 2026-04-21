import { type Binding, type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as Effects from '../analyses/effects';
import * as Zones from '../analyses/zones';
import { traverse } from '../util/babel';

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

/** The set of zone kinds that allow aggressive simplification. */
const AGGRESSIVE_ZONES = ['sroa', 'inline', 'unroll'] as const;

function inAggressiveZone(state: Zones.State, path: NodePath): boolean {
    const zones = Zones.activeZones(state, path);
    return AGGRESSIVE_ZONES.some((z) => zones.has(z));
}

export function applyDce(ast: t.File, options: Options): boolean {
    // Scope data may be stale if prior passes (inline, SROA, unroll) mutated
    // the AST without re-crawling. Force a fresh scope walk so binding
    // reference counts reflect the current AST.
    traverse(ast, {
        Program(path) {
            path.scope.crawl();
        },
    });

    let changed = false;
    traverse(ast, {
        VariableDeclaration(path) {
            if (!inAggressiveZone(options.zones, path)) return;

            const declarators = path.get('declarations');
            for (const decl of declarators) {
                const id = decl.node.id;
                if (!t.isIdentifier(id)) continue;

                const binding = path.scope.getBinding(id.name);
                if (!binding) continue;
                if (binding.references > 0) continue;

                if (eliminateBinding(binding, decl, options.effects)) {
                    changed = true;
                }

                // eliminateBinding may replace the enclosing VariableDeclaration
                // (e.g. with an ExpressionStatement that preserves impure init
                // side effects). In that case this path is stale and we stop.
                if (!path.node || !t.isVariableDeclaration(path.node)) return;
            }

            // If we removed every declarator, babel may or may not have
            // auto-removed the surrounding VariableDeclaration. Clean up if
            // still present.
            if (path.node && t.isVariableDeclaration(path.node) && path.node.declarations.length === 0) {
                path.remove();
                changed = true;
            }
        },
    });
    return changed;
}

/**
 * Remove a dead binding: delete the declarator plus every write to it.
 * Returns true if the elimination succeeded (some writes may block it, e.g.
 * updates embedded in complex expressions we don't want to rewrite).
 */
function eliminateBinding(
    binding: Binding,
    declPath: NodePath<t.VariableDeclarator>,
    effectsState: Effects.State,
): boolean {
    // First, verify every write is in a shape we can safely rewrite. If any
    // violation is embedded (e.g., inside an argument list), bail — we'd need
    // to hoist side effects, which v1 doesn't do.
    for (const writePath of binding.constantViolations) {
        if (!isRemovableWrite(writePath)) return false;
    }

    // Remove writes. Pure writes disappear entirely; writes with an impure RHS
    // become expression statements so side effects survive.
    for (const writePath of binding.constantViolations) {
        removeWrite(writePath, effectsState);
    }

    // Remove the initializer's side effects too if impure.
    const initNode = declPath.node.init;
    if (initNode && !Effects.isPure(effectsState, initNode)) {
        // Replace the declaration with a bare expression statement for the
        // init, preserving side effects. Only do this if the declarator is
        // the sole one in its VariableDeclaration; otherwise we'd need to
        // insert a sibling statement, which complicates traversal.
        const parent = declPath.parent;
        if (t.isVariableDeclaration(parent) && parent.declarations.length === 1) {
            (declPath.parentPath as NodePath<t.VariableDeclaration>).replaceWith(
                t.expressionStatement(initNode),
            );
            return true;
        }
        // Mixed declaration: conservatively leave this binding alone.
        return false;
    }

    declPath.remove();
    return true;
}

/**
 * A write we can remove without losing statements we can't resynthesize. We
 * handle: assignment expressions used as statements (`x = foo();`) and update
 * expressions used as statements (`x++;`). Assignments buried inside other
 * expressions (e.g. `if ((x = foo())) ...`) would require hoisting and are
 * deferred.
 */
function isRemovableWrite(writePath: NodePath): boolean {
    if (writePath.isAssignmentExpression()) {
        // the write is removable if it sits directly in an ExpressionStatement
        return writePath.parentPath?.isExpressionStatement() ?? false;
    }
    if (writePath.isUpdateExpression()) {
        return writePath.parentPath?.isExpressionStatement() ?? false;
    }
    // VariableDeclarator itself registers as a constantViolation for the
    // binding's declaration — that's handled by the declarator removal.
    if (writePath.isVariableDeclarator()) return true;
    return false;
}

function removeWrite(writePath: NodePath, effectsState: Effects.State): void {
    if (writePath.isAssignmentExpression()) {
        const rhs = writePath.node.right;
        const stmt = writePath.parentPath as NodePath<t.ExpressionStatement>;
        if (Effects.isPure(effectsState, rhs)) {
            stmt.remove();
        } else {
            stmt.replaceWith(t.expressionStatement(rhs));
        }
        return;
    }
    if (writePath.isUpdateExpression()) {
        // `x++` on a dead binding: drop entirely. The read-of-x inside x++ has
        // no side effect (x is pure).
        const stmt = writePath.parentPath as NodePath<t.ExpressionStatement>;
        stmt.remove();
        return;
    }
    if (writePath.isVariableDeclarator()) {
        // handled by the declarator removal at call site
        return;
    }
}
