//! Port of `data-flow-analysis.ts` (jscomp `DataFlowAnalysis`) — a worklist
//! fixpoint engine over a CFG. The caller describes its analysis via the
//! `DataFlow` trait (transfer / join / equality / bottom / entry); the engine
//! handles iteration, change-detection, and the divergence guard.
//!
//! Branched (per-edge) analyses are NOT ported — no consumer uses them
//! (must-def is plain forward, maybe-use + live-vars are plain backward). Add
//! per-edge state only if one ever does.

use super::cfg::ControlFlowGraph;
use super::graph::NodeId;

pub const MAX_STEPS_PER_NODE: u32 = 20000;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Forward,
    Backward,
}

/// IN/OUT lattice values per CFG node.
#[derive(Clone)]
pub struct LinearFlowState<L> {
    pub in_: L,
    pub out: L,
    step_count: u32,
}

pub trait DataFlow {
    type Lattice: Clone;
    fn direction(&self) -> Direction;
    /// Output state given the input state at CFG node `node`. `cfg` is provided
    /// so the transfer function can inspect the node's AST (`cfg.node(node)`).
    fn flow_through(
        &self,
        node: NodeId,
        cfg: &ControlFlowGraph,
        input: &Self::Lattice,
    ) -> Self::Lattice;
    fn join(&self, a: &Self::Lattice, b: &Self::Lattice) -> Self::Lattice;
    fn equals(&self, a: &Self::Lattice, b: &Self::Lattice) -> bool;
    fn bottom(&self) -> Self::Lattice;
    fn entry(&self) -> Self::Lattice;
}

/// Run `analysis` to fixpoint over `cfg`. Returns per-node states, or `Err` if
/// the analysis diverges (trips `MAX_STEPS_PER_NODE` — a safety net; sound
/// lattices have finite height and never hit it).
pub fn analyze<A: DataFlow>(
    cfg: &ControlFlowGraph,
    analysis: &A,
) -> Result<Vec<LinearFlowState<A::Lattice>>, ()> {
    let n = cfg.node_count();
    let mut state: Vec<LinearFlowState<A::Lattice>> = (0..n)
        .map(|_| LinearFlowState { in_: analysis.bottom(), out: analysis.bottom(), step_count: 0 })
        .collect();

    let mut q = Worklist::new(n);
    for id in 0..n {
        if id != cfg.implicit_return {
            q.add(id, cfg.priority[id]);
        }
    }

    while let Some(cur) = q.remove_first() {
        state[cur].step_count += 1;
        if state[cur].step_count > MAX_STEPS_PER_NODE {
            return Err(());
        }

        join_inputs(cfg, analysis, cur, &mut state);

        if flow(cfg, analysis, cur, &mut state) {
            match analysis.direction() {
                Direction::Forward => {
                    for (d, _) in cfg.successors(cur) {
                        if d != cfg.implicit_return {
                            q.add(d, cfg.priority[d]);
                        }
                    }
                }
                Direction::Backward => {
                    for (s, _) in cfg.predecessors(cur) {
                        if s != cfg.implicit_return {
                            q.add(s, cfg.priority[s]);
                        }
                    }
                }
            }
        }
    }

    if analysis.direction() == Direction::Forward {
        join_inputs(cfg, analysis, cfg.implicit_return, &mut state);
    }
    Ok(state)
}

fn join_inputs<A: DataFlow>(
    cfg: &ControlFlowGraph,
    analysis: &A,
    node: NodeId,
    state: &mut [LinearFlowState<A::Lattice>],
) {
    let dir = analysis.direction();
    if dir == Direction::Forward && node == cfg.entry {
        state[node].in_ = analysis.entry();
        return;
    }
    // Edges feeding this node: in-edges (forward) or out-edges (backward).
    let inputs: Vec<A::Lattice> = match dir {
        Direction::Forward => {
            cfg.predecessors(node).map(|(src, _)| state[src].out.clone()).collect()
        }
        Direction::Backward => {
            cfg.successors(node)
                .map(|(dst, _)| {
                    if dst == cfg.implicit_return {
                        analysis.entry()
                    } else {
                        state[dst].in_.clone()
                    }
                })
                .collect()
        }
    };
    if inputs.is_empty() {
        return;
    }
    let mut result = inputs[0].clone();
    for other in &inputs[1..] {
        result = analysis.join(&result, other);
    }
    match dir {
        Direction::Forward => state[node].in_ = result,
        Direction::Backward => state[node].out = result,
    }
}

fn flow<A: DataFlow>(
    cfg: &ControlFlowGraph,
    analysis: &A,
    node: NodeId,
    state: &mut [LinearFlowState<A::Lattice>],
) -> bool {
    match analysis.direction() {
        Direction::Forward => {
            let next = analysis.flow_through(node, cfg, &state[node].in_);
            let changed = !analysis.equals(&state[node].out, &next);
            state[node].out = next;
            changed
        }
        Direction::Backward => {
            let next = analysis.flow_through(node, cfg, &state[node].out);
            let changed = !analysis.equals(&state[node].in_, &next);
            state[node].in_ = next;
            changed
        }
    }
}

/// Priority-ordered de-duplicating worklist (Closure's `UniqueQueue`).
struct Worklist {
    items: Vec<(u32, NodeId)>, // (priority, node), kept sorted ascending
    in_queue: Vec<bool>,
}

impl Worklist {
    fn new(n: usize) -> Self {
        Worklist { items: Vec::new(), in_queue: vec![false; n] }
    }
    fn add(&mut self, node: NodeId, priority: u32) {
        if self.in_queue[node] {
            return;
        }
        self.in_queue[node] = true;
        let pos = self.items.partition_point(|&(p, _)| p <= priority);
        self.items.insert(pos, (priority, node));
    }
    fn remove_first(&mut self) -> Option<NodeId> {
        if self.items.is_empty() {
            return None;
        }
        let (_, node) = self.items.remove(0);
        self.in_queue[node] = false;
        Some(node)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::cfg::build;
    use oxc_allocator::Allocator;
    use oxc_ast::ast::{FunctionBody, Program, Statement};
    use oxc_ast::AstKind;
    use oxc_span::SourceType;

    fn cfg_of<'a>(a: &'a Allocator, code: &'a str) -> ControlFlowGraph<'a> {
        let program: &'a Program<'a> = a.alloc(crate::parse_program(a, code, SourceType::ts()));
        let Statement::FunctionDeclaration(f) = &program.body[0] else { panic!() };
        let body: &'a FunctionBody<'a> = f.body.as_ref().unwrap();
        build(AstKind::FunctionBody(body)).unwrap()
    }

    // Constant lattice: flow returns input; join = max.
    struct Const;
    impl DataFlow for Const {
        type Lattice = i32;
        fn direction(&self) -> Direction {
            Direction::Forward
        }
        fn flow_through(&self, _n: NodeId, _c: &ControlFlowGraph, input: &i32) -> i32 {
            *input
        }
        fn join(&self, a: &i32, b: &i32) -> i32 {
            (*a).max(*b)
        }
        fn equals(&self, a: &i32, b: &i32) -> bool {
            a == b
        }
        fn bottom(&self) -> i32 {
            0
        }
        fn entry(&self) -> i32 {
            1
        }
    }

    #[test]
    fn terminates_on_constant_lattice() {
        let a = Allocator::default();
        let cfg = cfg_of(&a, "function f() { a; b; c; }");
        let state = analyze(&cfg, &Const).unwrap();
        assert_eq!(state[cfg.entry].in_, 1);
        assert!(state[cfg.implicit_return].in_ >= 1);
    }

    // Diverging analysis: equals always false → never reaches fixpoint.
    struct Diverge {
        counter: std::cell::Cell<i32>,
    }
    impl DataFlow for Diverge {
        type Lattice = i32;
        fn direction(&self) -> Direction {
            Direction::Forward
        }
        fn flow_through(&self, _n: NodeId, _c: &ControlFlowGraph, _input: &i32) -> i32 {
            let v = self.counter.get();
            self.counter.set(v + 1);
            v
        }
        fn join(&self, a: &i32, b: &i32) -> i32 {
            a + b
        }
        fn equals(&self, _a: &i32, _b: &i32) -> bool {
            false
        }
        fn bottom(&self) -> i32 {
            -1
        }
        fn entry(&self) -> i32 {
            0
        }
    }

    #[test]
    fn aborts_on_divergence() {
        let a = Allocator::default();
        let cfg = cfg_of(&a, "function f() { while (cond) { a; } }");
        let r = analyze(&cfg, &Diverge { counter: std::cell::Cell::new(0) });
        assert!(r.is_err(), "diverging analysis must abort");
    }

    #[test]
    fn implicit_return_not_flowed() {
        let a = Allocator::default();
        let cfg = cfg_of(&a, "function f() { a; }");
        // Track which nodes flow_through is called on.
        struct Track {
            seen: std::cell::RefCell<Vec<NodeId>>,
        }
        impl DataFlow for Track {
            type Lattice = i32;
            fn direction(&self) -> Direction {
                Direction::Forward
            }
            fn flow_through(&self, n: NodeId, _c: &ControlFlowGraph, input: &i32) -> i32 {
                self.seen.borrow_mut().push(n);
                *input
            }
            fn join(&self, a: &i32, _b: &i32) -> i32 {
                *a
            }
            fn equals(&self, _a: &i32, _b: &i32) -> bool {
                true
            }
            fn bottom(&self) -> i32 {
                0
            }
            fn entry(&self) -> i32 {
                0
            }
        }
        let t = Track { seen: std::cell::RefCell::new(Vec::new()) };
        analyze(&cfg, &t).unwrap();
        assert!(!t.seen.borrow().contains(&cfg.implicit_return), "implicit return never flowed");
    }
}
