import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { DIRECTIVE_PATTERNS, type DirectiveKind, OPTIMIZE_DIRECTIVES } from './directives';

/**
 * Opt-in annotation zones. Aggressive transforms in plugin-alt fire only
 * inside these zones, where we assume well-behaved JS semantics (no effectful
 * getters, no proxies, no `Symbol.toPrimitive` tricks on arithmetic).
 *
 * A node belongs to a zone iff the node itself or any ancestor up to Program
 * carries the matching block comment in its leadingComments.
 *
 * This module exists because the "does this path sit inside an `@sroa`
 * (etc.) scope?" query gets asked many times during a single pass. A
 * hand-rolled ancestor walk does the lookup per call; here we memoize per
 * node so the walk amortizes to O(1) per query after the first hit on each
 * ancestor path.
 *
 * `@optimize` is an umbrella that implies every body-level zone but
 * deliberately NOT `inline` — decl-visibility is a separate axis from
 * body-level aggressiveness. See directives.ts for the implied set.
 */

export type ZoneKind = DirectiveKind;

/**
 * Read direct-on-node zone annotations from block-comment leading comments.
 * An `@optimize` marker expands here into every implied zone — doing the
 * expansion at collection time keeps `isInZone` a plain WeakMap lookup.
 *
 * Line comments (`// @inline`) are intentionally ignored — keeps
 * annotations visually deliberate.
 */
function directZonesOn(node: t.Node): ZoneKind[] {
    const comments = node.leadingComments;
    if (!comments || comments.length === 0) return [];
    const result: ZoneKind[] = [];
    for (const c of comments) {
        if (c.type !== 'CommentBlock') continue;
        for (const kind of Object.keys(DIRECTIVE_PATTERNS) as ZoneKind[]) {
            if (DIRECTIVE_PATTERNS[kind].test(c.value)) {
                result.push(kind);
                if (kind === 'optimize') {
                    for (const implied of OPTIMIZE_DIRECTIVES) result.push(implied);
                }
            }
        }
    }
    return result;
}

export type State = ReturnType<typeof init>;

export function init() {
    return {
        // Each cached set covers the node's own annotations plus every ancestor
        // it was resolved against. Shared between nodes that share an ancestor
        // prefix, so repeated queries in the same function body are O(1).
        cache: new WeakMap<t.Node, ReadonlySet<ZoneKind>>(),
    };
}

/**
 * Drop every cached entry. Call after a transform moves nodes across scope
 * boundaries; zone membership depends on ancestors, so structural reshapes
 * can invalidate otherwise-stable entries. Local expression rewrites that
 * don't change parent chains are safe to leave cached.
 */
export function invalidateAll(state: State): void {
    state.cache = new WeakMap();
}

/** The full set of zones active for `path` (considering itself and all ancestors). */
export function activeZones(state: State, path: NodePath): ReadonlySet<ZoneKind> {
    const cached = state.cache.get(path.node);
    if (cached) return cached;

    const own = directZonesOn(path.node);
    const parent = path.parentPath;
    const parentZones = parent ? activeZones(state, parent) : EMPTY;

    if (own.length === 0) {
        state.cache.set(path.node, parentZones);
        return parentZones;
    }

    const combined = new Set<ZoneKind>(parentZones);
    for (const z of own) combined.add(z);
    state.cache.set(path.node, combined);
    return combined;
}

/** True iff `path` sits inside (or on) a node annotated with the given zone. */
export function isInZone(state: State, path: NodePath, kind: ZoneKind): boolean {
    return activeZones(state, path).has(kind);
}

const EMPTY: ReadonlySet<ZoneKind> = new Set();
