//! Port of `dead-assignments-elimination.ts` (jscomp `DeadAssignmentsElimination`).
//!
//! Drops writes to locals whose value is never read afterward, driven by
//! liveness: at a CFG node, a write to slot `s` is dead when `s` is not live-out.
//! Rewrites:
//!   - `x = rhs`   (dead)         → `rhs`            (keep rhs effects)
//!   - `x op= rhs` (dead)         → `x op rhs`       (keep read+compute)
//!   - `x = x` / `var x = x`      → removed (identity)
//!   - `var x = rhs` (dead)       → `var x;` + hoist `rhs;` if impure
//!   - `x++;` (dead, stmt pos)    → statement dropped
//!   - `for (;; x++)` (dead)      → update slot nulled
//!
//! Bails (`ran=false`): function with a nested function (closure capture), or
//! > `MAX_VARIABLES_TO_ANALYZE` slots (liveness didn't run), or CFG bailed.
//!
//! Analyze→apply split (oxc can't mutate through the CFG's immutable borrow):
//! `analyze` computes node-id-keyed rewrites from liveness; `apply` (a `VisitMut`)
//! performs them after the borrows are dropped. Keyed by `NodeId`, NOT span:
//! SROA/unroll/inline produce nodes sharing `SPAN(0,0)`, so span identity would
//! conflate a dead store with a live one and rewrite both.
//!
//! No test removes a *live-in* assignment, so we use the sound rule
//! `dead = !live_out && !live_in` for assigns/var-inits, and `!live_out` for
//! updates.

use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, TakeIn};
use oxc_ast::ast::*;
use oxc_ast::{AstBuilder, AstKind};
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_semantic::{NodeId as AstId, Semantic};
use oxc_span::SPAN;

use crate::analysis::cfg::ControlFlowGraph;
use crate::analysis::data_flow::LinearFlowState;
use crate::analysis::live_vars::{is_live, Live};
use crate::analysis::local_var_table::LocalVarTable;
use crate::passes::util::is_pure;

#[derive(Default)]
pub struct Rewrites {
    /// assignment node id → replace with its rhs (op `=`).
    replace_with_rhs: HashSet<AstId>,
    /// compound-assignment node id → rewrite to `lhs op rhs`.
    compound_to_binary: HashSet<AstId>,
    /// ExpressionStatement node id → drop (dead `x++;`).
    drop_stmt: HashSet<AstId>,
    /// ForStatement node id → null its `update` (dead `for(;;x++)`).
    null_for_update: HashSet<AstId>,
    /// declarator node id → init is impure (hoist `init;` after) when nulling.
    var_init: HashMap<AstId, bool>,
}

impl Rewrites {
    fn is_empty(&self) -> bool {
        self.replace_with_rhs.is_empty()
            && self.compound_to_binary.is_empty()
            && self.drop_stmt.is_empty()
            && self.null_for_update.is_empty()
            && self.var_init.is_empty()
    }
    fn merge(&mut self, other: Rewrites) {
        self.replace_with_rhs.extend(other.replace_with_rhs);
        self.compound_to_binary.extend(other.compound_to_binary);
        self.drop_stmt.extend(other.drop_stmt);
        self.null_for_update.extend(other.null_for_update);
        self.var_init.extend(other.var_init);
    }
}

/// Per-function driver: for each opted-in (`touched`) function, build a CFG +
/// liveness and eliminate dead assignments. Analyze (immutable: semantic/CFG)
/// → span-keyed `Rewrites`, then apply once after the borrows drop. Functions
/// that bail (CFG unbuildable / >100 vars / nested function) are skipped.
pub fn run<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    touched: &std::collections::HashSet<u32>,
) -> u32 {
    use crate::analysis::{cfg, live_vars, local_var_table};
    use oxc_ast::AstKind;
    use oxc_semantic::SemanticBuilder;

    let rewrites = {
        let semantic = SemanticBuilder::new().build(&*program).semantic;
        let nodes = semantic.nodes();
        let mut combined = Rewrites::default();
        for node in nodes.iter() {
            let AstKind::Function(f) = node.kind() else { continue };
            if !touched.contains(&f.span.start) {
                continue;
            }
            let Some(body) = f.body.as_ref() else { continue };
            let Some(cfg) = cfg::build(AstKind::FunctionBody(body)) else { continue };
            let table = local_var_table::build(&semantic, node.id());
            let Some(states) = live_vars::run(&cfg, &table) else { continue };
            if let Some(rw) = analyze(&semantic, &cfg, &table, &states, node.id()) {
                combined.merge(rw);
            }
        }
        combined
    };
    apply(allocator, program, rewrites)
}

/// Compute dead-assignment rewrites for the function rooted at `fn_node`. None
/// if the pass bails (nested function present). `states` come from `live_vars::run`.
pub fn analyze(
    semantic: &Semantic,
    cfg: &ControlFlowGraph,
    table: &LocalVarTable,
    states: &[LinearFlowState<Live>],
    fn_node: oxc_semantic::NodeId,
) -> Option<Rewrites> {
    if contains_nested_function(semantic, fn_node) {
        return None;
    }
    let mut rw = Rewrites::default();
    for (id, st) in states.iter().enumerate() {
        let Some(kind) = cfg.node(id) else { continue };
        collect(kind, &st.in_, &st.out, table, &mut rw);
    }
    Some(rw)
}

fn collect(kind: AstKind, in_: &Live, out: &Live, t: &LocalVarTable, rw: &mut Rewrites) {
    match kind {
        AstKind::ExpressionStatement(es) => match &es.expression {
            // `x++;` in statement position.
            Expression::UpdateExpression(u) => {
                if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = &u.argument {
                    if dead_out(id.node_id.get(), out, t) {
                        rw.drop_stmt.insert(es.node_id.get());
                    }
                }
            }
            e => walk_expr(e, in_, out, t, rw),
        },
        AstKind::VariableDeclaration(vd) => {
            for d in &vd.declarations {
                if let Some(init) = &d.init {
                    walk_expr(init, in_, out, t, rw);
                }
                handle_var_init(vd, d, in_, out, t, rw);
            }
        }
        AstKind::ReturnStatement(s) => {
            if let Some(a) = &s.argument {
                walk_expr(a, in_, out, t, rw);
            }
        }
        AstKind::ForStatement(s) => {
            // dead `for(;; x++)`.
            if let Some(Expression::UpdateExpression(u)) = &s.update {
                if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = &u.argument {
                    if dead_out(id.node_id.get(), out, t) {
                        rw.null_for_update.insert(s.node_id.get());
                    }
                }
            }
        }
        AstKind::IfStatement(s) => walk_expr(&s.test, in_, out, t, rw),
        AstKind::WhileStatement(s) => walk_expr(&s.test, in_, out, t, rw),
        AstKind::DoWhileStatement(s) => walk_expr(&s.test, in_, out, t, rw),
        AstKind::SwitchStatement(s) => walk_expr(&s.discriminant, in_, out, t, rw),
        AstKind::ThrowStatement(s) => walk_expr(&s.argument, in_, out, t, rw),
        AstKind::AssignmentExpression(a) => handle_assign(a, in_, out, t, rw),
        _ => {}
    }
}

/// Walk an expression collecting dead identifier assignments (recurse rhs first
/// for chains: `a = b = 5`).
fn walk_expr(e: &Expression, in_: &Live, out: &Live, t: &LocalVarTable, rw: &mut Rewrites) {
    match e {
        Expression::AssignmentExpression(a) => {
            walk_expr(&a.right, in_, out, t, rw);
            handle_assign(a, in_, out, t, rw);
        }
        Expression::SequenceExpression(s) => {
            for e in &s.expressions {
                walk_expr(e, in_, out, t, rw);
            }
        }
        Expression::ParenthesizedExpression(p) => walk_expr(&p.expression, in_, out, t, rw),
        _ => {}
    }
}

fn handle_assign(
    a: &AssignmentExpression,
    in_: &Live,
    out: &Live,
    t: &LocalVarTable,
    rw: &mut Rewrites,
) {
    let AssignmentTarget::AssignmentTargetIdentifier(lhs) = &a.left else { return };
    let Some(slot) = t.resolve(lhs.node_id.get()) else { return };
    if t.is_escaped(slot) {
        return;
    }
    // Identity `a = a` (op `=`) — always remove.
    if a.operator == AssignmentOperator::Assign {
        if let Expression::Identifier(r) = &a.right {
            if t.resolve(r.node_id.get()) == Some(slot) {
                rw.replace_with_rhs.insert(a.node_id.get());
                return;
            }
        }
    }
    if is_live(out, slot) || is_live(in_, slot) {
        return; // live afterward (or before, conservatively) — keep
    }
    if a.operator == AssignmentOperator::Assign {
        rw.replace_with_rhs.insert(a.node_id.get());
    } else {
        rw.compound_to_binary.insert(a.node_id.get());
    }
}

fn handle_var_init(
    vd: &VariableDeclaration,
    d: &VariableDeclarator,
    in_: &Live,
    out: &Live,
    t: &LocalVarTable,
    rw: &mut Rewrites,
) {
    if vd.kind == VariableDeclarationKind::Const {
        return; // nulling a const init is invalid
    }
    let BindingPattern::BindingIdentifier(id) = &d.id else { return };
    let Some(init) = &d.init else { return };
    let Some(slot) = t.resolve(id.node_id.get()) else { return };
    if t.is_escaped(slot) {
        return;
    }
    // identity `var a = a;`
    if let Expression::Identifier(r) = init {
        if t.resolve(r.node_id.get()) == Some(slot) {
            rw.var_init.insert(d.node_id.get(), false);
            return;
        }
    }
    if is_live(out, slot) || is_live(in_, slot) {
        return;
    }
    rw.var_init.insert(d.node_id.get(), !is_pure(init));
}

fn dead_out(node: AstId, out: &Live, t: &LocalVarTable) -> bool {
    match t.resolve(node) {
        Some(slot) => !t.is_escaped(slot) && !is_live(out, slot),
        None => false,
    }
}

/// True if `fn_node`'s body contains a nested function (closure capture bail).
fn contains_nested_function(semantic: &Semantic, fn_node: oxc_semantic::NodeId) -> bool {
    use oxc_ast_visit::Visit;
    struct V {
        found: bool,
    }
    impl<'a> Visit<'a> for V {
        fn visit_function(&mut self, _f: &Function<'a>, _: oxc_semantic::ScopeFlags) {
            self.found = true;
        }
        fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {
            self.found = true;
        }
    }
    let nodes = semantic.nodes();
    let mut v = V { found: false };
    match nodes.kind(fn_node) {
        AstKind::Function(f) => {
            if let Some(body) = &f.body {
                for s in &body.statements {
                    v.visit_statement(s);
                }
            }
        }
        AstKind::ArrowFunctionExpression(a) => {
            for s in &a.body.statements {
                v.visit_statement(s);
            }
        }
        _ => {}
    }
    v.found
}

/// Apply the rewrites to `program` (or any subtree). Returns the count.
pub fn apply<'a>(allocator: &'a Allocator, program: &mut Program<'a>, rw: Rewrites) -> u32 {
    if rw.is_empty() {
        return 0;
    }
    let mut a = Applier { ast: AstBuilder::new(allocator), rw, count: 0 };
    a.visit_program(program);
    a.count
}

struct Applier<'a> {
    ast: AstBuilder<'a>,
    rw: Rewrites,
    count: u32,
}

impl<'a> VisitMut<'a> for Applier<'a> {
    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expr); // inner first (chains)
        if let Expression::AssignmentExpression(a) = expr {
            let nid = a.node_id.get();
            if self.rw.replace_with_rhs.contains(&nid) {
                *expr = a.right.take_in(self.ast.allocator);
                self.count += 1;
            } else if self.rw.compound_to_binary.contains(&nid) {
                let op = compound_op(a.operator);
                if let (Some(op), AssignmentTarget::AssignmentTargetIdentifier(id)) = (op, &a.left)
                {
                    let left = self.ast.expression_identifier(id.span, id.name);
                    let right = a.right.take_in(self.ast.allocator);
                    *expr = self.ast.expression_binary(a.span, left, op, right);
                    self.count += 1;
                }
            }
        }
    }

    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts);
        let taken = stmts.take_in(self.ast.allocator);
        let mut out = self.ast.vec_with_capacity(taken.len());
        for mut stmt in taken {
            // Drop dead `x++;` statements.
            if let Statement::ExpressionStatement(es) = &stmt {
                if self.rw.drop_stmt.contains(&es.node_id.get()) {
                    self.count += 1;
                    continue;
                }
            }
            // Null dead `for(;;x++)` updates.
            if let Statement::ForStatement(f) = &mut stmt {
                if self.rw.null_for_update.contains(&f.node_id.get()) {
                    f.update = None;
                    self.count += 1;
                }
            }
            // Null dead var inits; hoist impure ones.
            if let Statement::VariableDeclaration(vd) = &mut stmt {
                let mut hoist: Vec<Expression<'a>> = Vec::new();
                for d in vd.declarations.iter_mut() {
                    if let Some(&impure) = self.rw.var_init.get(&d.node_id.get()) {
                        if let Some(init) = d.init.take() {
                            if impure {
                                hoist.push(init);
                            }
                            self.count += 1;
                        }
                    }
                }
                out.push(stmt);
                for init in hoist {
                    out.push(Statement::ExpressionStatement(
                        self.ast.alloc(self.ast.expression_statement(SPAN, init)),
                    ));
                }
                continue;
            }
            out.push(stmt);
        }
        *stmts = out;
    }
}

fn compound_op(op: AssignmentOperator) -> Option<BinaryOperator> {
    use AssignmentOperator as A;
    use BinaryOperator as B;
    Some(match op {
        A::Addition => B::Addition,
        A::Subtraction => B::Subtraction,
        A::Multiplication => B::Multiplication,
        A::Division => B::Division,
        A::Remainder => B::Remainder,
        A::Exponential => B::Exponential,
        A::ShiftLeft => B::ShiftLeft,
        A::ShiftRight => B::ShiftRight,
        A::ShiftRightZeroFill => B::ShiftRightZeroFill,
        A::BitwiseAnd => B::BitwiseAnd,
        A::BitwiseOR => B::BitwiseOR,
        A::BitwiseXOR => B::BitwiseXOR,
        _ => return None, // &&=, ||=, ??= — keep (short-circuit semantics)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;

    /// Run DAE in isolation (function opted-in via its span); return normalized code.
    fn dae(code: &str) -> String {
        let allocator = Allocator::default();
        let program: &mut Program =
            allocator.alloc(crate::parse_program(&allocator, code, SourceType::ts()));
        let mut touched = std::collections::HashSet::new();
        for s in &program.body {
            if let Statement::FunctionDeclaration(f) = s {
                touched.insert(f.span.start);
            }
        }
        run(&allocator, program, &touched);
        Codegen::new().build(program).code.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn drops_dead_store_inside_loop_body_keeps_side_effect() {
        // `var t = compute(i)` is never read → init nulled to `var t;`, and the
        // impure rhs is hoisted out as a statement (side effect retained).
        let out = dae(
            "/* @optimize */ function f() { for (var i = 0; i < 10; i++) { var t = compute(i); } }",
        );
        assert!(out.contains("var t;"), "dead init nulled: {out}");
        assert!(out.contains("compute(i);"), "impure rhs hoisted/retained: {out}");
        assert!(!out.contains("var t = compute"), "dead store removed: {out}");
    }

    #[test]
    fn try_catch_bails_no_elimination() {
        // try/catch makes the CFG bail (or keeps `x` conservatively live), so the
        // otherwise-dead `x = 2` and `var x = 1` are both retained.
        let out = dae(
            "/* @optimize */ function f() { var x = 1; try { x = 2; } catch (e) {} return x; }",
        );
        assert!(out.contains("var x = 1"), "no elimination on try/catch: {out}");
        assert!(out.contains("x = 2"), "no elimination on try/catch: {out}");
        assert!(out.contains("return x"), "{out}");
    }

    #[test]
    fn drops_simple_dead_store() {
        let out = dae("function f() { var x = 1; x = 2; return x; }");
        assert!(out.contains("return x"), "{out}");
        assert!(out.contains("x = 2"), "{out}");
        assert!(!out.contains("x = 1"), "first store dead: {out}");
    }

    #[test]
    fn keeps_store_read_on_one_branch() {
        let out = dae("function f(c) { var x = 1; if (c) { x = 2; } return x; }");
        assert!(out.contains("x = 2"), "live via join: {out}");
    }

    #[test]
    fn hoists_impure_dead_var_init() {
        let out = dae("function f() { var x = sideEffect(); }");
        assert!(out.contains("sideEffect()"), "effect retained: {out}");
    }

    #[test]
    fn removes_identity_assignment() {
        let out = dae("function f() { var a = 1; a = a; return a; }");
        assert!(!out.contains("a = a"), "{out}");
    }

    #[test]
    fn removes_dead_increment_in_stmt_position() {
        let out = dae("function f() { var x = 0; x++; return 5; }");
        assert!(!out.contains("x++"), "{out}");
    }

    #[test]
    fn keeps_observed_increment() {
        let out = dae("function f() { var x = 0; use(x++); return 5; }");
        assert!(out.contains("x++"), "value observed: {out}");
    }

    #[test]
    fn bails_on_nested_function() {
        let out = dae("function f() { var x = 1; x = 2; return function() { return x; }; }");
        assert!(out.contains("x = 1") && out.contains("x = 2"), "no elimination: {out}");
    }

    #[test]
    fn drops_dead_lhs_of_assignment_chain() {
        let out = dae("function f() { var a, b; a = b = 5; return b; }");
        assert!(!out.contains("a = b ="), "dead outer assign dropped: {out}");
    }
}
