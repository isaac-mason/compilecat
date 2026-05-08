// Port of jscomp/graph/DiGraph.java (interface layer).
//
// DiGraph defines the shape of a directed graph: nodes carry a value of type
// N and an annotation slot; edges connect a source/destination pair and carry
// a value of type E plus their own annotation slot.
//
// The concrete implementation lives in LinkedDirectedGraph.ts. Closure splits
// the interface (DiGraph) from the impl (LinkedDirectedGraph) for Java-OOP
// reasons; we keep the same split so filenames stay 1:1 with the Closure
// source even though TS doesn't need the abstract layer at runtime.

import type { Annotation } from './annotation';

export type DiGraphNode<N, E> = {
    value: N;
    outEdges: DiGraphEdge<N, E>[];
    inEdges: DiGraphEdge<N, E>[];
    /**
     * Active annotation. Dataflow stores the current LatticeElement here.
     * CheckPathsBetweenNodes uses this slot for DFS coloring during a walk.
     * Direct mutation is fine — the graph itself doesn't reason about the
     * value.
     */
    annotation: Annotation | undefined;
    /**
     * Priority used by the dataflow worklist comparator. -1 if unset. Set by
     * ControlFlowAnalysis at CFG-build time.
     */
    priority: number;
};

export type DiGraphEdge<N, E> = {
    source: DiGraphNode<N, E>;
    destination: DiGraphNode<N, E>;
    value: E;
    /** Annotation slot used by graph algorithms (CheckPathsBetweenNodes etc.). */
    annotation: Annotation | undefined;
};

export type DiGraph<N, E> = {
    /** Insertion-ordered map of nodes keyed by value. */
    nodes: Map<N, DiGraphNode<N, E>>;
    /** Saved annotation snapshots — one entry per push/pop. */
    nodeAnnotationStack: Map<DiGraphNode<N, E>, Annotation | undefined>[];
    edgeAnnotationStack: Map<DiGraphEdge<N, E>, Annotation | undefined>[];
};
