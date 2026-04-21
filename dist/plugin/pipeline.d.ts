import type * as t from '@babel/types';
import * as Effects from './analyses/effects';
import * as Zones from './analyses/zones';
/**
 * Simplifier state shared across a full pipeline run. Zones and effects are
 * cached per-node so repeat queries across transforms are cheap; both caches
 * survive the fixpoint loop.
 */
export type SimplifierState = {
    zones: Zones.State;
    effects: Effects.State;
};
export declare function initSimplifier(): SimplifierState;
/**
 * Run constfold → copyprop → dce to fixpoint, capped at MAX_ITERS.
 *
 * Each transform reports whether it mutated the AST; the loop exits when a
 * full round reports no change. Order matters:
 *   - constfold first: creates new literal-literal opportunities for copyprop
 *     and dead-binding targets for dce.
 *   - copyprop next: creates new dead bindings for dce to remove.
 *   - dce last: cleans up the dead bindings the earlier passes produced.
 */
export declare function runSimplifier(ast: t.File, state: SimplifierState): void;
