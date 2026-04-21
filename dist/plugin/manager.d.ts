import type * as t from '@babel/types';
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
export declare function init(): {
    zones: {
        cache: WeakMap<t.Node, ReadonlySet<import("./analyses/directives").DirectiveKind>>;
    };
};
/**
 * Drop every cached analysis for a file's AST. Call after a transform rewrites
 * a file and caches may be stale. Per-analysis `invalidate`/`invalidateAll`
 * remains available for finer control.
 */
export declare function invalidate(state: State, _file: t.File): void;
export declare function invalidateAll(state: State): void;
