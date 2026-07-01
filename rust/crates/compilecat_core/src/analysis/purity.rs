//! Closure-aligned function purity analysis — a port of `PureFunctionIdentifier`
//! (see `analysis/purity_design.md`, grounded in `llm/closure/.../
//! PureFunctionIdentifier.java` + `AstAnalyzer.java` + `NodeUtil.java`).
//!
//! Per-function we compute a 4-flag side-effect summary; a reverse call-graph
//! fixpoint propagates callee flags to callers; a function with NO flags is
//! "pure" — its calls can be dropped / reordered / substituted / CSE'd. This is
//! the analysis path; `@pure` / `/*@__PURE__*/` are developer-assertion overrides
//! layered on top.
//!
//! The crux (what makes immutable-math pure): a mutation of a **freshly-created
//! local** object is NOT a side effect (`out[0] = …` where `out` is a local array
//! literal), while mutating a **parameter's** property is `MUTATES_ARGUMENTS`, and
//! mutating a **free/outer** variable is `MUTATES_GLOBAL_STATE`.

/// Closure's four side-effect bits (`PureFunctionIdentifier`). `MUTATES_GLOBAL`
/// subsumes the others. A summary with none set is pure.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SideEffects {
    /// An explicit `throw`, or a control-loss (`await`/`yield`) outside try/catch.
    pub throws: bool,
    /// Mutates state outside the function — a free/outer variable, a property of a
    /// non-local object, an escaping local, or a call to a global-mutating callee.
    pub mutates_global: bool,
    /// Mutates the `this` object (method bodies).
    pub mutates_this: bool,
    /// Mutates a parameter or a parameter's property (observable to the caller
    /// only if the corresponding arg escapes — refined at the call site in v2).
    pub mutates_arguments: bool,
}

impl SideEffects {
    /// All bits set — the summary for an unknown/external/unresolved callee.
    pub const ALL: SideEffects =
        SideEffects { throws: true, mutates_global: true, mutates_this: true, mutates_arguments: true };

    /// `MUTATES_GLOBAL_STATE` subsumes everything (Closure's
    /// `setMutatesGlobalStateAndAllOtherFlags`).
    pub fn set_mutates_global(&mut self) {
        *self = SideEffects::ALL;
    }

    /// Union another summary into this one (callee → caller propagation). Returns
    /// whether any bit was newly set (drives the fixpoint).
    pub fn union_from(&mut self, other: &SideEffects) -> bool {
        let before = *self;
        self.throws |= other.throws;
        self.mutates_global |= other.mutates_global;
        self.mutates_this |= other.mutates_this;
        self.mutates_arguments |= other.mutates_arguments;
        if self.mutates_global {
            *self = SideEffects::ALL;
        }
        *self != before
    }

    /// v1 droppability: a call is safe to drop/reorder/substitute iff its callee's
    /// summary is completely clean. (v2 will relax `mutates_arguments` when all args
    /// are unescaped locals, and reconsider `throws` per the throw-imprecision policy.)
    pub fn is_pure(&self) -> bool {
        !self.throws && !self.mutates_global && !self.mutates_this && !self.mutates_arguments
    }
}

/// A function's summary plus the set of callee names it invokes (edges for the
/// reverse-graph fixpoint). Keyed by function name (matching `gather_all_callables`).
#[derive(Clone, Debug, Default)]
pub struct FunctionSummary {
    pub effects: SideEffects,
    /// Identifier-callee names this function calls (for callee→caller propagation).
    pub callees: Vec<String>,
}

use std::collections::{HashMap, HashSet};

use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_semantic::{NodeId, ScopeFlags, Semantic, SemanticBuilder, SymbolId};

/// Whether a name resolves to a binding LOCAL to the analyzed function.
#[derive(Clone, Copy, PartialEq)]
enum Locality {
    Param,
    Local,
    /// A free/outer/global binding, or unresolved.
    Foreign,
}

/// Analyze every top-level named function/const-fn in the program and return a
/// name → summary map. Builds its own `Semantic` (read-only); the returned data
/// is owned so the borrow ends here.
pub fn analyze(program: &Program) -> HashMap<String, FunctionSummary> {
    let semantic = SemanticBuilder::new().build(program).semantic;
    let nodes = semantic.nodes();
    let mut out: HashMap<String, FunctionSummary> = HashMap::new();

    for node in nodes.iter() {
        // Only TOP-LEVEL functions (nested ones are handled conservatively — a call
        // to a non-top-level callee is treated as unknown by the fixpoint).
        if enclosing_function(nodes, node.id()).is_some() {
            continue;
        }
        let (name, root_fn, body): (String, NodeId, &FunctionBody) = match node.kind() {
            AstKind::Function(f) => {
                let (Some(id), Some(body)) = (&f.id, &f.body) else { continue };
                (id.name.to_string(), node.id(), body)
            }
            _ => continue,
        };
        out.insert(name, analyze_one(&semantic, root_fn, body));
    }
    out
}

/// Propagate side effects callee→caller to a fixpoint (Closure's
/// `propagateSideEffects` over the reverse call graph). A callee name absent from
/// the map is unknown/external → contributes ALL effects. Bitmask union converges
/// recursion + mutual recursion.
pub fn propagate(summaries: &mut HashMap<String, FunctionSummary>) {
    // Snapshot the edges — immutable through the loop; effects mutate.
    let edges: Vec<(String, Vec<String>)> =
        summaries.iter().map(|(k, v)| (k.clone(), v.callees.clone())).collect();
    loop {
        let mut changed = false;
        for (name, callees) in &edges {
            let mut acc = SideEffects::default();
            for c in callees {
                let ce = summaries.get(c).map_or(SideEffects::ALL, |s| s.effects);
                acc.union_from(&ce);
            }
            if let Some(s) = summaries.get_mut(name) {
                if s.effects.union_from(&acc) {
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
}

/// The set of top-level function names proven side-effect-free (analysis +
/// fixpoint). Their calls can be dropped / reordered / substituted / CSE'd.
pub fn pure_function_names(program: &Program) -> HashSet<String> {
    let mut summaries = analyze(program);
    propagate(&mut summaries);
    summaries.into_iter().filter(|(_, s)| s.effects.is_pure()).map(|(k, _)| k).collect()
}

/// Names of top-level functions/const-fns the developer ASSERTED pure via a
/// `/* @pure */` directive (ported from the old Babel compiler's `@pure`). The
/// override for what the analysis can't prove — a fn calling an imported/dynamic
/// callee it treats as impure, but the author knows is side-effect-free.
pub fn pure_annotated_names(program: &Program) -> HashSet<String> {
    let spans = crate::passes::directives::annotated_spans_with_exports(program, &["@pure"]);
    let mut names = HashSet::new();
    if spans.is_empty() {
        return names;
    }
    let mut consider = |name: &str, span_start: u32| {
        if spans.contains(&span_start) {
            names.insert(name.to_string());
        }
    };
    for stmt in &program.body {
        let decl = match stmt {
            Statement::ExportNamedDeclaration(e) => e.declaration.as_ref(),
            _ => stmt.as_declaration(),
        };
        match decl {
            Some(Declaration::FunctionDeclaration(f)) => {
                if let Some(id) = &f.id {
                    consider(id.name.as_str(), f.span.start);
                }
            }
            Some(Declaration::VariableDeclaration(vd)) => {
                for d in &vd.declarations {
                    if let (BindingPattern::BindingIdentifier(id), Some(init)) = (&d.id, &d.init) {
                        if matches!(
                            init,
                            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
                        ) {
                            consider(id.name.as_str(), vd.span.start);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    names
}

/// Stamp `CallExpression.pure = true` on every call whose plain-identifier callee
/// is a proven-pure function (Closure's `markPureFunctionCalls`, restricted to the
/// identifier-callee case). `is_side_effect_free` already honors `c.pure`, so this
/// is the single point that feeds the whole drop/reorder/substitute machinery — and
/// codegen emits `/*@__PURE__*/` for downstream. Returns the number stamped.
pub fn stamp_pure_calls(program: &mut Program) -> u32 {
    let mut pure = pure_function_names(program);
    // Union the developer-asserted `@pure` names — the override for the
    // un-analyzable tail (a fn calling an import / dynamic dispatch the analysis
    // conservatively treats as impure, but the author knows is side-effect-free).
    pure.extend(pure_annotated_names(program));
    if pure.is_empty() {
        return 0;
    }
    let mut st = Stamper { pure: &pure, count: 0 };
    st.visit_program(program);
    st.count
}

struct Stamper<'p> {
    pure: &'p HashSet<String>,
    count: u32,
}
impl<'a> VisitMut<'a> for Stamper<'_> {
    fn visit_call_expression(&mut self, c: &mut CallExpression<'a>) {
        walk_mut::walk_call_expression(self, c);
        if !c.pure {
            if let Expression::Identifier(id) = &c.callee {
                if self.pure.contains(id.name.as_str()) {
                    c.pure = true;
                    self.count += 1;
                }
            }
        }
    }
}

/// The nearest enclosing function/arrow node of `start` (exclusive), or None at
/// module top level. (Local copy of `local_var_table`'s helper.)
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

/// Compute one function's side-effect summary (Closure `FunctionBodyAnalyzer` +
/// `exitScope`).
fn analyze_one(semantic: &Semantic, root_fn: NodeId, body: &FunctionBody) -> FunctionSummary {
    let nodes = semantic.nodes();
    let scoping = semantic.scoping();

    // F's local symbols → is_param (Closure's "declared in same container scope").
    let mut locals: HashMap<SymbolId, bool> = HashMap::new();
    for sym in scoping.symbol_ids() {
        let decl = scoping.symbol_declaration(sym);
        if enclosing_function(nodes, decl) == Some(root_fn) {
            locals.insert(sym, is_param_decl(nodes, decl));
        }
    }

    let mut s = Scanner {
        semantic,
        root_fn,
        locals: &locals,
        effects: SideEffects::default(),
        tainted: HashSet::new(),
        skiplisted: HashSet::new(),
        callees: Vec::new(),
    };
    for stmt in &body.statements {
        s.visit_statement(stmt);
    }

    // exitScope finalize: a tainted param that isn't skiplisted → MUTATES_ARGUMENTS;
    // a skiplisted (escaping) local that's tainted → MUTATES_GLOBAL_STATE; a clean
    // tainted local → no flag (the pure local-mutation case).
    if !s.effects.mutates_global {
        for (&sym, &is_param) in &locals {
            if !s.tainted.contains(&sym) {
                continue;
            }
            if is_param && !s.skiplisted.contains(&sym) {
                s.effects.mutates_arguments = true;
            } else if !is_param && s.skiplisted.contains(&sym) {
                s.effects.set_mutates_global();
                break;
            }
        }
    }

    FunctionSummary { effects: s.effects, callees: s.callees }
}

/// Whether a symbol's declaration node is a formal parameter.
fn is_param_decl(nodes: &oxc_semantic::AstNodes, mut id: NodeId) -> bool {
    for _ in 0..6 {
        match nodes.kind(id) {
            AstKind::FormalParameter(_) | AstKind::FormalParameters(_) => return true,
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => return false,
            _ => {}
        }
        let p = nodes.parent_id(id);
        if p == id {
            return false;
        }
        id = p;
    }
    false
}

struct Scanner<'a, 's> {
    semantic: &'s Semantic<'a>,
    root_fn: NodeId,
    locals: &'s HashMap<SymbolId, bool>,
    effects: SideEffects,
    tainted: HashSet<SymbolId>,
    skiplisted: HashSet<SymbolId>,
    callees: Vec<String>,
}

impl<'a> Scanner<'a, '_> {
    /// Resolve an identifier reference to its locality within F.
    fn locality_of(&self, ident: &IdentifierReference) -> Locality {
        let Some(rid) = ident.reference_id.get() else { return Locality::Foreign };
        let Some(sym) = self.semantic.scoping().get_reference(rid).symbol_id() else {
            return Locality::Foreign;
        };
        match self.locals.get(&sym) {
            Some(true) => Locality::Param,
            Some(false) => Locality::Local,
            None => Locality::Foreign,
        }
    }

    fn sym_of(&self, ident: &IdentifierReference) -> Option<SymbolId> {
        self.semantic.scoping().get_reference(ident.reference_id.get()?).symbol_id()
    }

    /// Port of `visitLhsNode` for a member-write object (`obj.x = …`, `obj[k] = …`).
    fn member_write(&mut self, object: &Expression) {
        match object {
            Expression::ThisExpression(_) => self.effects.mutates_this = true,
            Expression::Identifier(id) => match self.locality_of(id) {
                // Local object mutation — defer to exitScope via taint.
                Locality::Param | Locality::Local => {
                    if let Some(sym) = self.sym_of(id) {
                        self.tainted.insert(sym);
                    }
                }
                // Mutating a free/outer object escapes.
                Locality::Foreign => self.effects.set_mutates_global(),
            },
            // Multi-level (`a.b.c = …`) — not tracked, conservatively global.
            _ => self.effects.set_mutates_global(),
        }
    }

    /// Port of `visitLhsNode` for a plain-name assignment target (`x = …`).
    fn name_write(&mut self, id: &IdentifierReference, rhs_local: bool) {
        match self.locality_of(id) {
            Locality::Param | Locality::Local => {
                if !rhs_local {
                    if let Some(sym) = self.sym_of(id) {
                        self.skiplisted.insert(sym);
                    }
                }
            }
            Locality::Foreign => self.effects.set_mutates_global(),
        }
    }

    fn handle_assign_target(&mut self, target: &AssignmentTarget, rhs_local: bool) {
        match target {
            // The variant holds an `IdentifierReference` directly.
            AssignmentTarget::AssignmentTargetIdentifier(id) => self.name_write(id, rhs_local),
            AssignmentTarget::StaticMemberExpression(m) => self.member_write(&m.object),
            AssignmentTarget::ComputedMemberExpression(m) => self.member_write(&m.object),
            AssignmentTarget::PrivateFieldExpression(m) => self.member_write(&m.object),
            // Destructuring / other — conservatively global.
            _ => self.effects.set_mutates_global(),
        }
    }

    fn handle_call(&mut self, call: &CallExpression<'a>) {
        // Known-pure builtin (Math.* etc.) — no effect, no edge.
        if is_pure_builtin(&call.callee) {
            return;
        }
        // A plain-identifier callee → a graph edge (the fixpoint resolves it). A
        // member/other callee is unknown → global.
        match &call.callee {
            Expression::Identifier(id) => self.callees.push(id.name.to_string()),
            _ => self.effects.set_mutates_global(),
        }
    }
}

impl<'a> Visit<'a> for Scanner<'a, '_> {
    // Don't descend into nested functions — their effects are gated behind a call,
    // which `handle_call` treats conservatively.
    fn visit_function(&mut self, _f: &Function<'a>, _flags: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {}
    fn visit_class(&mut self, _c: &Class<'a>) {}

    fn visit_assignment_expression(&mut self, a: &AssignmentExpression<'a>) {
        let rhs_local = evaluates_to_local(&a.right);
        self.handle_assign_target(&a.left, rhs_local);
        self.visit_expression(&a.right);
    }

    fn visit_update_expression(&mut self, u: &UpdateExpression<'a>) {
        // `x++` / `obj.x++` — the assigned value (a number) is always local.
        match &u.argument {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(_) => {} // number → local, no skiplist
            SimpleAssignmentTarget::StaticMemberExpression(m) => self.member_write(&m.object),
            SimpleAssignmentTarget::ComputedMemberExpression(m) => self.member_write(&m.object),
            SimpleAssignmentTarget::PrivateFieldExpression(m) => self.member_write(&m.object),
            _ => self.effects.set_mutates_global(),
        }
    }

    fn visit_variable_declarator(&mut self, d: &VariableDeclarator<'a>) {
        // `const x = v`: if v isn't a local value, x holds an escaping ref → skiplist.
        if let (BindingPattern::BindingIdentifier(bid), Some(init)) = (&d.id, &d.init) {
            if !evaluates_to_local(init) {
                // Resolve bid → symbol via its declaration.
                if let Some(sym) = self.binding_sym(bid) {
                    if self.locals.contains_key(&sym) {
                        self.skiplisted.insert(sym);
                    }
                }
            }
        }
        if let Some(init) = &d.init {
            self.visit_expression(init);
        }
    }

    fn visit_throw_statement(&mut self, _t: &ThrowStatement<'a>) {
        self.effects.throws = true; // v1: conservative (ignore try/catch)
    }
    fn visit_await_expression(&mut self, a: &AwaitExpression<'a>) {
        self.effects.throws = true;
        walk::walk_await_expression(self, a);
    }
    fn visit_yield_expression(&mut self, y: &YieldExpression<'a>) {
        self.effects.throws = true;
        walk::walk_yield_expression(self, y);
    }
    fn visit_unary_expression(&mut self, u: &UnaryExpression<'a>) {
        if u.operator == UnaryOperator::Delete {
            if let Expression::StaticMemberExpression(m) = &u.argument {
                self.member_write(&m.object);
            } else if let Expression::ComputedMemberExpression(m) = &u.argument {
                self.member_write(&m.object);
            } else {
                self.effects.set_mutates_global();
            }
        }
        walk::walk_unary_expression(self, u);
    }

    fn visit_call_expression(&mut self, c: &CallExpression<'a>) {
        self.handle_call(c);
        for arg in &c.arguments {
            if let Some(e) = arg.as_expression() {
                self.visit_expression(e);
            }
        }
    }
    fn visit_new_expression(&mut self, n: &NewExpression<'a>) {
        // Conservative: `new` is a global effect unless a known-pure builtin ctor.
        self.effects.set_mutates_global();
        walk::walk_new_expression(self, n);
    }
}

impl<'a> Scanner<'a, '_> {
    fn binding_sym(&self, bid: &BindingIdentifier) -> Option<SymbolId> {
        bid.symbol_id.get()
    }
}

/// `Math.*`/`Number.*`/`JSON.*` static-member calls are known pure (mirrors
/// `util::is_pure_builtin_callee`).
fn is_pure_builtin(callee: &Expression) -> bool {
    matches!(callee, Expression::StaticMemberExpression(m)
        if matches!(&m.object, Expression::Identifier(o)
            if matches!(o.name.as_str(), "Math" | "Number" | "JSON")))
}

/// Port of `NodeUtil.evaluatesToLocalValue` — does this expression evaluate to a
/// value local to (not escaping into) the current function? Conservative: unknown
/// → false (skiplist → more conservative → sound). The key `true` cases are fresh
/// literals/`new` (so `const out = [0,0,0]` keeps `out` a clean local).
fn evaluates_to_local(e: &Expression) -> bool {
    match e {
        Expression::ArrayExpression(_)
        | Expression::ObjectExpression(_)
        | Expression::FunctionExpression(_)
        | Expression::ArrowFunctionExpression(_)
        | Expression::ClassExpression(_)
        | Expression::RegExpLiteral(_)
        | Expression::TemplateLiteral(_)
        | Expression::NewExpression(_) => true,
        // Immutable primitives.
        Expression::NumericLiteral(_)
        | Expression::StringLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::BigIntLiteral(_) => true,
        // Simple operators produce a fresh primitive.
        Expression::BinaryExpression(_) => true,
        Expression::UnaryExpression(u) => u.operator != UnaryOperator::Delete,
        Expression::ParenthesizedExpression(p) => evaluates_to_local(&p.expression),
        Expression::TSAsExpression(t) => evaluates_to_local(&t.expression),
        Expression::TSNonNullExpression(t) => evaluates_to_local(&t.expression),
        Expression::TSSatisfiesExpression(t) => evaluates_to_local(&t.expression),
        Expression::LogicalExpression(l) => {
            evaluates_to_local(&l.left) && evaluates_to_local(&l.right)
        }
        Expression::ConditionalExpression(c) => {
            evaluates_to_local(&c.consequent) && evaluates_to_local(&c.alternate)
        }
        Expression::SequenceExpression(s) => {
            s.expressions.last().is_some_and(evaluates_to_local)
        }
        // `undefined` is immutable; other identifiers may alias.
        Expression::Identifier(id) => id.name == "undefined",
        // Property reads, calls, `this` → not known local.
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_span::SourceType;

    fn summ(code: &str) -> HashMap<String, FunctionSummary> {
        let allocator = Allocator::default();
        let program = crate::parse_program(&allocator, code, SourceType::ts());
        analyze(&program)
    }
    fn pure(m: &HashMap<String, FunctionSummary>, name: &str) -> bool {
        m.get(name).is_some_and(|s| s.effects.is_pure())
    }

    #[test]
    fn immutable_math_is_pure() {
        // `out` is a fresh local array; mutating its elements is NOT a side effect.
        let m = summ(
            "function add(a, b) { const out = [0,0,0]; out[0]=a[0]+b[0]; out[1]=a[1]+b[1]; return out; }",
        );
        assert!(pure(&m, "add"), "{:?}", m.get("add"));
    }
    #[test]
    fn out_param_mutation_is_impure() {
        let m = summ("function add(out, a, b) { out[0]=a[0]+b[0]; return out; }");
        assert!(!pure(&m, "add"));
        assert!(m["add"].effects.mutates_arguments, "{:?}", m["add"]);
    }
    #[test]
    fn global_write_is_impure() {
        let m = summ("let g = 0; function setG() { g = 1; }");
        assert!(m["setG"].effects.mutates_global);
    }
    #[test]
    fn member_call_is_impure() {
        let m = summ("function log(x) { console.log(x); }");
        assert!(!pure(&m, "log"));
    }
    #[test]
    fn recursive_arithmetic_summary_clean() {
        // Pre-fixpoint: fib's OWN summary is clean; the self-call is an edge.
        let m = summ("function fib(n) { return n < 2 ? n : fib(n-1) + fib(n-2); }");
        assert!(m["fib"].effects.is_pure(), "{:?}", m["fib"]);
        assert!(m["fib"].callees.iter().any(|c| c == "fib"));
    }
    #[test]
    fn pure_arithmetic_helper() {
        let m = summ("function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }");
        assert!(pure(&m, "dot"), "{:?}", m.get("dot"));
    }
    #[test]
    fn local_aliasing_external_then_mutate_is_impure() {
        // `t` aliases the escaping `a` (not a fresh local) → skiplisted → mutating
        // t.x taints an escaping ref → global.
        let m = summ("function f(a) { const t = a; t.x = 1; return t; }");
        assert!(!pure(&m, "f"), "{:?}", m.get("f"));
    }

    // ── fixpoint ──────────────────────────────────────────────────────────────
    fn pure_set(code: &str) -> HashSet<String> {
        let allocator = Allocator::default();
        let program = crate::parse_program(&allocator, code, SourceType::ts());
        pure_function_names(&program)
    }

    #[test]
    fn fixpoint_recursive_is_pure() {
        let p = pure_set("function fib(n) { return n < 2 ? n : fib(n-1) + fib(n-2); }");
        assert!(p.contains("fib"), "{p:?}");
    }
    #[test]
    fn fixpoint_calls_pure_helper_stays_pure() {
        let p = pure_set(
            "function sq(x) { return x*x; }\nfunction len2(a) { return sq(a[0]) + sq(a[1]); }",
        );
        assert!(p.contains("sq") && p.contains("len2"), "{p:?}");
    }
    #[test]
    fn fixpoint_calls_impure_becomes_impure() {
        let p = pure_set(
            "function log(x) { console.log(x); }\nfunction step(x) { log(x); return x + 1; }",
        );
        assert!(!p.contains("log") && !p.contains("step"), "{p:?}");
    }
    #[test]
    fn fixpoint_calls_external_is_impure() {
        let p = pure_set("function f(x) { return ext(x); }");
        assert!(!p.contains("f"), "{p:?}");
    }
    #[test]
    fn pure_annotation_detected() {
        let allocator = Allocator::default();
        let program = crate::parse_program(
            &allocator,
            "/* @pure */ function f(x) { return ext(x); }\nfunction g(x) { return x; }\n/* @pure */ const h = (x) => ext(x);",
            SourceType::ts(),
        );
        let ann = pure_annotated_names(&program);
        assert!(ann.contains("f"), "{ann:?}");
        assert!(ann.contains("h"), "{ann:?}");
        assert!(!ann.contains("g"), "{ann:?}");
    }

    #[test]
    fn fixpoint_mutual_recursion_pure() {
        let p = pure_set(
            "function ev(n){ return n===0 ? 1 : od(n-1); }\nfunction od(n){ return n===0 ? 0 : ev(n-1); }",
        );
        assert!(p.contains("ev") && p.contains("od"), "{p:?}");
    }
}
