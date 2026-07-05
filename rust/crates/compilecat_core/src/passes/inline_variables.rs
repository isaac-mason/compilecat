//! Port of `src/compiler/inline-variables.ts` (Closure InlineVariables subset).
//! **First pass on `oxc_semantic`** — needs per-symbol reference analysis.
//!
//! Three paths:
//!   1. single-use pure inline — `const x = <pure>; … x …` (one read) →
//!      replace the read with the init, drop the declarator.
//!   2. multi-use immutable inline — `const K = 42; … K … K …` → clone the
//!      literal into each read, drop the declarator.
//!   3. alias inline — `const b = a; … b … b …` where `a` is a **bare
//!      identifier** resolving to a local/param that is never reassigned and
//!      `b` is never reassigned → rewrite every read of `b` to `a`, drop the
//!      declarator. Unlike value inlining this is loop-safe (the aliased
//!      binding is stable). The scope/shadow check (see `try_alias`) makes it
//!      sound: every read site must resolve `a` to the *same* SymbolId.
//!
//! Semantic borrows the AST immutably, so we **analyze then mutate**: build
//! `Semantic`, collect owned edits (cloned inits keyed by read-site span +
//! declarator spans to drop), drop `Semantic`, then apply with a span-keyed
//! `VisitMut`. Iterates to fixpoint (one inline can drop another's ref count
//! or unblock an alias chain `a → b → c`).
//!
//! Deferred (TODO): inits referencing globals (we treat only reassigned
//! *local* names as unstable; unresolved globals are not inlined either);
//! destructuring/multi-declarator decls.

use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::ast::*;
use oxc_ast::{AstBuilder, AstKind};
use oxc_ast_visit::{walk_mut, Visit, VisitMut};
use oxc_semantic::{NodeId, SemanticBuilder};

use super::util::is_pure;

pub fn run<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> u32 {
    run_with(allocator, program, super::gate::Gate::ungated())
}

pub fn run_with<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    gate: super::gate::Gate,
) -> u32 {
    let mut total = 0;
    loop {
        let n = sweep(allocator, program, &gate);
        if n == 0 {
            break;
        }
        total += n;
    }
    total
}

fn sweep<'a>(allocator: &'a Allocator, program: &mut Program<'a>, gate: &super::gate::Gate) -> u32 {
    // Keyed by `NodeId` (unique per node, set by semantic) — NOT span:
    // compiler-generated nodes (sroa scalars, inline temps) share `SPAN(0,0)`,
    // so span identity collides and corrupts. `node_id` is collision-free.
    let mut replacements: HashMap<NodeId, Expression<'a>> = HashMap::new();
    let mut drop_decls: HashSet<NodeId> = HashSet::new();

    {
        let semantic = SemanticBuilder::new().build(&*program).semantic;
        let scoping = semantic.scoping();
        let nodes = semantic.nodes();

        // Names of reassigned symbols — an init that reads one is unstable.
        let mut written_names: HashSet<&str> = HashSet::new();
        for sym in scoping.symbol_ids() {
            if scoping.get_resolved_references(sym).any(|r| r.is_write()) {
                written_names.insert(scoping.symbol_name(sym));
            }
        }

        // Local names re-exported via a bare `export { X }` specifier (no
        // `from` source). These are public bindings — never inline them away
        // (see the export guard below). `export const X`/`export function X`
        // are caught structurally; this covers the specifier form esbuild and
        // crashcat emit.
        let exported_names = collect_exported_names(program);

        // Pass 1: collect eligible candidates (name, decl, reads, the names its
        // init references) — without applying yet.
        struct Cand {
            name: String,
            decl_id: NodeId,
            reads: Vec<NodeId>,
            init_refs: HashSet<String>,
        }
        let mut cands: Vec<Cand> = Vec::new();

        for sym in scoping.symbol_ids() {
            let decl_id = scoping.symbol_declaration(sym);
            let AstKind::VariableDeclarator(decl) = nodes.kind(decl_id) else { continue };
            let Some(init) = &decl.init else { continue };

            // Only simple `const name = init` declarators. A destructuring
            // pattern (`const [a, b] = arr`, `const { x } = o`) gives each of its
            // bindings the SAME declarator, whose `init` is the whole RHS — so
            // treating one as an alias of `init` would substitute the aggregate
            // for the element (`const [a] = arr; …a…` → `…arr…`), a miscompile.
            // Only bare identifiers are handled.
            if !matches!(decl.id, BindingPattern::BindingIdentifier(_)) {
                continue;
            }

            let AstKind::VariableDeclaration(vd) = nodes.parent_kind(decl_id) else { continue };
            if !matches!(vd.kind, VariableDeclarationKind::Const | VariableDeclarationKind::Let) {
                continue;
            }
            // Never strip an exported binding. Two forms:
            //   1. `export const X = …` — the declaration *is* the export.
            //   2. `const X = …; export { X }` — a separate specifier re-exports
            //      it (this is what esbuild lowers `export const` to, and what
            //      crashcat ships). The binding's name is in `exported_names`.
            // R3 (REMAINING_WORK §4): an exported module constant
            // (`EMPTY_SUB_SHAPE_ID`, `MAX_SUB_SHAPE_ID_BITS`) is a named, public
            // constant — value-propagating it into use sites destroys authored
            // intent. The `export { X }` reference is not a plain read, so its
            // multi-use inline bails.
            // Donor-private consts (cross-file `@inline`) are NOT exported, so
            // they still fold — no regression there.
            if matches!(
                nodes.parent_kind(nodes.parent_id(decl_id)),
                AstKind::ExportNamedDeclaration(_)
            ) {
                continue;
            }
            if exported_names.contains(scoping.symbol_name(sym)) {
                continue;
            }
            // Reassigned (a write reference) → not inlineable.
            if scoping.get_resolved_references(sym).any(|r| r.is_write()) {
                continue;
            }

            let reads: Vec<NodeId> = scoping
                .get_resolved_references(sym)
                .filter(|r| r.is_read())
                .map(|r| r.node_id())
                .collect();

            let eligible = match reads.len() {
                1 => {
                    is_pure(init)
                        && !contains_property_read(init)
                        && init_stable(init, &written_names)
                        && single_use_safe(nodes, decl_id, reads[0], init)
                }
                n if n > 1 => {
                    (is_primitive_literal(init)
                        && reads.iter().all(|&u| !def_is_conditional(nodes, decl_id, u)))
                        // Path 3: alias inline (multi-use bare-ident alias of a
                        // stable local/param). Loop-safe, so no def_is_conditional
                        // / loop gating — the aliased binding never changes.
                        || try_alias(scoping, nodes, sym, init, &reads)
                }
                _ => false,
            };
            if eligible {
                cands.push(Cand {
                    name: scoping.symbol_name(sym).to_string(),
                    decl_id,
                    reads,
                    init_refs: ident_names(init),
                });
            }
        }

        // Pass 2: apply only candidates whose init does NOT reference another
        // candidate being dropped this sweep — interdependent inlines in one
        // batch would corrupt (the captured value still names the dropped var).
        // The fixpoint loop picks up the deferred ones next sweep.
        let dropping: HashSet<&str> = cands.iter().map(|c| c.name.as_str()).collect();
        for c in &cands {
            if c.init_refs.iter().any(|n| dropping.contains(n.as_str())) {
                continue;
            }
            let AstKind::VariableDeclarator(decl) = nodes.kind(c.decl_id) else { continue };
            let Some(init) = &decl.init else { continue };
            for &use_id in &c.reads {
                replacements.insert(use_id, init.clone_in(allocator));
            }
            drop_decls.insert(c.decl_id);
        }
    }

    if replacements.is_empty() && drop_decls.is_empty() {
        return 0;
    }

    let mut app = Applier {
        ast: AstBuilder::new(allocator),
        replacements,
        drop_decls,
        gate: gate.clone(),
        count: 0,
    };
    app.visit_program(program);
    app.count
}

// ── apply ───────────────────────────────────────────────────────────────────

struct Applier<'a> {
    ast: AstBuilder<'a>,
    replacements: HashMap<NodeId, Expression<'a>>,
    drop_decls: HashSet<NodeId>,
    gate: super::gate::Gate,
    count: u32,
}

impl<'a> VisitMut<'a> for Applier<'a> {
    fn visit_function(&mut self, func: &mut Function<'a>, flags: oxc_semantic::ScopeFlags) {
        let s = self.gate.enter_fn(func.span.start);
        walk_mut::walk_function(self, func, flags);
        self.gate.exit(s);
    }
    fn visit_arrow_function_expression(&mut self, arrow: &mut ArrowFunctionExpression<'a>) {
        let s = self.gate.enter_fn(arrow.span.start);
        walk_mut::walk_arrow_function_expression(self, arrow);
        self.gate.exit(s);
    }

    fn visit_statement(&mut self, stmt: &mut Statement<'a>) {
        let s = self.gate.enter_scope(oxc_span::GetSpan::span(stmt).start);
        walk_mut::walk_statement(self, stmt);
        self.gate.exit(s);
    }

    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        if self.gate.active {
            if let Expression::Identifier(id) = &*expr {
                if let Some(rep) = self.replacements.remove(&id.node_id.get()) {
                    *expr = rep;
                    self.count += 1;
                    return;
                }
            }
        }
        walk_mut::walk_expression(self, expr);
    }

    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts);
        if !self.gate.active || self.drop_decls.is_empty() {
            return;
        }
        let taken = std::mem::replace(stmts, self.ast.vec());
        let mut out = self.ast.vec_with_capacity(taken.len());
        for stmt in taken {
            if let Statement::VariableDeclaration(mut vd) = stmt {
                // Drop the inlined *declarators*; keep the rest of a
                // `let a, b, c` group. Remove the whole statement only when
                // every declarator went.
                if vd.declarations.iter().any(|d| self.drop_decls.contains(&d.node_id.get())) {
                    let decls = std::mem::replace(&mut vd.declarations, self.ast.vec());
                    let mut kept = self.ast.vec();
                    for d in decls {
                        if self.drop_decls.contains(&d.node_id.get()) {
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
            } else {
                out.push(stmt);
            }
        }
        *stmts = out;
    }
}

// ── path 3: alias inline ─────────────────────────────────────────────────────

/// Return the `NodeId` of the innermost `Function` or `ArrowFunctionExpression`
/// that encloses `node`, or `None` if `node` is at module scope.
fn enclosing_fn_id(nodes: &oxc_semantic::AstNodes, node: NodeId) -> Option<NodeId> {
    for anc in nodes.ancestor_ids(node) {
        match nodes.kind(anc) {
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => return Some(anc),
            _ => {}
        }
    }
    None
}

/// `const/let b = a` (where `a` is a bare identifier) used N>1 times, safe to
/// rewrite every read of `b` to `a` and drop the declarator. SOUNDNESS is
/// paramount; this bails on anything it cannot prove. Five guards:
///
///   1. RHS must be a **bare identifier** resolving to a real binding (param or
///      local) — NOT a member expression, not a global. A member init (e.g.
///      `body.linearVelocity`) is rejected: relocating a property read is
///      unsound (see path-1 `contains_property_read`).
///   2. The **aliased** binding `a` must never be reassigned (no write refs) —
///      else later reads of `b` would see a stale value vs. the rewritten `a`.
///   3. The **alias** binding `b` must never be reassigned. (The caller already
///      filters out symbols with any write reference, so `b` is write-free by
///      construction; we don't re-check here — but the candidate gate enforces
///      it.)
///   4. At EVERY read site of `b`, the name `a` must resolve to the SAME
///      SymbolId as at the declaration. If an intervening nested scope shadows
///      `a`, rewriting `b → a` there would capture the wrong binding — BAIL.
///   5. Every read site must be in the **same enclosing function** as the
///      declaration. The `Applier` uses a per-function gate that resets at each
///      function boundary; if any read is in a nested function that the gate
///      skips, the read won't be rewritten — but `visit_statements` will still
///      drop the declarator (gate active in the outer function). That leaves `b`
///      referenced but undefined → ReferenceError. Bail on any cross-function
///      read.
fn try_alias(
    scoping: &oxc_semantic::Scoping,
    nodes: &oxc_semantic::AstNodes,
    alias_sym: oxc_semantic::SymbolId,
    init: &Expression,
    reads: &[NodeId],
) -> bool {
    // Guard #1: RHS must be a bare identifier (reject members, literals, etc).
    let Expression::Identifier(aliased_ref) = init else { return false };

    // Resolve the aliased identifier to a concrete SymbolId. An unresolved
    // (global/unknown) reference is rejected — can't prove stability or scope.
    let Some(rid) = aliased_ref.reference_id.get() else { return false };
    let Some(aliased_sym) = scoping.get_reference(rid).symbol_id() else {
        return false;
    };

    // Self-alias guard (`const x = x`-shaped after other rewrites) — nothing to
    // gain and would loop.
    if aliased_sym == alias_sym {
        return false;
    }

    // Guard #2: the aliased binding must never be reassigned.
    if scoping.get_resolved_references(aliased_sym).any(|r| r.is_write()) {
        return false;
    }

    let aliased_name: &str = scoping.symbol_name(aliased_sym);

    // Guard #5: all reads must be in the same function as the declaration.
    // The `Applier` uses a gate that resets at each function boundary; if a
    // read is in a nested (child) function that the gate skips, the read won't
    // be substituted even though the declarator IS dropped (gate active in the
    // outer function). That mismatch leaves `b` referenced but undefined.
    let decl_fn = enclosing_fn_id(nodes, scoping.symbol_declaration(alias_sym));
    for &read_id in reads {
        if enclosing_fn_id(nodes, read_id) != decl_fn {
            return false;
        }
    }

    // Guard #4: at every read site of the alias, `aliased_name` must resolve to
    // `aliased_sym` from that read's own scope (no intervening shadow). We
    // resolve this using only public scope-tree APIs (avoids constructing an
    // arena `Ident` for `Scoping::find_binding`): walk the read's scope chain
    // outward; the nearest scope that declares `aliased_name` must declare
    // exactly `aliased_sym`. A shadow (a different symbol of the same name in a
    // closer scope) → BAIL.
    for &read_id in reads {
        let read_scope = nodes.get_node(read_id).scope_id();
        match nearest_binding(scoping, read_scope, aliased_name) {
            Some(found) if found == aliased_sym => {}
            _ => return false,
        }
    }

    true
}

/// Public-API re-implementation of `Scoping::find_binding`: the SymbolId named
/// `name` declared in `scope_id` or its nearest enclosing scope, or `None`.
fn nearest_binding(
    scoping: &oxc_semantic::Scoping,
    scope_id: oxc_semantic::ScopeId,
    name: &str,
) -> Option<oxc_semantic::SymbolId> {
    for scope in scoping.scope_ancestors(scope_id) {
        if let Some(sym) =
            scoping.iter_bindings_in(scope).find(|&s| scoping.symbol_name(s) == name)
        {
            return Some(sym);
        }
    }
    None
}

// ── analysis helpers ────────────────────────────────────────────────────────

/// Local names re-exported via a bare `export { a, b as c }` clause (no `from`
/// source). A clause *with* a source is a cross-module re-export that binds no
/// local, so it's ignored. The `local` side is the binding we must not inline.
fn collect_exported_names(program: &Program) -> HashSet<String> {
    let mut out = HashSet::new();
    for stmt in &program.body {
        if let Statement::ExportNamedDeclaration(e) = stmt {
            if e.source.is_some() {
                continue;
            }
            for spec in &e.specifiers {
                out.insert(spec.local.name().to_string());
            }
        }
    }
    out
}

fn is_primitive_literal(e: &Expression) -> bool {
    matches!(
        e,
        Expression::NumericLiteral(_)
            | Expression::StringLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::BigIntLiteral(_)
    ) || matches!(e, Expression::Identifier(id) if id.name == "undefined")
}

fn contains_property_read(e: &Expression) -> bool {
    struct V {
        found: bool,
    }
    impl<'a> Visit<'a> for V {
        fn visit_member_expression(&mut self, m: &MemberExpression<'a>) {
            self.found = true;
            let _ = m;
        }
    }
    let mut v = V { found: false };
    v.visit_expression(e);
    v.found
}

/// Unstable if the init reads a local name that is reassigned somewhere.
fn init_stable(e: &Expression, written: &HashSet<&str>) -> bool {
    struct V<'w, 'x> {
        written: &'w HashSet<&'x str>,
        unstable: bool,
    }
    impl<'a> Visit<'a> for V<'_, '_> {
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            if self.written.contains(id.name.as_str()) {
                self.unstable = true;
            }
        }
    }
    let mut v = V { written, unstable: false };
    v.visit_expression(e);
    !v.unstable
}

/// Identifier names referenced anywhere in an expression.
fn ident_names(e: &Expression) -> HashSet<String> {
    struct V {
        names: HashSet<String>,
    }
    impl<'a> Visit<'a> for V {
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            self.names.insert(id.name.to_string());
        }
    }
    let mut v = V { names: HashSet::new() };
    v.visit_expression(e);
    v.names
}

fn single_use_safe(
    nodes: &oxc_semantic::AstNodes,
    def: NodeId,
    use_: NodeId,
    init: &Expression,
) -> bool {
    if def_is_conditional(nodes, def, use_) {
        return false;
    }
    if crosses_async(nodes, def, use_) {
        return false;
    }
    if !is_primitive_literal(init) && use_in_loop_out_of_def(nodes, def, use_) {
        return false;
    }
    true
}

fn use_ancestors(nodes: &oxc_semantic::AstNodes, use_: NodeId) -> HashSet<NodeId> {
    std::iter::once(use_).chain(nodes.ancestor_ids(use_)).collect()
}

/// Def hoisted out of a conditional that doesn't enclose the use.
fn def_is_conditional(nodes: &oxc_semantic::AstNodes, def: NodeId, use_: NodeId) -> bool {
    let use_anc = use_ancestors(nodes, use_);
    for aid in nodes.ancestor_ids(def) {
        if use_anc.contains(&aid) {
            return false;
        }
        match nodes.kind(aid) {
            AstKind::IfStatement(_)
            | AstKind::SwitchCase(_)
            | AstKind::ConditionalExpression(_) => {
                return true;
            }
            AstKind::LogicalExpression(_) => return true,
            _ => {}
        }
    }
    false
}

/// Use sits inside a loop that the def is outside of.
fn use_in_loop_out_of_def(nodes: &oxc_semantic::AstNodes, def: NodeId, use_: NodeId) -> bool {
    let def_anc: HashSet<NodeId> = std::iter::once(def).chain(nodes.ancestor_ids(def)).collect();
    for aid in nodes.ancestor_ids(use_) {
        if def_anc.contains(&aid) {
            return false;
        }
        if matches!(
            nodes.kind(aid),
            AstKind::ForStatement(_)
                | AstKind::ForInStatement(_)
                | AstKind::ForOfStatement(_)
                | AstKind::WhileStatement(_)
                | AstKind::DoWhileStatement(_)
        ) {
            return true;
        }
    }
    false
}

/// Use is separated from the def by an async/generator function boundary.
fn crosses_async(nodes: &oxc_semantic::AstNodes, def: NodeId, use_: NodeId) -> bool {
    let def_anc: HashSet<NodeId> = std::iter::once(def).chain(nodes.ancestor_ids(def)).collect();
    for aid in nodes.ancestor_ids(use_) {
        if def_anc.contains(&aid) {
            return false;
        }
        match nodes.kind(aid) {
            AstKind::Function(f) if f.r#async || f.generator => return true,
            AstKind::ArrowFunctionExpression(a) if a.r#async => return true,
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;

    /// Run inline-variables (ungated, to fixpoint) and return (codegen, count).
    /// The pass is exercised unconditionally here — gating is covered separately.
    fn iv(src: &str) -> (String, u32) {
        let allocator = Allocator::default();
        let mut program = crate::parse_program(&allocator, src, SourceType::ts());
        let n = run(&allocator, &mut program);
        (Codegen::new().build(&program).code, n)
    }

    // ── inlining that fires (assert the rewritten output; counts can differ in
    //    granularity, so we check output + non-zero) ──

    #[test]
    fn inlines_single_use_literal() {
        let (out, n) = iv("const FOO = 42; console.log(FOO);");
        assert!(out.contains("console.log(42)") && !out.contains("FOO"), "{out}");
        assert!(n > 0);
    }

    #[test]
    fn inlines_through_an_alias_chain_to_fixpoint() {
        let (out, _) = iv("const a = 1; const b = a; const c = b; console.log(c);");
        assert!(out.contains("console.log(1)"), "chain collapses to the literal:\n{out}");
    }

    #[test]
    fn inlines_a_stable_identifier_then_folds_the_chain() {
        let (out, _) = iv("const g = 1; const x = g; console.log(x);");
        assert!(out.contains("console.log(1)"), "{out}");
    }

    #[test]
    fn inlines_primitive_literal_into_loop_body() {
        let (out, _) = iv("const x = true; while (cond) { use(x); }");
        assert!(out.contains("use(true)") && !out.contains("const x"), "{out}");
    }

    #[test]
    fn inlines_into_a_plain_nested_function() {
        let (out, _) = iv("const x = 1; function f() { return x; }");
        assert!(out.contains("return 1") && !out.contains("const x"), "{out}");
    }

    #[test]
    fn inlines_literal_used_as_conditional_test() {
        let (out, _) = iv("const a = 1; const r = a ? 'yes' : 'no'; use(r);");
        assert!(out.contains("use(1 ? \"yes\" : \"no\")"), "{out}");
    }

    #[test]
    fn keeps_specifier_exported_module_const() {
        // R3 (REMAINING_WORK §4): a const re-exported via `export { X }` (the form
        // esbuild lowers `export const` to) is a public named constant — never
        // value-propagated (its `export {}` ref isn't a plain read, so multi-use
        // inline bails). This is what keeps `EMPTY_SUB_SHAPE_ID`
        // named across sub-shape.ts.
        let (out, n) = iv("const K = 4294967295; export { K };\nfunction f() { return K === K; }");
        assert!(out.contains("const K = 4294967295"), "exported const kept:\n{out}");
        assert!(out.contains("K === K"), "uses not value-propagated:\n{out}");
        assert_eq!(n, 0, "no inline of a re-exported const:\n{out}");
    }

    #[test]
    fn inlines_multi_use_const_literal_at_fn_scope() {
        let (out, _) = iv("function f() { const K = 42; return use(K) + use(K) + use(K); }");
        assert!(out.contains("use(42) + use(42) + use(42)") && !out.contains("const K"), "{out}");
    }

    #[test]
    fn alias_inlines_a_single_use_alias() {
        // The first hop of an alias chain collapses (a → originalA).
        let (out, _) =
            iv("function f(originalA) { const a = originalA; const b = a; use(b); use(b); }");
        assert!(!out.contains("const a"), "single-use alias `a` collapses:\n{out}");
    }

    // ── inlining that must NOT fire (safety / purity / scope) ──

    #[test]
    fn keeps_multi_use_member_read() {
        let (out, n) = iv("const x = obj.prop; console.log(x); console.log(x);");
        assert_eq!(n, 0, "member read not multi-use-inlined:\n{out}");
        assert!(out.contains("const x = obj.prop"));
    }

    #[test]
    fn keeps_property_read_across_a_mutation() {
        // Regression (addBroadphaseLayer): a GETPROP init must not be relocated
        // past a write to the same property — it would observe the new value.
        let (out, n) = iv("function f(o) { const i = o.n; o.n += 1; return i; }");
        assert_eq!(n, 0, "{out}");
        assert!(out.contains("const i = o.n") && out.contains("return i"));
    }

    #[test]
    fn keeps_impure_init() {
        let (out, n) = iv("const x = sideEffect(); console.log(x);");
        assert_eq!(n, 0, "{out}");
        assert!(out.contains("sideEffect()"));
    }

    #[test]
    fn keeps_reassigned_let() {
        let (out, n) = iv("let x = 1; x = 2; console.log(x);");
        assert_eq!(n, 0, "{out}");
    }

    #[test]
    fn keeps_exported_binding() {
        let (out, n) = iv("export const x = 1;");
        assert_eq!(n, 0, "{out}");
        assert!(out.contains("export const x = 1"));
    }

    #[test]
    fn does_not_inline_across_async_or_generator_boundary() {
        let (a, na) = iv("const x = 1; async function f() { return x; }");
        assert_eq!(na, 0, "no inline into async fn:\n{a}");
        let (g, ng) = iv("const x = 1; function* gen() { yield x; }");
        assert_eq!(ng, 0, "no inline into generator:\n{g}");
    }

    #[test]
    fn does_not_inline_var_out_of_a_conditional_branch() {
        let (out, n) = iv("if (cond) { var x = 1; } console.log(x);");
        assert_eq!(n, 0, "def may not have executed before the use:\n{out}");
        assert!(out.contains("var x = 1"));
    }

    // ── documented conservative cases (SAFE — no wrong output, just a missed
    //    optimization). Flip + update if fixed. ──

    #[test]
    fn intentional_keeps_single_use_object_literal() {
        // The pass leaves the heap-allocating literal bound rather than inlining
        // `console.log({ a: 1, b: 2 })`. Missed optimization, not a bug.
        let (out, n) = iv("const o = { a: 1, b: 2 }; console.log(o);");
        assert_eq!(n, 0, "object literal currently NOT inlined:\n{out}");
        assert!(out.contains("const o ="));
    }

    // ── path 3: alias inline ──

    #[test]
    fn alias_inlines_multi_use_alias_to_param() {
        // `const a = originalA; const b = a; use(b); use(b)` collapses all the
        // way to `use(originalA)` over fixpoint iterations: `a` is single-use
        // (path 1), then `b` is a multi-use bare-ident alias of a stable param
        // (path 3). Was previously kept (`conservative_keeps_multi_use_alias_to_param`).
        let (out, _) =
            iv("function f(originalA) { const a = originalA; const b = a; use(b); use(b); }");
        assert!(out.contains("use(originalA)"), "alias chain collapses to param:\n{out}");
        assert!(!out.contains("const b"), "alias decl dropped:\n{out}");
        assert!(!out.contains("const a"), "intermediate alias dropped:\n{out}");
    }

    #[test]
    fn alias_inlines_crashcat_loop_shape() {
        // crashcat shape: `_lv = body.linearVelocity` (member init — guard #1
        // keeps it), then `alias = _lv` (bare-ident alias of a stable local,
        // multi-use, never reassigned) collapses INTO the loop body. Alias
        // inlining a stable binding into a loop is sound (unlike value inline).
        let (out, _) = iv(
            "function f(body) { const _lv = body.linearVelocity; \
             for (let i = 0; i < 3; i++) { let alias = _lv; alias[0] += 1; alias[1] += 1; } }",
        );
        assert!(out.contains("const _lv = body.linearVelocity"), "member init kept:\n{out}");
        assert!(out.contains("_lv[0] += 1") && out.contains("_lv[1] += 1"), "alias collapsed:\n{out}");
        assert!(!out.contains("alias"), "alias decl dropped:\n{out}");
    }

    // ── path 3: soundness guards (each must NOT alias-inline) ──

    #[test]
    fn guard_keeps_array_destructuring_alias() {
        // Regression (found by the WS-B0 differential sweep): a destructuring
        // declarator gives each binding the SAME declarator whose `init` is the
        // whole RHS. Treating `const [rX, rY, rZ] = p` as an alias of `p` would
        // substitute the aggregate for each element (`rZ` → `p`), a miscompile.
        let (out, n) = iv(
            "function f(p) { const [rX, rY, rZ] = p; return rX * rY + rZ; }",
        );
        assert_eq!(n, 0, "destructuring binding must not alias-inline:\n{out}");
        assert!(out.contains("rX * rY + rZ"), "element refs preserved:\n{out}");
        assert!(out.contains("const [rX, rY, rZ] = p"), "declarator kept:\n{out}");
    }

    #[test]
    fn guard_keeps_object_destructuring_alias() {
        let (out, n) = iv("function f(o) { const { a } = o; return a + a; }");
        assert_eq!(n, 0, "object destructuring must not alias-inline:\n{out}");
        assert!(out.contains("const { a } = o"), "declarator kept:\n{out}");
    }

    #[test]
    fn guard1_keeps_member_init_alias() {
        // Guard #1: RHS is a member expression, not a bare identifier. Relocating
        // a property read is unsound (it may be mutated between def and uses).
        let (out, n) = iv("function f(body) { const v = body.linearVelocity; v[0] += 1; v[1] += 1; }");
        assert_eq!(n, 0, "member-init alias not inlined:\n{out}");
        assert!(out.contains("const v = body.linearVelocity"), "{out}");
    }

    #[test]
    fn guard2_keeps_alias_to_reassigned_binding() {
        // Guard #2: the aliased binding `y` is reassigned somewhere → reads of
        // `x` after the reassignment would see a stale value vs. rewritten `y`.
        let (out, n) = iv("function f() { let y = 1; y = 2; const x = y; use(x); use(x); }");
        assert_eq!(n, 0, "alias to reassigned binding kept:\n{out}");
        assert!(out.contains("const x = y"), "{out}");
    }

    #[test]
    fn guard3_keeps_reassigned_alias() {
        // Guard #3: the alias `x` itself is reassigned → not a stable alias.
        // (Enforced by the candidate gate: any write reference disqualifies.)
        let (out, n) = iv("function f(y) { let x = y; x = 5; use(x); use(x); }");
        assert_eq!(n, 0, "reassigned alias kept:\n{out}");
        assert!(out.contains("let x = y"), "{out}");
    }

    #[test]
    fn guard4_keeps_alias_when_use_site_shadows_aliased_name() {
        // Guard #4: a nested scope shadows `y`. Rewriting `x → y` inside `inner`
        // would bind `inner`'s param `y`, not the outer one — BAIL.
        let (out, n) = iv(
            "function f(y) { const x = y; function inner(y) { use(x); } inner(1); use(x); }",
        );
        assert_eq!(n, 0, "alias kept under shadowing use site:\n{out}");
        assert!(out.contains("const x = y"), "{out}");
    }

    #[test]
    fn guard5_keeps_alias_when_any_read_in_nested_closure() {
        // Guard #5: alias `va = v` declared in `entry`; one read is inside a
        // returned arrow closure `() => va[0]`. The Applier gate resets at the
        // arrow boundary (not opted-in) so that read would NOT be substituted, but
        // the declarator WOULD be dropped → ReferenceError. Must bail entirely.
        let (out, n) = iv(
            "const v = [0]; \
             function entry(p) { const va = v; va[0] = p; return () => va[0]; }",
        );
        // `va` must NOT be dropped — it's still used by the closure.
        assert!(out.contains("const va = v"), "alias decl kept:\n{out}");
        assert_eq!(n, 0, "no inline when read escapes into nested fn:\n{out}");
    }

    #[test]
    fn guard5_all_reads_in_same_fn_still_inlines() {
        // Regression guard: when ALL reads are in the same function as the decl,
        // guard #5 must NOT block the inline.
        let (out, _) = iv("function f(y) { const x = y; use(x); use(x); }");
        assert!(out.contains("use(y)") && !out.contains("const x"), "alias inline fires:\n{out}");
    }
}
