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
    let dead: HashSet<String> = {
        let semantic = SemanticBuilder::new().build(&*program).semantic;
        let scoping = semantic.scoping();
        let nodes = semantic.nodes();
        let mut dead = HashSet::new();
        for sym in scoping.symbol_ids() {
            let name = scoping.symbol_name(sym);
            if !generated.contains(name) {
                continue;
            }
            let decl_id = scoping.symbol_declaration(sym);
            if !matches!(nodes.kind(decl_id), AstKind::VariableDeclarator(_)) {
                continue;
            }
            if scoping.get_resolved_references(sym).all(|r| !r.is_read()) {
                dead.insert(name.to_string());
            }
        }
        dead
    };
    if !dead.is_empty() {
        let mut r = DeadDefRemover { ast: AstBuilder::new(allocator), dead, count: 0 };
        r.visit_program(program);
        count += r.count;
    }

    count
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
                        if let BindingPattern::BindingIdentifier(id) = &d.id {
                            if self.generated.contains(id.name.as_str()) {
                                if let Some(init) = &d.init {
                                    self.propagate_reads(init, &value);
                                    self.set_value(&mut value, id.name.as_str(), init);
                                    continue;
                                }
                            }
                        }
                        if let Some(init) = &d.init {
                            self.propagate_reads(init, &value);
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
                                    self.set_value(&mut value, name, &a.right);
                                    continue;
                                }
                            }
                        }
                    }
                    self.propagate_reads(&es.expression, &value);
                }
                Statement::ReturnStatement(r) => {
                    if let Some(arg) = &r.argument {
                        self.propagate_reads(arg, &value);
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
    dead: HashSet<String>,
    count: u32,
}

impl<'a> VisitMut<'a> for DeadDefRemover<'a> {
    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts);
        let taken = std::mem::replace(stmts, self.ast.vec());
        let mut out = self.ast.vec_with_capacity(taken.len());
        for stmt in taken {
            match stmt {
                // `g = …;` assignment to a dead generated var → drop.
                Statement::ExpressionStatement(ref es) => {
                    if let Expression::AssignmentExpression(a) = &es.expression {
                        if a.operator == AssignmentOperator::Assign {
                            if let Some(name) = a.left.get_identifier_name() {
                                if self.dead.contains(name) {
                                    self.count += 1;
                                    continue;
                                }
                            }
                        }
                    }
                    out.push(stmt);
                }
                // `let g = …` declarator(s) of dead generated vars → drop.
                Statement::VariableDeclaration(mut vd) => {
                    let any_dead = vd.declarations.iter().any(|d| {
                        matches!(&d.id, BindingPattern::BindingIdentifier(id) if self.dead.contains(id.name.as_str()))
                    });
                    if any_dead {
                        let decls = std::mem::replace(&mut vd.declarations, self.ast.vec());
                        let mut kept = self.ast.vec();
                        for d in decls {
                            let is_dead = matches!(&d.id, BindingPattern::BindingIdentifier(id) if self.dead.contains(id.name.as_str()));
                            if is_dead {
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
