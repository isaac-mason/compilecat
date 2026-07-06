//! Port of `src/compiler/scalar-replace-aggregates.ts` — Scalar Replacement of
//! Aggregates, directive-driven.
//!
//! Tuples: `@sroa const v = [a, b, c]` + constant-index accesses (`v[0]`,
//! `v[1] = …`) becomes `let v_0 = a, v_1 = b, v_2 = c` with each `v[i]`
//! rewritten to `v_i`. Records: `@sroa const v = { x, y }` (or a typed
//! `const v: Vec3 = mk()`) + property accesses (`v.x`, `v.x = …`) becomes
//! `let v_x = …, v_y = …` (or a destructure `let { x: v_x, y: v_y } = mk()`).
//!
//! Opt-in via `@sroa` on the declaration or an enclosing function. Conservative
//! escape analysis: every reference to the binding in its scope must be a
//! constant-index member (tuple) or known-field member (record) read/write;
//! anything else (passing `v`, dynamic/unknown index, `{...v}`, capture by
//! closure) disqualifies it.
//!
//! The arity (tuple) or field set (record) comes from a literal initializer, or
//! — when the initializer is opaque — from the declaration's TYPE: an inline
//! tuple/object type, a local `type`/`interface`, or one resolved cross-module
//! from a donor (see `Shape` + `build_alias_shapes`, the type-shape oracle).
//!
//! Candidates are collected recursively, so an aggregate declared inside a
//! nested block (a loop/if/switch/try body) is scalarized too.
//! Escape analysis stays scoped to the enclosing function/program.
//!
//! Each declarator of a (possibly multi-declarator) declaration is classified
//! independently, so `const a = […], b = […]` scalarizes each safe aggregate; a
//! statement that scalarizes only a subset splits into a source-order sequence
//! (kept declarators retain their `const`/`var` kind, scalars become `let`).
//! Declaration kind is irrelevant to safety — a `let` aggregate scalarizes when
//! it's only member-accessed; reassigning the whole binding (`v = […]`) is a
//! non-member reference that escape analysis already rejects.
//!
//! Deferred (TODO): interface `extends`, optional fields, computed/string
//! property keys.

use std::collections::{HashMap, HashSet};

use oxc_allocator::{Address, Allocator, CloneIn, TakeIn};
use oxc_ast::ast::*;
use oxc_ast::{AstBuilder, AstKind, NONE};
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_semantic::{NodeId, ScopeFlags, SemanticBuilder, Semantic, SymbolId};
use oxc_span::SPAN;

use super::util::is_side_effect_free;

use crate::analysis::cfg::{self, ControlFlowGraph};
use crate::analysis::data_flow::{analyze, DataFlow, Direction};
use crate::analysis::graph::NodeId as CfgNodeId;
use crate::analysis::type_shape::{
    build_type_map, reconstruct, resolve_ast, shape_of, NameSrc, ResolvedType, Shape,
};

const MIN_FIELDS: usize = 2;
const MAX_FIELDS: usize = 16;

pub fn run<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    external_shapes: &HashMap<String, Shape>,
) -> u32 {
    // `@optimize` implies `@sroa` (combo directive) — matching `directives.ts`.
    let sroa_spans =
        super::directives::annotated_spans_with_exports(program, &["@sroa", "@optimize"]);
    if sroa_spans.is_empty() {
        return 0;
    }

    // Type-shape oracle: resolve every local `type`/`interface` to a borrow-free
    // `ResolvedType` (done before we mutate), then overlay the imported shapes
    // the caller resolved cross-module. A local declaration shadows an imported
    // name of the same identifier.
    let mut types = build_type_map(program);
    for (name, shape) in external_shapes {
        types.entry(name.clone()).or_insert_with(|| reconstruct(shape));
    }
    let mut s = Sroa { ast: AstBuilder::new(allocator), sroa_spans, depth: 0, count: 0, types };
    // Single-owner module-scratch scalarization (LLVM GlobalOpt-localize fused into
    // SROA) — runs first, atomically emits scalars into the owning function and
    // deletes the module const, so a local aggregate is never materialized (no
    // per-call allocation). See `scalarize_module_scratch`.
    s.scalarize_module_scratch(program);
    // Program scope first, then recurse into functions.
    let prog_annotated = s.depth > 0;
    let body = &mut program.body;
    s.process_scope(body, prog_annotated);
    s.visit_program(program);
    s.count
}

struct Sroa<'a> {
    ast: AstBuilder<'a>,
    sroa_spans: HashSet<u32>,
    depth: u32,
    count: u32,
    /// Local + imported types, pre-resolved to a borrow-free `ResolvedType` (so
    /// the oracle owns no borrow into the program while we mutate it). Lets
    /// `@sroa` fire on a typed aggregate (`const v: Vec3 = expr`), not just a
    /// literal. SROA projects these to `Shape` via `shape_of`.
    types: HashMap<String, ResolvedType>,
}

impl<'a> VisitMut<'a> for Sroa<'a> {
    fn visit_function(&mut self, func: &mut Function<'a>, flags: ScopeFlags) {
        let annotated = self.depth > 0 || self.sroa_spans.contains(&func.span.start);
        if let Some(body) = func.body.as_mut() {
            self.process_scope(&mut body.statements, annotated);
        }
        if annotated {
            self.depth += 1;
        }
        walk_mut::walk_function(self, func, flags);
        if annotated {
            self.depth -= 1;
        }
    }
}

struct SafeCand<'a> {
    name: String,
    shape: Shape,
    /// Collision-free arena address of the *declarator* this candidate came from,
    /// used to locate it for rewriting. NOT keyed by span: inline-generated
    /// declarations all carry `SPAN(0,0)`, so span identity collides and corrupts
    /// (see `reference_cfg_node_identity_keying`). Keying per-declarator (not per
    /// `VariableDeclaration`) lets a multi-declarator statement scalarize each of
    /// its declarators independently. The address is stable across the `take_in`
    /// move in `rewrite_decls`.
    decl_addr: Address,
    /// Original declaration span — reused on the rewritten `let` so a leading
    /// `@sroa` comment (keyed by `attached_to`) still attaches (the in-place
    /// span reuse preserves the comment).
    decl_span: oxc_span::Span,
    init: SroaInit<'a>,
}

/// How the scalars are produced from the original declaration.
enum SroaInit<'a> {
    /// Literal aggregate (`[a, b, c]` or `{ x: a, y: b }`) → per-field
    /// `let v_<k> = …`. The Vec is in `shape` order.
    Literal(Vec<Expression<'a>>),
    /// Typed/opaque aggregate (`const v: Vec3 = expr`) → destructure `expr` by
    /// the shape: an array pattern for a tuple, an object pattern for a record.
    Destructure(Expression<'a>),
}

impl<'a> Sroa<'a> {
    fn alloc(&self) -> &'a Allocator {
        self.ast.allocator
    }

    fn process_scope(&mut self, body: &mut oxc_allocator::Vec<'a, Statement<'a>>, annotated: bool) {
        // Pre-phase: collapse the inliner's single-use result temps into their
        // alias so the value becomes an init-position aggregate SROA can collect
        // (`let _r; … _r = {…}; const x = _r;` → `… const x = {…};`). Then merge a
        // deferred-init aggregate (`let v; … v = {…};` with no read before the
        // single store) into init position (`… let v = {…};`) so a deferred
        // aggregate read field-wise more than once — which the collapse can't
        // reach — also becomes collectible. Both canonicalize to the init-position
        // form the existing collection/escape/rewrite already handle.
        if annotated {
            self.collapse_result_temps(body);
            self.merge_deferred_init(body);
        }
        let safe = self.collect_safe(body, annotated);
        if safe.is_empty() {
            return;
        }

        // Phase: rewrite accesses (`v[i]` / `v.field` reads + write targets).
        let shapes: HashMap<String, Shape> =
            safe.iter().map(|c| (c.name.clone(), c.shape.clone())).collect();
        let mut rw = AccessRewriter { ast: self.ast, shapes: &shapes };
        for stmt in body.iter_mut() {
            rw.visit_statement(stmt);
        }

        // Phase: rewrite declarations — recurse into nested blocks so a candidate
        // declared inside a loop/if/switch body is rewritten in place. Keyed by
        // the declaration's arena `Address` (collision-free), NOT span: inlined
        // decls all share `SPAN(0,0)`, which would alias distinct declarations.
        let mut by_addr: HashMap<Address, SafeCand<'a>> =
            safe.into_iter().map(|c| (c.decl_addr, c)).collect();
        self.rewrite_decls(body, &mut by_addr);
    }

    /// Collapse the inliner's single-use result temps: `let v; … v = E; <…v…>`
    /// where `v` is assigned exactly once, read exactly once (in the statement
    /// immediately after the assignment), and used nowhere else → substitute `E`
    /// at the read and drop the `let v;` + `v = E;`. The inliner emits exactly
    /// this for an expression-position BLOCK inline (the temp aliases the call's
    /// value at one site); after block_flatten the three sit in one list. The
    /// resulting `const x = E` is an init-position aggregate the existing
    /// collection scalarizes — no use-def collection needed for this case.
    fn collapse_result_temps(&mut self, list: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        // Nested blocks first (a temp inside an `if`/loop body).
        for stmt in list.iter_mut() {
            match stmt {
                Statement::BlockStatement(b) => self.collapse_result_temps(&mut b.body),
                Statement::IfStatement(s) => {
                    self.collapse_body(&mut s.consequent);
                    if let Some(alt) = &mut s.alternate {
                        self.collapse_body(alt);
                    }
                }
                Statement::ForStatement(s) => self.collapse_body(&mut s.body),
                Statement::ForInStatement(s) => self.collapse_body(&mut s.body),
                Statement::ForOfStatement(s) => self.collapse_body(&mut s.body),
                Statement::WhileStatement(s) => self.collapse_body(&mut s.body),
                Statement::DoWhileStatement(s) => self.collapse_body(&mut s.body),
                Statement::LabeledStatement(s) => self.collapse_body(&mut s.body),
                Statement::SwitchStatement(s) => {
                    for c in s.cases.iter_mut() {
                        self.collapse_result_temps(&mut c.consequent);
                    }
                }
                Statement::TryStatement(s) => {
                    self.collapse_result_temps(&mut s.block.body);
                    if let Some(h) = &mut s.handler {
                        self.collapse_result_temps(&mut h.body.body);
                    }
                    if let Some(f) = &mut s.finalizer {
                        self.collapse_result_temps(&mut f.body);
                    }
                }
                _ => {}
            }
        }
        // Then this level, repeatedly (one collapse can't enable another here, but
        // there may be several independent temps).
        while let Some((di, ai, name)) = find_collapsible_temp(list) {
            // Take `E` out of the assignment `v = E;` at `ai`.
            let e = {
                let Statement::ExpressionStatement(es) = &mut list[ai] else { break };
                let Expression::AssignmentExpression(asgn) = &mut es.expression else { break };
                asgn.right.take_in(self.alloc())
            };
            // Substitute it at the single read in the next statement.
            let mut sub = SingleIdentSub { name: &name, value: Some(e) };
            sub.visit_statement(&mut list[ai + 1]);
            // Drop `let v;` (di) and `v = E;` (ai).
            let taken = list.take_in(self.alloc());
            let mut out = self.ast.vec_with_capacity(taken.len().saturating_sub(2));
            for (i, s) in taken.into_iter().enumerate() {
                if i != di && i != ai {
                    out.push(s);
                }
            }
            *list = out;
        }
    }

    /// Collapse temps inside a single-statement body that's actually a block.
    fn collapse_body(&mut self, body: &mut Statement<'a>) {
        if let Statement::BlockStatement(b) = body {
            self.collapse_result_temps(&mut b.body);
        }
    }

    /// Merge a deferred-init aggregate into init position: `let v; … v = {…};`
    /// (a single store, no read of `v` before it) → drop the `let v;` and turn the
    /// store into `let v = {…};` in place. The existing collection then scalarizes
    /// the init-position aggregate, including the multi-field-read case the
    /// single-use `collapse_result_temps` can't reach. Single store + no prior read
    /// makes relocating the declaration to the store site unobservable (Stage 1 —
    /// conditional/multi-store aggregates need CFG; see follow_ups.md).
    fn merge_deferred_init(&mut self, list: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        for stmt in list.iter_mut() {
            match stmt {
                Statement::BlockStatement(b) => self.merge_deferred_init(&mut b.body),
                Statement::IfStatement(s) => {
                    self.merge_deferred_body(&mut s.consequent);
                    if let Some(alt) = &mut s.alternate {
                        self.merge_deferred_body(alt);
                    }
                }
                Statement::ForStatement(s) => self.merge_deferred_body(&mut s.body),
                Statement::ForInStatement(s) => self.merge_deferred_body(&mut s.body),
                Statement::ForOfStatement(s) => self.merge_deferred_body(&mut s.body),
                Statement::WhileStatement(s) => self.merge_deferred_body(&mut s.body),
                Statement::DoWhileStatement(s) => self.merge_deferred_body(&mut s.body),
                Statement::LabeledStatement(s) => self.merge_deferred_body(&mut s.body),
                Statement::SwitchStatement(s) => {
                    for c in s.cases.iter_mut() {
                        self.merge_deferred_init(&mut c.consequent);
                    }
                }
                Statement::TryStatement(s) => {
                    self.merge_deferred_init(&mut s.block.body);
                    if let Some(h) = &mut s.handler {
                        self.merge_deferred_init(&mut h.body.body);
                    }
                    if let Some(f) = &mut s.finalizer {
                        self.merge_deferred_init(&mut f.body);
                    }
                }
                _ => {}
            }
        }
        while let Some((di, ai)) = find_deferred_init(list) {
            // Turn the store `v = {…};` at `ai` into `let v = {…};`.
            let new_decl = {
                let Statement::ExpressionStatement(es) = &mut list[ai] else { break };
                let Expression::AssignmentExpression(asgn) = &mut es.expression else { break };
                let AssignmentTarget::AssignmentTargetIdentifier(id) = &asgn.left else { break };
                let name = id.name;
                let e = asgn.right.take_in(self.alloc());
                let bid = self.ast.binding_pattern_binding_identifier(SPAN, name);
                let declr = self.ast.variable_declarator(
                    SPAN,
                    VariableDeclarationKind::Let,
                    bid,
                    NONE,
                    Some(e),
                    false,
                );
                Statement::VariableDeclaration(self.ast.alloc(self.ast.variable_declaration(
                    SPAN,
                    VariableDeclarationKind::Let,
                    self.ast.vec1(declr),
                    false,
                )))
            };
            list[ai] = new_decl;
            // Drop the now-redundant `let v;` at `di`.
            let taken = list.take_in(self.alloc());
            let mut out = self.ast.vec_with_capacity(taken.len().saturating_sub(1));
            for (i, s) in taken.into_iter().enumerate() {
                if i != di {
                    out.push(s);
                }
            }
            *list = out;
        }
    }

    fn merge_deferred_body(&mut self, body: &mut Statement<'a>) {
        if let Statement::BlockStatement(b) = body {
            self.merge_deferred_init(&mut b.body);
        }
    }

    /// Replace each candidate declarator (located by its arena address) with its
    /// scalar form, descending into nested blocks but never into nested functions
    /// (those are processed as their own scope by `visit_function`).
    ///
    /// A multi-declarator statement (`const a = […], b = […];`) may scalarize any
    /// subset of its declarators. We split it into a source-order sequence of
    /// statements: a run of consecutive *kept* declarators stays in one statement
    /// of the original kind, and each scalarized declarator becomes its own `let`
    /// statement. Splitting (rather than merging back into one declaration) keeps
    /// declaration-kind consistency trivial — kept declarators retain `const`/`var`,
    /// scalars are always `let` — and preserves evaluation order.
    fn rewrite_decls(
        &mut self,
        list: &mut oxc_allocator::Vec<'a, Statement<'a>>,
        by_addr: &mut HashMap<Address, SafeCand<'a>>,
    ) {
        let taken = list.take_in(self.alloc());
        let mut out = self.ast.vec_with_capacity(taken.len());
        for mut stmt in taken {
            if let Statement::VariableDeclaration(vd) = &stmt {
                // Any declarator of this statement a candidate? (Single-declarator
                // is the common case: one scalar statement replaces the whole decl.)
                if vd.declarations.iter().any(|d| by_addr.contains_key(&declarator_addr(d))) {
                    self.split_decl(&mut stmt, &mut out, by_addr);
                    continue;
                }
            }
            self.rewrite_decls_in_children(&mut stmt, by_addr);
            out.push(stmt);
        }
        *list = out;
    }

    /// Split a `VariableDeclaration` statement that has at least one scalarizable
    /// declarator into a source-order sequence of statements pushed onto `out`.
    fn split_decl(
        &mut self,
        stmt: &mut Statement<'a>,
        out: &mut oxc_allocator::Vec<'a, Statement<'a>>,
        by_addr: &mut HashMap<Address, SafeCand<'a>>,
    ) {
        let Statement::VariableDeclaration(vd) = stmt else { return };
        let kind = vd.kind;
        let span = vd.span;
        // Resolve each declarator's candidate from its *live-buffer* address BEFORE
        // moving it out: `take_in` followed by by-value iteration relocates the
        // declarator (its `Address::from_ptr` would no longer match what was
        // collected). So pair `(scalar candidate?, addr)` up-front by reference.
        let cands: Vec<Option<SafeCand<'a>>> =
            vd.declarations.iter().map(|d| by_addr.remove(&declarator_addr(d))).collect();
        let declarations = vd.declarations.take_in(self.alloc());
        // Accumulate consecutive kept declarators so they emit as one statement.
        let mut kept: oxc_allocator::Vec<'a, VariableDeclarator<'a>> = self.ast.vec();
        let flush = |this: &Self,
                     kept: &mut oxc_allocator::Vec<'a, VariableDeclarator<'a>>,
                     out: &mut oxc_allocator::Vec<'a, Statement<'a>>| {
            if kept.is_empty() {
                return;
            }
            let decls = std::mem::replace(kept, this.ast.vec());
            out.push(Statement::VariableDeclaration(
                this.ast.alloc(this.ast.variable_declaration(span, kind, decls, false)),
            ));
        };
        for (d, cand) in declarations.into_iter().zip(cands.into_iter()) {
            if let Some(mut cand) = cand {
                flush(self, &mut kept, out);
                // Rebuild the scalar initializers from the LIVE declarator — the
                // access-rewrite phase has already updated it in place — rather
                // than the copy captured at collect time (pre-rewrite). See
                // `reinit_from_live`.
                let was_literal = matches!(cand.init, SroaInit::Literal(_));
                cand.init = self.reinit_from_live(&d, was_literal);
                out.push(self.scalar_decl(cand));
                self.count += 1;
            } else {
                kept.push(d);
            }
        }
        flush(self, &mut kept, out);
    }

    fn rewrite_decls_in_children(
        &mut self,
        stmt: &mut Statement<'a>,
        by_addr: &mut HashMap<Address, SafeCand<'a>>,
    ) {
        match stmt {
            Statement::BlockStatement(b) => self.rewrite_decls(&mut b.body, by_addr),
            Statement::IfStatement(s) => {
                self.rewrite_decls_body(&mut s.consequent, by_addr);
                if let Some(alt) = &mut s.alternate {
                    self.rewrite_decls_body(alt, by_addr);
                }
            }
            Statement::ForStatement(s) => self.rewrite_decls_body(&mut s.body, by_addr),
            Statement::ForInStatement(s) => self.rewrite_decls_body(&mut s.body, by_addr),
            Statement::ForOfStatement(s) => self.rewrite_decls_body(&mut s.body, by_addr),
            Statement::WhileStatement(s) => self.rewrite_decls_body(&mut s.body, by_addr),
            Statement::DoWhileStatement(s) => self.rewrite_decls_body(&mut s.body, by_addr),
            Statement::LabeledStatement(s) => self.rewrite_decls_body(&mut s.body, by_addr),
            Statement::SwitchStatement(s) => {
                for case in &mut s.cases {
                    self.rewrite_decls(&mut case.consequent, by_addr);
                }
            }
            Statement::TryStatement(s) => {
                self.rewrite_decls(&mut s.block.body, by_addr);
                if let Some(h) = &mut s.handler {
                    self.rewrite_decls(&mut h.body.body, by_addr);
                }
                if let Some(f) = &mut s.finalizer {
                    self.rewrite_decls(&mut f.body, by_addr);
                }
            }
            _ => {}
        }
    }

    fn rewrite_decls_body(
        &mut self,
        stmt: &mut Statement<'a>,
        by_addr: &mut HashMap<Address, SafeCand<'a>>,
    ) {
        match stmt {
            Statement::BlockStatement(b) => self.rewrite_decls(&mut b.body, by_addr),
            other => self.rewrite_decls_in_children(other, by_addr),
        }
    }

    /// Re-derive a candidate's scalar initializers from the LIVE declarator,
    /// which the access-rewrite phase has already updated in place — rather than
    /// the copy captured back in `collect_safe`, which predates that rewrite.
    ///
    /// This matters when a candidate's initializer reads ANOTHER candidate's
    /// field, e.g. `const na = { x: a.x - corr.x }`: the access-rewrite turns the
    /// live `corr.x` into the scalar `corr_x`, but the pre-rewrite copy still
    /// says `corr.x`. Emitting the scalar form from the stale copy would re-emit
    /// `corr.x` after `corr` was itself scalarized away — a reference to a removed
    /// binding. Keeping the live AST as the single source of truth (as LLVM's
    /// SROA does — it rewrites the IR in place, never a shadow copy) avoids the
    /// whole class of drift.
    fn reinit_from_live(&self, d: &VariableDeclarator<'a>, was_literal: bool) -> SroaInit<'a> {
        let Some(init) = &d.init else { return SroaInit::Literal(Vec::new()) };
        if was_literal {
            // collect_safe only accepts array/object literals here (no spreads or
            // elisions), so every element is a plain expression.
            let inits = match init {
                Expression::ArrayExpression(arr) => arr
                    .elements
                    .iter()
                    .map(|el| el.to_expression().clone_in(self.alloc()))
                    .collect(),
                Expression::ObjectExpression(obj) => {
                    object_literal_fields(obj, self.alloc()).map_or_else(Vec::new, |(_, inits)| inits)
                }
                _ => Vec::new(),
            };
            SroaInit::Literal(inits)
        } else {
            SroaInit::Destructure(init.clone_in(self.alloc()))
        }
    }

    fn scalar_decl(&self, cand: SafeCand<'a>) -> Statement<'a> {
        let span = cand.decl_span;
        let suffixes = cand.shape.suffixes();
        let declarators = match cand.init {
            // `let v_0 = a, v_1 = b;` / `let v_x = a, v_y = b;`
            SroaInit::Literal(inits) => {
                let mut declarators = self.ast.vec_with_capacity(inits.len());
                for (suffix, init) in suffixes.iter().zip(inits.into_iter()) {
                    let name = self.scalar(&cand.name, suffix);
                    let id = self.ast.binding_pattern_binding_identifier(SPAN, name);
                    declarators.push(self.ast.variable_declarator(
                        SPAN,
                        VariableDeclarationKind::Let,
                        id,
                        NONE,
                        Some(init),
                        false,
                    ));
                }
                declarators
            }
            // `let [v_0, v_1] = expr;` / `let { x: v_x, y: v_y } = expr;` — the
            // type gave the shape, so destructure the opaque initializer (a tuple
            // is array-iterable, a record is field-readable; evaluated once).
            SroaInit::Destructure(expr) => {
                let pat = match &cand.shape {
                    Shape::Tuple(_) => {
                        let mut elements = self.ast.vec_with_capacity(suffixes.len());
                        for suffix in &suffixes {
                            let name = self.scalar(&cand.name, suffix);
                            elements.push(Some(
                                self.ast.binding_pattern_binding_identifier(SPAN, name),
                            ));
                        }
                        self.ast.binding_pattern_array_pattern(SPAN, elements, NONE)
                    }
                    Shape::Object(fields) => {
                        let mut props = self.ast.vec_with_capacity(fields.len());
                        for field in fields {
                            let fname = self.alloc().alloc_str(field);
                            let scalar = self.scalar(&cand.name, field);
                            let key = self.ast.property_key_static_identifier(SPAN, fname);
                            let value = self.ast.binding_pattern_binding_identifier(SPAN, scalar);
                            props.push(self.ast.binding_property(SPAN, key, value, false, false));
                        }
                        self.ast.binding_pattern_object_pattern(SPAN, props, NONE)
                    }
                };
                self.ast.vec1(self.ast.variable_declarator(
                    SPAN,
                    VariableDeclarationKind::Let,
                    pat,
                    NONE,
                    Some(expr),
                    false,
                ))
            }
        };
        // Reuse the original decl span so a leading `@sroa` comment still lands.
        Statement::VariableDeclaration(self.ast.alloc(self.ast.variable_declaration(
            span,
            VariableDeclarationKind::Let,
            declarators,
            false,
        )))
    }

    /// The scalar binding name for `<base>` field/index `<suffix>` (`v` + `x` →
    /// `v_x`; `v` + `0` → `v_0`).
    fn scalar(&self, base: &str, suffix: &str) -> &'a str {
        self.alloc().alloc_str(&format!("{base}_{suffix}"))
    }

    /// Collect SROA candidates anywhere in this scope — including inside nested
    /// blocks (loop/if/switch/try bodies).
    /// Escape analysis is always scoped to the *enclosing* function/program
    /// (`scope`), so a block-local aggregate is rejected if anything elsewhere in
    /// the function references it by name (the conservative rule).
    /// (Limitation: a name shadowed across sibling scopes within one function is
    /// keyed only by name, so such collisions aren't disambiguated.)
    fn collect_safe(&self, scope: &[Statement<'a>], annotated: bool) -> Vec<SafeCand<'a>> {
        let mut out = Vec::new();
        self.collect_in(scope, scope, annotated, &mut out);
        out
    }

    /// Scan `list` (the function/program top level, or a nested block) for
    /// candidates; recurse into nested blocks but never into nested functions
    /// (each function is its own escape scope, handled by `visit_function`).
    fn collect_in(
        &self,
        scope: &[Statement<'a>],
        list: &[Statement<'a>],
        annotated: bool,
        out: &mut Vec<SafeCand<'a>>,
    ) {
        for stmt in list {
            if let Statement::VariableDeclaration(vd) = stmt {
                // Classify EACH declarator independently — a multi-declarator
                // statement (`const a = […], b = […];`) can scalarize any subset.
                let decl_annot = annotated || self.sroa_spans.contains(&vd.span.start);
                if decl_annot {
                    for d in &vd.declarations {
                        if let Some(cand) = self.candidate_of(scope, declarator_addr(d), d, vd.span)
                        {
                            out.push(cand);
                        }
                    }
                }
            }
            match stmt {
                Statement::BlockStatement(b) => self.collect_in(scope, &b.body, annotated, out),
                Statement::IfStatement(s) => {
                    self.collect_in_body(scope, &s.consequent, annotated, out);
                    if let Some(alt) = &s.alternate {
                        self.collect_in_body(scope, alt, annotated, out);
                    }
                }
                Statement::ForStatement(s) => self.collect_in_body(scope, &s.body, annotated, out),
                Statement::ForInStatement(s) => {
                    self.collect_in_body(scope, &s.body, annotated, out)
                }
                Statement::ForOfStatement(s) => {
                    self.collect_in_body(scope, &s.body, annotated, out)
                }
                Statement::WhileStatement(s) => {
                    self.collect_in_body(scope, &s.body, annotated, out)
                }
                Statement::DoWhileStatement(s) => {
                    self.collect_in_body(scope, &s.body, annotated, out)
                }
                Statement::LabeledStatement(s) => {
                    self.collect_in_body(scope, &s.body, annotated, out)
                }
                Statement::SwitchStatement(s) => {
                    for case in &s.cases {
                        self.collect_in(scope, &case.consequent, annotated, out);
                    }
                }
                Statement::TryStatement(s) => {
                    self.collect_in(scope, &s.block.body, annotated, out);
                    if let Some(h) = &s.handler {
                        self.collect_in(scope, &h.body.body, annotated, out);
                    }
                    if let Some(f) = &s.finalizer {
                        self.collect_in(scope, &f.body, annotated, out);
                    }
                }
                _ => {}
            }
        }
    }

    fn collect_in_body(
        &self,
        scope: &[Statement<'a>],
        stmt: &Statement<'a>,
        annotated: bool,
        out: &mut Vec<SafeCand<'a>>,
    ) {
        match stmt {
            Statement::BlockStatement(b) => self.collect_in(scope, &b.body, annotated, out),
            other => self.collect_in(scope, std::slice::from_ref(other), annotated, out),
        }
    }

    /// Classify one declarator as an SROA candidate (or not). The caller decides
    /// whether the declaration is annotated; each declarator of a multi-declarator
    /// statement is classified independently. `scope` is the enclosing
    /// function/program statement list, used for escape analysis regardless of
    /// which nested block the declaration sits in. `decl_span` is the parent
    /// `VariableDeclaration` span, reused so a leading `@sroa` comment re-attaches.
    /// (`const`/`let`/`var` kind is irrelevant: a `let` aggregate that's only
    /// member-accessed and never reassigned-as-whole is safe — escape analysis
    /// catches `v = […]` as a non-member reference and bails.)
    fn candidate_of(
        &self,
        scope: &[Statement<'a>],
        decl_addr: Address,
        d: &VariableDeclarator<'a>,
        decl_span: oxc_span::Span,
    ) -> Option<SafeCand<'a>> {
        let BindingPattern::BindingIdentifier(id) = &d.id else { return None };
        let name = id.name.to_string();

        // (a) Literal tuple: `const v = [a, b, c]` — shape + per-element inits
        // both come from the literal.
        if let Some(Expression::ArrayExpression(arr)) = &d.init {
            let mut inits = Vec::with_capacity(arr.elements.len());
            for el in &arr.elements {
                match el {
                    ArrayExpressionElement::SpreadElement(_)
                    | ArrayExpressionElement::Elision(_) => return None,
                    other => inits.push(other.to_expression().clone_in(self.alloc())),
                }
            }
            if !(MIN_FIELDS..=MAX_FIELDS).contains(&inits.len()) {
                return None;
            }
            let shape = Shape::Tuple(inits.len());
            return escape_ok(scope, &name, &shape).then_some(SafeCand {
                name,
                shape,
                decl_addr,
                decl_span,
                init: SroaInit::Literal(inits),
            });
        }

        // (b) Literal record: `const v = { x: a, y: b }` — field set + inits both
        // come from the literal.
        if let Some(Expression::ObjectExpression(obj)) = &d.init {
            let (fields, inits) = object_literal_fields(obj, self.alloc())?;
            if !(MIN_FIELDS..=MAX_FIELDS).contains(&fields.len()) {
                return None;
            }
            let shape = Shape::Object(fields);
            return escape_ok(scope, &name, &shape).then_some(SafeCand {
                name,
                shape,
                decl_addr,
                decl_span,
                init: SroaInit::Literal(inits),
            });
        }

        // (c) Typed aggregate: `const v: Vec3 = expr` — the TYPE gives the shape
        // (tuple arity or record field set); destructure the (opaque) initializer.
        let (Some(init), Some(ta)) = (&d.init, &d.type_annotation) else { return None };
        let mut seen = HashSet::new();
        let rt = resolve_ast(&ta.type_annotation, &NameSrc::Resolved(&self.types), &mut seen)?;
        let shape = shape_of(&rt)?;
        if !(MIN_FIELDS..=MAX_FIELDS).contains(&shape.len()) {
            return None;
        }
        escape_ok(scope, &name, &shape).then(|| SafeCand {
            name,
            shape,
            decl_addr,
            decl_span,
            init: SroaInit::Destructure(init.clone_in(self.alloc())),
        })
    }

    // ── module-scratch scalarization (GlobalOpt-localize fused into SROA) ────────

    /// Scalar-replace single-owner module-level scratch buffers: a program-level
    /// `const _s = <pure aggregate>` used ONLY as per-call scratch inside one
    /// annotated function `F` is replaced by fresh uninitialized scalars in `F`
    /// (`let _s_0, _s_1, _s_2;`), its `_s[i]` accesses rewritten to `_s_i`, and the
    /// module const deleted. This is LLVM's global-localization + SROA, FUSED into
    /// one atomic act so the local aggregate never exists (no per-call allocation):
    /// SROA either scalarizes fully or leaves the module const untouched — never a
    /// half state. Preconditions (ported from `GlobalOpt::processInternalGlobal`):
    /// single owner, not exported, owner non-recursive, killed-on-entry (every read
    /// preceded by a write — v1 straight-line), and all uses direct member
    /// load/stores (escape check).
    fn scalarize_module_scratch(&mut self, program: &mut Program<'a>) {
        let cands = self.find_module_scratch(program);
        if cands.is_empty() {
            return;
        }
        let mut by_owner: HashMap<u32, Vec<ModuleScratchCand>> = HashMap::new();
        for c in cands {
            by_owner.entry(c.owner_fn_span).or_default().push(c);
        }
        let mut consumed: HashSet<String> = HashSet::new();
        let mut count = 0u32;
        let mut m =
            ScratchMutator { ast: self.ast, by_owner: &by_owner, consumed: &mut consumed, count: &mut count };
        m.visit_program(program);
        self.count += count;
        // Delete the consumed module consts (now zero-referenced). Strip matching
        // declarators; drop a declaration that loses all of them.
        if !consumed.is_empty() {
            program.body.retain_mut(|stmt| {
                let Statement::VariableDeclaration(vd) = stmt else { return true };
                vd.declarations.retain(|d| {
                    !matches!(&d.id, BindingPattern::BindingIdentifier(id)
                        if consumed.contains(id.name.as_str()))
                });
                !vd.declarations.is_empty()
            });
        }
    }

    /// Find program-level scratch consts owned solely by one annotated,
    /// non-recursive function. Uses `oxc_semantic` for sound single-owner + escape
    /// resolution (symbol identity, not names — handles shadowing).
    fn find_module_scratch(&self, program: &Program<'a>) -> Vec<ModuleScratchCand> {
        // Early-out: skip the whole-module `SemanticBuilder` build unless at least one
        // top-level `const _x = <aggregate>` even exists (the common case is none).
        let has_candidate = program.body.iter().any(|s| {
            let Statement::VariableDeclaration(vd) = s else { return false };
            vd.kind == VariableDeclarationKind::Const
                && vd.declarations.iter().any(|d| self.module_scratch_shape(d).is_some())
        });
        if !has_candidate {
            return Vec::new();
        }
        let semantic = SemanticBuilder::new().build(program).semantic;
        let nodes = semantic.nodes();
        let scoping = semantic.scoping();
        let mut out = Vec::new();
        for stmt in &program.body {
            let Statement::VariableDeclaration(vd) = stmt else { continue };
            if vd.kind != VariableDeclarationKind::Const {
                continue; // a reassignable `let`/`var` global isn't a pure scratch
            }
            for d in &vd.declarations {
                let BindingPattern::BindingIdentifier(id) = &d.id else { continue };
                let Some(init) = &d.init else { continue };
                if !is_side_effect_free(init) {
                    continue; // deleting the module slot must drop only an allocation
                }
                let Some(shape) = self.module_scratch_shape(d) else { continue };
                let Some(sym) = id.symbol_id.get() else { continue };

                // Single owner: every resolved reference is inside the SAME function
                // (none at module scope). LLVM `!HasMultipleAccessingFunctions`.
                let refs: Vec<_> = scoping.get_resolved_references(sym).collect();
                if refs.is_empty() {
                    continue;
                }
                let mut owner: Option<NodeId> = None;
                let mut ok = true;
                for r in &refs {
                    match enclosing_function(nodes, r.node_id()) {
                        None => {
                            ok = false; // referenced at module scope → not owned
                            break;
                        }
                        Some(f) => match owner {
                            None => owner = Some(f),
                            Some(o) if o == f => {}
                            Some(_) => {
                                ok = false; // multiple owners
                                break;
                            }
                        },
                    }
                }
                if !ok {
                    continue;
                }
                let owner = owner.unwrap();
                let AstKind::Function(func) = nodes.kind(owner) else { continue };
                let owner_span = func.span.start;
                // Owner must be opted-in (`@optimize`/`@sroa`) and non-recursive.
                if !self.sroa_spans.contains(&owner_span) {
                    continue;
                }
                if fn_references_self(&semantic, nodes, owner, func) {
                    continue; // recursive / self-referential → could clobber mid-use
                }
                // v2 alias-following: if the ONLY reference is `const s = _scratch`,
                // analyze/rewrite the alias `s` (the real member accesses go through
                // it); else the scratch is used directly. All the per-function gates
                // then run on `name`, and both the alias decl + module const are
                // deleted. (~half of crashcat's scratch sites use the alias form.)
                // `rewrite_sym` = the symbol `name` must resolve to everywhere in the
                // owner: the scratch symbol for a direct use, the alias binding's
                // symbol for the alias form.
                let (name, aliased, rewrite_sym) = match refs.as_slice() {
                    [only] => match single_const_alias(only.node_id(), nodes) {
                        Some((alias, alias_sym)) => (alias, true, alias_sym),
                        None => (id.name.to_string(), false, sym),
                    },
                    _ => (id.name.to_string(), false, sym),
                };
                // SYMBOL GATE (subsumes the old shadow/capture heuristics): every
                // identifier named `name` in the owner must resolve to `rewrite_sym`.
                // If any doesn't, a distinct binding SHADOWS the name and the
                // name-based rewriter would hijack it — bail. This makes the
                // name-based rewrite provably equivalent to a symbol-based one.
                if owner_name_shadowed(func, &name, rewrite_sym, &semantic) {
                    continue;
                }
                // A generated scalar name `{name}_{suffix}` already present would merge
                // with the emitted scalar (separate, name-level concern).
                if owner_has_scalar_name(func, &name, &shape) {
                    continue;
                }
                // Escape + killed-on-entry gates run HERE (analysis phase, `&Function`
                // available for the CFG). The AST is unmutated between here and the
                // rewrite, so `process_owner` trusts these.
                let Some(fb) = func.body.as_ref() else { continue };
                if !escape_ok(&fb.statements, &name, &shape)
                    || !killed_on_entry(fb, &name, &shape)
                {
                    continue;
                }
                out.push(ModuleScratchCand {
                    name,
                    module_const: id.name.to_string(),
                    aliased,
                    shape,
                    owner_fn_span: owner_span,
                });
            }
        }
        out
    }

    /// Shape of a module scratch declarator, from a literal init, a type
    /// annotation, or a `<ns>.create()`-style constructor whose capitalized
    /// namespace (`vec3`→`Vec3`) resolves in the type oracle. `None` = don't touch.
    fn module_scratch_shape(&self, d: &VariableDeclarator<'a>) -> Option<Shape> {
        let init = d.init.as_ref()?;
        let bounded = |s: Shape| (MIN_FIELDS..=MAX_FIELDS).contains(&s.len()).then_some(s);
        match init {
            Expression::ArrayExpression(arr) => {
                if arr.elements.iter().any(|e| {
                    matches!(
                        e,
                        ArrayExpressionElement::SpreadElement(_)
                            | ArrayExpressionElement::Elision(_)
                    )
                }) {
                    return None;
                }
                bounded(Shape::Tuple(arr.elements.len()))
            }
            Expression::ObjectExpression(obj) => {
                let (fields, _) = object_literal_fields(obj, self.alloc())?;
                bounded(Shape::Object(fields))
            }
            _ => {
                // Typed annotation `const _s: Vec3 = …`, else a `<ns>.create()` ctor.
                if let Some(ta) = &d.type_annotation {
                    let mut seen = HashSet::new();
                    let rt =
                        resolve_ast(&ta.type_annotation, &NameSrc::Resolved(&self.types), &mut seen)?;
                    return bounded(shape_of(&rt)?);
                }
                let Expression::CallExpression(call) = init else { return None };
                let Expression::StaticMemberExpression(m) = &call.callee else { return None };
                let Expression::Identifier(ns) = &m.object else { return None };
                if !matches!(m.property.name.as_str(), "create" | "clone" | "identity" | "fromValues")
                {
                    return None;
                }
                let ty = capitalize(&ns.name);
                bounded(shape_of(self.types.get(&ty)?)?)
            }
        }
    }
}

/// Extract `(field names, value exprs)` from an object literal if every property
/// is a plain `key: value` (or shorthand) with a static identifier key — no
/// spread, method, getter/setter, computed, or duplicate keys. Field order is
/// preserved. `None` bails the whole literal.
fn object_literal_fields<'a>(
    obj: &ObjectExpression<'a>,
    alloc: &'a Allocator,
) -> Option<(Vec<String>, Vec<Expression<'a>>)> {
    let mut fields = Vec::with_capacity(obj.properties.len());
    let mut inits = Vec::with_capacity(obj.properties.len());
    for prop in &obj.properties {
        let ObjectPropertyKind::ObjectProperty(p) = prop else { return None }; // spread
        if p.computed || p.method || p.kind != PropertyKind::Init {
            return None; // computed key / method / getter / setter
        }
        let PropertyKey::StaticIdentifier(key) = &p.key else { return None }; // string/numeric/computed
        let fname = key.name.to_string();
        // `{ __proto__: v }` (colon form) is the prototype-initializer syntax — it
        // sets the prototype and creates NO own property, and `obj.__proto__` reads
        // go through `Object.prototype`. Scalarizing those would change behavior, so
        // bail. (Shorthand `{ __proto__ }` IS a real own property, but this field
        // name is unrealistic enough that a blanket bail is the safe simple choice.)
        if fname == "__proto__" {
            return None;
        }
        if fields.contains(&fname) {
            return None; // duplicate key
        }
        fields.push(fname);
        inits.push(p.value.clone_in(alloc));
    }
    Some((fields, inits))
}

// ── escape analysis ─────────────────────────────────────────────────────────

/// True if `e` is a member access `name[…]` / `name.f` (used to reject `delete`).
fn is_member_of(e: &Expression, name: &str) -> bool {
    match e {
        Expression::ComputedMemberExpression(m) => {
            matches!(&m.object, Expression::Identifier(o) if o.name == name)
        }
        Expression::StaticMemberExpression(m) => {
            matches!(&m.object, Expression::Identifier(o) if o.name == name)
        }
        _ => false,
    }
}

/// True if `e` is exactly the identifier `name` (a member-access object).
fn member_obj_is(e: &Expression, name: &str) -> bool {
    matches!(e, Expression::Identifier(o) if o.name == name)
}

// ── the single member-access classifier ─────────────────────────────────────
// THE one source of truth for "is this a valid, REWRITABLE member access of `name`
// for `shape`?" → the field suffix, else None. EVERY analysis (escape, read-collect,
// write-target) AND the rewriter consult these, so they cannot drift — a form the
// analysis accepts but the rewriter can't handle leaves a dangling reference (the
// `delete` and `v?.[i]` optional-chain miscompiles were exactly that drift). Rejects
// a different object, an OPTIONAL access (`v?.[i]`/`v?.f` — parses wrapped in a
// `ChainExpression` the rewriter won't descend into), a dynamic/out-of-range tuple
// index, and a wrong-shape access.

fn computed_member_suffix(m: &ComputedMemberExpression, name: &str, shape: &Shape) -> Option<String> {
    if !member_obj_is(&m.object, name) || m.optional {
        return None;
    }
    let (Shape::Tuple(size), Expression::NumericLiteral(lit)) = (shape, &m.expression) else {
        return None;
    };
    valid_index(lit.value, *size).then(|| (lit.value as usize).to_string())
}

fn static_member_suffix(m: &StaticMemberExpression, name: &str, shape: &Shape) -> Option<String> {
    if !member_obj_is(&m.object, name) || m.optional {
        return None;
    }
    let Shape::Object(fields) = shape else { return None };
    fields.iter().any(|f| f == m.property.name.as_str()).then(|| m.property.name.to_string())
}

fn escape_ok(body: &[Statement], name: &str, shape: &Shape) -> bool {
    let mut c = EscapeChecker { name, shape, bad: false };
    for stmt in body {
        c.visit_statement(stmt);
    }
    !c.bad
}

struct EscapeChecker<'s> {
    name: &'s str,
    shape: &'s Shape,
    bad: bool,
}

impl<'a> Visit<'a> for EscapeChecker<'_> {
    fn visit_computed_member_expression(&mut self, m: &ComputedMemberExpression<'a>) {
        if member_obj_is(&m.object, self.name) {
            if computed_member_suffix(m, self.name, self.shape).is_some() {
                self.visit_expression(&m.expression); // valid — audit only the index
            } else {
                self.bad = true; // `name` in a non-rewritable access (optional/dynamic/wrong-shape)
            }
            return;
        }
        walk::walk_computed_member_expression(self, m);
    }

    fn visit_static_member_expression(&mut self, m: &StaticMemberExpression<'a>) {
        if member_obj_is(&m.object, self.name) {
            if static_member_suffix(m, self.name, self.shape).is_none() {
                self.bad = true; // optional / unknown field / tuple-by-property
            }
            return;
        }
        walk::walk_static_member_expression(self, m);
    }

    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if id.name == self.name {
            self.bad = true; // any non-member-accounted reference escapes
        }
    }

    fn visit_unary_expression(&mut self, u: &UnaryExpression<'a>) {
        // `delete v[i]` / `delete v.f` removes the element/property — it is neither a
        // read nor a representable scalar write, and scalarizing it to `delete v_i`
        // (a `let` local) changes behavior / is a strict-mode SyntaxError. Bail.
        if u.operator == UnaryOperator::Delete && is_member_of(&u.argument, self.name) {
            self.bad = true;
            return;
        }
        walk::walk_unary_expression(self, u);
    }

    fn visit_function(&mut self, func: &Function<'a>, flags: ScopeFlags) {
        // A nested function that re-declares `name` as a param shadows it.
        let shadows = func.params.items.iter().any(
            |p| matches!(&p.pattern, BindingPattern::BindingIdentifier(b) if b.name == self.name),
        );
        if shadows {
            return;
        }
        walk::walk_function(self, func, flags);
    }
}

// ── module scratch: candidate + mutation + killed-on-entry ──────────────────

struct ModuleScratchCand {
    /// The name to analyze/rewrite/scalarize in the owner. For a DIRECT scratch this
    /// equals `module_const`. For an ALIASED scratch (`const s = _scratch`) it's the
    /// local alias `s` — all real member accesses go through it (v2 alias-following).
    name: String,
    /// The module-level const to delete once scalarized (always the scratch itself).
    module_const: String,
    /// True when `name` is a local alias `const name = module_const` (delete that
    /// alias declarator too).
    aliased: bool,
    shape: Shape,
    /// `span.start` of the sole owning function (its identity for the mutation walk).
    owner_fn_span: u32,
}

/// If the reference at `ref_id` is the initializer of a `const <s> = <ref>`
/// declarator, return the alias name `s`. This is the crashcat local-alias form
/// (`const rotation = _setMassProperties_rotation;`) — `s` is a second name for the
/// same buffer, so member accesses through `s` can be scalarized. Requires `const`
/// (a reassignable alias may not always equal the scratch). The other soundness
/// gates (member-only, killed-on-entry, no nested capture) then run on `s`.
fn single_const_alias(ref_id: NodeId, nodes: &oxc_semantic::AstNodes) -> Option<(String, SymbolId)> {
    let decl_id = nodes.parent_id(ref_id);
    let AstKind::VariableDeclarator(d) = nodes.kind(decl_id) else { return None };
    // The reference must BE the whole init (`= _scratch`), not nested (`= _scratch[0]`).
    if !matches!(&d.init, Some(Expression::Identifier(_))) {
        return None;
    }
    let BindingPattern::BindingIdentifier(bid) = &d.id else { return None };
    let AstKind::VariableDeclaration(vd) = nodes.kind(nodes.parent_id(decl_id)) else {
        return None;
    };
    if vd.kind != VariableDeclarationKind::Const {
        return None;
    }
    Some((bid.name.to_string(), bid.symbol_id.get()?))
}

/// `vec3` → `Vec3` (capitalize first byte) — the mathcat namespace→type convention.
fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(first) => first.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

/// Nearest enclosing function/arrow node of `start` (exclusive), or None at module
/// top level. (Mirror of `analysis::purity::enclosing_function`.)
fn enclosing_function(nodes: &oxc_semantic::AstNodes, start: NodeId) -> Option<NodeId> {
    let mut id = nodes.parent_id(start);
    loop {
        match nodes.kind(id) {
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => return Some(id),
            _ => {}
        }
        let p = nodes.parent_id(id);
        if p == id {
            return None;
        }
        id = p;
    }
}

/// True if the function's own name is referenced anywhere inside its body
/// (recursion / self-reference) — conservative bail for the "non-recursive owner"
/// precondition (LLVM `doesNotRecurse`).
fn fn_references_self(
    semantic: &oxc_semantic::Semantic,
    nodes: &oxc_semantic::AstNodes,
    owner: NodeId,
    func: &Function,
) -> bool {
    let Some(fid) = func.id.as_ref().and_then(|b| b.symbol_id.get()) else { return false };
    semantic
        .scoping()
        .get_resolved_references(fid)
        .any(|r| enclosing_function(nodes, r.node_id()) == Some(owner))
}

/// Walks the program, and for each function whose `span.start` owns module scratch,
/// scalarizes the qualifying candidates in place.
struct ScratchMutator<'a, 'b> {
    ast: AstBuilder<'a>,
    by_owner: &'b HashMap<u32, Vec<ModuleScratchCand>>,
    consumed: &'b mut HashSet<String>,
    count: &'b mut u32,
}

impl<'a> VisitMut<'a> for ScratchMutator<'a, '_> {
    fn visit_function(&mut self, func: &mut Function<'a>, flags: ScopeFlags) {
        if let Some(cands) = self.by_owner.get(&func.span.start) {
            if let Some(body) = func.body.as_mut() {
                self.process_owner(&mut body.statements, cands);
            }
        }
        walk_mut::walk_function(self, func, flags);
    }
}

impl<'a> ScratchMutator<'a, '_> {
    fn process_owner(
        &mut self,
        body: &mut oxc_allocator::Vec<'a, Statement<'a>>,
        cands: &[ModuleScratchCand],
    ) {
        // All gates (single-owner / recursion / alias / shape / scope-conflict / escape
        // / killed-on-entry) ran at analysis time in `find_module_scratch` on the same
        // (unmutated) AST, so every candidate here is already validated — just rewrite.
        let passing: Vec<&ModuleScratchCand> = cands.iter().collect();
        // Rewrite `name[i]`/`name.f` → `name_i` for every passing scratch (`name` is
        // the alias for the aliased form, else the scratch itself).
        let shapes: HashMap<String, Shape> =
            passing.iter().map(|c| (c.name.clone(), c.shape.clone())).collect();
        let mut rw = AccessRewriter { ast: self.ast, shapes: &shapes };
        for stmt in body.iter_mut() {
            rw.visit_statement(stmt);
        }
        // For an aliased scratch, drop the now-dead `const name = module_const;` decl.
        for c in &passing {
            if c.aliased {
                remove_alias_decl(body, &c.name, &c.module_const);
            }
        }
        // Prepend fresh uninitialized scalars (killed-on-entry ⇒ the init value is
        // never observed, so no init call — that is what keeps it allocation-free).
        // Mark the MODULE const (not the alias) for program-level deletion.
        for c in passing.iter().rev() {
            let decl = self.uninit_scalar_decl(&c.name, &c.shape);
            body.insert(0, decl);
            self.consumed.insert(c.module_const.clone());
            *self.count += 1;
        }
    }

    /// `let _s_0, _s_1, _s_2;` — one bare (no-init) scalar per field.
    fn uninit_scalar_decl(&self, name: &str, shape: &Shape) -> Statement<'a> {
        let suffixes = shape.suffixes();
        let mut declarators = self.ast.vec_with_capacity(suffixes.len());
        for suffix in &suffixes {
            let sname = self.ast.allocator.alloc_str(&format!("{name}_{suffix}"));
            let id = self.ast.binding_pattern_binding_identifier(SPAN, sname);
            declarators.push(self.ast.variable_declarator(
                SPAN,
                VariableDeclarationKind::Let,
                id,
                NONE,
                None,
                false,
            ));
        }
        Statement::VariableDeclaration(self.ast.alloc(self.ast.variable_declaration(
            SPAN,
            VariableDeclarationKind::Let,
            declarators,
            false,
        )))
    }
}

/// Remove a dead alias declarator `const <alias> = <module_const>;` from `body`
/// (its accesses have been rewritten to scalars). Strips just that declarator;
/// drops the statement if it becomes empty.
fn remove_alias_decl<'a>(body: &mut oxc_allocator::Vec<'a, Statement<'a>>, alias: &str, module_const: &str) {
    body.retain_mut(|stmt| {
        let Statement::VariableDeclaration(vd) = stmt else { return true };
        vd.declarations.retain(|d| {
            !(matches!(&d.id, BindingPattern::BindingIdentifier(id) if id.name == alias)
                && matches!(&d.init, Some(Expression::Identifier(i)) if i.name == module_const))
        });
        !vd.declarations.is_empty()
    });
}

// ── killed-on-entry as must-reaching-definitions over the owner's CFG ─────────
// The soundness proof — every READ of field `i` is preceded by a WRITE of field `i`
// on ALL paths — IS must-reaching-defs. Rather than hand-roll each control-flow
// shape (straight-line, loop, branch, switch), express it once on the shared CFG +
// dataflow tier (`analysis::cfg`/`data_flow`). This handles straight-line, loops,
// both-if-branches, and switch UNIFORMLY; `try`/generator/async make `cfg::build`
// return None, which we treat as a (sound) bail. `escape_ok` (run first) has already
// proved every use of `name` is a member access.

/// Per-CFG-node scratch effect. `None` from `node_fx` = an unhandleable use → bail.
#[derive(Default, Clone, Copy)]
struct NodeFx {
    /// Fields UNCONDITIONALLY written at this node (a clean `name[i] = RHS`), bitmask.
    writes: u32,
    /// Fields READ at this node that must already be must-written, bitmask.
    reads: u32,
    /// This node evaluates a non-side-effect-free call/new (re-entrancy candidate).
    reentrant: bool,
    /// Count of scratch member-accesses (read occurrences + write targets) this node
    /// attributed. Summed and compared to the whole-body total as a COMPLETENESS net:
    /// a scratch access in a CFG-node kind `node_fx` doesn't handle would be missed
    /// (the `_ => {}` catch-all), so the sum would fall short of the total → bail.
    /// Makes the per-kind dispatch sound by construction (retires the node-boundary
    /// bug class the two CFG reviewers found).
    access_count: u32,
}

/// Bit for field `suffix` under `shape` (tuple index / object field position).
fn field_bit(suffix: &str, shape: &Shape) -> Option<u32> {
    let idx = match shape {
        Shape::Tuple(n) => {
            let i: usize = suffix.parse().ok()?;
            if i >= *n {
                return None;
            }
            i
        }
        Shape::Object(fields) => fields.iter().position(|f| f == suffix)?,
    };
    (idx < 32).then(|| 1u32 << idx)
}

fn full_mask(shape: &Shape) -> u32 {
    let n = match shape {
        Shape::Tuple(n) => *n,
        Shape::Object(f) => f.len(),
    };
    if n >= 32 { u32::MAX } else { (1u32 << n) - 1 }
}

/// (read-field bitmask, read-occurrence count) for `e`, or None on an unmodellable
/// scratch use.
fn reads_mask(e: &Expression, name: &str, shape: &Shape) -> Option<(u32, u32)> {
    let reads = collect_reads(e, name, shape)?;
    let count = reads.len() as u32;
    let mut m = 0u32;
    for r in &reads {
        m |= field_bit(r, shape)?;
    }
    Some((m, count))
}

/// Classify one expression: a clean `name[i] = RHS` contributes write `i` + RHS
/// reads; anything else contributes its scratch reads (and `collect_reads` bails to
/// None on a scratch write-target it can't model — compound/nested write).
fn classify_expr(e: &Expression, name: &str, shape: &Shape, fx: &mut NodeFx) -> Option<()> {
    if let Expression::AssignmentExpression(a) = e {
        if a.operator == AssignmentOperator::Assign {
            if let Some(suffix) = assign_target_suffix(&a.left, name, shape) {
                fx.writes |= field_bit(&suffix, shape)?;
                fx.access_count += 1; // the write target `name[i]`
                let (m, c) = reads_mask(&a.right, name, shape)?;
                fx.reads |= m;
                fx.access_count += c;
                return Some(());
            }
        }
    }
    let (m, c) = reads_mask(e, name, shape)?;
    fx.reads |= m;
    fx.access_count += c;
    Some(())
}

/// The scratch effect of ONE CFG node. Mirrors `reaching::MustWalk`'s per-kind
/// dispatch: each node contributes only its DIRECT expression (a compound
/// statement's branches/body are their own CFG nodes), so reads are attributed to
/// the right node — the property confinement needs. `None` on any use the model
/// can't represent (bails the whole scratch).
fn node_fx(kind: AstKind, name: &str, shape: &Shape) -> Option<NodeFx> {
    let mut fx = NodeFx::default();
    let read = |e: &Expression, fx: &mut NodeFx| -> Option<()> {
        fx.reentrant |= expr_has_reentrant_call(e);
        let (m, c) = reads_mask(e, name, shape)?;
        fx.reads |= m;
        fx.access_count += c;
        Some(())
    };
    match kind {
        AstKind::ExpressionStatement(s) => {
            fx.reentrant |= expr_has_reentrant_call(&s.expression);
            classify_expr(&s.expression, name, shape, &mut fx)?;
        }
        AstKind::VariableDeclaration(vd) => {
            for d in &vd.declarations {
                if let Some(init) = &d.init {
                    read(init, &mut fx)?;
                }
            }
        }
        AstKind::ReturnStatement(s) => {
            if let Some(a) = &s.argument {
                read(a, &mut fx)?;
            }
        }
        AstKind::ThrowStatement(s) => read(&s.argument, &mut fx)?,
        AstKind::IfStatement(s) => read(&s.test, &mut fx)?,
        AstKind::WhileStatement(s) => read(&s.test, &mut fx)?,
        AstKind::DoWhileStatement(s) => read(&s.test, &mut fx)?,
        AstKind::ForStatement(s) => {
            if let Some(t) = &s.test {
                read(t, &mut fx)?;
            }
            // The for-INIT and -UPDATE are separate bare-expression CFG nodes
            // (Sequence/Update/Call/…) that `node_fx` can't model, so FOLD their
            // effects into this loop-head node (a sound over-approximation for the
            // may-may reachability): bail on a scratch use, and flag re-entrancy so an
            // impure call there (`for(…;…;g())`) is caught by the guard. Adversarial
            // review found both a for-update scratch READ and a re-entrant CALL slip
            // through otherwise.
            if s.init.as_ref().is_some_and(|i| for_init_mentions(i, name))
                || s.update.as_ref().is_some_and(|u| expr_mentions(u, name))
            {
                return None;
            }
            if s.init.as_ref().is_some_and(for_init_reentrant)
                || s.update.as_ref().is_some_and(|u| expr_has_reentrant_call(u))
            {
                fx.reentrant = true;
            }
        }
        AstKind::ForInStatement(s) => {
            read(&s.right, &mut fx)?;
            if for_left_mentions(&s.left, name) {
                return None;
            }
        }
        AstKind::ForOfStatement(s) => {
            read(&s.right, &mut fx)?;
            if for_left_mentions(&s.left, name) {
                return None;
            }
        }
        AstKind::SwitchStatement(s) => read(&s.discriminant, &mut fx)?,
        AstKind::SwitchCase(c) => {
            if let Some(t) = &c.test {
                read(t, &mut fx)?;
            }
        }
        // A standalone assignment CFG node (e.g. a for-init/update): model a clean
        // write; a compound assign to the scratch can't be modelled → bail.
        AstKind::AssignmentExpression(a) => {
            fx.reentrant |= expr_has_reentrant_call(&a.right);
            if a.operator == AssignmentOperator::Assign {
                if let Some(suffix) = assign_target_suffix(&a.left, name, shape) {
                    fx.writes |= field_bit(&suffix, shape)?;
                    fx.access_count += 1;
                }
                let (m, c) = reads_mask(&a.right, name, shape)?;
                fx.reads |= m;
                fx.access_count += c;
            } else if assign_target_suffix(&a.left, name, shape).is_some() {
                return None; // compound assign to the scratch
            } else {
                let (m, c) = reads_mask(&a.right, name, shape)?;
                fx.reads |= m;
                fx.access_count += c;
            }
        }
        // Bare-expression CFG nodes (for-headers, or any other position they occupy):
        // if one touches the scratch we can't attribute a read to a modelled slot, so
        // bail. Belt-and-braces alongside the for-header check above.
        AstKind::SequenceExpression(_)
        | AstKind::UpdateExpression(_)
        | AstKind::CallExpression(_) => {
            if bare_expr_mentions(kind, name) {
                return None;
            }
        }
        // Other node kinds (Block/Break/Continue/Empty/label/FunctionBody/…) carry no
        // direct scratch expression — their statements are separate CFG nodes.
        _ => {}
    }
    Some(fx)
}

/// Whether `name` appears as an identifier reference anywhere in the node.
struct NameFinder<'s> {
    name: &'s str,
    found: bool,
}
impl<'a> Visit<'a> for NameFinder<'_> {
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if id.name == self.name {
            self.found = true;
        }
    }
}
fn expr_mentions(e: &Expression, name: &str) -> bool {
    let mut f = NameFinder { name, found: false };
    f.visit_expression(e);
    f.found
}
fn for_init_mentions(init: &ForStatementInit, name: &str) -> bool {
    let mut f = NameFinder { name, found: false };
    walk::walk_for_statement_init(&mut f, init);
    f.found
}
fn for_init_reentrant(init: &ForStatementInit) -> bool {
    let mut v = ReentrantCallFinder { found: false };
    walk::walk_for_statement_init(&mut v, init);
    v.found
}
fn for_left_mentions(left: &ForStatementLeft, name: &str) -> bool {
    let mut f = NameFinder { name, found: false };
    walk::walk_for_statement_left(&mut f, left);
    f.found
}
fn bare_expr_mentions(kind: AstKind, name: &str) -> bool {
    let mut f = NameFinder { name, found: false };
    match kind {
        AstKind::SequenceExpression(s) => f.visit_sequence_expression(s),
        AstKind::UpdateExpression(u) => f.visit_update_expression(u),
        AstKind::CallExpression(c) => f.visit_call_expression(c),
        _ => {}
    }
    f.found
}

/// True if `e` contains a non-side-effect-free call/new (re-entrancy candidate).
fn expr_has_reentrant_call(e: &Expression) -> bool {
    let mut v = ReentrantCallFinder { found: false };
    v.visit_expression(e);
    v.found
}

/// Total scratch member-accesses (`name[i]` / `name.f`, read OR write target) in the
/// owner body, NOT descending into nested functions (which are not in this CFG). The
/// oracle for the completeness net: equals the sum of per-node `access_count` iff
/// `node_fx` attributed every access.
fn count_all_accesses(fb: &FunctionBody, name: &str) -> u32 {
    let mut c = AccessCounter { name, count: 0 };
    for s in &fb.statements {
        c.visit_statement(s);
    }
    c.count
}

struct AccessCounter<'s> {
    name: &'s str,
    count: u32,
}

impl<'a> Visit<'a> for AccessCounter<'_> {
    fn visit_computed_member_expression(&mut self, m: &ComputedMemberExpression<'a>) {
        if member_obj_is(&m.object, self.name) {
            self.count += 1;
        }
        walk::walk_computed_member_expression(self, m);
    }
    fn visit_static_member_expression(&mut self, m: &StaticMemberExpression<'a>) {
        if member_obj_is(&m.object, self.name) {
            self.count += 1;
        }
        walk::walk_static_member_expression(self, m);
    }
    // Nested functions/arrows are not part of the owner's CFG (a scratch capture there
    // was already rejected by the symbol gate) — don't count their accesses.
    fn visit_function(&mut self, _f: &Function<'a>, _flags: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {}
}

/// The must-write dataflow: lattice = bitmask of fields written on ALL paths so far.
struct ScratchKill<'x> {
    fx: &'x [NodeFx],
    full: u32,
}

impl DataFlow for ScratchKill<'_> {
    type Lattice = u32;
    fn direction(&self) -> Direction {
        Direction::Forward
    }
    fn flow_through(&self, node: CfgNodeId, _cfg: &ControlFlowGraph, input: &u32) -> u32 {
        input | self.fx[node].writes
    }
    fn join(&self, a: &u32, b: &u32) -> u32 {
        a & b // must = written on all incoming paths
    }
    fn equals(&self, a: &u32, b: &u32) -> bool {
        a == b
    }
    fn bottom(&self) -> u32 {
        self.full // TOP for an intersection lattice (narrows toward the real must-set)
    }
    fn entry(&self) -> u32 {
        0 // nothing written at function entry
    }
}

/// CFG-based killed-on-entry: build the owner's CFG, prove every field read is
/// must-reached by a same-field write, and reject re-entrant clobbering.
fn killed_on_entry(func_body: &FunctionBody, name: &str, shape: &Shape) -> bool {
    let Some(cfg) = cfg::build(AstKind::FunctionBody(func_body)) else {
        return false; // try / generator / async — sound bail
    };
    let n = cfg.node_count();
    let full = full_mask(shape);

    // Per-node effects (write/read/reentrant). Any unmodellable use → bail.
    let mut fx = Vec::with_capacity(n);
    for id in 0..n {
        let f = match cfg.node(id) {
            Some(k) => node_fx(k, name, shape),
            None => Some(NodeFx::default()),
        };
        match f {
            Some(f) => fx.push(f),
            None => return false,
        }
    }

    // COMPLETENESS NET: every scratch member-access in the body must have been
    // attributed to some node. If `node_fx`'s per-kind dispatch silently skipped a
    // CFG-node kind carrying a scratch access (the `_ => {}` catch-all), the sum
    // falls short of the whole-body total → bail. This makes the dispatch sound by
    // construction — a missed kind can only under-optimize, never miscompile.
    let attributed: u32 = fx.iter().map(|f| f.access_count).sum();
    if attributed != count_all_accesses(func_body, name) {
        return false;
    }

    let Ok(states) = analyze(&cfg, &ScratchKill { fx: &fx, full }) else {
        return false; // divergence guard — shouldn't happen (finite lattice)
    };

    // (1) Every field read must be must-written on entry to its node.
    for id in 0..n {
        if fx[id].reads & !states[id].in_ != 0 {
            return false;
        }
    }

    // (2) Re-entrancy: an impure call reachable FROM a scratch write AND reaching a
    // scratch read is on a live-window path where a re-entrant clobber would diverge
    // from the per-call scalars. Bail (sound; may-may over-approximation — leading
    // calls before any write and trailing calls after all reads still pass).
    let writes: Vec<bool> = fx.iter().map(|f| f.writes != 0).collect();
    let reads: Vec<bool> = fx.iter().map(|f| f.reads != 0).collect();
    for (id, f) in fx.iter().enumerate() {
        if f.reentrant
            && reachable_from_any(&cfg, id, &writes, false)
            && reachable_from_any(&cfg, id, &reads, true)
        {
            return false;
        }
    }
    true
}

/// True if, searching `forward` (successors) or backward (predecessors) from
/// `start`, any node with `flag[node]` is reachable (inclusive of `start` itself).
fn reachable_from_any(cfg: &ControlFlowGraph, start: CfgNodeId, flag: &[bool], forward: bool) -> bool {
    let n = cfg.node_count();
    let mut seen = vec![false; n];
    let mut stack = vec![start];
    seen[start] = true;
    while let Some(cur) = stack.pop() {
        if flag[cur] {
            return true;
        }
        if forward {
            for (d, _) in cfg.successors(cur) {
                if !seen[d] {
                    seen[d] = true;
                    stack.push(d);
                }
            }
        } else {
            for (s, _) in cfg.predecessors(cur) {
                if !seen[s] {
                    seen[s] = true;
                    stack.push(s);
                }
            }
        }
    }
    false
}

/// SYMBOL GATE. True if some identifier named `name` in `func` does NOT resolve to
/// `rewrite_sym` — i.e. a distinct binding SHADOWS the scratch/alias name (a nested
/// fn param, a block-scoped `const`, etc.), whose `name[i]` accesses the name-based
/// rewriter would wrongly hijack. Because oxc_semantic assigns the shadow its own
/// `SymbolId`, this one principled check subsumes the earlier scope heuristics
/// (nested-fn capture + re-binding count) and makes the name-based rewrite provably
/// equivalent to a symbol-based one. Runs at analysis time (Semantic live).
///
/// (The effectful-getter re-entrancy caveat lives on `killed_on_entry`, where the
/// re-entrancy machinery is.)
fn owner_name_shadowed(func: &Function, name: &str, rewrite_sym: SymbolId, semantic: &Semantic) -> bool {
    let mut c =
        SymShadowChecker { name, rewrite_sym, scoping: semantic.scoping(), fn_depth: 0, shadowed: false };
    if let Some(body) = &func.body {
        for stmt in &body.statements {
            c.visit_statement(stmt);
        }
    }
    c.shadowed
}

struct SymShadowChecker<'s> {
    name: &'s str,
    rewrite_sym: SymbolId,
    scoping: &'s oxc_semantic::Scoping,
    fn_depth: u32,
    shadowed: bool,
}

impl<'a> Visit<'a> for SymShadowChecker<'_> {
    fn visit_function(&mut self, f: &Function<'a>, flags: ScopeFlags) {
        self.fn_depth += 1;
        walk::walk_function(self, f, flags);
        self.fn_depth -= 1;
    }
    fn visit_arrow_function_expression(&mut self, a: &ArrowFunctionExpression<'a>) {
        self.fn_depth += 1;
        walk::walk_arrow_function_expression(self, a);
        self.fn_depth -= 1;
    }
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if id.name == self.name {
            let sym = id.reference_id.get().and_then(|r| self.scoping.get_reference(r).symbol_id());
            // A `name` ref resolving elsewhere = a shadow's use; a `name` ref inside a
            // NESTED function = a closure CAPTURE that may outlive the call (the symbol
            // gate alone can't see the capture — it resolves to the same symbol — so
            // this restores the capture guard, load-bearing on the alias path where
            // single-owner runs on the module const, not the alias).
            if sym != Some(self.rewrite_sym) || self.fn_depth > 0 {
                self.shadowed = true;
            }
        }
    }
    fn visit_binding_identifier(&mut self, id: &BindingIdentifier<'a>) {
        if id.name == self.name && id.symbol_id.get() != Some(self.rewrite_sym) {
            self.shadowed = true; // a `name` binding that isn't the scratch/alias = a shadow decl
        }
    }
}

/// True if a generated scalar name `{name}_{suffix}` already occurs (as a binding or
/// reference) in `func` — emitting `let {name}_{suffix}` would merge two distinct
/// variables (wrong value, or a `const`-reassignment crash). Name-level concern (the
/// scalar doesn't exist yet, so there's no symbol to resolve).
fn owner_has_scalar_name(func: &Function, name: &str, shape: &Shape) -> bool {
    let scalars: HashSet<String> = shape.suffixes().iter().map(|s| format!("{name}_{s}")).collect();
    let mut c = ScalarNameChecker { scalars: &scalars, found: false };
    if let Some(body) = &func.body {
        for stmt in &body.statements {
            c.visit_statement(stmt);
        }
    }
    c.found
}

struct ScalarNameChecker<'s> {
    scalars: &'s HashSet<String>,
    found: bool,
}

impl<'a> Visit<'a> for ScalarNameChecker<'_> {
    fn visit_binding_identifier(&mut self, id: &BindingIdentifier<'a>) {
        if self.scalars.contains(id.name.as_str()) {
            self.found = true;
        }
    }
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if self.scalars.contains(id.name.as_str()) {
            self.found = true;
        }
    }
}

struct ReentrantCallFinder {
    found: bool,
}

impl<'a> Visit<'a> for ReentrantCallFinder {
    // Override the invocation NODES directly (not `visit_expression`) so wrapped
    // forms are caught too: an optional call `f?.()` is a `CallExpression` inside a
    // `ChainExpression` (reached via `visit_call_expression`, never `visit_expression`),
    // and a tagged template `` tag`` `` / `new` are separate node kinds entirely.
    // Adversarial review found both slipping past the old `matches!` on `visit_expression`.
    fn visit_call_expression(&mut self, c: &CallExpression<'a>) {
        if !crate::passes::util::call_is_side_effect_free(c) {
            self.found = true;
            return;
        }
        walk::walk_call_expression(self, c); // a pure call's args may hold impure ones
    }
    fn visit_new_expression(&mut self, _n: &NewExpression<'a>) {
        self.found = true; // a constructor call can run arbitrary user code
    }
    fn visit_tagged_template_expression(&mut self, _t: &TaggedTemplateExpression<'a>) {
        self.found = true; // invokes the tag function
    }
}

/// The field suffix if `t` is a write target `name[<lit>]` / `name.<field>` in
/// range for `shape`, else None.
fn assign_target_suffix(t: &AssignmentTarget, name: &str, shape: &Shape) -> Option<String> {
    match t {
        AssignmentTarget::ComputedMemberExpression(m) => computed_member_suffix(m, name, shape),
        AssignmentTarget::StaticMemberExpression(m) => static_member_suffix(m, name, shape),
        _ => None,
    }
}

/// Collect the field suffixes of `name` READ in an expression. `None` if `name`
/// escapes (bare identifier) or is written (assignment target) inside — i.e. any
/// use that the straight-line model can't account for as a plain read.
fn collect_reads(e: &Expression, name: &str, shape: &Shape) -> Option<Vec<String>> {
    let mut c = ReadCollector { name, shape, reads: Vec::new(), bad: false };
    c.visit_expression(e);
    (!c.bad).then_some(c.reads)
}

struct ReadCollector<'s> {
    name: &'s str,
    shape: &'s Shape,
    reads: Vec<String>,
    bad: bool,
}

impl<'a> Visit<'a> for ReadCollector<'_> {
    fn visit_computed_member_expression(&mut self, m: &ComputedMemberExpression<'a>) {
        if member_obj_is(&m.object, self.name) {
            match computed_member_suffix(m, self.name, self.shape) {
                Some(s) => {
                    self.reads.push(s);
                    self.visit_expression(&m.expression); // audit only the index
                }
                None => self.bad = true,
            }
            return;
        }
        walk::walk_computed_member_expression(self, m);
    }

    fn visit_static_member_expression(&mut self, m: &StaticMemberExpression<'a>) {
        if member_obj_is(&m.object, self.name) {
            match static_member_suffix(m, self.name, self.shape) {
                Some(s) => self.reads.push(s),
                None => self.bad = true,
            }
            return;
        }
        walk::walk_static_member_expression(self, m);
    }

    fn visit_assignment_expression(&mut self, a: &AssignmentExpression<'a>) {
        // A write to `name` inside a read region can't be modelled straight-line.
        if assign_target_suffix(&a.left, self.name, self.shape).is_some() {
            self.bad = true;
            return;
        }
        walk::walk_assignment_expression(self, a);
    }

    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if id.name == self.name {
            self.bad = true; // bare `name` escapes
        }
    }
}

// ── access rewrite ──────────────────────────────────────────────────────────

struct AccessRewriter<'a, 's> {
    ast: AstBuilder<'a>,
    shapes: &'s HashMap<String, Shape>,
}

impl<'a> AccessRewriter<'a, '_> {
    /// The scalar name `{obj}_{suffix}` for `obj[i]`/`obj.f` when `obj` is a tracked
    /// candidate and the access is valid+rewritable — via the SHARED classifier, so
    /// the rewrite matches exactly what the analysis accounted for.
    fn scalar_computed(&self, m: &ComputedMemberExpression<'a>) -> Option<&'a str> {
        let Expression::Identifier(obj) = &m.object else { return None };
        let shape = self.shapes.get(obj.name.as_str())?;
        let suffix = computed_member_suffix(m, obj.name.as_str(), shape)?;
        Some(self.ast.allocator.alloc_str(&format!("{}_{}", obj.name, suffix)))
    }

    fn scalar_static(&self, m: &StaticMemberExpression<'a>) -> Option<&'a str> {
        let Expression::Identifier(obj) = &m.object else { return None };
        let shape = self.shapes.get(obj.name.as_str())?;
        let suffix = static_member_suffix(m, obj.name.as_str(), shape)?;
        Some(self.ast.allocator.alloc_str(&format!("{}_{}", obj.name, suffix)))
    }
}

impl<'a> VisitMut<'a> for AccessRewriter<'a, '_> {
    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        match &*expr {
            Expression::ComputedMemberExpression(m) => {
                if let Some(name) = self.scalar_computed(m) {
                    *expr = self.ast.expression_identifier(SPAN, name);
                    return;
                }
            }
            Expression::StaticMemberExpression(m) => {
                if let Some(name) = self.scalar_static(m) {
                    *expr = self.ast.expression_identifier(SPAN, name);
                    return;
                }
            }
            _ => {}
        }
        walk_mut::walk_expression(self, expr);
    }

    fn visit_simple_assignment_target(&mut self, target: &mut SimpleAssignmentTarget<'a>) {
        match &*target {
            SimpleAssignmentTarget::ComputedMemberExpression(m) => {
                if let Some(name) = self.scalar_computed(m) {
                    *target =
                        self.ast.simple_assignment_target_assignment_target_identifier(SPAN, name);
                    return;
                }
            }
            SimpleAssignmentTarget::StaticMemberExpression(m) => {
                if let Some(name) = self.scalar_static(m) {
                    *target =
                        self.ast.simple_assignment_target_assignment_target_identifier(SPAN, name);
                    return;
                }
            }
            _ => {}
        }
        walk_mut::walk_simple_assignment_target(self, target);
    }
}

fn valid_index(v: f64, size: usize) -> bool {
    v >= 0.0 && v.fract() == 0.0 && (v as usize) < size
}

/// Stable arena address of a single `VariableDeclarator`, used to key the
/// per-declarator rewrite of a (possibly multi-declarator) declaration. Unlike a
/// `Box`, a declarator lives inline in its parent's `declarations` `Vec`, so its
/// address is only stable while that `Vec` isn't resized/reordered — which holds
/// here: between `collect_safe` and `rewrite_decls` the access-rewrite phase only
/// edits declarator *contents*, never the `declarations` structure, and the
/// statement-level `take_in` moves the `Vec` header (not its arena buffer). NOT
/// keyed by span: inline-generated decls all share `SPAN(0,0)` and would alias.
fn declarator_addr(d: &VariableDeclarator) -> Address {
    // SAFETY: `d` references a `VariableDeclarator` allocated in the arena (an
    // element of a parent `VariableDeclaration`'s `declarations` Vec), not on the
    // stack, so its pointer is a meaningful arena address.
    unsafe { Address::from_ptr(d) }
}

/// Locate the first collapsible result temp in `list`: a `let v;` (no init)
/// assigned exactly once (`v = E;`) and read exactly once, with the read in the
/// statement immediately after the assignment. Returns (decl index, assign
/// index, name). See `collapse_result_temps`.
/// True if the single read of `name` in `stmt` is in an UNCONDITIONAL position —
/// not under a `?:` branch, a short-circuit `&&`/`||`/`??` RHS, or an if/loop/
/// switch body. Conservative: unhandled conditional-ish constructs count as
/// conditional (returns false).
fn read_is_unconditional(stmt: &Statement, name: &str) -> bool {
    struct V<'n> {
        name: &'n str,
        cond_depth: u32,
        conditional_read: bool,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            if id.name == self.name && self.cond_depth > 0 {
                self.conditional_read = true;
            }
        }
        fn visit_conditional_expression(&mut self, c: &ConditionalExpression<'a>) {
            self.visit_expression(&c.test);
            self.cond_depth += 1;
            self.visit_expression(&c.consequent);
            self.visit_expression(&c.alternate);
            self.cond_depth -= 1;
        }
        fn visit_logical_expression(&mut self, l: &LogicalExpression<'a>) {
            self.visit_expression(&l.left);
            self.cond_depth += 1; // RHS is short-circuit-conditional
            self.visit_expression(&l.right);
            self.cond_depth -= 1;
        }
        fn visit_if_statement(&mut self, s: &IfStatement<'a>) {
            self.visit_expression(&s.test);
            self.cond_depth += 1;
            self.visit_statement(&s.consequent);
            if let Some(a) = &s.alternate {
                self.visit_statement(a);
            }
            self.cond_depth -= 1;
        }
        fn visit_while_statement(&mut self, s: &WhileStatement<'a>) {
            self.visit_expression(&s.test);
            self.cond_depth += 1;
            self.visit_statement(&s.body);
            self.cond_depth -= 1;
        }
        fn visit_do_while_statement(&mut self, s: &DoWhileStatement<'a>) {
            // Body runs at least once, but the read may be after a conditional `break`;
            // treat as conditional to be safe.
            self.cond_depth += 1;
            self.visit_statement(&s.body);
            self.visit_expression(&s.test);
            self.cond_depth -= 1;
        }
        fn visit_for_statement(&mut self, s: &ForStatement<'a>) {
            self.cond_depth += 1;
            walk::walk_for_statement(self, s);
            self.cond_depth -= 1;
        }
        fn visit_switch_statement(&mut self, s: &SwitchStatement<'a>) {
            self.visit_expression(&s.discriminant);
            self.cond_depth += 1;
            for c in &s.cases {
                walk::walk_switch_case(self, c);
            }
            self.cond_depth -= 1;
        }
        // Nested functions don't run here.
        fn visit_function(&mut self, _f: &Function<'a>, _flags: ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {}
    }
    let mut v = V { name, cond_depth: 0, conditional_read: false };
    v.visit_statement(stmt);
    !v.conditional_read
}

fn find_collapsible_temp(list: &[Statement]) -> Option<(usize, usize, String)> {
    for (di, s) in list.iter().enumerate() {
        let Statement::VariableDeclaration(vd) = s else { continue };
        if vd.kind != VariableDeclarationKind::Let || vd.declarations.len() != 1 {
            continue;
        }
        let d = &vd.declarations[0];
        if d.init.is_some() {
            continue;
        }
        let BindingPattern::BindingIdentifier(id) = &d.id else { continue };
        let name = id.name.as_str();
        let (reads, writes) = count_name_uses(name, list);
        if reads != 1 || writes != 1 {
            continue;
        }
        let Some(ai) = list.iter().position(|st| is_assign_to(st, name)) else { continue };
        if ai <= di || ai + 1 >= list.len() {
            continue;
        }
        // The single read must be (solely) in the statement right after the assign.
        if count_name_uses(name, std::slice::from_ref(&list[ai + 1])).0 != 1 {
            continue;
        }
        // If `E` has side effects, collapsing it into the read is only sound when the
        // read is UNCONDITIONAL — otherwise the effect moves into a `?:`/`&&`/if/loop
        // branch and runs conditionally (dropping when the branch isn't taken). E was
        // evaluated eagerly at `v = E`; a pure E may move anywhere, an impure one only
        // to an unconditional position.
        let e_impure = match &list[ai] {
            Statement::ExpressionStatement(es) => match &es.expression {
                Expression::AssignmentExpression(asgn) => !is_side_effect_free(&asgn.right),
                _ => true,
            },
            _ => true,
        };
        if e_impure && !read_is_unconditional(&list[ai + 1], name) {
            continue;
        }
        return Some((di, ai, name.to_string()));
    }
    None
}

/// `true` if `stmt` is a top-level `name = <expr>;` (simple `=` assignment).
fn is_assign_to(stmt: &Statement, name: &str) -> bool {
    let Statement::ExpressionStatement(es) = stmt else { return false };
    let Expression::AssignmentExpression(a) = &es.expression else { return false };
    a.operator == AssignmentOperator::Assign
        && matches!(&a.left, AssignmentTarget::AssignmentTargetIdentifier(id) if id.name == name)
}

/// `true` if `stmt` is `name = <object|array literal>;` (the deferred aggregate
/// store the existing collection can scalarize once it's at init position).
fn is_literal_assign_to(stmt: &Statement, name: &str) -> bool {
    let Statement::ExpressionStatement(es) = stmt else { return false };
    let Expression::AssignmentExpression(a) = &es.expression else { return false };
    a.operator == AssignmentOperator::Assign
        && matches!(&a.left, AssignmentTarget::AssignmentTargetIdentifier(id) if id.name == name)
        && matches!(&a.right, Expression::ObjectExpression(_) | Expression::ArrayExpression(_))
}

/// Locate the first deferred-init aggregate in `list`: a `let v;` (no init,
/// single declarator) assigned exactly once — a `v = <literal>;` store at a later
/// index — with no read of `v` before (or at) that store. Returns (decl index,
/// store index). See `merge_deferred_init`.
fn find_deferred_init(list: &[Statement]) -> Option<(usize, usize)> {
    for (di, s) in list.iter().enumerate() {
        let Statement::VariableDeclaration(vd) = s else { continue };
        if vd.kind != VariableDeclarationKind::Let || vd.declarations.len() != 1 {
            continue;
        }
        let d = &vd.declarations[0];
        if d.init.is_some() {
            continue;
        }
        let BindingPattern::BindingIdentifier(id) = &d.id else { continue };
        let name = id.name.as_str();
        let (_reads, writes) = count_name_uses(name, list);
        if writes != 1 {
            continue; // a single store is what makes the relocation safe (Stage 1)
        }
        // A closure capturing `v` could observe it before the relocated store, and
        // a store hidden inside a closure wouldn't be in the visible `writes`
        // count — bail if `v` appears in any nested function at all.
        if name_in_nested_fn(name, list) {
            continue;
        }
        let Some(ai) = list.iter().position(|st| is_literal_assign_to(st, name)) else { continue };
        if ai <= di {
            continue;
        }
        // No read of `v` between the decl and the store (inclusive of the store,
        // whose RHS literal can't read `v`) → relocating the decl is unobservable.
        if count_name_uses(name, &list[di + 1..=ai]).0 != 0 {
            continue;
        }
        return Some((di, ai));
    }
    None
}

/// Reads + writes of `name` across `stmts` (+ nested blocks), excluding nested
/// functions (their own scope).
fn count_name_uses(name: &str, stmts: &[Statement]) -> (usize, usize) {
    struct C<'n> {
        name: &'n str,
        reads: usize,
        writes: usize,
    }
    impl<'a> Visit<'a> for C<'_> {
        fn visit_assignment_expression(&mut self, a: &AssignmentExpression<'a>) {
            if let AssignmentTarget::AssignmentTargetIdentifier(id) = &a.left {
                if id.name == self.name {
                    self.writes += 1;
                    if a.operator != AssignmentOperator::Assign {
                        self.reads += 1; // compound assignment reads too
                    }
                }
            } else {
                self.visit_assignment_target(&a.left);
            }
            self.visit_expression(&a.right);
        }
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            if id.name == self.name {
                self.reads += 1;
            }
        }
        fn visit_function(&mut self, _: &Function<'a>, _: ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _: &ArrowFunctionExpression<'a>) {}
    }
    let mut c = C { name, reads: 0, writes: 0 };
    for s in stmts {
        c.visit_statement(s);
    }
    (c.reads, c.writes)
}

/// `true` if `name` is referenced inside any nested function/arrow in `stmts`
/// (a closure capture). Used to bail merges that relocate `name`'s declaration —
/// a closure could observe it before the relocated store.
fn name_in_nested_fn(name: &str, stmts: &[Statement]) -> bool {
    struct C<'n> {
        name: &'n str,
        depth: u32,
        found: bool,
    }
    impl<'a> Visit<'a> for C<'_> {
        fn visit_function(&mut self, f: &Function<'a>, flags: ScopeFlags) {
            self.depth += 1;
            walk::walk_function(self, f, flags);
            self.depth -= 1;
        }
        fn visit_arrow_function_expression(&mut self, f: &ArrowFunctionExpression<'a>) {
            self.depth += 1;
            walk::walk_arrow_function_expression(self, f);
            self.depth -= 1;
        }
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            if self.depth > 0 && id.name == self.name {
                self.found = true;
            }
        }
    }
    let mut c = C { name, depth: 0, found: false };
    for s in stmts {
        c.visit_statement(s);
    }
    c.found
}

/// Replace the first `IdentifierReference` named `name` with `value` (taken once).
struct SingleIdentSub<'a, 'n> {
    name: &'n str,
    value: Option<Expression<'a>>,
}
impl<'a> VisitMut<'a> for SingleIdentSub<'a, '_> {
    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        if self.value.is_some() {
            if let Expression::Identifier(id) = &*expr {
                if id.name == self.name {
                    *expr = self.value.take().unwrap();
                    return;
                }
            }
        }
        walk_mut::walk_expression(self, expr);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;

    /// Run the SROA pass on `src` and return (codegen, count).
    fn sroa(src: &str) -> (String, u32) {
        let allocator = Allocator::default();
        let mut program = crate::parse_program(&allocator, src, SourceType::ts());
        let n = run(&allocator, &mut program, &HashMap::new());
        (Codegen::new().build(&program).code, n)
    }

    /// Run normalize → inline → block-flatten → sroa and return the codegen.
    /// Reproduces the real pipeline state where inline-generated declarations all
    /// carry `SPAN(0,0)` — the condition that exposed the span-collision bug.
    fn inline_then_sroa(src: &str) -> String {
        let allocator = Allocator::default();
        let mut program = crate::parse_program(&allocator, src, SourceType::ts());
        crate::passes::normalize::run(&allocator, &mut program);
        let mut uid = 0u32;
        crate::passes::inline_functions::run(&allocator, &mut program, &mut uid);
        crate::passes::block_flatten::run(&allocator, &mut program);
        run(&allocator, &mut program, &HashMap::new());
        Codegen::new().build(&program).code
    }

    #[test]
    fn inline_generated_object_decls_scalarize_independently() {
        // Regression: two object-literal args inlined as `let a = {…}; let b = {…}`
        // both carry SPAN(0,0). Keying the declaration rewrite by span aliased
        // them, so only one was scalarized while both names' accesses were
        // rewritten — leaving `a_x` referenced but never declared (ReferenceError).
        // Keying by arena Address fixes it. (cf. reference_cfg_node_identity_keying)
        let out = inline_then_sroa(
            "function dist2(p) { return p.dx * p.dx + p.dy * p.dy; }\n\
             function measure(a, b) { const p = { dx: b.x - a.x, dy: b.y - a.y }; return dist2(p); }\n\
             /* @optimize */ function run() { return measure({ x: 0, y: 0 }, { x: 3, y: 4 }); }",
        );
        let run_fn = out.split("function run").nth(1).expect("run in output");
        // Both arg aggregates were scalarized away (the `{x,y}` literals are gone).
        // The injected params `a`/`b` are uncontested in this HOST-scoped `@optimize`
        // expansion, so they stay BARE (no per-expansion suffix), and SROA emits
        // scalars named `a_x`/`b_x` etc. — assert both arg objects are gone and both
        // produced scalar bindings. (Eval-correctness — that no scalar is
        // referenced-but-undeclared — is covered behaviorally by
        // equivalence.test.ts `inline-object-args-then-sroa`.)
        assert!(!run_fn.contains("x: 0"), "arg object `a` not scalarized:\n{out}");
        assert!(!run_fn.contains("x: 3"), "arg object `b` not scalarized:\n{out}");
        assert!(run_fn.contains("a_x") && run_fn.contains("b_x"), "both args present as scalars:\n{out}");
    }

    #[test]
    fn candidate_init_reading_another_candidates_field_stays_consistent() {
        // Regression: `na`'s initializer reads `corr.x` — another candidate's
        // field. Once both are scalarized, `na` must reference the scalar
        // `corr_x`, not the now-removed `corr.x`. The bug emitted `na` from the
        // copy of its init captured BEFORE the access-rewrite, leaving a dangling
        // `corr.x` after `corr` itself was scalarized away. Fixed by rebuilding
        // the scalar init from the live (already-rewritten) declarator.
        let out = inline_then_sroa(
            "type V = { x: number; y: number };\n\
             function sub(a: V, b: V): V { return { x: a.x - b.x, y: a.y - b.y }; }\n\
             function scale(a: V, s: number): V { return { x: a.x * s, y: a.y * s }; }\n\
             /* @optimize */ function f(a: V, s: number, p: boolean): void {\n\
               const corr = scale(a, s);\n\
               if (p) { const na = sub(a, corr); a.x = na.x; a.y = na.y; }\n\
             }",
        );
        assert!(!out.contains("corr."), "`corr` left as a member access (dangling):\n{out}");
        assert!(out.contains("corr_x"), "`corr` scalarized to `corr_x`:\n{out}");
    }

    #[test]
    fn scalarizes_tuple_at_function_top_level() {
        let (out, n) =
            sroa("/* @sroa */ export function f() { const v = [1, 2]; return v[0] + v[1]; }");
        assert_eq!(n, 1, "one aggregate scalarized:\n{out}");
        assert!(out.contains("v_0 = 1"), "scalar 0:\n{out}");
        assert!(out.contains("v_1 = 2"), "scalar 1:\n{out}");
        assert!(out.contains("v_0 + v_1"), "accesses rewritten:\n{out}");
        assert!(!out.contains("[1, 2]"), "aggregate gone:\n{out}");
    }

    #[test]
    fn scalarizes_tuple_inside_loop_body() {
        // An aggregate declared inside a loop body is scalarized in place,
        // not skipped.
        let (out, n) = sroa(
            "/* @sroa */ export function f(arr) { \
                let s = 0; \
                for (let i = 0; i < arr.length; i++) { const v = [arr[i], i]; s += v[0] * v[1]; } \
                return s; \
            }",
        );
        assert_eq!(n, 1, "loop-body aggregate scalarized:\n{out}");
        assert!(out.contains("v_0 = arr[i]"), "scalar 0 in loop:\n{out}");
        assert!(out.contains("v_1 = i"), "scalar 1 in loop:\n{out}");
        assert!(out.contains("v_0 * v_1"), "accesses rewritten:\n{out}");
        // The scalar decl stays inside the loop body, not hoisted out.
        let pre_loop = &out[..out.find("for ").expect("loop present")];
        assert!(!pre_loop.contains("v_0"), "scalar not hoisted above loop:\n{out}");
    }

    #[test]
    fn scalarizes_record_inside_if_branch() {
        let (out, n) = sroa(
            "/* @sroa */ export function f(c, a, b) { \
                if (c) { const p = { x: a, y: b }; return p.x + p.y; } \
                return 0; \
            }",
        );
        assert_eq!(n, 1, "branch-local record scalarized:\n{out}");
        assert!(out.contains("p_x = a"), "field x:\n{out}");
        assert!(out.contains("p_y = b"), "field y:\n{out}");
        assert!(out.contains("p_x + p_y"), "field accesses rewritten:\n{out}");
    }

    #[test]
    fn rejects_loop_aggregate_that_escapes() {
        // Escape analysis is function-scoped: a plain (non-member) use anywhere in
        // the function disqualifies the aggregate, even across the block boundary.
        let (out, n) = sroa(
            "/* @sroa */ export function f(arr, sink) { \
                for (let i = 0; i < arr.length; i++) { const v = [arr[i], i]; sink(v); } \
            }",
        );
        assert_eq!(n, 0, "escaping aggregate left intact:\n{out}");
        assert!(out.contains("[arr[i], i]"), "aggregate preserved:\n{out}");
    }

    // ── edge cases ───────────────────────────────────────────────────────────

    #[test]
    fn skips_non_literal_index() {
        // A dynamic (param) index can't be resolved to a field — skip.
        let (out, n) = sroa("/* @sroa */ function f(i) { const v = [1, 2, 3]; return v[i]; }");
        assert_eq!(n, 0, "dynamic index not scalarized:\n{out}");
        assert!(out.contains("v[i]"), "aggregate access preserved:\n{out}");
        assert!(out.contains("const v ="), "aggregate decl preserved:\n{out}");
    }

    #[test]
    fn skips_out_of_bounds_index() {
        // `v[5]` on a 3-element tuple has no corresponding field — skip.
        let (out, n) = sroa("/* @sroa */ function f() { const v = [1, 2, 3]; return v[5]; }");
        assert_eq!(n, 0, "out-of-bounds access not scalarized:\n{out}");
        assert!(out.contains("v[5]"), "aggregate access preserved:\n{out}");
        assert!(out.contains("const v ="), "aggregate decl preserved:\n{out}");
    }

    #[test]
    fn skips_singleton_array() {
        // MIN_FIELDS=2: a 1-element aggregate isn't worth scalarizing — skip.
        let (out, n) = sroa("/* @sroa */ function f() { const v = [1]; return v[0]; }");
        assert_eq!(n, 0, "singleton not scalarized:\n{out}");
        assert!(out.contains("const v = [1]"), "aggregate preserved:\n{out}");
    }

    #[test]
    fn decl_level_annotation_scalarizes() {
        // Annotation on the declaration (no function-level directive) still opts
        // that aggregate into scalarization.
        let (out, n) =
            sroa("function f() { /* @sroa */ const v = [1, 2, 3]; return v[0] + v[1] + v[2]; }");
        assert_eq!(n, 1, "decl-level @sroa scalarized:\n{out}");
        assert!(out.contains("v_0 = 1"), "scalar 0:\n{out}");
        assert!(out.contains("v_1 = 2"), "scalar 1:\n{out}");
        assert!(out.contains("v_2 = 3"), "scalar 2:\n{out}");
        assert!(out.contains("v_0 + v_1 + v_2"), "accesses rewritten:\n{out}");
    }

    #[test]
    fn escape_analysis_is_per_function() {
        // Two @optimize functions with same-named-shaped aggregates: `f`'s tuple
        // is purely member-accessed (scalarizes), while `g`'s escapes via `sink`
        // (left intact). One function's escape must not disqualify the other.
        let (out, n) = sroa(
            "/* @optimize */ function f() { const v = [1, 2]; return v[0] + v[1]; }\n\
             /* @optimize */ function g(sink) { const w = [3, 4]; sink(w); return w; }",
        );
        assert_eq!(n, 1, "exactly one (non-escaping) aggregate scalarized:\n{out}");
        let f = out.split("function f").nth(1).expect("f in output");
        let f = &f[..f.find("function g").unwrap_or(f.len())];
        assert!(f.contains("v_0 = 1") && f.contains("v_1 = 2"), "f scalarized:\n{out}");
        let g = out.split("function g").nth(1).expect("g in output");
        assert!(g.contains("sink(w)"), "g's escaping aggregate left intact:\n{out}");
        assert!(g.contains("const w ="), "g's aggregate decl preserved:\n{out}");
    }

    // ── multi-declarator decls ───────────────────────────────────────────────

    #[test]
    fn scalarizes_both_declarators_in_multi_decl() {
        // `const a = […], b = […];` — each declarator is classified and rewritten
        // independently; both scalarize and the statement splits into two `let`s.
        let (out, n) = sroa(
            "/* @optimize */ export function f() { \
                const a = [1, 2], b = [3, 4]; return a[0] + a[1] + b[0] + b[1]; }",
        );
        assert_eq!(n, 2, "both declarators scalarized:\n{out}");
        assert!(out.contains("a_0 = 1") && out.contains("a_1 = 2"), "a scalarized:\n{out}");
        assert!(out.contains("b_0 = 3") && out.contains("b_1 = 4"), "b scalarized:\n{out}");
        assert!(out.contains("a_0 + a_1 + b_0 + b_1"), "accesses rewritten:\n{out}");
        assert!(!out.contains("[1, 2]") && !out.contains("[3, 4]"), "aggregates gone:\n{out}");
    }

    #[test]
    fn scalarizes_subset_of_multi_decl_preserving_kept_kind() {
        // Only the aggregate declarators (`a`, `c`) scalarize; the plain `b` is
        // kept, retaining its `const` kind, and source order is preserved.
        let (out, n) = sroa(
            "/* @optimize */ export function f(x) { \
                const a = [1, 2], b = x, c = [3, 4]; return a[0] + b + c[1]; }",
        );
        assert_eq!(n, 2, "two aggregate declarators scalarized:\n{out}");
        assert!(out.contains("let a_0 = 1, a_1 = 2"), "a → let:\n{out}");
        assert!(out.contains("const b = x"), "b kept as const:\n{out}");
        assert!(out.contains("let c_0 = 3, c_1 = 4"), "c → let:\n{out}");
        assert!(out.contains("a_0 + b + c_1"), "accesses rewritten:\n{out}");
        // Source order: a's scalars, then b, then c's scalars.
        let ia = out.find("a_0 = 1").expect("a present");
        let ib = out.find("const b = x").expect("b present");
        let ic = out.find("c_0 = 3").expect("c present");
        assert!(ia < ib && ib < ic, "source order preserved:\n{out}");
    }

    #[test]
    fn multi_decl_one_escapes_other_scalarizes() {
        // One declarator's aggregate escapes (passed whole to `sink`) and is left
        // intact; the sibling, purely member-accessed, still scalarizes.
        let (out, n) = sroa(
            "/* @optimize */ export function f(sink) { \
                const a = [1, 2], b = [3, 4]; sink(b); return a[0] + a[1]; }",
        );
        assert_eq!(n, 1, "only the non-escaping declarator scalarized:\n{out}");
        assert!(out.contains("let a_0 = 1, a_1 = 2"), "a scalarized:\n{out}");
        assert!(out.contains("const b = [3, 4]"), "b (escaping) kept intact:\n{out}");
        assert!(out.contains("sink(b)"), "b still passed whole:\n{out}");
    }

    // ── let-kind aggregates ──────────────────────────────────────────────────

    #[test]
    fn scalarizes_let_kind_aggregate() {
        // A `let` aggregate that's only constant-index-accessed (never reassigned
        // as a whole) is safe to scalarize — declaration kind is irrelevant.
        let (out, n) =
            sroa("/* @optimize */ export function f() { let v = [1, 2]; return v[0] + v[1]; }");
        assert_eq!(n, 1, "let aggregate scalarized:\n{out}");
        assert!(out.contains("v_0 = 1") && out.contains("v_1 = 2"), "scalars:\n{out}");
        assert!(out.contains("v_0 + v_1"), "accesses rewritten:\n{out}");
        assert!(!out.contains("[1, 2]"), "aggregate gone:\n{out}");
    }

    #[test]
    fn rejects_let_aggregate_reassigned_as_whole() {
        // Reassigning the whole binding (`v = […]`) is a non-member reference, so
        // escape analysis bails — `let` reassignment is correctly handled.
        let (out, n) = sroa(
            "/* @optimize */ export function f() { let v = [1, 2]; v = [3, 4]; return v[0] + v[1]; }",
        );
        assert_eq!(n, 0, "reassigned-as-whole let aggregate left intact:\n{out}");
        assert!(out.contains("let v = [1, 2]"), "decl preserved:\n{out}");
        assert!(out.contains("v = [3, 4]"), "reassignment preserved:\n{out}");
        assert!(out.contains("v[0] + v[1]"), "accesses preserved:\n{out}");
    }

    // ── module scratch (GlobalOpt-localize fused into SROA) ──────────────────

    const ADD3: &str =
        "/* @inline */ function add3(o, a, b) { o[0]=a[0]+b[0]; o[1]=a[1]+b[1]; o[2]=a[2]+b[2]; }\n";

    #[test]
    fn module_scratch_single_owner_scalarized() {
        let out = inline_then_sroa(&format!(
            "{ADD3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function foo(out, a, b) {{ add3(_s,a,b); add3(out,_s,a); return out; }}"
        ));
        assert!(out.contains("_s_0") && out.contains("_s_1") && out.contains("_s_2"), "scalars:\n{out}");
        assert!(!out.contains("const _s"), "module const deleted:\n{out}");
        // No local aggregate materialized (no per-call allocation / self-prank).
        assert!(!out.contains("[0, 0, 0]") && !out.contains("[0,0,0]"), "no local aggregate:\n{out}");
    }

    #[test]
    fn module_scratch_multi_owner_bailed() {
        // A second reader → not single-owner → left as a module const (no self-prank).
        let out = inline_then_sroa(&format!(
            "{ADD3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function foo(out, a, b) {{ add3(_s,a,b); add3(out,_s,a); return out; }}\n\
             export function other() {{ return _s[0]; }}"
        ));
        assert!(out.contains("const _s = ["), "module const preserved:\n{out}");
        assert!(!out.contains("_s_0"), "not scalarized:\n{out}");
    }

    #[test]
    fn module_scratch_read_before_write_bailed() {
        // `out[0]=_s[0]` before any write of `_s[0]` → killed-on-entry fails.
        let out = inline_then_sroa(&format!(
            "{ADD3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function foo(out, a, b) {{ out[0]=_s[0]; add3(_s,a,b); return out; }}"
        ));
        assert!(out.contains("const _s = ["), "module const preserved:\n{out}");
        assert!(!out.contains("_s_0"), "not scalarized:\n{out}");
    }

    #[test]
    fn module_scratch_escape_bailed() {
        // `_s` passed as a bare argument to a non-inlined call escapes.
        let out = inline_then_sroa(&format!(
            "{ADD3}function sink(x) {{ return x; }}\n\
             const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function foo(out, a, b) {{ add3(_s,a,b); sink(_s); add3(out,_s,a); return out; }}"
        ));
        assert!(out.contains("const _s = ["), "module const preserved:\n{out}");
        assert!(!out.contains("_s_0"), "not scalarized:\n{out}");
    }

    #[test]
    fn module_scratch_local_alias_scalarized() {
        // v2 alias-following: `const s = _scratch; …s[i]…` scalarizes `s`; BOTH the
        // alias decl and the module const are deleted.
        let out = inline_then_sroa(&format!(
            "{ADD3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function foo(out, a, b) {{ const s = _s; add3(s,a,b); add3(out,s,a); return out; }}"
        ));
        assert!(out.contains("s_0") && out.contains("s_1") && out.contains("s_2"), "alias scalarized:\n{out}");
        assert!(!out.contains("const _s"), "module const deleted:\n{out}");
        assert!(!out.contains("const s = _s"), "alias decl deleted:\n{out}");
    }

    #[test]
    fn module_scratch_trailing_impure_call_scalarized() {
        // v2 window: an impure call AFTER the scratch's last use can't clobber it →
        // scalarizes (the pre-v2 guard bailed on any impure call after first write).
        let out = inline_then_sroa(&format!(
            "{ADD3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function foo(out, a, b) {{ add3(_s,a,b); add3(out,_s,a); ext(); return out; }}"
        ));
        assert!(out.contains("_s_0"), "scalarized despite trailing call:\n{out}");
        assert!(!out.contains("const _s"), "module const deleted:\n{out}");
    }

    const SET3: &str =
        "/* @inline */ function set3(o, a, b, c) { o[0]=a; o[1]=b; o[2]=c; }\n";

    #[test]
    fn scratch_optional_chain_read_bailed() {
        // `v?.[i]` parses as a member wrapped in a ChainExpression that AccessRewriter
        // doesn't descend into — the analysis would accept it but the rewrite would
        // leave it dangling on the deleted binding (ReferenceError). Bail. Adversarial
        // review; shared escape check → covers module-scratch AND local SROA.
        let (out, n) =
            sroa("/* @optimize */ export function f(x) { const v = [x, x]; return v?.[0] + v[1]; }");
        assert_eq!(n, 0, "optional-chain member not scalarized:\n{out}");
        let mod_out = inline_then_sroa(
            "const _s = /*@__PURE__*/ [0,0];\n\
             /* @optimize */ export function f(x) { _s[0]=x; return _s?.[0] + _s[1]; }",
        );
        assert!(mod_out.contains("const _s"), "module scratch preserved (optional):\n{mod_out}");
    }

    #[test]
    fn scratch_delete_member_bailed() {
        // `delete v[i]` removes the element — scalarizing to `delete v_i` (a `let`)
        // changes behavior / is a strict-mode SyntaxError. Bail. Adversarial review;
        // shared escape check, so covers module-scratch AND plain local SROA.
        let mod_out = inline_then_sroa(
            "const _s = /*@__PURE__*/ [0,0];\n\
             /* @optimize */ export function f(p) { _s[0]=p; delete _s[0]; return _s[0]; }",
        );
        assert!(mod_out.contains("const _s"), "module scratch preserved (delete):\n{mod_out}");
        assert!(!mod_out.contains("_s_0"), "not scalarized:\n{mod_out}");
        // Plain local SROA path (same helper):
        let (loc_out, n) =
            sroa("/* @optimize */ function f(p) { const v = [p, p]; delete v[0]; return v[0] + v[1]; }");
        assert_eq!(n, 0, "local aggregate not scalarized (delete):\n{loc_out}");
    }

    #[test]
    fn module_scratch_loop_body_confined_scalarized() {
        // v2 confinement: a per-iteration scratch confined to a loop body scalarizes
        // (killed-on-entry within each iteration). The canonical crashcat kernel.
        let out = inline_then_sroa(&format!(
            "{SET3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function f(out, a, b, n) {{ \
             for (let i=0;i<n;i++) {{ set3(_s, a, b, a); out[i]=_s[0]+_s[1]+_s[2]; }} return out; }}"
        ));
        assert!(out.contains("_s_0"), "loop-body scratch scalarized:\n{out}");
        assert!(!out.contains("const _s"), "module const deleted:\n{out}");
    }

    #[test]
    fn module_scratch_single_if_branch_confined_scalarized() {
        let out = inline_then_sroa(&format!(
            "{SET3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function f(out, a, b, n) {{ \
             if (n>0) {{ set3(_s, a, b, a); out[0]=_s[0]+_s[1]+_s[2]; }} return out; }}"
        ));
        assert!(out.contains("_s_0"), "if-branch scratch scalarized:\n{out}");
        assert!(!out.contains("const _s"), "module const deleted:\n{out}");
    }

    #[test]
    fn module_scratch_loop_read_before_write_bailed() {
        // Read of a field before its write WITHIN the iteration → reads the prior
        // iteration's value; per-call scalars wouldn't reproduce it. Bail.
        let out = inline_then_sroa(&format!(
            "{SET3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function f(out, a, b, n) {{ \
             for (let i=0;i<n;i++) {{ out[i]=_s[0]; set3(_s, a, b, a); }} return out; }}"
        ));
        assert!(out.contains("const _s"), "module const preserved (read-before-write):\n{out}");
        assert!(!out.contains("_s_0"), "not scalarized:\n{out}");
    }

    #[test]
    fn module_scratch_both_if_branches_scalarized() {
        // v3 (CFG must-reaching): both arms write ALL fields, so at the merge every
        // read field is must-written on all paths → scalarizes. (Was a v2 over-bail.)
        let out = inline_then_sroa(&format!(
            "{SET3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function f(out, a, b, n) {{ \
             if (n>0) {{ set3(_s,a,b,a); }} else {{ set3(_s,b,a,b); }} out[0]=_s[0]+_s[1]+_s[2]; return out; }}"
        ));
        assert!(out.contains("_s_0"), "both-branches scratch scalarized:\n{out}");
        assert!(!out.contains("const _s"), "module const deleted:\n{out}");
    }

    #[test]
    fn module_scratch_switch_dispatch_scalarized() {
        // v3 (CFG): a switch where every case writes all read fields (the crashcat
        // `getSupport` shape) scalarizes — the CFG models switch uniformly.
        let out = inline_then_sroa(&format!(
            "{SET3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function f(out, a, b, k) {{ \
             switch (k) {{ case 0: {{ set3(_s,a,b,a); break; }} case 1: {{ set3(_s,b,a,b); break; }} \
             default: {{ set3(_s,a,a,a); }} }} out[0]=_s[0]+_s[1]+_s[2]; return out; }}"
        ));
        assert!(out.contains("_s_0"), "switch scratch scalarized:\n{out}");
        assert!(!out.contains("const _s"), "module const deleted:\n{out}");
    }

    #[test]
    fn module_scratch_for_header_use_bailed() {
        // Adversarial review (CFG): a scratch read/write hidden in a for-init/-update
        // becomes an unattributable bare-expression CFG node → bail. Read variant
        // (returns 7 in source, undefined if wrongly scalarized) and write variant.
        let read = inline_then_sroa(
            "const _s = /*@__PURE__*/ [7,0,0];\n\
             /* @optimize */ export function f(out) { for (let i=0;i<1;(out[0]=_s[0], i++)) {} }",
        );
        assert!(read.contains("const _s"), "for-update read bailed:\n{read}");
        let write = inline_then_sroa(
            "const _s = /*@__PURE__*/ [0,0];\n\
             /* @optimize */ export function f(out) { for (let i=0;i<3;_s[0]=i,i++) {} out[0]=_s[0]; }",
        );
        assert!(write.contains("const _s"), "for-update write bailed:\n{write}");
    }

    #[test]
    fn module_scratch_for_header_reentrant_call_bailed() {
        // Adversarial review (CFG): a re-entrant call in the for-init/-update slot
        // doesn't mention the scratch, so the mention-bail misses it — but it can
        // clobber the shared buffer between a write and a read. The loop-head node
        // must be flagged re-entrant. (source 208 vs compiled 30 if wrongly scalarized)
        let update = inline_then_sroa(
            "const _s = /*@__PURE__*/ [0,0];\n\
             /* @optimize */ export function f(a, n) { _s[1]=a; let r=0; for (let i=0;i<n;g()) { r+=_s[1]; i++; } return r; }",
        );
        assert!(update.contains("const _s"), "reentrant for-update bailed:\n{update}");
        let init = inline_then_sroa(
            "const _s = /*@__PURE__*/ [0,0];\n\
             /* @optimize */ export function f(a) { _s[1]=a; let r=0; for (g(); r<1; r++) { r+=_s[1]; } return r; }",
        );
        assert!(init.contains("const _s"), "reentrant for-init bailed:\n{init}");
    }

    #[test]
    fn module_scratch_try_body_bailed() {
        // `cfg::build` bails on `try` (exceptional control flow) → killed_on_entry
        // returns false → not scalarized. Sound.
        let out = inline_then_sroa(&format!(
            "{SET3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function f(out, a, b) {{ \
             try {{ set3(_s,a,b,a); out[0]=_s[0]+_s[1]+_s[2]; }} catch (e) {{}} return out; }}"
        ));
        assert!(out.contains("const _s"), "module const preserved (try):\n{out}");
    }

    #[test]
    fn module_scratch_partial_branch_write_bailed() {
        // One arm writes only SOME of the fields read after → NOT must-written on all
        // paths → must bail (soundness of the CFG merge).
        let out = inline_then_sroa(&format!(
            "{SET3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function f(out, a, b, n) {{ \
             if (n>0) {{ set3(_s,a,b,a); }} else {{ _s[0]=b; }} out[0]=_s[0]+_s[1]+_s[2]; return out; }}"
        ));
        assert!(out.contains("const _s"), "module const preserved (partial branch):\n{out}");
        assert!(!out.contains("_s_0"), "not scalarized:\n{out}");
    }

    #[test]
    fn object_scratch_proto_field_bailed() {
        // `{ __proto__: v }` (colon form) sets the prototype, creates NO own property;
        // scalarizing `_s.__proto__` would diverge. Bail (shared SROA helper).
        // Adversarial completeness review.
        let out = sroa(
            "const _s = /*@__PURE__*/ { __proto__: 0, x: 0 };\n\
             /* @optimize */ export function f(p, q) { _s.__proto__ = p; _s.x = q; return _s.x; }",
        )
        .0;
        assert!(out.contains("__proto__"), "proto-form object not scalarized:\n{out}");
        assert!(!out.contains("_s_x"), "not scalarized:\n{out}");
    }

    #[test]
    fn module_scratch_block_scope_shadow_bailed() {
        // Adversarial review (v2): a block-scoped `const v = q` shadow of the alias
        // name is a DISTINCT variable — the name-based rewriter must not hijack its
        // `v[0]`. `fn_depth` missed block scopes; the re-binding count catches it.
        let out = inline_then_sroa(
            "const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function f(p, q, c) { const v = _s; v[0]=p; v[1]=p; v[2]=p; \
             let out = v[0]+v[1]+v[2]; if (c) { const v = q; out += v[0]; } return out; }",
        );
        assert!(out.contains("const _s"), "module const preserved (shadow):\n{out}");
        assert!(!out.contains("v_0"), "not scalarized (shadow):\n{out}");
    }

    #[test]
    fn module_scratch_wrapped_reentrant_call_bailed() {
        // Adversarial review (v2): a tagged template / optional call re-enters the
        // owner but isn't a `CallExpression` node — the guard must still fire.
        let tagged = inline_then_sroa(
            "const _s = /*@__PURE__*/ [0,0];\n\
             /* @optimize */ export function owner(x, tag) { _s[0]=x; tag``; return _s[0]; }",
        );
        assert!(!tagged.contains("_s_0"), "tagged-template re-entry not scalarized:\n{tagged}");
        let optional = inline_then_sroa(
            "const _s = /*@__PURE__*/ [0,0];\n\
             /* @optimize */ export function owner(x, f) { _s[0]=x; f?.(); return _s[0]; }",
        );
        assert!(!optional.contains("_s_0"), "optional-call re-entry not scalarized:\n{optional}");
    }

    #[test]
    fn module_scratch_scalar_name_collision_bailed() {
        // A local named like a generated scalar (`_s_0`) must NOT be merged with it
        // (would corrupt values / crash on a const reassignment). Adversarial review.
        let out = inline_then_sroa(&format!(
            "{ADD3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function foo(out, a, b) {{ let _s_0 = a[0]*100; add3(_s,a,b); return _s[0]+_s[1]+_s[2]+_s_0; }}"
        ));
        assert!(out.contains("const _s = ["), "module const preserved:\n{out}");
        // The pre-existing `_s_0` local must survive with its own initializer.
        assert!(out.contains("* 100") || out.contains("*100"), "collided local preserved:\n{out}");
    }

    #[test]
    fn module_scratch_alias_captured_in_closure_bailed() {
        // Self-review regression: an ALIAS captured in a returned/stored closure
        // observes the shared buffer across calls — per-call scalars would diverge.
        // The symbol gate sees the same symbol, so a nested-function capture guard is
        // required (direct scratches get this free via single-owner).
        let out = inline_then_sroa(&format!(
            "{ADD3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function f(a, b) {{ const s = _s; add3(s,a,b); return () => s[0]+s[1]+s[2]; }}"
        ));
        assert!(out.contains("const _s"), "module const preserved (alias capture):\n{out}");
        assert!(!out.contains("s_0"), "not scalarized (alias capture):\n{out}");
    }

    #[test]
    fn module_scratch_nested_scope_shadow_bailed() {
        // A nested closure whose param shadows the scratch name must NOT have its
        // accesses hijacked by the scalarizer. Adversarial review.
        let out = inline_then_sroa(&format!(
            "{ADD3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function foo(out, a, b) {{ add3(_s,a,b); return (_s) => _s[0]+_s[1]+_s[2]; }}"
        ));
        assert!(out.contains("const _s = ["), "module const preserved:\n{out}");
        assert!(!out.contains("_s_0"), "not scalarized (nested shadow):\n{out}");
    }

    #[test]
    fn module_scratch_reentrant_call_bailed() {
        // An opaque impure call after the first write could transitively re-enter
        // the owner and clobber the shared buffer; the per-call scalars wouldn't
        // reproduce that, so bail (mutual/indirect recursion guard).
        let out = inline_then_sroa(&format!(
            "{ADD3}const _s = /*@__PURE__*/ [0,0,0];\n\
             /* @optimize */ export function foo(out, a, b) {{ add3(_s,a,b); ext(); out[0]=_s[0]; return out; }}"
        ));
        assert!(out.contains("const _s = ["), "module const preserved:\n{out}");
        assert!(!out.contains("_s_0"), "not scalarized:\n{out}");
    }

    #[test]
    fn module_scratch_unannotated_owner_bailed() {
        // Owner not `@optimize`/`@sroa` → opt-in not satisfied.
        let out = inline_then_sroa(&format!(
            "{ADD3}const _s = /*@__PURE__*/ [0,0,0];\n\
             export function foo(out, a, b) {{ add3(_s,a,b); add3(out,_s,a); return out; }}"
        ));
        assert!(out.contains("const _s = ["), "module const preserved:\n{out}");
        assert!(!out.contains("_s_0"), "not scalarized:\n{out}");
    }
}
