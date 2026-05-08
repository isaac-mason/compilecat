import type { DiGraph, DiGraphEdge, DiGraphNode } from './di-graph';
export declare function createDiGraph<N, E>(): DiGraph<N, E>;
/** Idempotent: returns the existing node if `value` is already present. */
export declare function createNode<N, E>(graph: DiGraph<N, E>, value: N): DiGraphNode<N, E>;
export declare function getNode<N, E>(graph: DiGraph<N, E>, value: N): DiGraphNode<N, E> | undefined;
/**
 * Add an edge from `src` to `dest` carrying `edgeValue`. Both endpoints must
 * already be in the graph (use createNode first if needed). Mirrors Closure's
 * `connect(N, E, N)` — does NOT dedupe; multiple edges between the same pair
 * are allowed.
 */
export declare function connect<N, E>(graph: DiGraph<N, E>, srcValue: N, edgeValue: E, destValue: N): DiGraphEdge<N, E>;
/** Direct-node variant; preferred when callers already hold the nodes. */
export declare function connectNodes<N, E>(src: DiGraphNode<N, E>, edgeValue: E, dest: DiGraphNode<N, E>): DiGraphEdge<N, E>;
/**
 * Like connect, but only adds an edge if one doesn't already exist (matching
 * by edgeValue) between the two nodes. Creates nodes if absent.
 */
export declare function connectIfNotConnectedInDirection<N, E>(graph: DiGraph<N, E>, srcValue: N, edgeValue: E, destValue: N): void;
/** Removes every edge in either direction between n1 and n2. */
export declare function disconnect<N, E>(graph: DiGraph<N, E>, n1: N, n2: N): void;
export declare function disconnectInDirection<N, E>(graph: DiGraph<N, E>, srcValue: N, destValue: N): void;
export declare function getOutEdges<N, E>(graph: DiGraph<N, E>, value: N): DiGraphEdge<N, E>[];
export declare function getInEdges<N, E>(graph: DiGraph<N, E>, value: N): DiGraphEdge<N, E>[];
/** All edges from `n1` to `n2` (one direction only). */
export declare function getEdgesInDirection<N, E>(graph: DiGraph<N, E>, n1: N, n2: N): DiGraphEdge<N, E>[];
/**
 * Whether `source` reaches `dest` via a single edge whose value passes
 * `edgeFilter`. Matches Closure's optimization of scanning the shorter of
 * src.outEdges / dest.inEdges.
 */
export declare function isConnectedInDirection<N, E>(source: DiGraphNode<N, E>, dest: DiGraphNode<N, E>, edgeFilter: (v: E) => boolean): boolean;
export declare function getDirectedPredNodes<N, E>(node: DiGraphNode<N, E>): DiGraphNode<N, E>[];
export declare function getDirectedSuccNodes<N, E>(node: DiGraphNode<N, E>): DiGraphNode<N, E>[];
export declare function getNodeCount<N, E>(graph: DiGraph<N, E>): number;
export declare function pushNodeAnnotations<N, E>(graph: DiGraph<N, E>): void;
export declare function popNodeAnnotations<N, E>(graph: DiGraph<N, E>): void;
export declare function pushEdgeAnnotations<N, E>(graph: DiGraph<N, E>): void;
export declare function popEdgeAnnotations<N, E>(graph: DiGraph<N, E>): void;
/** Clear the annotation slot on every node. Cheaper than push/pop when the
 *  caller doesn't need to restore prior values. */
export declare function clearNodeAnnotations<N, E>(graph: DiGraph<N, E>): void;
