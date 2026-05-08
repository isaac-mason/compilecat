import type { DiGraph, DiGraphEdge, DiGraphNode } from './di-graph';
export type CheckPathsBetweenNodesOptions<N, E> = {
    graph: DiGraph<N, E>;
    start: DiGraphNode<N, E>;
    end: DiGraphNode<N, E>;
    nodePredicate: (n: N) => boolean;
    edgePredicate: (e: DiGraphEdge<N, E>) => boolean;
    /**
     * If true (Closure default), `start` and `end` count toward satisfying the
     * node predicate. If false, only intermediate nodes count.
     */
    inclusive?: boolean;
};
/** True iff every non-looping path from start to end has at least one node
 *  satisfying nodePredicate. */
export declare function allPathsSatisfyPredicate<N, E>(opts: CheckPathsBetweenNodesOptions<N, E>): boolean;
/** True iff at least one non-looping path from start to end has a node
 *  satisfying nodePredicate. */
export declare function somePathsSatisfyPredicate<N, E>(opts: CheckPathsBetweenNodesOptions<N, E>): boolean;
