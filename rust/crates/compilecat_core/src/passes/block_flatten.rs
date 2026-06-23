//! Port of Closure's `renameForFlatten` (`normalize.ts`) + `tryMergeBlock`
//! (`node-util.ts`) — the simplifier step that erases the scaffolding `{ }`
//! blocks that function inlining emits.
//!
//! `function-to-block-mutator` (BLOCK inlining) wraps each inlined callee body in
//! a `BlockStatement` purely to scope its `let p = arg;` prologue temps. This
//! pass flattens those blocks into the parent; without it the blocks survive and
//! their lexical scopes carry a (small but real) cost the inlined math doesn't
//! need.
//!
//! This pass runs per function scope, in two phases:
//!   1. **Rename** (renameForFlatten): walk every nested non-function block
//!      top-down and make each `let`/`const` name unique within the function — a
//!      binding whose base name was already seen becomes `name$N`. First seen
//!      keeps its name, so the common case stays clean (the suffix noise is
//!      absorbed by the bundler). Done on the *original* nested
//!      structure, where each binding is unambiguous.
//!   2. **Merge** (tryMergeBlock): lift every *bare* block — a `BlockStatement`
//!      sitting as an element of a statement list, not a control-flow body — up
//!      into that list. Safe now: every nested name is unique.
//!
//! The renamer is scope-accurate: it rewrites a reference only when it resolves
//! to the renamed binding — skipping any nested block / loop / catch / function
//! that re-binds the name (a shadow), but following closures that merely capture
//! it. Blocks declaring a `function`/`class` are left intact (hoisting + id
//! renaming aren't worth it for inlined math).

use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_semantic::ScopeFlags;

#[allow(dead_code)] // used by tests + kept symmetric with the other passes
pub fn run<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> u32 {
    run_with(allocator, program, super::gate::Gate::ungated())
}

pub fn run_with<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    gate: super::gate::Gate,
) -> u32 {
    let mut f = Flattener { allocator, ast: AstBuilder::new(allocator), count: 0, gate };
    if f.gate.active {
        // ungated: also flatten the program top level.
        f.flatten_scope(&mut program.body, HashSet::new());
    }
    f.visit_program(program); // recurse into functions (each its own scope)
    f.count
}

struct Flattener<'a> {
    allocator: &'a Allocator,
    ast: AstBuilder<'a>,
    count: u32,
    gate: super::gate::Gate,
}

// The walk only establishes per-function scopes; the merging is the manual
// recursion in `flatten_scope` (which needs the containing statement list).
impl<'a> VisitMut<'a> for Flattener<'a> {
    fn visit_function(&mut self, func: &mut Function<'a>, flags: ScopeFlags) {
        let s = self.gate.enter_fn(func.span.start);
        if self.gate.active {
            if let Some(body) = &mut func.body {
                let seed = param_names(&func.params);
                self.flatten_scope(&mut body.statements, seed);
            }
        }
        walk_mut::walk_function(self, func, flags);
        self.gate.exit(s);
    }

    fn visit_arrow_function_expression(&mut self, arrow: &mut ArrowFunctionExpression<'a>) {
        let s = self.gate.enter_fn(arrow.span.start);
        if self.gate.active {
            let seed = param_names(&arrow.params);
            self.flatten_scope(&mut arrow.body.statements, seed);
        }
        walk_mut::walk_arrow_function_expression(self, arrow);
        self.gate.exit(s);
    }
}

impl<'a> Flattener<'a> {
    /// Process one function scope: uniquify lexical names that actually share a
    /// scope, then lift its bare blocks. `scope_seed` is the function's params.
    fn flatten_scope(
        &mut self,
        list: &mut oxc_allocator::Vec<'a, Statement<'a>>,
        scope_seed: HashSet<String>,
    ) {
        // Function-wide avoid set for minting fresh names: every identifier that
        // appears anywhere in this subtree, so a `name$N` can never collide with —
        // or accidentally capture — an existing name, regardless of which scope it
        // lives in. The per-scope `scope` set (below) drives the rename *decision*;
        // `avoid` only constrains the *replacement* name.
        let mut avoid = collect_all_names(list);
        avoid.extend(scope_seed.iter().cloned());
        let mut scope = scope_seed;
        // Function body is a merging list (no enclosing scope to shadow): empty
        // `seed`, so a `let x` redeclaring a param renames unconditionally.
        let no_seed = HashSet::new();
        self.rename_list(list, &mut scope, &no_seed, &mut avoid);
        self.merge_list(list);
    }

    // ---- phase 1: renameForFlatten (scope-aware lexical uniqueness) ----

    /// Uniquify every `let`/`const` declared *in this scope* against the names
    /// already committed to it (`scope`), top-down. A bare block shares this scope
    /// (phase 2 lifts it in), so its bindings are renamed against the same set;
    /// control-flow bodies, switch, try and hoisted-decl blocks each open their
    /// own child scope SEEDED with this one (`rename_child_scope`), so a child
    /// binding that *shadows* an enclosing name is renamed (it would otherwise put
    /// the block in that name's TDZ — see `rename_child_scope`) while a child
    /// binding with a fresh name keeps it. `avoid` is the function-wide set used
    /// only to pick collision-free fresh names.
    fn rename_list(
        &mut self,
        list: &mut oxc_allocator::Vec<'a, Statement<'a>>,
        scope: &mut HashSet<String>,
        seed: &HashSet<String>,
        avoid: &mut HashSet<String>,
    ) {
        // This list's own top-level lexical bindings, in source order. Track the
        // statement index of each collision: a same-scope collision is a
        // *redeclaration* (`let part = …; …; let part = …`) — the block inliner
        // emits these when each call's prologue binds its param to the same name,
        // and a fold collapsing an `if` merges two distinct-scope bindings into
        // one list. oxc models a redeclaration as ONE symbol with two
        // declaration sites (verified), so there is no symbol identity to rename
        // by — only *position* separates them. `ScopeRename` matches by name, so
        // each rename must be scoped to the statements from its declarator
        // onward: references after a redeclaration bind to the later declarator;
        // the earlier one keeps its name.
        //
        // `seed` is the subset of `scope` made of NON-merging *enclosing* bindings
        // (a child scope's parent — see `rename_child_scope`); empty for a merging
        // list (function body / bare block), where every collision must rename. A
        // collision with a `seed` name that this list hasn't itself re-declared is
        // a pure *shadow* the block scoping already isolates — it only needs
        // renaming when an earlier statement references the enclosing binding (the
        // reference would otherwise fall into the shadow's TDZ). A shadow with no
        // prior reference keeps its clean name.
        let mut declared_here: HashSet<String> = HashSet::new();
        let mut renames: Vec<(String, String, usize)> = Vec::new();
        for (i, stmt) in list.iter().enumerate() {
            for name in top_level_lexical_bindings(stmt) {
                let collides = scope.contains(&name);
                let pure_shadow =
                    collides && seed.contains(&name) && !declared_here.contains(&name);
                let needs_rename =
                    collides && (!pure_shadow || references_name_before(list, i, &name));
                if needs_rename {
                    let fresh = pick_fresh(&name, avoid);
                    avoid.insert(fresh.clone());
                    scope.insert(fresh.clone());
                    declared_here.insert(fresh.clone());
                    renames.push((name, fresh, i));
                } else {
                    avoid.insert(name.clone());
                    scope.insert(name.clone());
                    declared_here.insert(name);
                }
            }
        }
        // Apply later-declarator renames FIRST (descending index): renaming the
        // last `part` (to `part$2`) before the middle one (to `part$1`) means the
        // middle rename — `ScopeRename { from: "part" }` over `[i..]` — no longer
        // matches the already-renamed later declarator, so N redeclarations get N
        // distinct names instead of all collapsing onto one.
        renames.sort_by(|a, b| b.2.cmp(&a.2));
        for (from, to, i) in renames {
            let to_a: &'a str = self.allocator.alloc_str(&to);
            let mut r = ScopeRename { from: &from, to: to_a };
            for s in list.iter_mut().skip(i) {
                r.visit_statement(s);
            }
        }
        // Recurse into nested scopes (bare blocks share `scope`; the rest fork).
        for stmt in list.iter_mut() {
            self.rename_child_scopes(stmt, scope, avoid);
        }
    }

    fn rename_child_scopes(
        &mut self,
        stmt: &mut Statement<'a>,
        scope: &mut HashSet<String>,
        avoid: &mut HashSet<String>,
    ) {
        match stmt {
            // Bare block: merges into the current scope (phase 2), so share it —
            // its bindings join this scope, so every collision must rename (empty
            // `seed`).
            Statement::BlockStatement(b) if !block_has_hoisted_decl(&b.body) => {
                let no_seed = HashSet::new();
                self.rename_list(&mut b.body, scope, &no_seed, avoid)
            }
            // Hoisted-decl block: kept intact → its own child scope.
            Statement::BlockStatement(b) => self.rename_child_scope(&mut b.body, scope, avoid),
            Statement::IfStatement(s) => {
                self.rename_body_childscope(&mut s.consequent, scope, avoid);
                if let Some(alt) = &mut s.alternate {
                    self.rename_body_childscope(alt, scope, avoid);
                }
            }
            Statement::ForStatement(s) => self.rename_body_childscope(&mut s.body, scope, avoid),
            Statement::ForInStatement(s) => self.rename_body_childscope(&mut s.body, scope, avoid),
            Statement::ForOfStatement(s) => self.rename_body_childscope(&mut s.body, scope, avoid),
            Statement::WhileStatement(s) => self.rename_body_childscope(&mut s.body, scope, avoid),
            Statement::DoWhileStatement(s) => self.rename_body_childscope(&mut s.body, scope, avoid),
            Statement::LabeledStatement(s) => self.rename_body_childscope(&mut s.body, scope, avoid),
            Statement::SwitchStatement(s) => {
                // Each case gets its own scope: phase 2 keeps a case's top-level
                // block (it scopes that case's bindings — see the merge's
                // `SwitchStatement` arm), so a `const x` in one case never shares
                // a scope with another case's `const x`. Renaming per-case (vs the
                // shared switch scope) avoids minting needless `x$1` cross-case
                // suffixes — each case keeps its clean names.
                for case in &mut s.cases {
                    let mut cs = scope.clone();
                    self.rename_list(&mut case.consequent, &mut cs, scope, avoid);
                }
            }
            Statement::TryStatement(s) => {
                self.rename_child_scope(&mut s.block.body, scope, avoid);
                if let Some(handler) = &mut s.handler {
                    // The catch param is in the handler body's lexical scope.
                    let mut h = scope.clone();
                    if let Some(p) = &handler.param {
                        let mut names = Vec::new();
                        collect_pattern_names(&p.pattern, &mut names);
                        h.extend(names);
                    }
                    self.rename_list(&mut handler.body.body, &mut h, scope, avoid);
                }
                if let Some(finalizer) = &mut s.finalizer {
                    self.rename_child_scope(&mut finalizer.body, scope, avoid);
                }
            }
            _ => {} // expression statements (incl. nested functions) — own scopes
        }
    }

    /// Recurse into a child scope, SEEDED with the parent's in-scope bindings
    /// (`parent`). A child `let x`/`const x` that shadows an enclosing binding
    /// (e.g. an inlined helper's `let out` inside a loop, shadowing the host's
    /// `out` param) must be renamed: otherwise the shadow puts the *whole* child
    /// block in `x`'s TDZ, so an earlier reference to the enclosing `x` throws
    /// `Cannot access 'x' before initialization`. Seeding makes such a binding a
    /// collision; `rename_list` renames it (and its later uses) while leaving the
    /// earlier enclosing-`x` references untouched. Non-shadowing child bindings
    /// don't collide, so they keep their names.
    fn rename_child_scope(
        &mut self,
        list: &mut oxc_allocator::Vec<'a, Statement<'a>>,
        parent: &HashSet<String>,
        avoid: &mut HashSet<String>,
    ) {
        let mut scope = parent.clone();
        self.rename_list(list, &mut scope, parent, avoid);
    }

    /// A control-flow body: if a block, its contents are a child scope; otherwise
    /// recurse into whatever child scopes the single statement contains. Threads
    /// the parent scope through so shadowing bindings are renamed (see
    /// `rename_child_scope`).
    fn rename_body_childscope(
        &mut self,
        stmt: &mut Statement<'a>,
        parent: &HashSet<String>,
        avoid: &mut HashSet<String>,
    ) {
        if let Statement::BlockStatement(b) = stmt {
            self.rename_child_scope(&mut b.body, parent, avoid);
        } else {
            let mut scope = parent.clone();
            self.rename_child_scopes(stmt, &mut scope, avoid);
        }
    }

    // ---- phase 2: tryMergeBlock (structural lift) ----

    /// Lift every bare block in `list` up into `list` (recursively). Names are
    /// already unique from phase 1 (the renamer), so lifts are unconditional —
    /// except switch-case consequents, handled in `merge_child_scopes`.
    fn merge_list(&mut self, list: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        let taken = std::mem::replace(list, self.ast.vec());
        for mut stmt in taken {
            if let Statement::BlockStatement(block) = &mut stmt {
                let mut inner = std::mem::replace(&mut block.body, self.ast.vec());
                self.merge_list(&mut inner);
                if block_has_hoisted_decl(&inner) {
                    block.body = inner; // keep block: function/class hoisting semantics
                    list.push(stmt);
                    continue;
                }
                for s in inner {
                    list.push(s);
                }
                self.count += 1;
            } else {
                self.merge_child_scopes(&mut stmt);
                list.push(stmt);
            }
        }
    }

    /// Recurse into a statement list and lift blocks nested *within* it, but do
    /// NOT lift the list's own top-level bare blocks. Used for `switch` case
    /// consequents, where a top-level block scopes that case's bindings against
    /// the cases that share its scope (see the `SwitchStatement` arm).
    fn merge_recurse_no_toplevel_lift(&mut self, list: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        for stmt in list.iter_mut() {
            if let Statement::BlockStatement(b) = stmt {
                // Keep this block; flatten its interior (a real nested scope).
                self.merge_list(&mut b.body);
            } else {
                self.merge_child_scopes(stmt);
            }
        }
    }

    fn merge_child_scopes(&mut self, stmt: &mut Statement<'a>) {
        match stmt {
            Statement::IfStatement(s) => {
                merge_body(self, &mut s.consequent);
                if let Some(alt) = &mut s.alternate {
                    merge_body(self, alt);
                }
            }
            Statement::ForStatement(s) => merge_body(self, &mut s.body),
            Statement::ForInStatement(s) => merge_body(self, &mut s.body),
            Statement::ForOfStatement(s) => merge_body(self, &mut s.body),
            Statement::WhileStatement(s) => merge_body(self, &mut s.body),
            Statement::DoWhileStatement(s) => merge_body(self, &mut s.body),
            Statement::LabeledStatement(s) => merge_body(self, &mut s.body),
            Statement::SwitchStatement(s) => {
                // All cases share ONE block scope, so a bare block sitting
                // directly in a case consequent is load-bearing — it scopes that
                // case's `let`/`const` away from the other cases (e.g. two cases
                // that each inline a helper declaring `const aby`). NEVER lift it.
                // We still recurse INTO it (and other nested structures) to lift
                // blocks nested deeper, which have their own real scopes.
                for case in &mut s.cases {
                    self.merge_recurse_no_toplevel_lift(&mut case.consequent);
                }
            }
            Statement::TryStatement(s) => {
                self.merge_list(&mut s.block.body);
                if let Some(handler) = &mut s.handler {
                    self.merge_list(&mut handler.body.body);
                }
                if let Some(finalizer) = &mut s.finalizer {
                    self.merge_list(&mut finalizer.body);
                }
            }
            _ => {}
        }
    }
}

/// Every identifier name appearing anywhere under `list` (bindings + references,
/// including inside nested functions). Used as the avoid-set base so a minted
/// `name$N` temp never collides with — or captures — an existing name.
fn collect_all_names(list: &[Statement]) -> HashSet<String> {
    struct V {
        names: HashSet<String>,
    }
    impl<'a> oxc_ast_visit::Visit<'a> for V {
        fn visit_binding_identifier(&mut self, id: &BindingIdentifier<'a>) {
            self.names.insert(id.name.to_string());
        }
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            self.names.insert(id.name.to_string());
        }
    }
    let mut v = V { names: HashSet::new() };
    for s in list {
        oxc_ast_visit::Visit::visit_statement(&mut v, s);
    }
    v.names
}

/// `true` if `name` occurs as an identifier *reference* anywhere in `list[..end]`.
/// A shadowing `let name`/`const name` at index `end` puts its whole block in
/// `name`'s TDZ, so such a prior reference (which meant the enclosing binding)
/// would throw — the shadow must be renamed. Conservative: counts references in
/// nested functions too (renaming them is always safe).
fn references_name_before(list: &[Statement], end: usize, name: &str) -> bool {
    struct V<'n> {
        name: &'n str,
        found: bool,
    }
    impl<'a> oxc_ast_visit::Visit<'a> for V<'_> {
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            if id.name == self.name {
                self.found = true;
            }
        }
    }
    let mut v = V { name, found: false };
    for s in &list[..end] {
        oxc_ast_visit::Visit::visit_statement(&mut v, s);
        if v.found {
            return true;
        }
    }
    false
}

fn merge_body<'a>(f: &mut Flattener<'a>, stmt: &mut Statement<'a>) {
    if let Statement::BlockStatement(b) = stmt {
        f.merge_list(&mut b.body);
    } else {
        f.merge_child_scopes(stmt);
    }
}

/// Renames a single binding `from`→`to` within its scope: rewrites the binding
/// declaration and every reference, skipping any nested scope (block / loop /
/// catch / function) that *re-binds* `from` — those shadow it — but following
/// closures that merely capture it.
struct ScopeRename<'a, 's> {
    from: &'s str,
    to: &'a str,
}

impl<'a> VisitMut<'a> for ScopeRename<'a, '_> {
    fn visit_function(&mut self, func: &mut Function<'a>, flags: ScopeFlags) {
        if !function_binds(func, self.from) {
            walk_mut::walk_function(self, func, flags);
        }
    }

    fn visit_arrow_function_expression(&mut self, arrow: &mut ArrowFunctionExpression<'a>) {
        let shadows = params_bind(&arrow.params, self.from)
            || subtree_binds(&arrow.body.statements, self.from);
        if !shadows {
            walk_mut::walk_arrow_function_expression(self, arrow);
        }
    }

    fn visit_class(&mut self, _class: &mut Class<'a>) {}

    fn visit_binding_identifier(&mut self, id: &mut BindingIdentifier<'a>) {
        if id.name == self.from {
            id.name = self.to.into();
        }
    }

    fn visit_identifier_reference(&mut self, id: &mut IdentifierReference<'a>) {
        if id.name == self.from {
            id.name = self.to.into();
        }
    }

    fn visit_block_statement(&mut self, block: &mut BlockStatement<'a>) {
        if !declares_lexical(&block.body, self.from) {
            walk_mut::walk_block_statement(self, block);
        }
    }

    fn visit_for_statement(&mut self, node: &mut ForStatement<'a>) {
        if !for_init_declares(node.init.as_ref(), self.from) {
            walk_mut::walk_for_statement(self, node);
        }
    }

    fn visit_for_in_statement(&mut self, node: &mut ForInStatement<'a>) {
        if !for_left_declares(&node.left, self.from) {
            walk_mut::walk_for_in_statement(self, node);
        }
    }

    fn visit_for_of_statement(&mut self, node: &mut ForOfStatement<'a>) {
        if !for_left_declares(&node.left, self.from) {
            walk_mut::walk_for_of_statement(self, node);
        }
    }

    fn visit_catch_clause(&mut self, node: &mut CatchClause<'a>) {
        let shadows = node.param.as_ref().is_some_and(|p| pattern_binds(&p.pattern, self.from));
        if !shadows {
            walk_mut::walk_catch_clause(self, node);
        }
    }
}

/// Names a statement binds at the top level of its list as `let`/`const`.
/// Excludes `var` (already function-scoped) and function/class declarations
/// (kept inside their block by `merge_list`).
fn top_level_lexical_bindings(stmt: &Statement) -> Vec<String> {
    let mut out = Vec::new();
    if let Statement::VariableDeclaration(v) = stmt {
        if matches!(v.kind, VariableDeclarationKind::Let | VariableDeclarationKind::Const) {
            for d in &v.declarations {
                collect_pattern_names(&d.id, &mut out);
            }
        }
    }
    out
}

/// Does this list declare `name` lexically at its top level (shadow guard)? Also
/// counts function/class declarations — both shadow a captured outer name.
fn declares_lexical(list: &[Statement], name: &str) -> bool {
    list.iter().any(|s| match s {
        Statement::FunctionDeclaration(f) => f.id.as_ref().is_some_and(|id| id.name == name),
        Statement::ClassDeclaration(c) => c.id.as_ref().is_some_and(|id| id.name == name),
        _ => top_level_lexical_bindings(s).iter().any(|n| n == name),
    })
}

/// Does the list declare a `function`/`class` at top level (block kept intact)?
fn block_has_hoisted_decl(list: &[Statement]) -> bool {
    list.iter()
        .any(|s| matches!(s, Statement::FunctionDeclaration(_) | Statement::ClassDeclaration(_)))
}

/// Does a function bind `name` (param or any declaration in its body, not
/// crossing further nested functions)? Such a function shadows a captured outer
/// `name`, so the renamer must not descend into it.
fn function_binds(func: &Function, name: &str) -> bool {
    params_bind(&func.params, name)
        || func.body.as_ref().is_some_and(|b| subtree_binds(&b.statements, name))
}

fn params_bind(params: &FormalParameters, name: &str) -> bool {
    params.items.iter().any(|p| pattern_binds(&p.pattern, name))
        || params.rest.as_ref().is_some_and(|r| pattern_binds(&r.rest.argument, name))
}

/// Any declaration of `name` (var/let/const/function/class) anywhere in `stmts`
/// without crossing into a nested function. Conservative shadow check.
fn subtree_binds(stmts: &[Statement], name: &str) -> bool {
    struct V<'n> {
        name: &'n str,
        found: bool,
    }
    impl<'a> oxc_ast_visit::Visit<'a> for V<'_> {
        fn visit_function(&mut self, _f: &Function<'a>, _: ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {}
        fn visit_binding_identifier(&mut self, id: &BindingIdentifier<'a>) {
            if id.name == self.name {
                self.found = true;
            }
        }
    }
    let mut v = V { name, found: false };
    for s in stmts {
        oxc_ast_visit::Visit::visit_statement(&mut v, s);
    }
    v.found
}

fn for_init_declares(init: Option<&ForStatementInit>, name: &str) -> bool {
    matches!(init, Some(ForStatementInit::VariableDeclaration(v))
        if matches!(v.kind, VariableDeclarationKind::Let | VariableDeclarationKind::Const)
            && v.declarations.iter().any(|d| pattern_binds(&d.id, name)))
}

fn for_left_declares(left: &ForStatementLeft, name: &str) -> bool {
    matches!(left, ForStatementLeft::VariableDeclaration(v)
        if matches!(v.kind, VariableDeclarationKind::Let | VariableDeclarationKind::Const)
            && v.declarations.iter().any(|d| pattern_binds(&d.id, name)))
}

fn pattern_binds(pat: &BindingPattern, name: &str) -> bool {
    let mut names = Vec::new();
    collect_pattern_names(pat, &mut names);
    names.iter().any(|n| n == name)
}

/// Collect every identifier a binding pattern introduces (handles destructuring).
fn collect_pattern_names(pat: &BindingPattern, out: &mut Vec<String>) {
    match pat {
        BindingPattern::BindingIdentifier(id) => out.push(id.name.to_string()),
        BindingPattern::ObjectPattern(o) => {
            for p in &o.properties {
                collect_pattern_names(&p.value, out);
            }
            if let Some(rest) = &o.rest {
                collect_pattern_names(&rest.argument, out);
            }
        }
        BindingPattern::ArrayPattern(a) => {
            for e in a.elements.iter().flatten() {
                collect_pattern_names(e, out);
            }
            if let Some(rest) = &a.rest {
                collect_pattern_names(&rest.argument, out);
            }
        }
        BindingPattern::AssignmentPattern(a) => collect_pattern_names(&a.left, out),
    }
}

fn param_names(params: &FormalParameters) -> HashSet<String> {
    let mut out = Vec::new();
    for p in &params.items {
        collect_pattern_names(&p.pattern, &mut out);
    }
    if let Some(rest) = &params.rest {
        collect_pattern_names(&rest.rest.argument, &mut out);
    }
    out.into_iter().collect()
}

/// Mint a fresh `name$N` not in `taken`. The base is first stripped of any
/// trailing `$<digits>` groups this pass previously appended, so re-renaming an
/// already-suffixed binding (`part$2`) yields `part$3`, NOT `part$2$1`. Without
/// this the renamer is not idempotent: re-running it each simplify-fixpoint pass
/// stacks suffixes (`part`→`part$2`→`part$2$1`→`part$2$1$1`…) until two collide
/// into an invalid duplicate `let`. With it, a binding that's already unique
/// won't collide and so won't be touched again — the pass converges.
pub(crate) fn pick_fresh(base: &str, taken: &HashSet<String>) -> String {
    let root = strip_flatten_suffix(base);
    let mut n = 1;
    loop {
        let candidate = format!("{root}${n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Strip trailing `$<digits>` group(s) that a prior `pick_fresh` appended, so we
/// always grow from the original root. `part$2$1$1` → `part`; `x$3` → `x`;
/// `_result_14` (no `$`) and `foo$bar` (non-numeric) are unchanged.
fn strip_flatten_suffix(name: &str) -> &str {
    let mut root = name;
    loop {
        let Some(idx) = root.rfind('$') else { return root };
        let tail = &root[idx + 1..];
        if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) {
            root = &root[..idx];
        } else {
            return root;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;

    fn run_src(src: &str) -> String {
        let allocator = Allocator::default();
        let mut program = crate::parse_program(&allocator, src, SourceType::ts());
        run(&allocator, &mut program);
        Codegen::new().build(&program).code
    }

    /// Run full block_flatten `passes` times, returning the code (idempotency).
    fn run_n(src: &str, passes: usize) -> String {
        let allocator = Allocator::default();
        let mut program = crate::parse_program(&allocator, src, SourceType::ts());
        for _ in 0..passes {
            run(&allocator, &mut program);
        }
        Codegen::new().build(&program).code
    }

    #[test]
    fn renames_redeclarations_to_distinct_names() {
        // A redeclaration in one scope (compiler-generated by inline + fold) —
        // oxc sees ONE symbol, so this is fixed structurally by position. Each
        // `let part` must get a DISTINCT name (not all collapse onto `part$1`),
        // and references must follow the nearest preceding declarator.
        let out = run_src("function f(a) { let part = a; sink1(part); let part = a + 1; sink2(part); let part = a + 2; sink3(part); }");
        assert!(out.contains("let part = a;"), "first kept:\n{out}");
        assert!(out.contains("let part$1 = a + 1"), "second distinct:\n{out}");
        assert!(out.contains("let part$2 = a + 2"), "third distinct:\n{out}");
        assert!(out.contains("sink1(part)"), "ref→1st:\n{out}");
        assert!(out.contains("sink2(part$1)"), "ref→2nd:\n{out}");
        assert!(out.contains("sink3(part$2)"), "ref→3rd:\n{out}");
    }

    #[test]
    fn flatten_is_idempotent_no_suffix_growth() {
        // The crux of the contact-constraints `part$2$1$1` miscompile: re-running
        // the renamer in the simplify fixpoint must NOT stack suffixes.
        // `pick_fresh` strips the existing suffix before minting, so a binding
        // that's already unique isn't renamed again — 1× ≡ 8×.
        let src = "function f(a, b) { { let p = b; a.x = p; } { let p = b + 1; a.y = p; } return a; }";
        let one = run_n(src, 1);
        let many = run_n(src, 8);
        assert_eq!(one, many, "block_flatten must be idempotent:\n1x:\n{one}\n8x:\n{many}");
        assert!(!many.contains("$1$1") && !many.contains("$2$1"), "no stacked suffixes:\n{many}");
        assert!(many.contains("let p = b") && many.contains("let p$1 = b + 1"), "single-level:\n{many}");
    }

    #[test]
    fn switch_cases_keep_blocks_with_clean_per_case_names() {
        // Each case keeps its scoping block (not lifted) and is renamed per-case,
        // so two cases that each declare `const v` BOTH stay `const v` in their own
        // block — valid, idempotent, and no needless cross-case `v$1`.
        let out = run_n(
            "function f(s, y) { switch (s) { case 1: { const v = y[0]; sink(v); } break; case 2: { const v = y[1]; sink(v); } break; } }",
            3,
        );
        assert!(!out.contains("v$"), "no cross-case rename:\n{out}");
        assert_eq!(out.matches("const v =").count(), 2, "both `const v` present:\n{out}");
        assert!(out.matches('{').count() >= 3, "both case blocks kept (fn body + 2 cases):\n{out}");
    }

    #[test]
    fn update_expression_write_in_inner_block_renamed() {
        // `x++` against a colliding inner `let x` follows the rename; outer `x` kept.
        let out = run_src("function f() { let x = 1; { let x = 2; x++; sink(x); } return x; }");
        assert!(out.contains("let x = 1"), "outer kept:\n{out}");
        assert!(out.contains("let x$1 = 2"), "inner renamed:\n{out}");
        assert!(out.contains("x$1++"), "update target renamed:\n{out}");
        assert!(out.contains("sink(x$1)"), "ref renamed:\n{out}");
        assert!(out.contains("return x;"), "outer return kept:\n{out}");
        assert_eq!(out.matches('{').count(), 1, "bare block lifted:\n{out}");
    }

    #[test]
    fn compound_assignment_write_in_inner_block_renamed() {
        let out = run_src("function f() { let x = 1; { let x = 2; x += 5; sink(x); } return x; }");
        assert!(out.contains("let x = 1"), "outer kept:\n{out}");
        assert!(out.contains("let x$1 = 2"), "inner renamed:\n{out}");
        assert!(out.contains("x$1 += 5"), "compound target renamed:\n{out}");
        assert!(out.contains("sink(x$1)"), "ref renamed:\n{out}");
        assert_eq!(out.matches('{').count(), 1, "bare block lifted:\n{out}");
    }

    #[test]
    fn destructuring_assignment_in_inner_block_renamed() {
        // Both sides of `[a, b] = [b, a]` track the inner binding rename.
        let out = run_src(
            "function f() { let a = 1; { let a = 2, b = 3; [a, b] = [b, a]; sink(a, b); } return a; }",
        );
        assert!(out.contains("let a = 1"), "outer kept:\n{out}");
        assert!(out.contains("let a$1 = 2, b = 3"), "inner renamed (b unique):\n{out}");
        assert!(out.contains("[a$1, b] = [b, a$1]"), "destructure targets+refs renamed:\n{out}");
        assert!(out.contains("sink(a$1, b)"), "refs renamed:\n{out}");
        assert!(out.contains("return a;"), "outer return kept:\n{out}");
        assert_eq!(out.matches('{').count(), 1, "bare block lifted:\n{out}");
    }

    #[test]
    fn inner_function_declaration_shadow_block_kept() {
        // A block declaring a `function` is left intact (hoisting semantics): the
        // bare block is NOT merged, and the inner `g` is not renamed against the
        // outer `let g`. The inner `sink(g)` resolves to the inner function decl.
        let out = run_src("function f() { let g = 1; { function g() {} sink(g); } return g; }");
        assert!(out.contains("let g = 1"), "outer kept:\n{out}");
        assert!(out.contains("function g() {}"), "inner fn decl kept un-renamed:\n{out}");
        assert!(out.contains("sink(g)"), "inner ref kept:\n{out}");
        assert!(!out.contains("g$1"), "hoisted-decl block left intact, no rename:\n{out}");
        // The hoisted-decl block survives — two `{` (fn body + kept block).
        assert!(out.matches('{').count() >= 2, "hoisted-decl block not merged:\n{out}");
    }

    #[test]
    fn shorthand_object_property_expanded_on_rename() {
        // Renaming the inner `x` expands the shorthand `{ x }` to `{ x: x$1 }`.
        let out = run_src("function f() { let x = 1; { let x = 2; sink({ x }); } return x; }");
        assert!(out.contains("let x = 1"), "outer kept:\n{out}");
        assert!(out.contains("let x$1 = 2"), "inner renamed:\n{out}");
        assert!(out.contains("sink({ x: x$1 })"), "shorthand expanded on rename:\n{out}");
        assert_eq!(out.matches('{').count(), 2, "fn body + object literal braces:\n{out}");
    }

    #[test]
    fn computed_member_access_key_renamed() {
        // `o[k]` follows the rename of a colliding inner `let k`; the computed key
        // is a reference, so it tracks the binding (not a string-literal property).
        let out = run_src("function f() { let k = 'a'; { let k = 'b'; o[k] = 1; } }");
        assert!(out.contains("let k = \"a\""), "outer kept:\n{out}");
        assert!(out.contains("let k$1 = \"b\""), "inner renamed:\n{out}");
        assert!(out.contains("o[k$1] = 1"), "computed key ref renamed:\n{out}");
        assert_eq!(out.matches('{').count(), 1, "bare block lifted:\n{out}");
    }

    #[test]
    fn default_param_referencing_outer_name_kept() {
        // The bare block declares a `function g` → kept intact (hoisted decl). The
        // inner `let a = 2` lives in its own (un-lifted) scope so it is NOT renamed
        // against the param `a`; `g`'s default `p = a` resolves to that inner `a`.
        let out =
            run_src("function f(a) { { let a = 2; function g(p = a) { return p; } sink(g()); } }");
        assert!(out.contains("let a = 2"), "inner binding kept (own scope):\n{out}");
        assert!(out.contains("function g(p = a)"), "default param ref kept:\n{out}");
        assert!(!out.contains("a$1"), "hoisted-decl block not lifted → no rename:\n{out}");
        assert!(out.matches('{').count() >= 2, "hoisted-decl block kept intact:\n{out}");
    }

    #[test]
    fn try_catch_param_block_kept() {
        // A catch handler body is its own (non-bare) scope, not lifted; the
        // `let x = e` and the catch param `e` are untouched.
        let out = run_src("function f() { try {} catch (e) { let x = e; sink(x); } }");
        assert!(out.contains("catch (e)"), "catch param kept:\n{out}");
        assert!(out.contains("let x = e"), "handler binding kept:\n{out}");
        assert!(out.contains("sink(x)"), "ref kept:\n{out}");
        assert!(!out.contains("x$1") && !out.contains("e$1"), "no rename:\n{out}");
    }

    #[test]
    fn flattens_a_bare_block_no_collision() {
        let out = run_src("function f(a) { { let x = a; g(x); } }");
        assert!(out.contains("let x = a"), "binding kept clean:\n{out}");
        assert!(out.contains("g(x)"), "{out}");
        // The only braces left are the function body's.
        assert_eq!(out.matches('{').count(), 1, "scaffolding block removed:\n{out}");
    }

    #[test]
    fn renames_on_collision_between_two_blocks() {
        let out = run_src("function f(a) { { let x = a; g(x); } { let x = a + 1; h(x); } }");
        assert!(out.contains("let x = a;"), "first keeps name:\n{out}");
        assert!(out.contains("let x$1 = a + 1"), "second renamed:\n{out}");
        assert!(out.contains("h(x$1)"), "reference renamed:\n{out}");
        assert!(!out.contains("h(x)"), "old reference gone:\n{out}");
    }

    #[test]
    fn renames_against_a_param() {
        let out = run_src("function f(out) { { let out = mk(); use(out); } }");
        assert!(out.contains("let out$1 = mk()"), "let renamed off the param:\n{out}");
        assert!(out.contains("use(out$1)"), "ref renamed:\n{out}");
    }

    #[test]
    fn keeps_control_flow_blocks() {
        let out = run_src("function f(a) { if (a) { let x = 1; g(x); } }");
        assert!(out.contains("if"), "if kept:\n{out}");
        assert!(out.matches('{').count() >= 2, "control body block kept:\n{out}");
    }

    #[test]
    fn sibling_control_flow_bodies_keep_their_names() {
        // Two branches that never merge into the same scope each keep `x` — the
        // rename is scope-aware, not function-wide, so no needless `x$1`.
        let out =
            run_src("function f(c) { if (c) { let x = 1; g(x); } else { let x = 2; h(x); } }");
        assert!(out.contains("let x = 1"), "consequent keeps name:\n{out}");
        assert!(out.contains("let x = 2"), "alternate keeps name (own scope):\n{out}");
        assert!(!out.contains("x$1"), "no needless rename across disjoint scopes:\n{out}");
    }

    #[test]
    fn loop_body_binding_independent_of_sibling_block() {
        // A binding in a (non-lifted) loop body shares no scope with a sibling
        // bare block's binding of the same name — both stay `t`.
        let out = run_src(
            "function f(arr) { for (let i = 0; i < arr.length; i++) { let t = arr[i]; use(t); } { let t = 9; use(t); } }",
        );
        assert!(out.contains("let t = arr[i]"), "loop-body binding kept:\n{out}");
        assert!(out.contains("let t = 9"), "lifted bare-block binding kept:\n{out}");
        assert!(!out.contains("t$1"), "disjoint scopes → no rename:\n{out}");
    }

    #[test]
    fn nested_shadow_renamed_distinctly() {
        // Outer `x` collides with param → x$1; inner shadow is a distinct binding
        // → x$2; each reference tracks its own binding.
        let out = run_src("function f(x) { { let x = 1; { let x = 2; inner(x); } outer(x); } }");
        assert!(out.contains("let x$1 = 1"), "outer renamed:\n{out}");
        assert!(out.contains("let x$2 = 2"), "inner renamed distinctly:\n{out}");
        assert!(out.contains("inner(x$2)"), "inner ref → inner binding:\n{out}");
        assert!(out.contains("outer(x$1)"), "outer ref → outer binding:\n{out}");
    }

    #[test]
    fn closure_capture_is_renamed() {
        // A captured (non-shadowing) reference inside a nested arrow must follow
        // the rename.
        let out = run_src("function f(n) { { let n = mk(); return () => n; } }");
        assert!(out.contains("let n$1 = mk()"), "binding renamed off param:\n{out}");
        assert!(out.contains("() => n$1"), "captured ref renamed:\n{out}");
    }
}
