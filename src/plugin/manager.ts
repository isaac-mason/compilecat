import type * as t from '@babel/types';
import * as Zones from './analyses/zones';

/**
 * Bundle of every analysis state used across plugin-alt. Grows as analyses
 * land. Passes that need many analyses take a Manager.State; passes that
 * need one can take just that analysis's state directly.
 *
 * Each analysis module exports its own concrete State, init, get, and
 * invalidate. The manager just holds them together and forwards lifecycle
 * calls. No abstract registry, no kind strings — everything is concretely
 * typed.
 */
export type State = ReturnType<typeof init>;

export function init() {
    return {
        zones: Zones.init(),
        // effects: Effects.init(),
        // ... lands here when a transform consumes it
    };
}

/**
 * Drop every cached analysis for a file's AST. Call after a transform rewrites
 * a file and caches may be stale. Per-analysis `invalidate`/`invalidateAll`
 * remains available for finer control.
 */
export function invalidate(state: State, _file: t.File): void {
    // Most plugin-alt caches key by node identity and are WeakMaps, so a whole-
    // file invalidation drops everything that transitively referenced that
    // file's nodes. For zones specifically we go to invalidateAll because zone
    // membership depends on ancestor reshape, which a transform may have done.
    Zones.invalidateAll(state.zones);
}

export function invalidateAll(state: State): void {
    Zones.invalidateAll(state.zones);
}
