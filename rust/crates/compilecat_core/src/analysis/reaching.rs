//! Port of `must-be-reaching-variable-def.ts` + `maybe-reaching-variable-use.ts`
//! (jscomp `MustBeReachingVariableDef` / `MaybeReachingVariableUse`, simplified
//! to the 3-state lattice FlowSensitiveInlineVariables needs).
//!
//! - **must-def** (forward): the *unique* definition that must reach each slot.
//!   Lattice per slot: TOP (none) / `Def(idx)` / BOTTOM (multiple distinct).
//! - **maybe-use** (backward): the *unique* use that might be reached next.
//!   Lattice per slot: TOP / `Use(span)` / BOTTOM.
//!
//! Each precomputes a flat per-CFG-node event list once (transfer is invariant
//! across worklist visits); the fixpoint iterates events, no AST walk per visit.

use std::collections::HashSet;

use oxc_allocator::{Address, GetAddress};
use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_semantic::NodeId as AstId;

use super::cfg::ControlFlowGraph;
use super::data_flow::{analyze, DataFlow, Direction, LinearFlowState};
use super::graph::NodeId;
use super::local_var_table::LocalVarTable;

// ── must-be-reaching-def ─────────────────────────────────────────────────────

#[derive(Clone)]
pub struct Definition {
    /// Arena address of the CFG node the def lives at (its identity for
    /// join/equality). Keyed by address, not span, so generated (`SPAN(0,0)`)
    /// defs stay distinct.
    pub node: Address,
    /// Slots the def's RHS reads.
    pub depends: HashSet<usize>,
    /// RHS references a name outside the local table (can't reason about it).
    pub unknown_dependencies: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum MustVal {
    Top,
    Bottom,
    Def(u32),
}

enum MustEvent {
    Write { slot: usize, conditional: bool, def: u32 },
    InvalidateAll,
}

struct MustAnalysis<'a> {
    table: &'a LocalVarTable,
    size: usize,
    defs: &'a [Definition],
    transfers: &'a [Vec<MustEvent>],
    sentinel: u32,
}

impl MustAnalysis<'_> {
    fn node_of(&self, v: MustVal) -> Option<Address> {
        match v {
            MustVal::Def(i) => Some(self.defs[i as usize].node),
            _ => None,
        }
    }
}

impl DataFlow for MustAnalysis<'_> {
    type Lattice = Vec<MustVal>;
    fn direction(&self) -> Direction {
        Direction::Forward
    }
    fn flow_through(
        &self,
        node: NodeId,
        _cfg: &ControlFlowGraph,
        input: &Vec<MustVal>,
    ) -> Vec<MustVal> {
        let mut out = input.clone();
        for e in &self.transfers[node] {
            match e {
                MustEvent::InvalidateAll => out.iter_mut().for_each(|s| *s = MustVal::Bottom),
                MustEvent::Write { slot, conditional, def } => {
                    for v in out.iter_mut() {
                        if let MustVal::Def(i) = *v {
                            if self.defs[i as usize].depends.contains(slot) {
                                *v = MustVal::Bottom;
                            }
                        }
                    }
                    if self.table.is_escaped(*slot) {
                        continue;
                    }
                    out[*slot] = if *conditional { MustVal::Bottom } else { MustVal::Def(*def) };
                }
            }
        }
        out
    }
    fn join(&self, a: &Vec<MustVal>, b: &Vec<MustVal>) -> Vec<MustVal> {
        (0..self.size)
            .map(|i| match (a[i], b[i]) {
                (MustVal::Top, x) | (x, MustVal::Top) => x,
                (MustVal::Bottom, _) | (_, MustVal::Bottom) => MustVal::Bottom,
                (x, y) if self.node_of(x) == self.node_of(y) => x,
                _ => MustVal::Bottom,
            })
            .collect()
    }
    fn equals(&self, a: &Vec<MustVal>, b: &Vec<MustVal>) -> bool {
        a.len() == b.len()
            && a.iter().zip(b).all(|(x, y)| match (x, y) {
                (MustVal::Def(_), MustVal::Def(_)) => self.node_of(*x) == self.node_of(*y),
                _ => x == y,
            })
    }
    fn bottom(&self) -> Vec<MustVal> {
        vec![MustVal::Top; self.size]
    }
    fn entry(&self) -> Vec<MustVal> {
        vec![MustVal::Def(self.sentinel); self.size]
    }
}

pub struct MustResult {
    states: Vec<LinearFlowState<Vec<MustVal>>>,
    defs: Vec<Definition>,
}

impl MustResult {
    /// The def reaching `slot` at the START of CFG node `cfg_node`, if unique.
    pub fn get_def(&self, slot: usize, cfg_node: NodeId) -> Option<&Definition> {
        match self.states.get(cfg_node)?.in_.get(slot)? {
            MustVal::Def(i) => self.defs.get(*i as usize),
            _ => None,
        }
    }
}

pub fn run_must_reaching(
    cfg: &ControlFlowGraph,
    table: &LocalVarTable,
    fn_root: Address,
) -> Option<MustResult> {
    let size = table.size();
    let mut defs: Vec<Definition> =
        vec![Definition { node: fn_root, depends: HashSet::new(), unknown_dependencies: false }];
    let sentinel = 0u32;

    let mut transfers: Vec<Vec<MustEvent>> = Vec::with_capacity(cfg.node_count());
    for id in 0..cfg.node_count() {
        let evs = match cfg.node(id) {
            Some(kind) => {
                let mut w = MustWalk {
                    table,
                    defs: &mut defs,
                    events: Vec::new(),
                    cfg_addr: kind.address(),
                };
                w.node(kind, false);
                w.events
            }
            None => Vec::new(),
        };
        transfers.push(evs);
    }

    let states = {
        let a = MustAnalysis { table, size, defs: &defs, transfers: &transfers, sentinel };
        analyze(cfg, &a).ok()?
    };
    Some(MustResult { states, defs })
}

struct MustWalk<'a, 'd> {
    table: &'a LocalVarTable,
    defs: &'d mut Vec<Definition>,
    events: Vec<MustEvent>,
    cfg_addr: Address,
}

impl MustWalk<'_, '_> {
    fn emit_write(&mut self, id_node: AstId, rhs: Option<&Expression>, conditional: bool) {
        let Some(slot) = self.table.resolve(id_node) else { return };
        let mut def = Definition {
            node: self.cfg_addr,
            depends: HashSet::new(),
            unknown_dependencies: false,
        };
        if let Some(rhs) = rhs {
            compute_dependence(&mut def, rhs, self.table);
        }
        let idx = self.defs.len() as u32;
        self.defs.push(def);
        self.events.push(MustEvent::Write { slot, conditional, def: idx });
    }

    fn node(&mut self, kind: AstKind, cond: bool) {
        match kind {
            AstKind::ExpressionStatement(s) => self.expr(&s.expression, cond),
            AstKind::VariableDeclaration(vd) => self.var_decl(vd, cond),
            AstKind::ReturnStatement(s) => {
                if let Some(a) = &s.argument {
                    self.expr(a, cond);
                }
            }
            AstKind::ThrowStatement(s) => self.expr(&s.argument, cond),
            AstKind::IfStatement(s) => self.expr(&s.test, cond),
            AstKind::WhileStatement(s) => self.expr(&s.test, cond),
            AstKind::DoWhileStatement(s) => self.expr(&s.test, cond),
            AstKind::ForStatement(s) => {
                if let Some(t) = &s.test {
                    self.expr(t, cond);
                }
            }
            AstKind::ForInStatement(s) => self.for_head(&s.left, &s.right, cond),
            AstKind::ForOfStatement(s) => self.for_head(&s.left, &s.right, cond),
            AstKind::SwitchStatement(s) => self.expr(&s.discriminant, cond),
            AstKind::SwitchCase(c) => {
                if let Some(t) = &c.test {
                    self.expr(t, cond);
                }
            }
            // for-test / for-update expression nodes:
            AstKind::AssignmentExpression(a) => self.assign(a, cond),
            AstKind::UpdateExpression(u) => self.update(u, cond),
            AstKind::SequenceExpression(s) => s.expressions.iter().for_each(|e| self.expr(e, cond)),
            AstKind::CallExpression(c) => self.call(c, cond),
            _ => {}
        }
    }

    fn var_decl(&mut self, vd: &VariableDeclaration, cond: bool) {
        for d in &vd.declarations {
            if let Some(init) = &d.init {
                self.expr(init, cond);
                if let BindingPattern::BindingIdentifier(id) = &d.id {
                    self.emit_write(id.node_id.get(), Some(init), cond);
                }
            }
        }
    }

    fn for_head(&mut self, left: &ForStatementLeft, _right: &Expression, cond: bool) {
        if let ForStatementLeft::VariableDeclaration(v) = left {
            if let Some(last) = v.declarations.last() {
                if let BindingPattern::BindingIdentifier(id) = &last.id {
                    self.emit_write(id.node_id.get(), None, cond);
                }
            }
        }
    }

    fn assign(&mut self, a: &AssignmentExpression, cond: bool) {
        if let AssignmentTarget::AssignmentTargetIdentifier(id) = &a.left {
            self.expr(&a.right, cond);
            self.emit_write(id.node_id.get(), Some(&a.right), cond);
        } else {
            self.expr(&a.right, cond);
        }
    }

    fn update(&mut self, u: &UpdateExpression, cond: bool) {
        if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = &u.argument {
            // self-referencing redefinition: depends on itself.
            // Build a def that depends on the slot it writes.
            let Some(slot) = self.table.resolve(id.node_id.get()) else { return };
            let mut def = Definition {
                node: self.cfg_addr,
                depends: HashSet::new(),
                unknown_dependencies: false,
            };
            def.depends.insert(slot);
            let idx = self.defs.len() as u32;
            self.defs.push(def);
            self.events.push(MustEvent::Write { slot, conditional: cond, def: idx });
        }
    }

    fn call(&mut self, c: &CallExpression, cond: bool) {
        self.expr(&c.callee, cond);
        for arg in &c.arguments {
            if let Some(e) = arg.as_expression() {
                self.expr(e, cond);
            }
        }
    }

    fn expr(&mut self, e: &Expression, cond: bool) {
        match e {
            Expression::AssignmentExpression(a) => self.assign(a, cond),
            Expression::UpdateExpression(u) => self.update(u, cond),
            Expression::LogicalExpression(l) => {
                self.expr(&l.left, cond);
                self.expr(&l.right, true);
            }
            Expression::ConditionalExpression(c) => {
                self.expr(&c.test, cond);
                self.expr(&c.consequent, true);
                self.expr(&c.alternate, true);
            }
            Expression::SequenceExpression(s) => {
                s.expressions.iter().for_each(|e| self.expr(e, cond))
            }
            Expression::ParenthesizedExpression(p) => self.expr(&p.expression, cond),
            Expression::CallExpression(c) => self.call(c, cond),
            Expression::BinaryExpression(b) => {
                self.expr(&b.left, cond);
                self.expr(&b.right, cond);
            }
            Expression::UnaryExpression(u) => self.expr(&u.argument, cond),
            Expression::Identifier(id) if id.name == "arguments" => {
                self.events.push(MustEvent::InvalidateAll);
            }
            _ => {}
        }
    }
}

/// Collect the slots `rhs` reads (and whether it reads any outside the table).
fn compute_dependence(def: &mut Definition, rhs: &Expression, table: &LocalVarTable) {
    use oxc_ast_visit::Visit;
    struct V<'a, 'd> {
        table: &'a LocalVarTable,
        def: &'d mut Definition,
    }
    impl<'a> Visit<'a> for V<'_, '_> {
        fn visit_function(&mut self, _f: &Function<'a>, _: oxc_semantic::ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {}
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            match self.table.resolve(id.node_id.get()) {
                Some(slot) => {
                    self.def.depends.insert(slot);
                }
                None => self.def.unknown_dependencies = true,
            }
        }
    }
    let mut v = V { table, def };
    v.visit_expression(rhs);
}

pub fn depends_on_outer_scope_vars(def: &Definition) -> bool {
    def.unknown_dependencies
}

// ── maybe-reaching-use ───────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum UseVal {
    Top,
    Bottom,
    Use(AstId),
}

enum MayEvent {
    Kill { slot: usize },
    Use { slot: usize, id: AstId },
}

struct MaybeAnalysis<'a> {
    size: usize,
    transfers: &'a [Vec<MayEvent>],
}

impl DataFlow for MaybeAnalysis<'_> {
    type Lattice = Vec<UseVal>;
    fn direction(&self) -> Direction {
        Direction::Backward
    }
    fn flow_through(
        &self,
        node: NodeId,
        _cfg: &ControlFlowGraph,
        out: &Vec<UseVal>,
    ) -> Vec<UseVal> {
        let mut r = out.clone();
        for e in &self.transfers[node] {
            match e {
                MayEvent::Kill { slot } => r[*slot] = UseVal::Top,
                MayEvent::Use { slot, id } => {
                    r[*slot] = match r[*slot] {
                        UseVal::Top => UseVal::Use(*id),
                        UseVal::Use(s) if s == *id => UseVal::Use(s),
                        _ => UseVal::Bottom,
                    };
                }
            }
        }
        r
    }
    fn join(&self, a: &Vec<UseVal>, b: &Vec<UseVal>) -> Vec<UseVal> {
        (0..self.size)
            .map(|i| match (a[i], b[i]) {
                (x, y) if x == y => x,
                (UseVal::Top, x) | (x, UseVal::Top) => x,
                _ => UseVal::Bottom,
            })
            .collect()
    }
    fn equals(&self, a: &Vec<UseVal>, b: &Vec<UseVal>) -> bool {
        a == b
    }
    fn bottom(&self) -> Vec<UseVal> {
        vec![UseVal::Top; self.size]
    }
    fn entry(&self) -> Vec<UseVal> {
        vec![UseVal::Top; self.size] // function end: no use reaches.
    }
}

pub struct MaybeResult {
    states: Vec<LinearFlowState<Vec<UseVal>>>,
}

impl MaybeResult {
    /// The unique use of `slot` reachable just AFTER `cfg_node`, if unique.
    /// Returns the use identifier's node id, or None (TOP or BOTTOM).
    pub fn unique_use_after(&self, slot: usize, cfg_node: NodeId) -> Option<AstId> {
        match self.states.get(cfg_node)?.out.get(slot)? {
            UseVal::Use(s) => Some(*s),
            _ => None,
        }
    }
    /// True iff exactly one use (any) reaches after — distinguishes TOP/Use from
    /// BOTTOM. (Callers usually want `unique_use_after` matched to a target.)
    pub fn is_bottom_after(&self, slot: usize, cfg_node: NodeId) -> bool {
        matches!(self.states.get(cfg_node).and_then(|s| s.out.get(slot)), Some(UseVal::Bottom))
    }
}

pub fn run_maybe_reaching(cfg: &ControlFlowGraph, table: &LocalVarTable) -> Option<MaybeResult> {
    let size = table.size();
    let mut transfers: Vec<Vec<MayEvent>> = Vec::with_capacity(cfg.node_count());
    for id in 0..cfg.node_count() {
        let evs = match cfg.node(id) {
            Some(kind) => {
                let mut w = MayWalk { table, events: Vec::new() };
                w.node(kind, false);
                w.events
            }
            None => Vec::new(),
        };
        transfers.push(evs);
    }
    let states = {
        let a = MaybeAnalysis { size, transfers: &transfers };
        analyze(cfg, &a).ok()?
    };
    Some(MaybeResult { states })
}

struct MayWalk<'a> {
    table: &'a LocalVarTable,
    events: Vec<MayEvent>,
}

impl MayWalk<'_> {
    fn kill(&mut self, node: AstId) {
        if let Some(slot) = self.table.resolve(node) {
            if !self.table.is_escaped(slot) {
                self.events.push(MayEvent::Kill { slot });
            }
        }
    }
    fn use_(&mut self, node: AstId) {
        if let Some(slot) = self.table.resolve(node) {
            if !self.table.is_escaped(slot) {
                self.events.push(MayEvent::Use { slot, id: node });
            }
        }
    }

    fn node(&mut self, kind: AstKind, cond: bool) {
        match kind {
            AstKind::ExpressionStatement(s) => self.expr(&s.expression, cond),
            AstKind::VariableDeclaration(vd) => self.var_decl(vd, cond),
            AstKind::ReturnStatement(s) => {
                if let Some(a) = &s.argument {
                    self.expr(a, cond);
                }
            }
            AstKind::ThrowStatement(s) => self.expr(&s.argument, cond),
            AstKind::IfStatement(s) => self.expr(&s.test, cond),
            AstKind::WhileStatement(s) => self.expr(&s.test, cond),
            AstKind::DoWhileStatement(s) => self.expr(&s.test, cond),
            AstKind::ForStatement(s) => {
                if let Some(t) = &s.test {
                    self.expr(t, cond);
                }
            }
            AstKind::ForInStatement(s) => self.for_head(&s.left, &s.right, cond),
            AstKind::ForOfStatement(s) => self.for_head(&s.left, &s.right, cond),
            AstKind::SwitchStatement(s) => self.expr(&s.discriminant, cond),
            AstKind::SwitchCase(c) => {
                if let Some(t) = &c.test {
                    self.expr(t, cond);
                }
            }
            AstKind::AssignmentExpression(a) => self.assign(a, cond),
            AstKind::UpdateExpression(u) => self.update(u, cond),
            AstKind::SequenceExpression(s) => {
                for e in s.expressions.iter().rev() {
                    self.expr(e, cond);
                }
            }
            AstKind::CallExpression(c) => self.call(c, cond),
            AstKind::IdentifierReference(id) => self.use_(id.node_id.get()),
            _ => {}
        }
    }

    fn var_decl(&mut self, vd: &VariableDeclaration, cond: bool) {
        for d in vd.declarations.iter().rev() {
            if let Some(init) = &d.init {
                if let BindingPattern::BindingIdentifier(id) = &d.id {
                    if !cond {
                        self.kill(id.node_id.get());
                    }
                }
                self.expr(init, cond);
            }
        }
    }

    fn for_head(&mut self, left: &ForStatementLeft, right: &Expression, cond: bool) {
        if !cond {
            if let ForStatementLeft::VariableDeclaration(v) = left {
                if let Some(last) = v.declarations.last() {
                    if let BindingPattern::BindingIdentifier(id) = &last.id {
                        self.kill(id.node_id.get());
                    }
                }
            }
        }
        self.expr(right, cond);
    }

    fn assign(&mut self, a: &AssignmentExpression, cond: bool) {
        if let AssignmentTarget::AssignmentTargetIdentifier(id) = &a.left {
            if !cond {
                self.kill(id.node_id.get());
            }
            if a.operator != AssignmentOperator::Assign {
                self.use_(id.node_id.get());
            }
            self.expr(&a.right, cond);
        } else {
            self.expr(&a.right, cond);
        }
    }

    fn update(&mut self, u: &UpdateExpression, cond: bool) {
        if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = &u.argument {
            if !cond {
                self.kill(id.node_id.get());
            }
            self.use_(id.node_id.get());
        }
    }

    fn call(&mut self, c: &CallExpression, cond: bool) {
        for arg in c.arguments.iter().rev() {
            if let Some(e) = arg.as_expression() {
                self.expr(e, cond);
            }
        }
        self.expr(&c.callee, cond);
    }

    fn expr(&mut self, e: &Expression, cond: bool) {
        match e {
            Expression::Identifier(id) => self.use_(id.node_id.get()),
            Expression::AssignmentExpression(a) => self.assign(a, cond),
            Expression::UpdateExpression(u) => self.update(u, cond),
            Expression::LogicalExpression(l) => {
                self.expr(&l.right, true);
                self.expr(&l.left, cond);
            }
            Expression::ConditionalExpression(c) => {
                self.expr(&c.alternate, true);
                self.expr(&c.consequent, true);
                self.expr(&c.test, cond);
            }
            Expression::SequenceExpression(s) => {
                for e in s.expressions.iter().rev() {
                    self.expr(e, cond);
                }
            }
            Expression::ParenthesizedExpression(p) => self.expr(&p.expression, cond),
            Expression::CallExpression(c) => self.call(c, cond),
            Expression::BinaryExpression(b) => {
                self.expr(&b.right, cond);
                self.expr(&b.left, cond);
            }
            Expression::UnaryExpression(u) => self.expr(&u.argument, cond),
            Expression::StaticMemberExpression(m) => self.expr(&m.object, cond),
            Expression::ComputedMemberExpression(m) => {
                self.expr(&m.expression, cond);
                self.expr(&m.object, cond);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::cfg::build as build_cfg;
    use crate::analysis::local_var_table;
    use oxc_allocator::Allocator;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;

    struct Ctx<'a> {
        cfg: ControlFlowGraph<'a>,
        table: LocalVarTable,
        fn_root: Address,
    }
    fn setup<'a>(a: &'a Allocator, code: &'a str) -> Ctx<'a> {
        let program: &'a Program<'a> = a.alloc(crate::parse_program(a, code, SourceType::ts()));
        let semantic = SemanticBuilder::new().build(program).semantic;
        let nodes = semantic.nodes();
        let fn_id = nodes.iter().find(|n| matches!(n.kind(), AstKind::Function(_))).unwrap().id();
        let AstKind::Function(f) = nodes.kind(fn_id) else { unreachable!() };
        let body: &'a FunctionBody<'a> = f.body.as_ref().unwrap();
        let cfg = build_cfg(AstKind::FunctionBody(body)).unwrap();
        let table = local_var_table::build(&semantic, fn_id);
        Ctx { cfg, table, fn_root: AstKind::FunctionBody(body).address() }
    }

    fn node_matching<'a>(cfg: &ControlFlowGraph<'a>, pred: impl Fn(AstKind<'a>) -> bool) -> NodeId {
        (0..cfg.node_count()).find(|&id| cfg.node(id).is_some_and(&pred)).expect("node")
    }

    #[test]
    fn must_def_reaches_unique_def() {
        let a = Allocator::default();
        let ctx = setup(&a, "function f() { var x = 1; return x; }");
        let must = run_must_reaching(&ctx.cfg, &ctx.table, ctx.fn_root).unwrap();
        let var_decl = node_matching(&ctx.cfg, |k| matches!(k, AstKind::VariableDeclaration(_)));
        let ret = node_matching(&ctx.cfg, |k| matches!(k, AstKind::ReturnStatement(_)));
        let x = (0..ctx.table.size()).find(|&s| ctx.table.name_of(s) == "x").unwrap();
        // At the return, x's unique reaching def is the `var x = 1` node.
        let def = must.get_def(x, ret).expect("a reaching def");
        assert_eq!(def.node, ctx.cfg.node(var_decl).unwrap().address(), "def is the var-decl");
    }

    #[test]
    fn must_def_bottom_on_two_defs() {
        let a = Allocator::default();
        let ctx = setup(&a, "function f(c) { var x; if (c) { x = 1; } else { x = 2; } return x; }");
        let must = run_must_reaching(&ctx.cfg, &ctx.table, ctx.fn_root).unwrap();
        let ret = node_matching(&ctx.cfg, |k| matches!(k, AstKind::ReturnStatement(_)));
        let x = (0..ctx.table.size()).find(|&s| ctx.table.name_of(s) == "x").unwrap();
        // Two distinct defs reach the return → BOTTOM → no unique def.
        assert!(must.get_def(x, ret).is_none(), "two defs → BOTTOM");
    }

    #[test]
    fn maybe_use_unique_after_def() {
        let a = Allocator::default();
        let ctx = setup(&a, "function f() { var x = 1; return x; }");
        let maybe = run_maybe_reaching(&ctx.cfg, &ctx.table).unwrap();
        let var_decl = node_matching(&ctx.cfg, |k| matches!(k, AstKind::VariableDeclaration(_)));
        let x = (0..ctx.table.size()).find(|&s| ctx.table.name_of(s) == "x").unwrap();
        // After `var x = 1`, a unique use of x reaches (the `x` in return).
        assert!(maybe.unique_use_after(x, var_decl).is_some(), "unique use reaches");
        assert!(!maybe.is_bottom_after(x, var_decl));
    }

    #[test]
    fn maybe_use_bottom_on_two_uses() {
        let a = Allocator::default();
        let ctx = setup(&a, "function f(c) { var x = 1; if (c) { use(x); } else { use(x); } }");
        let maybe = run_maybe_reaching(&ctx.cfg, &ctx.table).unwrap();
        let var_decl = node_matching(&ctx.cfg, |k| matches!(k, AstKind::VariableDeclaration(_)));
        let x = (0..ctx.table.size()).find(|&s| ctx.table.name_of(s) == "x").unwrap();
        // Two distinct uses reach after the def → BOTTOM.
        assert!(maybe.is_bottom_after(x, var_decl), "two uses → BOTTOM");
    }
}
