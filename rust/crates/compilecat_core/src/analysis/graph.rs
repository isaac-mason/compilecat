//! Idiomatic index-based directed graph — the foundation the CFG and dataflow
//! framework build on. Replaces compilecat's `graph/di-graph.ts` +
//! `linked-directed-graph.ts` (a JS object-graph) with a Rust arena of nodes
//! and edges addressed by `NodeId`.
//!
//! Design note: unlike the TS version, **lattice/annotation state is NOT stored
//! on the graph**. The dataflow framework keeps it in a parallel
//! `Vec<Lattice>` indexed by `NodeId`, so the graph stays pure structure.

pub type NodeId = usize;

#[derive(Debug, Clone, Copy)]
pub struct Edge<E> {
    pub from: NodeId,
    pub to: NodeId,
    pub value: E,
}

/// Directed graph with edge labels of type `E` (the CFG uses `Branch`).
#[derive(Debug, Default)]
pub struct DiGraph<E> {
    out: Vec<Vec<usize>>, // node → indices into `edges`
    inc: Vec<Vec<usize>>, // node → indices into `edges` (incoming)
    edges: Vec<Edge<E>>,
}

impl<E: Copy> DiGraph<E> {
    pub fn new() -> Self {
        DiGraph { out: Vec::new(), inc: Vec::new(), edges: Vec::new() }
    }

    pub fn node_count(&self) -> usize {
        self.out.len()
    }

    /// Allocate a fresh node, returning its id.
    pub fn add_node(&mut self) -> NodeId {
        let id = self.out.len();
        self.out.push(Vec::new());
        self.inc.push(Vec::new());
        id
    }

    /// Add a directed `from → to` edge labelled `value`. Does not dedupe
    /// (matches Closure's `connect`, which allows parallel edges).
    pub fn connect(&mut self, from: NodeId, value: E, to: NodeId) {
        let edge_id = self.edges.len();
        self.edges.push(Edge { from, to, value });
        self.out[from].push(edge_id);
        self.inc[to].push(edge_id);
    }

    /// Successors with the edge label taken to reach them.
    pub fn successors(&self, node: NodeId) -> impl Iterator<Item = (NodeId, E)> + '_ {
        self.out[node].iter().map(move |&e| (self.edges[e].to, self.edges[e].value))
    }

    /// Predecessors with the edge label taken from them.
    pub fn predecessors(&self, node: NodeId) -> impl Iterator<Item = (NodeId, E)> + '_ {
        self.inc[node].iter().map(move |&e| (self.edges[e].from, self.edges[e].value))
    }

    pub fn out_degree(&self, node: NodeId) -> usize {
        self.out[node].len()
    }

    pub fn in_degree(&self, node: NodeId) -> usize {
        self.inc[node].len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// Out-edges of `node` as `(edge_id, destination)`. The `edge_id` is a stable
    /// index into the edge arena — usable to key per-edge traversal state.
    pub fn out_edge_ids(&self, node: NodeId) -> impl Iterator<Item = (usize, NodeId)> + '_ {
        self.out[node].iter().map(move |&e| (e, self.edges[e].to))
    }
}

/// Port of `CheckPathsBetweenNodes.somecheckSomePathsWithoutBackEdges`
/// (`graph/check-paths-between-nodes.ts`, the only variant the flow-sensitive
/// inliner uses): true iff at least one non-looping path from `start` to `end`
/// passes through a node satisfying `node_pred`. `inclusive=false` excludes the
/// `start`/`end` endpoints from counting. Edges are never filtered (the inliner
/// always passes `edgePredicate: () => true`).
///
/// Two phases, matching Closure/CLRS: (1) a DFS from `start` colors nodes
/// WHITE/GRAY/BLACK to mark back-edges (edges to a GRAY ancestor — cycle edges);
/// (2) a DFS that skips back-edges and already-visited edges looks for a
/// predicate-true node before reaching `end`.
pub fn some_path_satisfies<E: Copy>(
    g: &DiGraph<E>,
    start: NodeId,
    end: NodeId,
    inclusive: bool,
    node_pred: impl Fn(NodeId) -> bool,
) -> bool {
    const WHITE: u8 = 0;
    const GRAY: u8 = 1;
    const BLACK: u8 = 2;

    let mut color = vec![WHITE; g.node_count()];
    let mut back = vec![false; g.edge_count()];
    // Phase 1: discover back-edges (iterative DFS to avoid deep recursion).
    // Stack frames are (node, next-out-edge-index); a node is GRAY while on the
    // stack and BLACK once all its out-edges are processed.
    let mut stack: Vec<(NodeId, usize)> = Vec::new();
    let out_ids = |n: NodeId| -> Vec<(usize, NodeId)> { g.out_edge_ids(n).collect() };
    color[start] = GRAY;
    stack.push((start, 0));
    while let Some(&(u, i)) = stack.last() {
        let edges = out_ids(u);
        if i < edges.len() {
            stack.last_mut().unwrap().1 += 1;
            let (eid, v) = edges[i];
            match color[v] {
                WHITE => {
                    color[v] = GRAY;
                    stack.push((v, 0));
                }
                GRAY => back[eid] = true,
                _ => {}
            }
        } else {
            color[u] = BLACK;
            stack.pop();
        }
    }

    // Phase 2: DFS for a satisfying node, skipping back-edges + revisited edges.
    let mut visited_edge = vec![false; g.edge_count()];
    let excluded = |n: NodeId| !inclusive && (n == start || n == end);
    // Recursive helper as an explicit stack: each frame tracks the node and the
    // next out-edge to try; we test the predicate when a node is first entered.
    fn dfs<E: Copy>(
        g: &DiGraph<E>,
        a: NodeId,
        end: NodeId,
        back: &[bool],
        visited_edge: &mut [bool],
        excluded: &impl Fn(NodeId) -> bool,
        node_pred: &impl Fn(NodeId) -> bool,
    ) -> bool {
        if node_pred(a) && !excluded(a) {
            return true;
        }
        if a == end {
            return false;
        }
        for (eid, v) in g.out_edge_ids(a).collect::<Vec<_>>() {
            if visited_edge[eid] {
                continue;
            }
            visited_edge[eid] = true;
            if back[eid] {
                continue;
            }
            if dfs(g, v, end, back, visited_edge, excluded, node_pred) {
                return true;
            }
        }
        false
    }
    dfs(g, start, end, &back, &mut visited_edge, &excluded, &node_pred)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Branch {
        True,
        False,
        Uncond,
    }

    #[test]
    fn build_and_traverse() {
        let mut g: DiGraph<Branch> = DiGraph::new();
        let entry = g.add_node();
        let a = g.add_node();
        let b = g.add_node();
        let exit = g.add_node();
        g.connect(entry, Branch::Uncond, a);
        g.connect(a, Branch::True, b);
        g.connect(a, Branch::False, exit);
        g.connect(b, Branch::Uncond, exit);

        assert_eq!(g.node_count(), 4);
        assert_eq!(g.out_degree(a), 2);
        assert_eq!(g.in_degree(exit), 2);

        let succ: Vec<_> = g.successors(a).collect();
        assert!(succ.contains(&(b, Branch::True)));
        assert!(succ.contains(&(exit, Branch::False)));

        let preds: Vec<_> = g.predecessors(exit).map(|(n, _)| n).collect();
        assert!(preds.contains(&a) && preds.contains(&b));
    }

    /// entry → a → b → exit, plus a→exit shortcut. Mark `b`. Some path through
    /// `b` exists (entry→a→b→exit), so `some_path_satisfies` is true; but not
    /// every path (the a→exit shortcut skips b).
    #[test]
    fn some_path_through_marked_node() {
        let mut g: DiGraph<Branch> = DiGraph::new();
        let entry = g.add_node();
        let a = g.add_node();
        let b = g.add_node();
        let exit = g.add_node();
        g.connect(entry, Branch::Uncond, a);
        g.connect(a, Branch::True, b);
        g.connect(a, Branch::False, exit);
        g.connect(b, Branch::Uncond, exit);

        assert!(some_path_satisfies(&g, entry, exit, false, |n| n == b), "b lies on a path");
        assert!(!some_path_satisfies(&g, entry, exit, false, |n| n == 99), "no node 99");
    }

    /// inclusive=false must not count the start/end endpoints.
    #[test]
    fn some_path_excludes_endpoints_when_not_inclusive() {
        let mut g: DiGraph<Branch> = DiGraph::new();
        let s = g.add_node();
        let e = g.add_node();
        g.connect(s, Branch::Uncond, e);
        assert!(!some_path_satisfies(&g, s, e, false, |n| n == s || n == e), "endpoints excluded");
        assert!(some_path_satisfies(&g, s, e, true, |n| n == s), "endpoint counts when inclusive");
    }

    /// A cycle (b→a back-edge) must not cause infinite recursion, and the
    /// back-edge must not be traversed when searching for a satisfying node.
    #[test]
    fn some_path_terminates_with_cycle() {
        let mut g: DiGraph<Branch> = DiGraph::new();
        let s = g.add_node();
        let a = g.add_node();
        let b = g.add_node();
        let e = g.add_node();
        g.connect(s, Branch::Uncond, a);
        g.connect(a, Branch::Uncond, b);
        g.connect(b, Branch::True, a); // back-edge (cycle)
        g.connect(b, Branch::False, e);
        // Reaches e without hitting node 99 → false (and terminates).
        assert!(!some_path_satisfies(&g, s, e, false, |n| n == 99));
        // a is on the (acyclic) path → true.
        assert!(some_path_satisfies(&g, s, e, false, |n| n == a));
    }
}
