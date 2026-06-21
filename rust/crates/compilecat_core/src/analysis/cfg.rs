//! Port of `control-flow-graph.ts` + `control-flow-analysis.ts` (jscomp
//! `ControlFlowGraph` / `ControlFlowAnalysis`, subset).
//!
//! Builds a per-AST-node CFG for one root (a function body / Program). Nodes are
//! keyed by their arena **`Address`** (NOT `Span`): compiler-generated nodes
//! (SROA/unroll/inline output) all share `SPAN(0,0)`, so span identity collides
//! and merges distinct statements into one CFG node, corrupting every downstream
//! dataflow analysis on optimized code. An `Address` is a unique, stable pointer
//! into the arena, collision-free even for generated nodes, and needs no
//! semantic pass. The borrowed `AstKind<'a>` is stored so the dataflow layer can
//! compute GEN/KILL from each node. The graph is the index-based
//! `super::graph::DiGraph<Branch>`.
//!
//! BAILOUTS (build returns None): try / with / yield / await / generator /
//! async / for-await — any analysis needing a CFG skips the fn.
//!
//! Not modelled: ON_EX exception edges, finally routing.

use std::collections::HashMap;

use oxc_allocator::{Address, GetAddress, UnstableAddress};
use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_ast_visit::{walk, Visit};
use oxc_semantic::ScopeFlags;

use super::graph::{DiGraph, NodeId};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Branch {
    OnTrue,
    OnFalse,
    Uncond,
    OnEx,
    SynBlock,
}

impl Branch {
    pub fn is_conditional(self) -> bool {
        matches!(self, Branch::OnTrue | Branch::OnFalse)
    }
}

/// A CFG node value: a borrowed AST node, or the implicit-return sentinel.
#[derive(Clone, Copy)]
pub enum CfgValue<'a> {
    Node(AstKind<'a>),
    ImplicitReturn,
}

pub struct ControlFlowGraph<'a> {
    pub graph: DiGraph<Branch>,
    /// NodeId → value.
    values: Vec<CfgValue<'a>>,
    /// node arena address → NodeId (implicit-return is not in here).
    addr_to_id: HashMap<Address, NodeId>,
    /// NodeId → priority (forward-flow worklist order). Filled by `prioritize`.
    pub priority: Vec<u32>,
    pub entry: NodeId,
    pub implicit_return: NodeId,
}

impl<'a> ControlFlowGraph<'a> {
    pub fn value(&self, id: NodeId) -> CfgValue<'a> {
        self.values[id]
    }
    /// The AST node for a CFG node, or None for the implicit return.
    pub fn node(&self, id: NodeId) -> Option<AstKind<'a>> {
        match self.values[id] {
            CfgValue::Node(k) => Some(k),
            CfgValue::ImplicitReturn => None,
        }
    }
    pub fn node_count(&self) -> usize {
        self.values.len()
    }
    pub fn id_of_addr(&self, addr: Address) -> Option<NodeId> {
        self.addr_to_id.get(&addr).copied()
    }
    pub fn successors(&self, id: NodeId) -> impl Iterator<Item = (NodeId, Branch)> + '_ {
        self.graph.successors(id)
    }
    pub fn predecessors(&self, id: NodeId) -> impl Iterator<Item = (NodeId, Branch)> + '_ {
        self.graph.predecessors(id)
    }
}

/// Build a CFG for `root`. None if `root` contains a bail construct.
pub fn build<'a>(root: AstKind<'a>) -> Option<ControlFlowGraph<'a>> {
    // One pass: collect node_map / parent / source-order positions, detect bail,
    // and skip nested function bodies.
    let mut c = Collector {
        root: root.address(),
        stack: Vec::new(),
        node_map: HashMap::new(),
        parent: HashMap::new(),
        ast_position: HashMap::new(),
        counter: 0,
        bail: false,
    };
    // The root function's own async/generator-ness is a bail.
    if let AstKind::Function(f) = root {
        if f.r#async || f.generator {
            return None;
        }
    }
    match root {
        AstKind::Program(p) => c.visit_program(p),
        AstKind::FunctionBody(b) => c.visit_function_body(b),
        AstKind::BlockStatement(b) => c.visit_block_statement(b),
        AstKind::Function(f) => c.visit_function(f, ScopeFlags::empty()),
        _ => return None,
    }
    if c.bail {
        return None;
    }

    let mut b = Builder {
        node_map: c.node_map,
        parent: c.parent,
        ast_position: c.ast_position,
        graph: DiGraph::new(),
        values: Vec::new(),
        addr_to_id: HashMap::new(),
        position_counter: c.counter,
        root: root.address(),
    };
    let implicit_return = b.new_node(CfgValue::ImplicitReturn);
    // Position the implicit return last.
    let entry = b.ensure(root.address());

    // Emit edges for every collected node (order doesn't matter — ensure dedups).
    let addrs: Vec<Address> = b.node_map.keys().copied().collect();
    for addr in addrs {
        b.handle(addr, implicit_return);
    }

    let mut cfg = ControlFlowGraph {
        graph: b.graph,
        values: b.values,
        addr_to_id: b.addr_to_id,
        priority: Vec::new(),
        entry,
        implicit_return,
    };
    prioritize(&mut cfg, &b.ast_position, b.position_counter);
    Some(cfg)
}

// ── collection pass ──────────────────────────────────────────────────────────

struct Collector<'a> {
    root: Address,
    stack: Vec<Address>,
    node_map: HashMap<Address, AstKind<'a>>,
    parent: HashMap<Address, Address>,
    ast_position: HashMap<Address, usize>,
    counter: usize,
    bail: bool,
}

impl<'a> Collector<'a> {
    fn check_bail(&mut self, kind: AstKind<'a>) {
        match kind {
            AstKind::TryStatement(_) | AstKind::WithStatement(_) => self.bail = true,
            _ => {}
        }
    }
}

impl<'a> Visit<'a> for Collector<'a> {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        let addr = kind.address();
        if let Some(&p) = self.stack.last() {
            self.parent.entry(addr).or_insert(p);
        }
        self.node_map.entry(addr).or_insert(kind);
        if !self.ast_position.contains_key(&addr) {
            self.ast_position.insert(addr, self.counter);
            self.counter += 1;
        }
        self.stack.push(addr);
        self.check_bail(kind);
    }

    fn leave_node(&mut self, _kind: AstKind<'a>) {
        self.stack.pop();
    }

    fn visit_yield_expression(&mut self, _it: &YieldExpression<'a>) {
        self.bail = true;
    }
    fn visit_await_expression(&mut self, _it: &AwaitExpression<'a>) {
        self.bail = true;
    }

    fn visit_for_of_statement(&mut self, it: &ForOfStatement<'a>) {
        if it.r#await {
            self.bail = true;
        }
        walk::walk_for_of_statement(self, it);
    }

    // Don't descend into nested functions — they own their own CFG, and their
    // bodies must not appear as nodes in this one. `walk_function` is what fires
    // `enter_node`, so skipping it entirely keeps the nested fn out of node_map
    // (it only ever sits inside an expression, never a CFG node).
    fn visit_function(&mut self, func: &Function<'a>, flags: ScopeFlags) {
        if func.unstable_address() == self.root {
            walk::walk_function(self, func, flags);
        }
    }
    fn visit_arrow_function_expression(&mut self, arrow: &ArrowFunctionExpression<'a>) {
        if arrow.unstable_address() == self.root {
            walk::walk_arrow_function_expression(self, arrow);
        }
    }
}

// ── edge construction ────────────────────────────────────────────────────────

struct Builder<'a> {
    node_map: HashMap<Address, AstKind<'a>>,
    parent: HashMap<Address, Address>,
    ast_position: HashMap<Address, usize>,
    graph: DiGraph<Branch>,
    values: Vec<CfgValue<'a>>,
    addr_to_id: HashMap<Address, NodeId>,
    position_counter: usize,
    root: Address,
}

impl<'a> Builder<'a> {
    fn new_node(&mut self, v: CfgValue<'a>) -> NodeId {
        let id = self.graph.add_node();
        self.values.push(v);
        id
    }

    /// Get-or-create the CFG node for `addr`.
    fn ensure(&mut self, addr: Address) -> NodeId {
        if let Some(&id) = self.addr_to_id.get(&addr) {
            return id;
        }
        let kind = self.node_map[&addr];
        let id = self.new_node(CfgValue::Node(kind));
        self.addr_to_id.insert(addr, id);
        id
    }

    fn kind(&self, addr: Address) -> AstKind<'a> {
        self.node_map[&addr]
    }
    fn parent_kind(&self, addr: Address) -> Option<AstKind<'a>> {
        self.parent.get(&addr).map(|p| self.node_map[p])
    }

    fn edge(
        &mut self,
        from: Address,
        branch: Branch,
        to: Option<Address>,
        implicit_return: NodeId,
    ) {
        let f = self.ensure(from);
        let t = match to {
            Some(s) => self.ensure(s),
            None => implicit_return,
        };
        // Dedup parallel identical edges.
        if self.graph.successors(f).any(|(d, b)| d == t && b == branch) {
            return;
        }
        self.graph.connect(f, branch, t);
    }

    fn handle(&mut self, addr: Address, ir: NodeId) {
        let kind = self.node_map[&addr];
        match kind {
            AstKind::IfStatement(s) => {
                self.edge(
                    addr,
                    Branch::OnTrue,
                    Some(fall_through(self.kind(s.consequent.address()))),
                    ir,
                );
                if let Some(alt) = &s.alternate {
                    self.edge(
                        addr,
                        Branch::OnFalse,
                        Some(fall_through(self.kind(alt.address()))),
                        ir,
                    );
                } else {
                    let f = self.follow(addr);
                    self.edge(addr, Branch::OnFalse, f, ir);
                }
            }
            AstKind::WhileStatement(s) => {
                self.edge(
                    addr,
                    Branch::OnTrue,
                    Some(fall_through(self.kind(s.body.address()))),
                    ir,
                );
                if !is_literal_true(&s.test) {
                    let f = self.follow(addr);
                    self.edge(addr, Branch::OnFalse, f, ir);
                }
            }
            AstKind::DoWhileStatement(s) => {
                self.edge(
                    addr,
                    Branch::OnTrue,
                    Some(fall_through(self.kind(s.body.address()))),
                    ir,
                );
                if !is_literal_true(&s.test) {
                    let f = self.follow(addr);
                    self.edge(addr, Branch::OnFalse, f, ir);
                }
            }
            AstKind::ForStatement(s) => {
                if let Some(init) = &s.init {
                    self.edge(init.address(), Branch::Uncond, Some(addr), ir);
                }
                self.edge(
                    addr,
                    Branch::OnTrue,
                    Some(fall_through(self.kind(s.body.address()))),
                    ir,
                );
                if s.test.as_ref().is_none_or(|t| !is_literal_true(t)) {
                    let f = self.follow(addr);
                    self.edge(addr, Branch::OnFalse, f, ir);
                }
                if let Some(update) = &s.update {
                    self.edge(update.address(), Branch::Uncond, Some(addr), ir);
                }
            }
            AstKind::ForInStatement(s) => {
                self.edge(s.right.address(), Branch::Uncond, Some(addr), ir);
                self.edge(
                    addr,
                    Branch::OnTrue,
                    Some(fall_through(self.kind(s.body.address()))),
                    ir,
                );
                let f = self.follow(addr);
                self.edge(addr, Branch::OnFalse, f, ir);
            }
            AstKind::ForOfStatement(s) => {
                self.edge(s.right.address(), Branch::Uncond, Some(addr), ir);
                self.edge(
                    addr,
                    Branch::OnTrue,
                    Some(fall_through(self.kind(s.body.address()))),
                    ir,
                );
                let f = self.follow(addr);
                self.edge(addr, Branch::OnFalse, f, ir);
            }
            AstKind::SwitchStatement(s) => self.handle_switch(addr, s, ir),
            AstKind::SwitchCase(s) => self.handle_switch_case(addr, s, ir),
            AstKind::BlockStatement(s) => self.handle_stmt_list(addr, &s.body, ir),
            AstKind::Program(s) => self.handle_stmt_list(addr, &s.body, ir),
            AstKind::FunctionBody(s) => self.handle_stmt_list(addr, &s.statements, ir),
            AstKind::Function(f) => {
                if let Some(body) = &f.body {
                    self.edge(
                        addr,
                        Branch::Uncond,
                        Some(fall_through(self.kind(body.unstable_address()))),
                        ir,
                    );
                }
            }
            AstKind::ExpressionStatement(_) => {
                let f = self.follow(addr);
                self.edge(addr, Branch::Uncond, f, ir);
            }
            AstKind::ThrowStatement(_) => { /* no out-edge (no exception model) */ }
            AstKind::BreakStatement(s) => {
                let label = s.label.as_ref().map(|l| l.name.as_str());
                if let Some(target) = self.find_break_target(addr, label) {
                    let f = self.follow(target);
                    self.edge(addr, Branch::Uncond, f, ir);
                }
            }
            AstKind::ContinueStatement(s) => {
                let label = s.label.as_ref().map(|l| l.name.as_str());
                if let Some(target) = self.find_continue_target(addr, label) {
                    // vanilla for: continue → update slot; else → loop node.
                    let to = match self.kind(target) {
                        AstKind::ForStatement(fs) => {
                            fs.update.as_ref().map(|u| u.address()).unwrap_or(target)
                        }
                        _ => target,
                    };
                    self.edge(addr, Branch::Uncond, Some(to), ir);
                }
            }
            AstKind::ReturnStatement(_) => {
                self.edge(addr, Branch::Uncond, None, ir);
            }
            AstKind::LabeledStatement(_) => { /* transparent; body emits edges */ }
            // A for-header decl (`for (var i…)` / `for (const x of…)`) gets its
            // edges from the loop handler, not a generic statement fall-through.
            AstKind::VariableDeclaration(_)
                if matches!(
                    self.parent_kind(addr),
                    Some(
                        AstKind::ForStatement(_)
                            | AstKind::ForInStatement(_)
                            | AstKind::ForOfStatement(_)
                    )
                ) => {}
            // Any other statement: unconditional fall-through.
            other if is_statement_kind(other) => {
                let f = self.follow(addr);
                self.edge(addr, Branch::Uncond, f, ir);
            }
            _ => {}
        }
    }

    fn handle_switch(&mut self, addr: Address, s: &'a SwitchStatement<'a>, ir: NodeId) {
        if let Some(first) = s.cases.iter().find(|c| c.test.is_some()) {
            self.edge(addr, Branch::Uncond, Some(first.unstable_address()), ir);
        } else if let Some(dflt) = s.cases.iter().find(|c| c.test.is_none()) {
            let target = if let Some(first) = dflt.consequent.first() {
                Some(fall_through(self.kind(first.address())))
            } else {
                self.follow(addr)
            };
            self.edge(addr, Branch::Uncond, target, ir);
        } else {
            let f = self.follow(addr);
            self.edge(addr, Branch::Uncond, f, ir);
        }
    }

    fn handle_switch_case(&mut self, addr: Address, s: &'a SwitchCase<'a>, ir: NodeId) {
        if s.test.is_none() {
            let target = if let Some(first) = s.consequent.first() {
                Some(fall_through(self.kind(first.address())))
            } else {
                self.follow(addr)
            };
            self.edge(addr, Branch::Uncond, target, ir);
            return;
        }
        let on_true = if let Some(first) = s.consequent.first() {
            Some(fall_through(self.kind(first.address())))
        } else {
            self.follow(addr)
        };
        self.edge(addr, Branch::OnTrue, on_true, ir);

        // ON_FALSE → next real case, else default, else follow.
        let Some(AstKind::SwitchStatement(sw)) = self.parent_kind(addr) else {
            let f = self.follow(addr);
            self.edge(addr, Branch::OnFalse, f, ir);
            return;
        };
        let idx = sw.cases.iter().position(|c| c.unstable_address() == addr);
        let next = idx.and_then(|i| sw.cases[i + 1..].iter().find(|c| c.test.is_some()));
        if let Some(nc) = next {
            self.edge(addr, Branch::OnFalse, Some(nc.unstable_address()), ir);
        } else if let Some(dflt) = sw.cases.iter().find(|c| c.test.is_none()) {
            self.edge(addr, Branch::OnFalse, Some(dflt.unstable_address()), ir);
        } else {
            let f = self.follow(addr);
            self.edge(addr, Branch::OnFalse, f, ir);
        }
    }

    fn handle_stmt_list(
        &mut self,
        addr: Address,
        body: &'a oxc_allocator::Vec<'a, Statement<'a>>,
        ir: NodeId,
    ) {
        let first = body.iter().find(|s| !matches!(s, Statement::FunctionDeclaration(_)));
        let target = match first {
            Some(s) => Some(fall_through(self.kind(s.address()))),
            None => self.follow(addr),
        };
        self.edge(addr, Branch::Uncond, target, ir);
    }

    /// Port of `computeFollowNode` — returns the node control transfers to after
    /// `node`, or None for the implicit return.
    fn follow(&self, node: Address) -> Option<Address> {
        let parent = self.parent_kind(node)?;
        if matches!(parent, AstKind::Function(_)) || node == self.root() {
            return None;
        }
        match parent {
            AstKind::IfStatement(_) => self.follow(parent.address()),
            AstKind::SwitchCase(c) => {
                let idx = c.consequent.iter().position(|s| s.address() == node);
                if let Some(i) = idx {
                    for s in &c.consequent[i + 1..] {
                        if !matches!(s, Statement::FunctionDeclaration(_)) {
                            return Some(fall_through(self.kind(s.address())));
                        }
                    }
                }
                let grand = self.parent_kind(parent.address());
                let Some(AstKind::SwitchStatement(sw)) = grand else {
                    return self.follow(parent.address());
                };
                let cidx = sw.cases.iter().position(|x| x.unstable_address() == parent.address());
                let next_case = cidx.and_then(|ci| sw.cases.get(ci + 1));
                if let Some(nc) = next_case {
                    if let Some(first) = nc.consequent.first() {
                        return Some(fall_through(self.kind(first.address())));
                    }
                    return self.follow(nc.unstable_address());
                }
                self.follow(parent.address())
            }
            AstKind::ForStatement(fs) => {
                Some(fs.update.as_ref().map(|u| u.address()).unwrap_or(parent.address()))
            }
            AstKind::WhileStatement(_)
            | AstKind::DoWhileStatement(_)
            | AstKind::ForInStatement(_)
            | AstKind::ForOfStatement(_) => Some(parent.address()),
            AstKind::LabeledStatement(_) => self.follow(parent.address()),
            _ => {
                if let Some(list) = self.sibling_list(parent) {
                    let idx = list.iter().position(|s| s.address() == node);
                    if let Some(i) = idx {
                        for s in &list[i + 1..] {
                            if !matches!(s, Statement::FunctionDeclaration(_)) {
                                return Some(fall_through(self.kind(s.address())));
                            }
                        }
                    }
                    return self.follow(parent.address());
                }
                self.follow(parent.address())
            }
        }
    }

    fn sibling_list(
        &self,
        parent: AstKind<'a>,
    ) -> Option<&'a oxc_allocator::Vec<'a, Statement<'a>>> {
        match parent {
            AstKind::BlockStatement(b) => Some(&b.body),
            AstKind::Program(p) => Some(&p.body),
            AstKind::FunctionBody(b) => Some(&b.statements),
            AstKind::SwitchCase(c) => Some(&c.consequent),
            _ => None,
        }
    }

    fn root(&self) -> Address {
        self.root
    }

    fn find_break_target(&self, from: Address, label: Option<&str>) -> Option<Address> {
        let mut cur = Some(from);
        while let Some(c) = cur {
            let k = self.kind(c);
            let is_target = match label {
                None => is_loop(k) || matches!(k, AstKind::SwitchStatement(_)),
                Some(l) => self.label_matches(c, l),
            };
            if is_target {
                return Some(c);
            }
            cur = self.parent.get(&c).copied();
        }
        None
    }

    fn find_continue_target(&self, from: Address, label: Option<&str>) -> Option<Address> {
        let mut cur = Some(from);
        while let Some(c) = cur {
            if is_loop(self.kind(c)) && label.is_none_or(|l| self.label_matches(c, l)) {
                return Some(c);
            }
            cur = self.parent.get(&c).copied();
        }
        None
    }

    fn label_matches(&self, target: Address, label: &str) -> bool {
        let mut cur = self.parent.get(&target).copied();
        while let Some(c) = cur {
            match self.kind(c) {
                AstKind::LabeledStatement(l) if l.label.name == label => return true,
                AstKind::LabeledStatement(_) => cur = self.parent.get(&c).copied(),
                _ => break,
            }
        }
        false
    }
}

/// Port of `computeFallThrough`. Returns the arena address of the node control
/// actually enters when reaching `kind`.
fn fall_through(kind: AstKind) -> Address {
    match kind {
        AstKind::DoWhileStatement(s) => s.body.address(),
        AstKind::ForStatement(s) => {
            s.init.as_ref().map(|i| i.address()).unwrap_or_else(|| kind.address())
        }
        AstKind::ForInStatement(s) => s.right.address(),
        AstKind::ForOfStatement(s) => s.right.address(),
        AstKind::LabeledStatement(s) => s.body.address(),
        _ => kind.address(),
    }
}

fn is_literal_true(e: &Expression) -> bool {
    matches!(e, Expression::BooleanLiteral(b) if b.value)
}

fn is_loop(k: AstKind) -> bool {
    matches!(
        k,
        AstKind::WhileStatement(_)
            | AstKind::DoWhileStatement(_)
            | AstKind::ForStatement(_)
            | AstKind::ForInStatement(_)
            | AstKind::ForOfStatement(_)
    )
}

fn is_statement_kind(k: AstKind) -> bool {
    matches!(
        k,
        AstKind::ExpressionStatement(_)
            | AstKind::VariableDeclaration(_)
            | AstKind::EmptyStatement(_)
            | AstKind::DebuggerStatement(_)
    )
}

// ── priority assignment ──────────────────────────────────────────────────────

fn prioritize(
    cfg: &mut ControlFlowGraph,
    ast_position: &HashMap<Address, usize>,
    fallback_pos: usize,
) {
    let n = cfg.node_count();
    cfg.priority = vec![0; n];
    let mut counter = 0u32;
    // Reachable-from-entry, ordered by AST position.
    let mut reached: Vec<NodeId> = Vec::new();
    let mut seen = vec![false; n];
    let mut stack = vec![cfg.entry];
    while let Some(cur) = stack.pop() {
        if seen[cur] {
            continue;
        }
        seen[cur] = true;
        reached.push(cur);
        for (d, _) in cfg.graph.successors(cur) {
            stack.push(d);
        }
    }
    let pos = |cfg: &ControlFlowGraph, id: NodeId| -> usize {
        match cfg.values[id] {
            CfgValue::Node(k) => *ast_position.get(&k.address()).unwrap_or(&usize::MAX),
            CfgValue::ImplicitReturn => fallback_pos,
        }
    };
    reached.sort_by_key(|&id| pos(cfg, id));
    for id in reached {
        if cfg.priority[id] == 0 {
            counter += 1;
            cfg.priority[id] = counter;
        }
    }
    for id in 0..n {
        if cfg.priority[id] == 0 {
            counter += 1;
            cfg.priority[id] = counter;
        }
    }
    counter += 1;
    cfg.priority[cfg.implicit_return] = counter;
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_span::SourceType;

    /// Parse `code` (into the arena so refs are `'a`), take the first function
    /// decl's BODY, build its CFG.
    fn build_fn<'a>(allocator: &'a Allocator, code: &'a str) -> ControlFlowGraph<'a> {
        let program: &'a Program<'a> =
            allocator.alloc(crate::parse_program(allocator, code, SourceType::ts()));
        let Statement::FunctionDeclaration(f) = &program.body[0] else {
            panic!("expected function declaration")
        };
        let body: &'a FunctionBody<'a> = f.body.as_ref().expect("fn body");
        build(AstKind::FunctionBody(body)).expect("expected CFG, got bailout")
    }

    /// Successors of the CFG node matching `pred` on its AstKind.
    fn succs_of<'a>(
        cfg: &ControlFlowGraph<'a>,
        pred: impl Fn(AstKind<'a>) -> bool,
    ) -> Vec<(Option<AstKind<'a>>, Branch)> {
        let id = find(cfg, pred);
        cfg.successors(id).map(|(d, b)| (cfg.node(d), b)).collect()
    }

    fn find<'a>(cfg: &ControlFlowGraph<'a>, pred: impl Fn(AstKind<'a>) -> bool) -> NodeId {
        for id in 0..cfg.node_count() {
            if let Some(k) = cfg.node(id) {
                if pred(k) {
                    return id;
                }
            }
        }
        panic!("no matching CFG node");
    }

    fn is_expr_named(k: AstKind, name: &str) -> bool {
        matches!(k, AstKind::ExpressionStatement(es)
            if matches!(&es.expression, Expression::Identifier(id) if id.name == name))
    }

    fn targets_implicit_return(
        cfg: &ControlFlowGraph,
        succs: &[(Option<AstKind>, Branch)],
        br: Branch,
    ) -> bool {
        let _ = cfg;
        succs.iter().any(|(n, b)| n.is_none() && *b == br)
    }

    #[test]
    fn empty_function_entry_to_implicit_return() {
        let a = Allocator::default();
        let cfg = build_fn(&a, "function f() {}");
        let succs: Vec<_> = cfg.successors(cfg.entry).map(|(d, b)| (cfg.node(d), b)).collect();
        assert!(targets_implicit_return(&cfg, &succs, Branch::Uncond), "entry → implicit return");
    }

    #[test]
    fn linearises_straight_line() {
        let a = Allocator::default();
        let cfg = build_fn(&a, "function f() { a; b; c; }");
        let sa = succs_of(&cfg, |k| is_expr_named(k, "a"));
        assert!(
            sa.iter()
                .any(|(n, b)| n.is_some_and(|k| is_expr_named(k, "b")) && *b == Branch::Uncond),
            "a→b"
        );
        let sb = succs_of(&cfg, |k| is_expr_named(k, "b"));
        assert!(
            sb.iter()
                .any(|(n, b)| n.is_some_and(|k| is_expr_named(k, "c")) && *b == Branch::Uncond),
            "b→c"
        );
        let sc = succs_of(&cfg, |k| is_expr_named(k, "c"));
        assert!(targets_implicit_return(&cfg, &sc, Branch::Uncond), "c→IR");
    }

    #[test]
    fn if_else_true_false_edges() {
        let a = Allocator::default();
        let cfg = build_fn(&a, "function f() { if (cond) { a; } else { b; } }");
        let s = succs_of(&cfg, |k| matches!(k, AstKind::IfStatement(_)));
        assert!(s.iter().any(|(n, b)| *b == Branch::OnTrue
            && n.is_some_and(|k| matches!(k, AstKind::BlockStatement(_)))));
        assert!(s.iter().any(|(n, b)| *b == Branch::OnFalse
            && n.is_some_and(|k| matches!(k, AstKind::BlockStatement(_)))));
    }

    #[test]
    fn if_without_else_falls_through_on_false() {
        let a = Allocator::default();
        let cfg = build_fn(&a, "function f() { if (cond) { a; } b; }");
        let s = succs_of(&cfg, |k| matches!(k, AstKind::IfStatement(_)));
        let on_false = s.iter().find(|(_, b)| *b == Branch::OnFalse).expect("on_false");
        assert!(on_false.0.is_some_and(|k| is_expr_named(k, "b")), "if→b on false");
    }

    #[test]
    fn while_loop_edges() {
        let a = Allocator::default();
        let cfg = build_fn(&a, "function f() { while (cond) { a; } b; }");
        let s = succs_of(&cfg, |k| matches!(k, AstKind::WhileStatement(_)));
        assert!(s.iter().any(|(n, b)| *b == Branch::OnTrue
            && n.is_some_and(|k| matches!(k, AstKind::BlockStatement(_)))));
        assert!(s
            .iter()
            .any(|(n, b)| *b == Branch::OnFalse && n.is_some_and(|k| is_expr_named(k, "b"))));
        let sa = succs_of(&cfg, |k| is_expr_named(k, "a"));
        assert!(
            sa.iter().any(|(n, _)| n.is_some_and(|k| matches!(k, AstKind::WhileStatement(_)))),
            "body→while"
        );
    }

    #[test]
    fn while_true_omits_on_false() {
        let a = Allocator::default();
        let cfg = build_fn(&a, "function f() { while (true) { a; } }");
        let s = succs_of(&cfg, |k| matches!(k, AstKind::WhileStatement(_)));
        assert!(!s.iter().any(|(_, b)| *b == Branch::OnFalse));
        assert!(s.iter().any(|(_, b)| *b == Branch::OnTrue));
    }

    #[test]
    fn for_routes_through_update() {
        let a = Allocator::default();
        let cfg = build_fn(&a, "function f() { for (var i = 0; i < n; i++) { a; } }");
        let sa = succs_of(&cfg, |k| is_expr_named(k, "a"));
        let target = sa[0].0.expect("target");
        assert!(matches!(target, AstKind::UpdateExpression(_)), "body→update");
        let su = succs_of(&cfg, |k| matches!(k, AstKind::UpdateExpression(_)));
        assert!(
            su.iter().any(|(n, _)| n.is_some_and(|k| matches!(k, AstKind::ForStatement(_)))),
            "update→for"
        );
    }

    #[test]
    fn return_to_implicit_return() {
        let a = Allocator::default();
        let cfg = build_fn(&a, "function f() { return; }");
        let s = succs_of(&cfg, |k| matches!(k, AstKind::ReturnStatement(_)));
        assert!(targets_implicit_return(&cfg, &s, Branch::Uncond));
    }

    #[test]
    fn break_exits_loop() {
        let a = Allocator::default();
        let cfg = build_fn(&a, "function f() { while (cond) { break; } a; }");
        let s = succs_of(&cfg, |k| matches!(k, AstKind::BreakStatement(_)));
        assert!(s.iter().any(|(n, _)| n.is_some_and(|k| is_expr_named(k, "a"))), "break→a");
    }

    #[test]
    fn continue_jumps_to_header_or_update() {
        let a = Allocator::default();
        let cfg = build_fn(&a, "function f() { while (cond) { continue; a; } }");
        let s = succs_of(&cfg, |k| matches!(k, AstKind::ContinueStatement(_)));
        assert!(s.iter().any(|(n, _)| n.is_some_and(|k| matches!(k, AstKind::WhileStatement(_)))));
        let b = Allocator::default();
        let cfg2 = build_fn(&b, "function f() { for (var i = 0; i < n; i++) { continue; } }");
        let s2 = succs_of(&cfg2, |k| matches!(k, AstKind::ContinueStatement(_)));
        assert!(s2[0].0.is_some_and(|k| matches!(k, AstKind::UpdateExpression(_))));
    }

    #[test]
    fn bare_case_falls_to_sibling_not_next_case() {
        let a = Allocator::default();
        let cfg = build_fn(
            &a,
            "function f(x) { let v; switch (x) { case 1: v = 1; break; case 2: v = 2; break; } return v; }",
        );
        // The `v = 1` assignment must flow to the BreakStatement next to it.
        let s = succs_of(&cfg, |k| {
            matches!(k, AstKind::ExpressionStatement(es)
                if matches!(&es.expression, Expression::AssignmentExpression(a)
                    if matches!(&a.right, Expression::NumericLiteral(n) if n.value == 1.0)))
        });
        assert_eq!(s.len(), 1);
        assert!(
            s[0].0.is_some_and(|k| matches!(k, AstKind::BreakStatement(_))),
            "v=1 → break, not next case"
        );
    }

    #[test]
    fn skips_nested_function_bodies() {
        let a = Allocator::default();
        let cfg = build_fn(&a, "function f() { var g = function() { inner; }; outer; }");
        for id in 0..cfg.node_count() {
            if let Some(k) = cfg.node(id) {
                assert!(!is_expr_named(k, "inner"), "inner must not be a CFG node");
            }
        }
    }

    /// Build over the first function decl's BODY; true if it bailed.
    fn try_build_body<'a>(allocator: &'a Allocator, code: &'a str) -> bool {
        let program: &'a Program<'a> =
            allocator.alloc(crate::parse_program(allocator, code, SourceType::ts()));
        let Statement::FunctionDeclaration(f) = &program.body[0] else { panic!("fn decl") };
        let body: &'a FunctionBody<'a> = f.body.as_ref().expect("body");
        build(AstKind::FunctionBody(body)).is_none()
    }
    /// Build over the first function decl NODE (catches async/generator).
    fn try_build_fn<'a>(allocator: &'a Allocator, code: &'a str) -> bool {
        let program: &'a Program<'a> =
            allocator.alloc(crate::parse_program(allocator, code, SourceType::ts()));
        let Statement::FunctionDeclaration(f) = &program.body[0] else { panic!("fn decl") };
        build(AstKind::Function(f)).is_none()
    }

    #[test]
    fn bails_on_try_and_with() {
        let a = Allocator::default();
        assert!(try_build_body(&a, "function f() { try { a; } catch (e) { b; } }"), "try bails");
        let b = Allocator::default();
        assert!(try_build_body(&b, "function f(o) { with (o) { a; } }"), "with bails");
    }

    #[test]
    fn bails_on_async_generator_await_yield() {
        let a = Allocator::default();
        assert!(try_build_fn(&a, "async function f() { return 1; }"), "async bails");
        let b = Allocator::default();
        assert!(try_build_fn(&b, "function* g() { yield 1; }"), "generator bails");
        let c = Allocator::default();
        assert!(try_build_fn(&c, "async function f() { await foo(); }"), "await bails");
    }

    #[test]
    fn priorities_entry_before_implicit_return() {
        let a = Allocator::default();
        let cfg = build_fn(&a, "function f() { a; b; }");
        assert!(cfg.priority[cfg.entry] > 0);
        assert!(cfg.priority[cfg.implicit_return] > cfg.priority[cfg.entry]);
    }
}
