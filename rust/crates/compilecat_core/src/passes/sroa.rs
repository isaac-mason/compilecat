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
use oxc_ast::{AstBuilder, NONE};
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_semantic::ScopeFlags;
use oxc_span::SPAN;

use super::util::is_side_effect_free;

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
        if fields.contains(&fname) {
            return None; // duplicate key
        }
        fields.push(fname);
        inits.push(p.value.clone_in(alloc));
    }
    Some((fields, inits))
}

// ── escape analysis ─────────────────────────────────────────────────────────

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
        if let Expression::Identifier(obj) = &m.object {
            if obj.name == self.name {
                if let (Shape::Tuple(size), Expression::NumericLiteral(lit)) =
                    (self.shape, &m.expression)
                {
                    if valid_index(lit.value, *size) {
                        // Valid `v[<lit>]` — only audit the index expression,
                        // not the (accounted-for) object identifier.
                        self.visit_expression(&m.expression);
                        return;
                    }
                }
                self.bad = true; // dynamic/out-of-range index, or a record indexed
                return;
            }
        }
        walk::walk_computed_member_expression(self, m);
    }

    fn visit_static_member_expression(&mut self, m: &StaticMemberExpression<'a>) {
        if let Expression::Identifier(obj) = &m.object {
            if obj.name == self.name {
                if let Shape::Object(fields) = self.shape {
                    if fields.iter().any(|f| f == m.property.name.as_str()) {
                        return; // valid `v.field` — accounted for
                    }
                }
                self.bad = true; // unknown field, or a tuple accessed by property
                return;
            }
        }
        walk::walk_static_member_expression(self, m);
    }

    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if id.name == self.name {
            self.bad = true; // any non-member-accounted reference escapes
        }
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

// ── access rewrite ──────────────────────────────────────────────────────────

struct AccessRewriter<'a, 's> {
    ast: AstBuilder<'a>,
    shapes: &'s HashMap<String, Shape>,
}

impl<'a> AccessRewriter<'a, '_> {
    /// `v[<lit>]` → `v_<lit>` when `v` is a tuple shape and the index is in range.
    fn tuple_scalar(&self, object: &Expression<'a>, index: &Expression<'a>) -> Option<&'a str> {
        let Expression::Identifier(obj) = object else { return None };
        let Some(Shape::Tuple(size)) = self.shapes.get(obj.name.as_str()) else { return None };
        let Expression::NumericLiteral(lit) = index else { return None };
        if !valid_index(lit.value, *size) {
            return None;
        }
        Some(self.ast.allocator.alloc_str(&format!("{}_{}", obj.name, lit.value as usize)))
    }

    /// `v.field` → `v_field` when `v` is a record shape with that field.
    fn object_scalar(&self, object: &Expression<'a>, field: &str) -> Option<&'a str> {
        let Expression::Identifier(obj) = object else { return None };
        let Some(Shape::Object(fields)) = self.shapes.get(obj.name.as_str()) else { return None };
        if !fields.iter().any(|f| f == field) {
            return None;
        }
        Some(self.ast.allocator.alloc_str(&format!("{}_{}", obj.name, field)))
    }
}

impl<'a> VisitMut<'a> for AccessRewriter<'a, '_> {
    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        match &*expr {
            Expression::ComputedMemberExpression(m) => {
                if let Some(name) = self.tuple_scalar(&m.object, &m.expression) {
                    *expr = self.ast.expression_identifier(SPAN, name);
                    return;
                }
            }
            Expression::StaticMemberExpression(m) => {
                if let Some(name) = self.object_scalar(&m.object, m.property.name.as_str()) {
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
                if let Some(name) = self.tuple_scalar(&m.object, &m.expression) {
                    *target =
                        self.ast.simple_assignment_target_assignment_target_identifier(SPAN, name);
                    return;
                }
            }
            SimpleAssignmentTarget::StaticMemberExpression(m) => {
                if let Some(name) = self.object_scalar(&m.object, m.property.name.as_str()) {
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
        // The inliner now α-renames the params per expansion (`a__<id>`/`b__<id>`),
        // so SROA emits scalars named `a__<id>_x` etc. — assert both arg objects
        // are gone and both produced scalar bindings, without hardcoding the id.
        // (Eval-correctness — that no scalar is referenced-but-undeclared — is
        // covered behaviorally by equivalence.test.ts `inline-object-args-then-sroa`.)
        assert!(!run_fn.contains("x: 0"), "arg object `a` not scalarized:\n{out}");
        assert!(!run_fn.contains("x: 3"), "arg object `b` not scalarized:\n{out}");
        assert!(run_fn.contains("a__") && run_fn.contains("b__"), "both args present as scalars:\n{out}");
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
}
