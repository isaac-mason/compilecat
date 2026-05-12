// Port of jscomp/graph/CheckPathsBetweenNodes.java
//
// Given a graph G and nodes A, B, decide whether all (or some) paths from A
// to B contain at least one node satisfying `nodePredicate`. Edges may be
// filtered by `edgePredicate`.
//
// Algorithm (per Closure / CLRS DFS-Visit):
//   1. DFS from A, coloring WHITE/GRAY/BLACK to discover back edges
//      (non-tree edges to a GRAY ancestor — i.e. cycle edges).
//   2. Recursively walk the back-edge-free subgraph from A to B. If the
//      walk reaches B without first hitting a node-predicate-true node,
//      that's a counter-example to "all paths satisfy".
//
// Uses graph.{nodeAnnotationStack,edgeAnnotationStack} via push/pop so the
// caller's pre-existing annotations survive the walk.

import type { DiGraph, DiGraphEdge, DiGraphNode } from './di-graph';
import { popEdgeAnnotations, popNodeAnnotations, pushEdgeAnnotations, pushNodeAnnotations } from './linked-directed-graph';

// Sentinel annotation values. Distinct object identities — checked by ===.
const BACK_EDGE: object = { tag: 'BACK_EDGE' };
const VISITED_EDGE: object = { tag: 'VISITED_EDGE' };
const GRAY: object = { tag: 'GRAY' };
const BLACK: object = { tag: 'BLACK' };
// WHITE is `undefined` (the default annotation slot value after a push).

type State<N, E> = {
    graph: DiGraph<N, E>;
    start: DiGraphNode<N, E>;
    end: DiGraphNode<N, E>;
    nodePredicate: (n: N) => boolean;
    edgePredicate: (e: DiGraphEdge<N, E>) => boolean;
    inclusive: boolean;
};

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
export function allPathsSatisfyPredicate<N, E>(opts: CheckPathsBetweenNodesOptions<N, E>): boolean {
    const state: State<N, E> = {
        graph: opts.graph,
        start: opts.start,
        end: opts.end,
        nodePredicate: opts.nodePredicate,
        edgePredicate: opts.edgePredicate,
        inclusive: opts.inclusive ?? true,
    };
    setUp(state);
    try {
        return checkAllPathsWithoutBackEdges(state, state.start);
    } finally {
        tearDown(state);
    }
}

/** True iff at least one non-looping path from start to end has a node
 *  satisfying nodePredicate. */
export function somePathsSatisfyPredicate<N, E>(opts: CheckPathsBetweenNodesOptions<N, E>): boolean {
    const state: State<N, E> = {
        graph: opts.graph,
        start: opts.start,
        end: opts.end,
        nodePredicate: opts.nodePredicate,
        edgePredicate: opts.edgePredicate,
        inclusive: opts.inclusive ?? true,
    };
    setUp(state);
    try {
        return checkSomePathsWithoutBackEdges(state, state.start);
    } finally {
        tearDown(state);
    }
}

function setUp<N, E>(s: State<N, E>): void {
    pushNodeAnnotations(s.graph);
    pushEdgeAnnotations(s.graph);
    discoverBackEdges(s, s.start);
}

function tearDown<N, E>(s: State<N, E>): void {
    popNodeAnnotations(s.graph);
    popEdgeAnnotations(s.graph);
}

function ignoreEdge<N, E>(s: State<N, E>, e: DiGraphEdge<N, E>): boolean {
    return !s.edgePredicate(e);
}

function discoverBackEdges<N, E>(s: State<N, E>, u: DiGraphNode<N, E>): void {
    u.annotation = GRAY;
    for (const e of u.outEdges) {
        if (ignoreEdge(s, e)) continue;
        const v = e.destination;
        if (v.annotation === undefined) {
            discoverBackEdges(s, v);
        } else if (v.annotation === GRAY) {
            e.annotation = BACK_EDGE;
        }
    }
    u.annotation = BLACK;
}

function isExcluded<N, E>(s: State<N, E>, n: DiGraphNode<N, E>): boolean {
    return !s.inclusive && (n === s.start || n === s.end);
}

function checkAllPathsWithoutBackEdges<N, E>(s: State<N, E>, a: DiGraphNode<N, E>): boolean {
    if (s.nodePredicate(a.value) && !isExcluded(s, a)) return true;
    if (a === s.end) return false;
    for (const e of a.outEdges) {
        if (e.annotation === VISITED_EDGE) continue;
        e.annotation = VISITED_EDGE;
        if (ignoreEdge(s, e)) continue;
        if (e.annotation === BACK_EDGE) continue;
        if (!checkAllPathsWithoutBackEdges(s, e.destination)) return false;
    }
    return true;
}

function checkSomePathsWithoutBackEdges<N, E>(s: State<N, E>, a: DiGraphNode<N, E>): boolean {
    if (s.nodePredicate(a.value) && !isExcluded(s, a)) return true;
    if (a === s.end) return false;
    for (const e of a.outEdges) {
        if (e.annotation === VISITED_EDGE) continue;
        e.annotation = VISITED_EDGE;
        if (ignoreEdge(s, e)) continue;
        if (e.annotation === BACK_EDGE) continue;
        if (checkSomePathsWithoutBackEdges(s, e.destination)) return true;
    }
    return false;
}
