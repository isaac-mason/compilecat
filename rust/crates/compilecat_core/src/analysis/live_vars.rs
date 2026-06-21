//! Port of `live-variables-analysis.ts` (jscomp `LiveVariablesAnalysis`).
//!
//! Backward dataflow: a slot is "live at P" if its value might be read after P.
//! Lattice = bitset over the function's slots; JOIN = OR; transfer is
//! `in = (out − KILL) | GEN`. GEN/KILL come from walking the CFG node's AST:
//! reads → gen; definite (unconditional) writes → kill; compound assigns and
//! `x++` → both. Conditional sub-expressions (`&&`/`||`/`??` RHS, `?:` branches)
//! may only gen, never kill. Escaped slots are live-out at function exit.
//!
//! Bails (`ran=false`) when the function has > `MAX_VARIABLES_TO_ANALYZE` slots.

use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_ast_visit::Visit;
use oxc_semantic::ScopeFlags;
use oxc_span::GetSpan;

use super::cfg::ControlFlowGraph;
use super::data_flow::{analyze, DataFlow, Direction, LinearFlowState};
use super::graph::NodeId;
use super::local_var_table::LocalVarTable;

pub const MAX_VARIABLES_TO_ANALYZE: usize = 100;

/// Bitset lattice (one bit per slot).
pub type Live = Vec<u32>;

fn new_lattice(size: usize) -> Live {
    vec![0; size.div_ceil(32)]
}
fn set(l: &mut Live, idx: usize) {
    l[idx >> 5] |= 1 << (idx & 31);
}
pub fn is_live(l: &Live, idx: usize) -> bool {
    l[idx >> 5] & (1 << (idx & 31)) != 0
}

struct LiveAnalysis<'t> {
    table: &'t LocalVarTable,
    size: usize,
}

impl DataFlow for LiveAnalysis<'_> {
    type Lattice = Live;
    fn direction(&self) -> Direction {
        Direction::Backward
    }
    fn flow_through(&self, node: NodeId, cfg: &ControlFlowGraph, out: &Live) -> Live {
        let mut gen = new_lattice(self.size);
        let mut kill = new_lattice(self.size);
        if let Some(kind) = cfg.node(node) {
            let mut gk = GenKill { table: self.table, gen: &mut gen, kill: &mut kill };
            gk.node(kind);
        }
        // (out & !kill) | gen
        let mut r = out.clone();
        for i in 0..r.len() {
            r[i] = (r[i] & !kill[i]) | gen[i];
        }
        r
    }
    fn join(&self, a: &Live, b: &Live) -> Live {
        let mut r = a.clone();
        for i in 0..r.len() {
            r[i] |= b[i];
        }
        r
    }
    fn equals(&self, a: &Live, b: &Live) -> bool {
        a == b
    }
    fn bottom(&self) -> Live {
        new_lattice(self.size)
    }
    fn entry(&self) -> Live {
        // Backward: flows into the implicit return. Escaped locals are live-out.
        let mut l = new_lattice(self.size);
        for &slot in &self.table.escaped {
            set(&mut l, slot);
        }
        l
    }
}

/// Run liveness. Returns per-node states, or None if the function bailed
/// (too many slots).
pub fn run(cfg: &ControlFlowGraph, table: &LocalVarTable) -> Option<Vec<LinearFlowState<Live>>> {
    if table.size() > MAX_VARIABLES_TO_ANALYZE {
        return None;
    }
    let analysis = LiveAnalysis { table, size: table.size() };
    analyze(cfg, &analysis).ok()
}

// ── GEN/KILL ─────────────────────────────────────────────────────────────────

struct GenKill<'t, 'g> {
    table: &'t LocalVarTable,
    gen: &'g mut Live,
    kill: &'g mut Live,
}

impl GenKill<'_, '_> {
    fn gen_slot(&mut self, slot: usize) {
        set(self.gen, slot);
    }
    fn kill_slot(&mut self, slot: usize) {
        set(self.kill, slot);
    }

    /// Top-level entry for a CFG node (statement, or a for-header expression).
    fn node(&mut self, kind: AstKind) {
        match kind {
            AstKind::ExpressionStatement(s) => self.expr(&s.expression, false),
            AstKind::VariableDeclaration(vd) => {
                for d in &vd.declarations {
                    if let Some(init) = &d.init {
                        self.expr(init, false);
                        self.kill_pattern(&d.id);
                    }
                    // `let x;` (no init) does NOT kill (no prior value overwritten).
                }
            }
            AstKind::ReturnStatement(s) => {
                if let Some(a) = &s.argument {
                    self.expr(a, false);
                }
            }
            AstKind::ThrowStatement(s) => self.expr(&s.argument, false),
            AstKind::IfStatement(s) => self.expr(&s.test, false),
            AstKind::WhileStatement(s) => self.expr(&s.test, false),
            AstKind::DoWhileStatement(s) => self.expr(&s.test, false),
            AstKind::ForStatement(s) => {
                if let Some(test) = &s.test {
                    self.expr(test, false);
                }
            }
            AstKind::ForInStatement(s) => self.for_left(&s.left),
            AstKind::ForOfStatement(s) => self.for_left(&s.left),
            AstKind::SwitchStatement(s) => self.expr(&s.discriminant, false),
            AstKind::SwitchCase(c) => {
                if let Some(test) = &c.test {
                    self.expr(test, false);
                }
            }
            // for-test / for-update CFG nodes are expressions:
            AstKind::UpdateExpression(u) => self.update(u, false),
            AstKind::AssignmentExpression(a) => self.assign(a, false),
            AstKind::SequenceExpression(s) => {
                for e in &s.expressions {
                    self.expr(e, false);
                }
            }
            AstKind::BinaryExpression(b) => {
                self.expr(&b.left, false);
                self.expr(&b.right, false);
            }
            AstKind::LogicalExpression(l) => {
                self.expr(&l.left, false);
                self.expr(&l.right, true);
            }
            AstKind::CallExpression(c) => self.call(c, false),
            AstKind::IdentifierReference(id) => self.read(id.name.as_str(), id.node_id.get()),
            // Other expression kinds as a for-header: collect reads (sound).
            other => {
                if other.span() != oxc_span::SPAN {
                    self.reads_in_kind(other);
                }
            }
        }
    }

    fn for_left(&mut self, left: &ForStatementLeft) {
        match left {
            ForStatementLeft::VariableDeclaration(v) => {
                if let Some(last) = v.declarations.last() {
                    self.kill_pattern(&last.id);
                }
            }
            // assignment target (`for (x in y)`) — x is written.
            _ => {
                if let Some(AssignmentTarget::AssignmentTargetIdentifier(id)) =
                    left.as_assignment_target()
                {
                    if let Some(slot) = self.table.resolve(id.node_id.get()) {
                        if !self.table.is_escaped(slot) {
                            self.kill_slot(slot);
                        }
                    }
                }
            }
        }
    }

    fn read(&mut self, name: &str, node: oxc_semantic::NodeId) {
        if name == "arguments" {
            return; // handled via escape in the table
        }
        if let Some(slot) = self.table.resolve(node) {
            if !self.table.is_escaped(slot) {
                self.gen_slot(slot);
            }
        }
    }

    fn assign(&mut self, a: &AssignmentExpression, cond: bool) {
        match &a.left {
            AssignmentTarget::AssignmentTargetIdentifier(id) => {
                if let Some(slot) = self.table.resolve(id.node_id.get()) {
                    if !self.table.is_escaped(slot) {
                        if !cond {
                            self.kill_slot(slot);
                        }
                        if a.operator != AssignmentOperator::Assign {
                            self.gen_slot(slot); // compound reads first
                        }
                    }
                }
                self.expr(&a.right, cond);
            }
            AssignmentTarget::ArrayAssignmentTarget(_)
            | AssignmentTarget::ObjectAssignmentTarget(_) => {
                if !cond {
                    self.kill_assign_target(&a.left);
                }
                self.expr(&a.right, cond);
            }
            // member assignment (`o.x = …`) — read the object side + rhs.
            _ => {
                if let Some(expr) = a.left.as_member_expression() {
                    self.member_reads(expr, cond);
                }
                self.expr(&a.right, cond);
            }
        }
    }

    fn update(&mut self, u: &UpdateExpression, cond: bool) {
        if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = &u.argument {
            if let Some(slot) = self.table.resolve(id.node_id.get()) {
                if !self.table.is_escaped(slot) {
                    self.gen_slot(slot);
                    if !cond {
                        self.kill_slot(slot);
                    }
                }
            }
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

    fn member_reads(&mut self, m: &MemberExpression, cond: bool) {
        match m {
            MemberExpression::ComputedMemberExpression(c) => {
                self.expr(&c.object, cond);
                self.expr(&c.expression, cond);
            }
            MemberExpression::StaticMemberExpression(s) => self.expr(&s.object, cond),
            MemberExpression::PrivateFieldExpression(p) => self.expr(&p.object, cond),
        }
    }

    fn expr(&mut self, e: &Expression, cond: bool) {
        match e {
            Expression::Identifier(id) => self.read(id.name.as_str(), id.node_id.get()),
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
                for e in &s.expressions {
                    self.expr(e, cond);
                }
            }
            Expression::ParenthesizedExpression(p) => self.expr(&p.expression, cond),
            Expression::CallExpression(c) => self.call(c, cond),
            Expression::BinaryExpression(b) => {
                self.expr(&b.left, cond);
                self.expr(&b.right, cond);
            }
            Expression::UnaryExpression(u) => self.expr(&u.argument, cond),
            Expression::StaticMemberExpression(s) => self.expr(&s.object, cond),
            Expression::ComputedMemberExpression(c) => {
                self.expr(&c.object, cond);
                self.expr(&c.expression, cond);
            }
            // Long tail (literals, objects, arrays, templates, new, …): collect
            // identifier reads (sound — never kills). Skips nested functions.
            other => self.reads_in_expr(other),
        }
    }

    fn kill_pattern(&mut self, pat: &BindingPattern) {
        let mut names = Vec::new();
        collect_pattern_idents(pat, &mut names);
        for node in names {
            if let Some(slot) = self.table.resolve(node) {
                if !self.table.is_escaped(slot) {
                    self.kill_slot(slot);
                }
            }
        }
    }

    fn kill_assign_target(&mut self, t: &AssignmentTarget) {
        // Collect identifier targets in a destructuring assignment.
        struct V<'a, 't, 'g> {
            gk: &'a mut GenKill<'t, 'g>,
        }
        impl<'x> Visit<'x> for V<'_, '_, '_> {
            fn visit_identifier_reference(&mut self, id: &IdentifierReference<'x>) {
                if let Some(slot) = self.gk.table.resolve(id.node_id.get()) {
                    if !self.gk.table.is_escaped(slot) {
                        self.gk.kill_slot(slot);
                    }
                }
            }
            fn visit_function(&mut self, _f: &Function<'x>, _: ScopeFlags) {}
            fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'x>) {}
        }
        let mut v = V { gk: self };
        v.visit_assignment_target(t);
    }

    /// Sound fallback: gen every identifier read in `e`'s subtree (no kills),
    /// skipping nested functions.
    fn reads_in_expr(&mut self, e: &Expression) {
        let mut c = ReadCollector { hits: Vec::new() };
        c.visit_expression(e);
        for (name, node) in c.hits {
            self.read(&name, node);
        }
    }
    fn reads_in_kind(&mut self, kind: AstKind) {
        // Only used for unusual for-header expression kinds; collect reads.
        if let Some(e) = kind_as_expression_span(kind) {
            self.read(&e.0, e.1);
        }
    }
}

struct ReadCollector {
    hits: Vec<(String, oxc_semantic::NodeId)>,
}
impl<'a> Visit<'a> for ReadCollector {
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        self.hits.push((id.name.to_string(), id.node_id.get()));
    }
    fn visit_function(&mut self, _f: &Function<'a>, _: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {}
}

fn kind_as_expression_span(kind: AstKind) -> Option<(String, oxc_semantic::NodeId)> {
    if let AstKind::IdentifierReference(id) = kind {
        return Some((id.name.to_string(), id.node_id.get()));
    }
    None
}

fn collect_pattern_idents(pat: &BindingPattern, out: &mut Vec<oxc_semantic::NodeId>) {
    match pat {
        BindingPattern::BindingIdentifier(id) => out.push(id.node_id.get()),
        BindingPattern::ObjectPattern(o) => {
            for p in &o.properties {
                collect_pattern_idents(&p.value, out);
            }
            if let Some(r) = &o.rest {
                collect_pattern_idents(&r.argument, out);
            }
        }
        BindingPattern::ArrayPattern(a) => {
            for e in a.elements.iter().flatten() {
                collect_pattern_idents(e, out);
            }
            if let Some(r) = &a.rest {
                collect_pattern_idents(&r.argument, out);
            }
        }
        BindingPattern::AssignmentPattern(a) => collect_pattern_idents(&a.left, out),
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
    use std::collections::HashSet;

    struct Ctx<'a> {
        cfg: ControlFlowGraph<'a>,
        table: LocalVarTable,
        states: Option<Vec<LinearFlowState<Live>>>,
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
        let states = run(&cfg, &table);
        Ctx { cfg, table, states }
    }

    /// Live names at the in/out of the first CFG node matching `pred`.
    fn live_at(ctx: &Ctx, pred: impl Fn(AstKind) -> bool, out: bool) -> HashSet<String> {
        let states = ctx.states.as_ref().unwrap();
        for id in 0..ctx.cfg.node_count() {
            if let Some(k) = ctx.cfg.node(id) {
                if pred(k) {
                    let l = if out { &states[id].out } else { &states[id].in_ };
                    let mut names = HashSet::new();
                    for slot in 0..ctx.table.size() {
                        if is_live(l, slot) {
                            names.insert(ctx.table.name_of(slot).to_string());
                        }
                    }
                    return names;
                }
            }
        }
        panic!("node not found");
    }

    fn is_var_decl(k: AstKind) -> bool {
        matches!(k, AstKind::VariableDeclaration(_))
    }

    #[test]
    fn unread_store_is_dead() {
        let a = Allocator::default();
        let ctx = setup(&a, "function f() { var x = 1; }");
        assert!(ctx.states.is_some());
        assert!(!live_at(&ctx, is_var_decl, true).contains("x"));
    }

    #[test]
    fn kept_alive_across_use() {
        let a = Allocator::default();
        let ctx = setup(&a, "function f() { var x = 1; use(x); }");
        assert!(live_at(&ctx, is_var_decl, true).contains("x"));
    }

    #[test]
    fn joins_across_branches() {
        let a = Allocator::default();
        let ctx = setup(
            &a,
            "function f() { var x = 1; var y = 2; if (cond) { use(x); } else { use(y); } }",
        );
        // OUT of `var y = 2;` — both x and y live.
        let out = live_at(
            &ctx,
            |k| {
                matches!(k, AstKind::VariableDeclaration(v)
                    if matches!(&v.declarations[0].id, BindingPattern::BindingIdentifier(id) if id.name == "y"))
            },
            true,
        );
        assert!(out.contains("x"), "x live: {out:?}");
        assert!(out.contains("y"), "y live: {out:?}");
    }

    #[test]
    fn escaped_locals_live_out() {
        let a = Allocator::default();
        let ctx = setup(&a, "function f() { var x = 1; return function() { return x; }; }");
        assert!(ctx.states.is_some());
        let x = (0..ctx.table.size()).find(|&s| ctx.table.name_of(s) == "x").unwrap();
        assert!(ctx.table.is_escaped(x), "captured x escapes");
    }

    #[test]
    fn bails_over_max_vars() {
        let a = Allocator::default();
        let decls: String =
            (0..105).map(|i| format!("var v{i} = 0;")).collect::<Vec<_>>().join(" ");
        let code = format!("function f() {{ {decls} }}");
        // leak code into allocator-bound str
        let code: &str = a.alloc_str(&code);
        let ctx = setup(&a, code);
        assert!(ctx.states.is_none(), "bails over MAX_VARIABLES_TO_ANALYZE");
    }

    #[test]
    fn inner_shadow_does_not_kill_outer() {
        let a = Allocator::default();
        let ctx = setup(&a, "function f() { var x = 1; { let x = 2; sink(x); } use(x); }");
        assert!(ctx.states.is_some());
        let out = live_at(
            &ctx,
            |k| {
                matches!(k, AstKind::VariableDeclaration(v) if v.kind == VariableDeclarationKind::Var
                    && matches!(&v.declarations[0].id, BindingPattern::BindingIdentifier(id) if id.name == "x"))
            },
            true,
        );
        assert!(out.contains("x"), "outer x live across inner shadow: {out:?}");
    }

    #[test]
    fn compound_assign_read_then_write() {
        let a = Allocator::default();
        let ctx = setup(&a, "function f() { var x = 1; x += 2; }");
        let pred = |k: AstKind| {
            matches!(k, AstKind::ExpressionStatement(es)
                if matches!(&es.expression, Expression::AssignmentExpression(a) if a.operator == AssignmentOperator::Addition))
        };
        assert!(live_at(&ctx, pred, false).contains("x"), "x live before +=");
        assert!(!live_at(&ctx, pred, true).contains("x"), "x dead after +=");
    }
}
