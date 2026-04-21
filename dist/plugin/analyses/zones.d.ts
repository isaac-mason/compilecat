import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { type DirectiveKind } from './directives';
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
export type State = ReturnType<typeof init>;
export declare function init(): {
    cache: WeakMap<t.Node, ReadonlySet<DirectiveKind>>;
};
/**
 * Drop every cached entry. Call after a transform moves nodes across scope
 * boundaries; zone membership depends on ancestors, so structural reshapes
 * can invalidate otherwise-stable entries. Local expression rewrites that
 * don't change parent chains are safe to leave cached.
 */
export declare function invalidateAll(state: State): void;
/** The full set of zones active for `path` (considering itself and all ancestors). */
export declare function activeZones(state: State, path: NodePath): ReadonlySet<ZoneKind>;
/** True iff `path` sits inside (or on) a node annotated with the given zone. */
export declare function isInZone(state: State, path: NodePath, kind: ZoneKind): boolean;
