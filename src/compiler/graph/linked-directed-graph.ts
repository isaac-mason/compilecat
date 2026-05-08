// Port of jscomp/graph/LinkedDirectedGraph.java
//
// Concrete impl of DiGraph. Closure splits this from the abstract DiGraph for
// Java-OOP reasons; in TS the interface lives in DiGraph.ts and this file
// holds the functions that build/mutate it.
//
// Simplifications vs Closure:
//   - No `useNodeAnnotations` / `useEdgeAnnotations` flags. The annotation
//     slot always exists; callers that don't use it just ignore it. The dual
//     (Annotated)LinkedDiGraphNode/Edge class hierarchy collapses.
//   - No Graphviz interface, no SubGraph. Not needed by the analyses we port.
//   - Methods become module-level functions taking the graph as first arg.

import type { Annotation } from './annotation';
import type { DiGraph, DiGraphEdge, DiGraphNode } from './di-graph';

export function createDiGraph<N, E>(): DiGraph<N, E> {
    return {
        nodes: new Map(),
        nodeAnnotationStack: [],
        edgeAnnotationStack: [],
    };
}

/** Idempotent: returns the existing node if `value` is already present. */
export function createNode<N, E>(graph: DiGraph<N, E>, value: N): DiGraphNode<N, E> {
    let node = graph.nodes.get(value);
    if (node === undefined) {
        node = {
            value,
            outEdges: [],
            inEdges: [],
            annotation: undefined,
            priority: -1,
        };
        graph.nodes.set(value, node);
    }
    return node;
}

export function getNode<N, E>(graph: DiGraph<N, E>, value: N): DiGraphNode<N, E> | undefined {
    return graph.nodes.get(value);
}

function getNodeOrFail<N, E>(graph: DiGraph<N, E>, value: N): DiGraphNode<N, E> {
    const n = graph.nodes.get(value);
    if (n === undefined) throw new Error(`graph: node not found for value ${String(value)}`);
    return n;
}

/**
 * Add an edge from `src` to `dest` carrying `edgeValue`. Both endpoints must
 * already be in the graph (use createNode first if needed). Mirrors Closure's
 * `connect(N, E, N)` — does NOT dedupe; multiple edges between the same pair
 * are allowed.
 */
export function connect<N, E>(
    graph: DiGraph<N, E>,
    srcValue: N,
    edgeValue: E,
    destValue: N,
): DiGraphEdge<N, E> {
    const src = getNodeOrFail(graph, srcValue);
    const dest = getNodeOrFail(graph, destValue);
    return connectNodes(src, edgeValue, dest);
}

/** Direct-node variant; preferred when callers already hold the nodes. */
export function connectNodes<N, E>(
    src: DiGraphNode<N, E>,
    edgeValue: E,
    dest: DiGraphNode<N, E>,
): DiGraphEdge<N, E> {
    const edge: DiGraphEdge<N, E> = {
        source: src,
        destination: dest,
        value: edgeValue,
        annotation: undefined,
    };
    src.outEdges.push(edge);
    dest.inEdges.push(edge);
    return edge;
}

/**
 * Like connect, but only adds an edge if one doesn't already exist (matching
 * by edgeValue) between the two nodes. Creates nodes if absent.
 */
export function connectIfNotConnectedInDirection<N, E>(
    graph: DiGraph<N, E>,
    srcValue: N,
    edgeValue: E,
    destValue: N,
): void {
    const src = createNode(graph, srcValue);
    const dest = createNode(graph, destValue);
    if (!isConnectedInDirection(src, dest, (v) => v === edgeValue)) {
        connectNodes(src, edgeValue, dest);
    }
}

/** Removes every edge in either direction between n1 and n2. */
export function disconnect<N, E>(graph: DiGraph<N, E>, n1: N, n2: N): void {
    disconnectInDirection(graph, n1, n2);
    disconnectInDirection(graph, n2, n1);
}

export function disconnectInDirection<N, E>(graph: DiGraph<N, E>, srcValue: N, destValue: N): void {
    const src = getNodeOrFail(graph, srcValue);
    const dest = getNodeOrFail(graph, destValue);
    const toRemove: DiGraphEdge<N, E>[] = [];
    for (const e of src.outEdges) {
        if (e.destination === dest) toRemove.push(e);
    }
    for (const e of toRemove) {
        removeFromArray(src.outEdges, e);
        removeFromArray(dest.inEdges, e);
    }
}

function removeFromArray<T>(arr: T[], el: T): void {
    const i = arr.indexOf(el);
    if (i >= 0) arr.splice(i, 1);
}

export function getOutEdges<N, E>(graph: DiGraph<N, E>, value: N): DiGraphEdge<N, E>[] {
    return getNodeOrFail(graph, value).outEdges;
}

export function getInEdges<N, E>(graph: DiGraph<N, E>, value: N): DiGraphEdge<N, E>[] {
    return getNodeOrFail(graph, value).inEdges;
}

/** All edges from `n1` to `n2` (one direction only). */
export function getEdgesInDirection<N, E>(
    graph: DiGraph<N, E>,
    n1: N,
    n2: N,
): DiGraphEdge<N, E>[] {
    const a = getNodeOrFail(graph, n1);
    const b = getNodeOrFail(graph, n2);
    const out: DiGraphEdge<N, E>[] = [];
    for (const e of a.outEdges) {
        if (e.destination === b) out.push(e);
    }
    return out;
}

/**
 * Whether `source` reaches `dest` via a single edge whose value passes
 * `edgeFilter`. Matches Closure's optimization of scanning the shorter of
 * src.outEdges / dest.inEdges.
 */
export function isConnectedInDirection<N, E>(
    source: DiGraphNode<N, E>,
    dest: DiGraphNode<N, E>,
    edgeFilter: (v: E) => boolean,
): boolean {
    if (source.outEdges.length < dest.inEdges.length) {
        for (const e of source.outEdges) {
            if (e.destination === dest && edgeFilter(e.value)) return true;
        }
    } else {
        for (const e of dest.inEdges) {
            if (e.source === source && edgeFilter(e.value)) return true;
        }
    }
    return false;
}

export function getDirectedPredNodes<N, E>(node: DiGraphNode<N, E>): DiGraphNode<N, E>[] {
    return node.inEdges.map((e) => e.source);
}

export function getDirectedSuccNodes<N, E>(node: DiGraphNode<N, E>): DiGraphNode<N, E>[] {
    return node.outEdges.map((e) => e.destination);
}

export function getNodeCount<N, E>(graph: DiGraph<N, E>): number {
    return graph.nodes.size;
}

// ---------------------------------------------------------------------------
// Annotation push/pop
//
// Closure uses these to snapshot every node+edge annotation into a stack so
// algorithms can scribble into the slot temporarily and restore on exit.
// CheckPathsBetweenNodes uses this for DFS coloring.

export function pushNodeAnnotations<N, E>(graph: DiGraph<N, E>): void {
    const snap = new Map<DiGraphNode<N, E>, Annotation | undefined>();
    for (const node of graph.nodes.values()) {
        snap.set(node, node.annotation);
        node.annotation = undefined;
    }
    graph.nodeAnnotationStack.push(snap);
}

export function popNodeAnnotations<N, E>(graph: DiGraph<N, E>): void {
    const snap = graph.nodeAnnotationStack.pop();
    if (snap === undefined) throw new Error('graph: node annotation stack underflow');
    for (const [node, ann] of snap) {
        node.annotation = ann;
    }
}

export function pushEdgeAnnotations<N, E>(graph: DiGraph<N, E>): void {
    const snap = new Map<DiGraphEdge<N, E>, Annotation | undefined>();
    for (const node of graph.nodes.values()) {
        for (const e of node.outEdges) {
            snap.set(e, e.annotation);
            e.annotation = undefined;
        }
    }
    graph.edgeAnnotationStack.push(snap);
}

export function popEdgeAnnotations<N, E>(graph: DiGraph<N, E>): void {
    const snap = graph.edgeAnnotationStack.pop();
    if (snap === undefined) throw new Error('graph: edge annotation stack underflow');
    for (const [edge, ann] of snap) {
        edge.annotation = ann;
    }
}

/** Clear the annotation slot on every node. Cheaper than push/pop when the
 *  caller doesn't need to restore prior values. */
export function clearNodeAnnotations<N, E>(graph: DiGraph<N, E>): void {
    for (const node of graph.nodes.values()) node.annotation = undefined;
}
