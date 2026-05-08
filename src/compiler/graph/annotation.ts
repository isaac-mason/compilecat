// Port of jscomp/graph/Annotation.java
//
// Marker for any value that can be attached to a graph node or edge. The
// dataflow framework writes a LatticeElement here; CheckPathsBetweenNodes
// uses three internal sentinel annotations to track DFS state. Anything
// goes — it's an opaque slot.

export type Annotation = unknown;
