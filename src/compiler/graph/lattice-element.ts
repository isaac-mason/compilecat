// Port of jscomp/graph/LatticeElement.java
//
// Marker interface for a dataflow lattice value. Subtypes implement equals
// (for fixpoint termination) via a sibling function passed to the analysis.
// In TS we don't need a runtime presence — the type alias is enough to
// document where lattice values flow.

import type { Annotation } from './annotation';

export type LatticeElement = Annotation;
