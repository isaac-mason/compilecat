import { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import * as Zones from '../analyses/zones';
import { traverse } from '../util/babel';

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

const AGGRESSIVE_ZONES = ['sroa', 'inline', 'unroll'] as const;

function inAggressiveZone(state: Zones.State, path: NodePath): boolean {
    const zones = Zones.activeZones(state, path);
    return AGGRESSIVE_ZONES.some((z) => zones.has(z));
}

export function applyCopyprop(ast: t.File, options: Options): boolean {
    traverse(ast, {
        Program(path) {
            path.scope.crawl();
        },
    });

    let changed = false;
    traverse(ast, {
        VariableDeclarator(path) {
            if (!inAggressiveZone(options.zones, path)) return;

            const { id, init } = path.node;
            if (!t.isIdentifier(id) || !init || !t.isIdentifier(init)) return;

            const xName = id.name;
            const yName = init.name;
            if (xName === yName) return;

            // Reject for-loop init forms — removing the declarator breaks the loop.
            const grandparent = path.parentPath?.parentPath;
            if (
                !grandparent ||
                grandparent.isForStatement() ||
                grandparent.isForInStatement() ||
                grandparent.isForOfStatement()
            ) {
                return;
            }

            const xBinding = path.scope.getBinding(xName);
            if (!xBinding || !xBinding.constant) return;

            const yBinding = path.scope.getBinding(yName);
            if (!yBinding || !yBinding.constant) return;

            // Shadow check: every reference of x must resolve yName to the same
            // binding we saw at the declaration site.
            for (const ref of xBinding.referencePaths) {
                if (ref.scope.getBinding(yName) !== yBinding) return;
            }

            for (const ref of xBinding.referencePaths) {
                ref.replaceWith(t.identifier(yName));
            }

            const declPath = path.parentPath;
            path.remove();
            if (
                declPath &&
                declPath.isVariableDeclaration() &&
                declPath.node.declarations.length === 0
            ) {
                declPath.remove();
            }
            changed = true;
        },
    });
    return changed;
}
