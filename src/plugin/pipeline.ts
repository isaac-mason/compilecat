import type * as t from '@babel/types';
import * as Effects from './analyses/effects';
import * as Zones from './analyses/zones';
import { applyConstfold } from './transforms/constfold';
import { applyCopyprop } from './transforms/copyprop';
import { applyDce } from './transforms/dce';

/**
 * Simplifier state shared across a full pipeline run. Zones and effects are
 * cached per-node so repeat queries across transforms are cheap; both caches
 * survive the fixpoint loop.
 */
export type SimplifierState = {
    zones: Zones.State;
    effects: Effects.State;
};

export function initSimplifier(): SimplifierState {
    return { zones: Zones.init(), effects: Effects.init() };
}

const MAX_ITERS = 8;

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
export function runSimplifier(ast: t.File, state: SimplifierState): void {
    for (let i = 0; i < MAX_ITERS; i++) {
        const foldChanged = applyConstfold(ast, { zones: state.zones, effects: state.effects });
        const copyChanged = applyCopyprop(ast, { zones: state.zones });
        const dceChanged = applyDce(ast, { zones: state.zones, effects: state.effects });
        if (!foldChanged && !copyChanged && !dceChanged) break;
    }
}
