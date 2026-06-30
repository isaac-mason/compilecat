//! Readability cleanup of **compiler-generated residue** — NOT a general
//! minifier and NEVER touches user code (hard rule from the goal).
//!
//! sroa expands `const v=[…]` into `let v_0, v_1, …` scalars + assignments;
//! after fold/inline-variables that leaves shapes like
//! `let v_0 = 1; v_0 = 5; return v_0;`. This pass reduces such residue to
//! `return 5` so the intermediate TS output stays clean.
//!
//! **Identifying generated vars without plumbing:** every node compilecat
//! synthesizes carries `SPAN(0,0)`, so a function-local whose declarator span
//! starts at 0 is compiler-generated. User bindings always have a real span
//! (>0 inside a function — the header precedes them).
//!
//! v1 is deliberately conservative (straight-line, literal propagation only,
//! recurse into nested blocks with fresh state). Correctness is gated by the
//! behavioral-equivalence harness.

use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::ast::*;
use oxc_ast::{AstBuilder, AstKind};
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_semantic::{NodeId, SemanticBuilder};
use oxc_span::GetSpan;

pub fn run<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> u32 {
    // Generated non-escaped local names (span-0 declarator, no nested-fn capture).
    let generated: HashSet<String> = {
        let semantic = SemanticBuilder::new().build(&*program).semantic;
        let scoping = semantic.scoping();
        let nodes = semantic.nodes();
        let mut g = HashSet::new();
        for sym in scoping.symbol_ids() {
            let decl_id = scoping.symbol_declaration(sym);
            if !matches!(nodes.kind(decl_id), AstKind::VariableDeclarator(_)) {
                continue;
            }
            if nodes.kind(decl_id).span().start != 0 {
                continue; // user binding (real span)
            }
            // Generated vars from sroa are non-escaped by construction (sroa's
            // escape analysis). When other generators (BLOCK-mode inline temps)
            // arrive, add a nested-function capture check here.
            g.insert(scoping.symbol_name(sym).to_string());
        }
        g
    };
    if generated.is_empty() {
        return 0;
    }

    // Phase 1: straight-line literal propagation → collect read substitutions.
    let mut subs: HashMap<NodeId, Expression<'a>> = HashMap::new();
    {
        let mut p = Propagator { generated: &generated, allocator, subs: &mut subs };
        p.run_list(&program.body);
    }
    let mut count = subs.len() as u32;
    if !subs.is_empty() {
        let mut a = SubApplier { subs };
        a.visit_program(program);
    }

    // Phase 2: any generated var now read 0 times → its defs are dead; remove.
    // Keyed by the declarator's / write-statement's `NodeId`, NOT by name: the
    // same generated temp name (`_h0__result_0`) can exist as DISTINCT symbols in
    // two functions (the per-context inline id counters can repeat across
    // functions), and one may be dead while the other is live. Name-based removal
    // would drop both — corrupting the live one. (cf. reference_cfg_node_identity_keying)
    let (dead_decls, dead_writes): (HashSet<NodeId>, HashSet<NodeId>) = {
        let semantic = SemanticBuilder::new().build(&*program).semantic;
        let scoping = semantic.scoping();
        let nodes = semantic.nodes();
        let mut decls = HashSet::new();
        let mut writes = HashSet::new();
        for sym in scoping.symbol_ids() {
            if !generated.contains(scoping.symbol_name(sym)) {
                continue;
            }
            let decl_id = scoping.symbol_declaration(sym);
            let AstKind::VariableDeclarator(decl) = nodes.kind(decl_id) else {
                continue;
            };
            // Only simple `let g = …;` bindings are removable. A destructuring
            // declarator (`let [v_0, v_1, v_2] = mk()`) binds several symbols and
            // its init may have effects — one dead element must NOT drop the whole
            // declarator (would kill the live siblings + the initializer).
            if !matches!(&decl.id, BindingPattern::BindingIdentifier(_)) {
                continue;
            }
            // Must have zero reads.
            if !scoping.get_resolved_references(sym).all(|r| !r.is_read()) {
                continue;
            }
            // The init (if any) must be side-effect-free — dropping `let g = f()`
            // would lose the call.
            if let Some(init) = &decl.init {
                if !is_side_effect_free(init) {
                    continue;
                }
            }
            // SYMMETRIC removal: every write must be a droppable bare
            // `g = pureRHS;` statement (LHS is exactly `g`, RHS side-effect-free,
            // assignment is the whole statement). If even ONE write isn't (impure
            // RHS like `g = f()`, a chained `g = h = 9` whose inner write would be
            // lost, or a write nested in a larger expr like `sink(g = 9)`), keep
            // the WHOLE binding. Dropping the declaration while a write/use
            // survives dangles the reference or loses an effect.
            let mut this_writes = Vec::new();
            let mut all_droppable = true;
            for r in scoping.get_resolved_references(sym) {
                match droppable_write_stmt(nodes, r.node_id()) {
                    Some(stmt_id) => this_writes.push(stmt_id),
                    None => {
                        all_droppable = false;
                        break;
                    }
                }
            }
            if !all_droppable {
                continue;
            }
            decls.insert(decl_id);
            writes.extend(this_writes);
        }
        (decls, writes)
    };
    if !dead_decls.is_empty() || !dead_writes.is_empty() {
        let mut r =
            DeadDefRemover { ast: AstBuilder::new(allocator), dead_decls, dead_writes, count: 0 };
        r.visit_program(program);
        count += r.count;
    }

    count
}

/// The bare `g = pureRHS;` statement that write-reference `id` is the direct LHS
/// of — droppable wholesale — or `None`. A few hops up: ref → [target wrapper] →
/// AssignmentExpression → ExpressionStatement. Returns `None` (so the caller
/// keeps the binding) for a compound op (`g += …`), an impure RHS (`g = f()`), a
/// chained `g = h = 9` (RHS is itself an assignment → not side-effect-free, so
/// the live inner write `h = 9` is preserved), or a write nested in a larger
/// expression (`sink(g = 9)`, `let y = (g = 9)` → the AssignmentExpression's
/// parent isn't an ExpressionStatement).
fn droppable_write_stmt(nodes: &oxc_semantic::AstNodes, id: NodeId) -> Option<NodeId> {
    let mut cur = id;
    for _ in 0..4 {
        let p = nodes.parent_id(cur);
        if p == cur {
            return None;
        }
        if let AstKind::AssignmentExpression(a) = nodes.kind(p) {
            if a.operator != AssignmentOperator::Assign || !is_side_effect_free(&a.right) {
                return None;
            }
            let stmt = nodes.parent_id(p);
            return matches!(nodes.kind(stmt), AstKind::ExpressionStatement(_)).then_some(stmt);
        }
        cur = p;
    }
    None
}

/// Conservative side-effect-freedom: literals/identifiers/`this`, pure operators
/// over pure operands, member reads (getters assumed absent — the optimizer's
/// standing assumption, matching this pass's pre-existing behavior), TS wrappers,
/// and array/object literals of pure non-spread parts. Everything else
/// (calls/`new`/assignment/update/await/yield/tagged-template/spread/computed
/// keys) is treated as effectful.
fn is_side_effect_free(e: &Expression) -> bool {
    match e {
        Expression::NumericLiteral(_)
        | Expression::StringLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::RegExpLiteral(_)
        | Expression::Identifier(_)
        | Expression::ThisExpression(_) => true,
        Expression::ParenthesizedExpression(p) => is_side_effect_free(&p.expression),
        Expression::TSAsExpression(t) => is_side_effect_free(&t.expression),
        Expression::TSSatisfiesExpression(t) => is_side_effect_free(&t.expression),
        Expression::TSNonNullExpression(t) => is_side_effect_free(&t.expression),
        Expression::TSTypeAssertion(t) => is_side_effect_free(&t.expression),
        Expression::UnaryExpression(u) => {
            u.operator != UnaryOperator::Delete && is_side_effect_free(&u.argument)
        }
        Expression::BinaryExpression(b) => {
            is_side_effect_free(&b.left) && is_side_effect_free(&b.right)
        }
        Expression::LogicalExpression(l) => {
            is_side_effect_free(&l.left) && is_side_effect_free(&l.right)
        }
        Expression::ConditionalExpression(c) => {
            is_side_effect_free(&c.test)
                && is_side_effect_free(&c.consequent)
                && is_side_effect_free(&c.alternate)
        }
        Expression::SequenceExpression(s) => s.expressions.iter().all(is_side_effect_free),
        Expression::StaticMemberExpression(m) => is_side_effect_free(&m.object),
        Expression::ComputedMemberExpression(m) => {
            is_side_effect_free(&m.object) && is_side_effect_free(&m.expression)
        }
        Expression::ArrayExpression(a) => a.elements.iter().all(|el| match el {
            ArrayExpressionElement::Elision(_) => true,
            ArrayExpressionElement::SpreadElement(_) => false,
            _ => el.as_expression().is_some_and(is_side_effect_free),
        }),
        Expression::ObjectExpression(o) => o.properties.iter().all(|p| match p {
            ObjectPropertyKind::ObjectProperty(prop) => {
                !prop.computed && is_side_effect_free(&prop.value)
            }
            ObjectPropertyKind::SpreadProperty(_) => false,
        }),
        _ => false,
    }
}

// ── phase 1: propagation ─────────────────────────────────────────────────────

struct Propagator<'g, 'a, 's> {
    generated: &'g HashSet<String>,
    allocator: &'a Allocator,
    subs: &'s mut HashMap<NodeId, Expression<'a>>,
}

impl<'a> Propagator<'_, 'a, '_> {
    /// Process a straight-line statement list, tracking each generated var's
    /// current literal value. Resets at any control-flow statement (then
    /// recurses into its blocks with fresh state).
    fn run_list(&mut self, stmts: &oxc_allocator::Vec<'a, Statement<'a>>) {
        let mut value: HashMap<String, Expression<'a>> = HashMap::new();
        for stmt in stmts {
            match stmt {
                Statement::VariableDeclaration(vd) => {
                    for d in &vd.declarations {
                        if let Some(init) = &d.init {
                            self.propagate_reads(init, &value);
                            // Invalidate nested writes BEFORE recording the top-level
                            // value (the top-level binding can't shadow them).
                            self.invalidate_nested(init, &mut value);
                            if let BindingPattern::BindingIdentifier(id) = &d.id {
                                if self.generated.contains(id.name.as_str()) {
                                    self.set_value(&mut value, id.name.as_str(), init);
                                }
                            }
                        }
                    }
                }
                Statement::ExpressionStatement(es) => {
                    // `g = <expr>` assignment.
                    if let Expression::AssignmentExpression(a) = &es.expression {
                        if a.operator == AssignmentOperator::Assign {
                            if let Some(name) = a.left.get_identifier_name() {
                                if self.generated.contains(name) {
                                    self.propagate_reads(&a.right, &value);
                                    self.invalidate_nested(&a.right, &mut value);
                                    self.set_value(&mut value, name, &a.right);
                                    continue;
                                }
                            }
                        }
                    }
                    self.propagate_reads(&es.expression, &value);
                    self.invalidate_nested(&es.expression, &mut value);
                }
                Statement::ReturnStatement(r) => {
                    if let Some(arg) = &r.argument {
                        self.propagate_reads(arg, &value);
                        self.invalidate_nested(arg, &mut value);
                    }
                }
                // Control flow / anything else → straight-line broken: reset,
                // then recurse into nested blocks with fresh state.
                other => {
                    value.clear();
                    self.recurse_blocks(other);
                }
            }
        }
    }

    /// Invalidate the tracked value of every generated var that is WRITTEN
    /// (assignment / update target) anywhere inside `expr` — including nested
    /// positions the top-level handling misses, e.g. the `v_y` in a chained
    /// `v_x = v_y = 9` or in `foo(v_y = 9)`. Without this, the propagator keeps
    /// `v_y`'s stale pre-write value and substitutes it into a later read (a
    /// miscompile). Nested functions own their own scope → don't descend.
    fn invalidate_nested(&self, expr: &Expression<'a>, value: &mut HashMap<String, Expression<'a>>) {
        struct W<'g> {
            generated: &'g HashSet<String>,
            hits: Vec<String>,
        }
        impl<'a> Visit<'a> for W<'_> {
            fn visit_assignment_expression(&mut self, a: &AssignmentExpression<'a>) {
                if let Some(name) = a.left.get_identifier_name() {
                    if self.generated.contains(name) {
                        self.hits.push(name.to_string());
                    }
                }
                walk::walk_assignment_expression(self, a);
            }
            fn visit_update_expression(&mut self, u: &UpdateExpression<'a>) {
                if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = &u.argument {
                    if self.generated.contains(id.name.as_str()) {
                        self.hits.push(id.name.to_string());
                    }
                }
                walk::walk_update_expression(self, u);
            }
            fn visit_function(&mut self, _f: &Function<'a>, _: oxc_semantic::ScopeFlags) {}
            fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {}
        }
        let mut w = W { generated: self.generated, hits: Vec::new() };
        w.visit_expression(expr);
        for name in w.hits {
            value.remove(&name);
        }
    }

    /// Record `g`'s current value (only literals are safe to re-evaluate later).
    fn set_value(
        &self,
        value: &mut HashMap<String, Expression<'a>>,
        name: &str,
        init: &Expression<'a>,
    ) {
        if is_literal(init) {
            value.insert(name.to_string(), init.clone_in(self.allocator));
        } else {
            value.remove(name);
        }
    }

    /// Substitute reads of generated vars that have a known literal value.
    fn propagate_reads(&mut self, expr: &Expression<'a>, value: &HashMap<String, Expression<'a>>) {
        struct R<'g, 'v, 'a, 's> {
            generated: &'g HashSet<String>,
            value: &'v HashMap<String, Expression<'a>>,
            allocator: &'a Allocator,
            subs: &'s mut HashMap<NodeId, Expression<'a>>,
        }
        impl<'a> Visit<'a> for R<'_, '_, 'a, '_> {
            fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
                if self.generated.contains(id.name.as_str()) {
                    if let Some(v) = self.value.get(id.name.as_str()) {
                        self.subs.insert(id.node_id.get(), v.clone_in(self.allocator));
                    }
                }
            }
        }
        let mut r =
            R { generated: self.generated, value, allocator: self.allocator, subs: self.subs };
        r.visit_expression(expr);
    }

    fn recurse_blocks(&mut self, stmt: &Statement<'a>) {
        // Recurse into nested statement lists with fresh straight-line state.
        struct Collector<'g, 'a, 's, 'p> {
            p: &'p mut Propagator<'g, 'a, 's>,
        }
        impl<'a> Visit<'a> for Collector<'_, 'a, '_, '_> {
            fn visit_statements(&mut self, stmts: &oxc_allocator::Vec<'a, Statement<'a>>) {
                self.p.run_list(stmts);
            }
        }
        let mut c = Collector { p: self };
        walk::walk_statement(&mut c, stmt);
    }
}

struct SubApplier<'a> {
    subs: HashMap<NodeId, Expression<'a>>,
}

impl<'a> VisitMut<'a> for SubApplier<'a> {
    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        if let Expression::Identifier(id) = &*expr {
            if let Some(rep) = self.subs.remove(&id.node_id.get()) {
                *expr = rep;
                return;
            }
        }
        walk_mut::walk_expression(self, expr);
    }
}

// ── phase 2: dead-def removal ────────────────────────────────────────────────

struct DeadDefRemover<'a> {
    ast: AstBuilder<'a>,
    /// VariableDeclarator node ids of dead generated bindings.
    dead_decls: HashSet<NodeId>,
    /// ExpressionStatement node ids of `g = …;` writes to dead bindings.
    dead_writes: HashSet<NodeId>,
    count: u32,
}

impl<'a> VisitMut<'a> for DeadDefRemover<'a> {
    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts);
        let taken = std::mem::replace(stmts, self.ast.vec());
        let mut out = self.ast.vec_with_capacity(taken.len());
        for stmt in taken {
            match stmt {
                // `g = …;` write to a dead generated var → drop (by node id).
                Statement::ExpressionStatement(ref es)
                    if self.dead_writes.contains(&es.node_id.get()) =>
                {
                    self.count += 1;
                }
                // `let g = …` declarator(s) of dead generated vars → drop (by node id).
                Statement::VariableDeclaration(mut vd) => {
                    let is_dead = |d: &VariableDeclarator<'a>| {
                        self.dead_decls.contains(&d.node_id.get())
                            && matches!(&d.id, BindingPattern::BindingIdentifier(_))
                    };
                    let any_dead = vd.declarations.iter().any(|d| is_dead(d));
                    if any_dead {
                        let decls = std::mem::replace(&mut vd.declarations, self.ast.vec());
                        let mut kept = self.ast.vec();
                        for d in decls {
                            if is_dead(&d) {
                                self.count += 1;
                            } else {
                                kept.push(d);
                            }
                        }
                        if kept.is_empty() {
                            continue;
                        }
                        vd.declarations = kept;
                    }
                    out.push(Statement::VariableDeclaration(vd));
                }
                other => out.push(other),
            }
        }
        *stmts = out;
    }
}

fn is_literal(e: &Expression) -> bool {
    matches!(
        e,
        Expression::NumericLiteral(_)
            | Expression::StringLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::BigIntLiteral(_)
    )
}
