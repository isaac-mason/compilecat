//! Port of `src/compiler/loop-unroller.ts` — directive-driven loop unrolling.
//!
//! Replaces an opt-in loop with a flat sequence of its body, one copy per
//! iteration, the loop variable substituted by its concrete value.
//!
//! Eligibility (REMAINING_WORK §4 / R2): a loop unrolls **only** when it carries
//! an explicit `/* @unroll */` comment. `@optimize` does
//! NOT imply unrolling — it's a deliberately opt-in, situational transform (it
//! trades size for loop overhead the JIT usually handles), and folding it into
//! the general `@optimize` gate unrolled loops nobody asked to (128-iteration
//! bloat, nested-loop bodies leaving dead `for (j=0; j<0; j++)` residue). The
//! author marks the specific hot loops worth unrolling; everything else is left
//! intact. Even an explicit `@unroll` is capped by the budget below.
//!
//! Supported shapes:
//!   - `for (let i = <lit>; i <(=) <lit>; i++ | i += <lit>) { ... }` (start /
//!     bound / step may also be a statically-resolved numeric `const`)
//!   - `for (const x of [<lit>, ...]) { ... }` (a statically-known array literal)
//!
//! Soft-fails (leaves the loop) when the trip count isn't statically known, the
//! body has cross-loop control flow (return/break/continue escaping), or the
//! expansion exceeds the unroll budget.
//!
//! oxc simplification: non-read identifier positions use
//! distinct node types (`BindingIdentifier`/`IdentifierName`), so substituting
//! only `Expression::Identifier` is automatically read-context-correct — no
//! manual `isReadContext` table needed.

use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, CloneIn, TakeIn};
use oxc_ast::ast::*;
use oxc_ast::AstBuilder;
use oxc_ast_visit::{walk_mut, Visit, VisitMut};
use oxc_semantic::ScopeFlags;
use oxc_span::SPAN;

/// Hard ceiling on iterations we'll even enumerate (guards `compute_values`
/// against a runaway range). The real policy is the budget below.
const MAX_ITERATIONS: usize = 1024;

/// REMAINING_WORK §4 / R2 — unroll budget. Unrolling is a real win for small,
/// statically-resolvable loops (a `vec3` kernel, a `for (const x of [a, b])`
/// over a literal array), but a liability past a point: unrolling `for i<128`
/// bloats output, and unrolling a loop whose body *contains another loop*
/// (e.g. the Jacobi `sweep` loop, or a nested-index outer) both bloats and
/// leaves dead/half-unrolled inner loops (`for (j=0; j<0; j++)`) once the loop
/// var is substituted in. So we bail (leave the loop intact) unless:
///   (b) trip count ≤ MAX_UNROLL_TRIP, and
///   (c) trip × body-size ≤ MAX_UNROLL_PRODUCT.
/// A nested-loop body is large, so (c) naturally bails the outer of a nest —
/// which is exactly what stops the dead-inner-loop residue at the source.
/// Zero-trip loops are exempt: they still expand to nothing (loop removed).
const MAX_UNROLL_TRIP: usize = 64;
const MAX_UNROLL_PRODUCT: usize = 96;

pub fn run<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> u32 {
    let src = program.source_text;
    let unroll_spans = super::directives::annotated_spans_with_exports(program, &["@unroll"]);
    if unroll_spans.is_empty() {
        return 0;
    }

    let consts = collect_numeric_consts(program);
    let mut v = Unroller {
        ast: AstBuilder::new(allocator),
        unroll_spans,
        consts,
        count: 0,
    };
    v.visit_program(program);
    let count = v.count;

    // The unroll pass consumes `@unroll` markers (gone on success; stripped on
    // soft-fail). Drop them from the output.
    if count > 0 || !v.unroll_spans.is_empty() {
        let taken = program.comments.take_in(allocator);
        let mut kept = v.ast.vec_with_capacity(taken.len());
        for c in taken {
            let text = &src[c.span.start as usize..c.span.end as usize];
            if text.contains("@unroll") {
                continue;
            }
            kept.push(c);
        }
        program.comments = kept;
    }

    count
}

struct Unroller<'a> {
    ast: AstBuilder<'a>,
    unroll_spans: HashSet<u32>,
    /// Names bound to a unique top-level/nested `const NAME = <number>` whose
    /// init is a numeric literal (possibly unary-negated). A name is present
    /// only if it has exactly one such const definition anywhere in the
    /// program; ambiguous/shadowed names are dropped so resolution stays sound.
    consts: HashMap<String, f64>,
    count: u32,
}

/// Scan the whole program for `const NAME = <numeric-literal>` bindings. Records
/// each name → value, but removes any name that is declared (as a const-number,
/// or as anything else that could shadow it) more than once, so a resolved name
/// is unambiguous regardless of scope. `const` can't be reassigned, so a unique
/// numeric-literal init is a sound compile-time value.
fn collect_numeric_consts(program: &Program) -> HashMap<String, f64> {
    let mut found: HashMap<String, f64> = HashMap::new();
    let mut ambiguous: HashSet<String> = HashSet::new();
    let mut c = ConstCollector { found: &mut found, ambiguous: &mut ambiguous };
    c.visit_program(program);
    for name in ambiguous {
        found.remove(&name);
    }
    found
}

struct ConstCollector<'c> {
    found: &'c mut HashMap<String, f64>,
    ambiguous: &'c mut HashSet<String>,
}

impl<'a> Visit<'a> for ConstCollector<'_> {
    fn visit_variable_declarator(&mut self, decl: &VariableDeclarator<'a>) {
        if let BindingPattern::BindingIdentifier(id) = &decl.id {
            let name = id.name.to_string();
            let value = if decl.kind == VariableDeclarationKind::Const {
                decl.init.as_ref().and_then(read_numeric_expr)
            } else {
                None
            };
            match value {
                // A second occurrence of a name (even a matching const number)
                // makes the binding ambiguous across scopes — drop it.
                Some(v) if !self.found.contains_key(&name) => {
                    self.found.insert(name, v);
                }
                _ => {
                    self.ambiguous.insert(name);
                }
            }
        }
        oxc_ast_visit::walk::walk_variable_declarator(self, decl);
    }
}

/// Read an expression as an integer-valued constant: a numeric literal or a
/// unary-negated numeric literal. Returns `None` for anything else.
fn read_numeric_expr(expr: &Expression) -> Option<f64> {
    match expr {
        Expression::NumericLiteral(lit) => Some(lit.value),
        Expression::UnaryExpression(u) if u.operator == UnaryOperator::UnaryNegation => {
            if let Expression::NumericLiteral(lit) = &u.argument {
                Some(-lit.value)
            } else {
                None
            }
        }
        _ => None,
    }
}

impl<'a> VisitMut<'a> for Unroller<'a> {
    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        // Bottom-up: inner lists (and nested loops) expand before this one, so a
        // single pass handles nesting.
        walk_mut::walk_statements(self, stmts);

        if !stmts.iter().any(|s| self.is_eligible_loop(s)) {
            return;
        }
        let taken = stmts.take_in(self.ast.allocator);
        let mut out = self.ast.vec_with_capacity(taken.len());
        for stmt in taken {
            if let Some(expanded) = self.try_expand(&stmt) {
                self.count += 1;
                out.extend(expanded);
            } else {
                out.push(stmt);
            }
        }
        *stmts = out;
    }
}

impl<'a> Unroller<'a> {
    fn alloc(&self) -> &'a Allocator {
        self.ast.allocator
    }

    fn is_eligible_loop(&self, s: &Statement<'a>) -> bool {
        let span_start = match s {
            Statement::ForStatement(f) => f.span.start,
            Statement::ForOfStatement(f) => f.span.start,
            _ => return false,
        };
        // Opt-in only: an explicit `/* @unroll */` marker on the loop. `@optimize`
        // no longer implies unrolling (see module docs / R2).
        self.unroll_spans.contains(&span_start)
    }

    fn try_expand(&self, stmt: &Statement<'a>) -> Option<Vec<Statement<'a>>> {
        if !self.is_eligible_loop(stmt) {
            return None;
        }
        match stmt {
            Statement::ForStatement(f) => self.expand_for(f),
            Statement::ForOfStatement(f) => self.expand_for_of(f),
            _ => None,
        }
    }

    fn expand_for(&self, node: &ForStatement<'a>) -> Option<Vec<Statement<'a>>> {
        let shape = parse_loop_shape(node, &self.consts)?;
        let values = compute_values(&shape)?;
        if unsafe_control_flow(&node.body) {
            return None;
        }
        if !within_unroll_budget(values.len(), &node.body) {
            return None;
        }
        let mut out = Vec::new();
        for v in values {
            let value = self.num(v);
            out.push(self.iteration(&node.body, &shape.var_name, &value));
        }
        Some(out)
    }

    fn expand_for_of(&self, node: &ForOfStatement<'a>) -> Option<Vec<Statement<'a>>> {
        let ForStatementLeft::VariableDeclaration(vd) = &node.left else { return None };
        if vd.declarations.len() != 1 {
            return None;
        }
        let BindingPattern::BindingIdentifier(id) = &vd.declarations[0].id else { return None };
        let var_name = id.name.to_string();

        let Expression::ArrayExpression(arr) = &node.right else { return None };
        let mut elements = Vec::new();
        for el in &arr.elements {
            match el {
                ArrayExpressionElement::SpreadElement(_) | ArrayExpressionElement::Elision(_) => {
                    return None;
                }
                other => elements.push(other.to_expression()),
            }
        }
        if elements.len() > MAX_ITERATIONS {
            return None;
        }
        if unsafe_control_flow(&node.body) {
            return None;
        }
        if !within_unroll_budget(elements.len(), &node.body) {
            return None;
        }
        let mut out = Vec::new();
        for el in elements {
            let value = el.clone_in(self.alloc());
            out.push(self.iteration(&node.body, &var_name, &value));
        }
        Some(out)
    }

    /// One unrolled iteration: clone the body, substitute the loop var. Each
    /// iteration is wrapped in its own block so block-scoped bindings stay
    /// isolated (the simplifier's α-rename later flattens them).
    fn iteration(
        &self,
        body: &Statement<'a>,
        var_name: &str,
        value: &Expression<'a>,
    ) -> Statement<'a> {
        let mut cloned = body.clone_in(self.alloc());
        let mut subst = Subst { allocator: self.alloc(), var_name, value, shadow_depth: 0 };
        subst.visit_statement(&mut cloned);
        if matches!(cloned, Statement::BlockStatement(_)) {
            cloned
        } else {
            let body = self.ast.vec1(cloned);
            Statement::BlockStatement(self.ast.alloc(self.ast.block_statement(SPAN, body)))
        }
    }

    fn num(&self, value: f64) -> Expression<'a> {
        if value < 0.0 {
            let lit = self.ast.expression_numeric_literal(SPAN, -value, None, NumberBase::Decimal);
            self.ast.expression_unary(SPAN, UnaryOperator::UnaryNegation, lit)
        } else {
            self.ast.expression_numeric_literal(SPAN, value, None, NumberBase::Decimal)
        }
    }
}

struct LoopShape {
    var_name: String,
    start: f64,
    bound: f64,
    inclusive: bool,
    step: f64,
}

/// Read a start/bound/step operand: a numeric literal, a unary-negated numeric
/// literal (negative start/bound/step), or an identifier resolving to a unique
/// numeric `const`. Returns `None` (→ soft-fail) otherwise.
fn read_operand(expr: &Expression, consts: &HashMap<String, f64>) -> Option<f64> {
    if let Some(v) = read_numeric_expr(expr) {
        return Some(v);
    }
    if let Expression::Identifier(id) = expr {
        return consts.get(id.name.as_str()).copied();
    }
    None
}

fn parse_loop_shape(node: &ForStatement, consts: &HashMap<String, f64>) -> Option<LoopShape> {
    let Some(ForStatementInit::VariableDeclaration(vd)) = &node.init else { return None };
    if vd.declarations.len() != 1 {
        return None;
    }
    let decl = &vd.declarations[0];
    let BindingPattern::BindingIdentifier(id) = &decl.id else { return None };
    let var_name = id.name.to_string();
    let start = read_operand(decl.init.as_ref()?, consts)?;

    let Some(Expression::BinaryExpression(test)) = &node.test else { return None };
    let Expression::Identifier(left) = &test.left else { return None };
    if left.name.as_str() != var_name.as_str() {
        return None;
    }
    let bound = read_operand(&test.right, consts)?;
    let inclusive = match test.operator {
        BinaryOperator::LessThan => false,
        BinaryOperator::LessEqualThan => true,
        _ => return None,
    };

    let update = node.update.as_ref()?;
    let step = match update {
        Expression::UpdateExpression(u) => {
            if u.operator != UpdateOperator::Increment {
                return None;
            }
            if u.argument.get_identifier_name() != Some(var_name.as_str()) {
                return None;
            }
            1.0
        }
        Expression::AssignmentExpression(a) => {
            if a.operator != AssignmentOperator::Addition {
                return None;
            }
            if a.left.get_identifier_name() != Some(var_name.as_str()) {
                return None;
            }
            read_operand(&a.right, consts)?
        }
        _ => return None,
    };
    if step <= 0.0 || step.fract() != 0.0 {
        return None;
    }
    if start.fract() != 0.0 || bound.fract() != 0.0 {
        return None;
    }

    Some(LoopShape { var_name, start, bound, inclusive, step })
}

/// R2 budget gate (see `MAX_UNROLL_TRIP`/`MAX_UNROLL_PRODUCT`). A zero-trip
/// loop is always allowed through — it expands to nothing, removing the loop.
fn within_unroll_budget(trip: usize, body: &Statement) -> bool {
    if trip == 0 {
        return true;
    }
    if trip > MAX_UNROLL_TRIP {
        return false;
    }
    trip.saturating_mul(body_size(body)) <= MAX_UNROLL_PRODUCT
}

/// A rough AST-size metric for a loop body: the number of statement and
/// expression nodes. A body containing a nested loop counts that loop's whole
/// subtree, so nested-loop outers are large and bail the product budget.
fn body_size(body: &Statement) -> usize {
    struct Counter {
        n: usize,
    }
    impl<'a> oxc_ast_visit::Visit<'a> for Counter {
        fn visit_expression(&mut self, e: &Expression<'a>) {
            self.n += 1;
            oxc_ast_visit::walk::walk_expression(self, e);
        }
        fn visit_statement(&mut self, s: &Statement<'a>) {
            self.n += 1;
            oxc_ast_visit::walk::walk_statement(self, s);
        }
    }
    let mut c = Counter { n: 0 };
    c.visit_statement(body);
    c.n
}

fn compute_values(shape: &LoopShape) -> Option<Vec<f64>> {
    let mut values = Vec::new();
    let limit = if shape.inclusive { shape.bound + 1.0 } else { shape.bound };
    let mut i = shape.start;
    while i < limit {
        values.push(i);
        if values.len() > MAX_ITERATIONS {
            return None;
        }
        i += shape.step;
    }
    Some(values)
}

// ── substitution ────────────────────────────────────────────────────────────

struct Subst<'a, 's> {
    allocator: &'a Allocator,
    var_name: &'s str,
    value: &'s Expression<'a>,
    shadow_depth: u32,
}

impl<'a> VisitMut<'a> for Subst<'a, '_> {
    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        if self.shadow_depth == 0 {
            if let Expression::Identifier(id) = &*expr {
                if id.name == self.var_name {
                    *expr = self.value.clone_in(self.allocator);
                    return;
                }
            }
        }
        walk_mut::walk_expression(self, expr);
    }

    fn visit_function(&mut self, func: &mut Function<'a>, flags: ScopeFlags) {
        let shadows = function_declares(func, self.var_name);
        if shadows {
            self.shadow_depth += 1;
        }
        walk_mut::walk_function(self, func, flags);
        if shadows {
            self.shadow_depth -= 1;
        }
    }

    fn visit_block_statement(&mut self, block: &mut BlockStatement<'a>) {
        let shadows = block_declares(block, self.var_name);
        if shadows {
            self.shadow_depth += 1;
        }
        walk_mut::walk_block_statement(self, block);
        if shadows {
            self.shadow_depth -= 1;
        }
    }

    fn visit_catch_clause(&mut self, clause: &mut CatchClause<'a>) {
        // `catch (i)` introduces a fresh binding of `i` scoped to the clause
        // (param + body); reads inside it refer to the caught value, not the
        // loop var, so suppress substitution within.
        let shadows = catch_declares(clause, self.var_name);
        if shadows {
            self.shadow_depth += 1;
        }
        walk_mut::walk_catch_clause(self, clause);
        if shadows {
            self.shadow_depth -= 1;
        }
    }
}

fn catch_declares(clause: &CatchClause, name: &str) -> bool {
    clause.param.as_ref().is_some_and(|p| binding_pattern_declares(&p.pattern, name))
}

fn binding_pattern_declares(pat: &BindingPattern, name: &str) -> bool {
    matches!(pat, BindingPattern::BindingIdentifier(id) if id.name == name)
}

fn function_declares(func: &Function, name: &str) -> bool {
    if func.id.as_ref().is_some_and(|id| id.name == name) {
        return true;
    }
    func.params
        .items
        .iter()
        .any(|p| matches!(&p.pattern, BindingPattern::BindingIdentifier(id) if id.name == name))
}

fn block_declares(block: &BlockStatement, name: &str) -> bool {
    block.body.iter().any(|s| match s {
        Statement::VariableDeclaration(vd)
            if matches!(vd.kind, VariableDeclarationKind::Let | VariableDeclarationKind::Const) =>
        {
            vd.declarations
                .iter()
                .any(|d| matches!(&d.id, BindingPattern::BindingIdentifier(id) if id.name == name))
        }
        Statement::FunctionDeclaration(f) => f.id.as_ref().is_some_and(|id| id.name == name),
        Statement::ClassDeclaration(c) => c.id.as_ref().is_some_and(|id| id.name == name),
        _ => false,
    })
}

// ── control-flow safety ─────────────────────────────────────────────────────

fn unsafe_control_flow(body: &Statement) -> bool {
    let mut c = CfChecker { loop_depth: 0, fn_depth: 0, unsafe_found: false };
    c.visit_statement(body);
    c.unsafe_found
}

struct CfChecker {
    loop_depth: u32,
    fn_depth: u32,
    unsafe_found: bool,
}

impl<'a> oxc_ast_visit::Visit<'a> for CfChecker {
    fn visit_return_statement(&mut self, _: &ReturnStatement<'a>) {
        if self.fn_depth == 0 {
            self.unsafe_found = true;
        }
    }
    fn visit_break_statement(&mut self, _: &BreakStatement<'a>) {
        if self.loop_depth == 0 {
            self.unsafe_found = true;
        }
    }
    fn visit_continue_statement(&mut self, _: &ContinueStatement<'a>) {
        if self.loop_depth == 0 {
            self.unsafe_found = true;
        }
    }
    fn visit_function(&mut self, func: &Function<'a>, flags: ScopeFlags) {
        self.fn_depth += 1;
        self.loop_depth += 1;
        oxc_ast_visit::walk::walk_function(self, func, flags);
        self.fn_depth -= 1;
        self.loop_depth -= 1;
    }
    fn visit_for_statement(&mut self, node: &ForStatement<'a>) {
        self.loop_depth += 1;
        oxc_ast_visit::walk::walk_for_statement(self, node);
        self.loop_depth -= 1;
    }
    fn visit_while_statement(&mut self, node: &WhileStatement<'a>) {
        self.loop_depth += 1;
        oxc_ast_visit::walk::walk_while_statement(self, node);
        self.loop_depth -= 1;
    }
    fn visit_do_while_statement(&mut self, node: &DoWhileStatement<'a>) {
        self.loop_depth += 1;
        oxc_ast_visit::walk::walk_do_while_statement(self, node);
        self.loop_depth -= 1;
    }
    fn visit_for_of_statement(&mut self, node: &ForOfStatement<'a>) {
        self.loop_depth += 1;
        oxc_ast_visit::walk::walk_for_of_statement(self, node);
        self.loop_depth -= 1;
    }
    fn visit_for_in_statement(&mut self, node: &ForInStatement<'a>) {
        self.loop_depth += 1;
        oxc_ast_visit::walk::walk_for_in_statement(self, node);
        self.loop_depth -= 1;
    }
    fn visit_switch_statement(&mut self, node: &SwitchStatement<'a>) {
        self.loop_depth += 1;
        oxc_ast_visit::walk::walk_switch_statement(self, node);
        self.loop_depth -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;
    fn f(src: &str) -> (String, u32) {
        let allocator = Allocator::default();
        let mut program = crate::parse_program(&allocator, src, SourceType::ts());
        let n = run(&allocator, &mut program);
        (Codegen::new().build(&program).code, n)
    }

    #[test]
    fn const_numeric_bound() {
        // Bound `N` is a `const` numeric literal in an enclosing scope → resolve
        // it and unroll 0,1,2,3.
        let (out, n) = f("const N = 4; /* @unroll */ for (let i = 0; i < N; i++) { f(i); }");
        for c in ["f(0)", "f(1)", "f(2)", "f(3)"] {
            assert!(out.contains(c), "missing {c} in: {out}");
        }
        assert!(!out.contains("f(4)") && !out.contains("for ("), "got: {out}");
        assert_eq!(n, 1);
    }

    #[test]
    fn const_numeric_start_and_step() {
        // Start, bound, and step all resolved from numeric consts.
        let (out, n) = f(
            "const S = 1; const E = 7; const K = 2; /* @unroll */ for (let i = S; i < E; i += K) { f(i); }",
        );
        for c in ["f(1)", "f(3)", "f(5)"] {
            assert!(out.contains(c), "missing {c} in: {out}");
        }
        assert!(!out.contains("f(7)") && !out.contains("for ("), "got: {out}");
        assert_eq!(n, 1);
    }

    #[test]
    fn non_const_bound_soft_fails() {
        // `let`-bound (reassignable) → not a sound const, so bail.
        let (out, n) = f("let N = 4; /* @unroll */ for (let i = 0; i < N; i++) { f(i); }");
        assert!(out.contains("for ("), "loop kept: {out}");
        assert!(!out.contains("@unroll"), "marker stripped: {out}");
        assert_eq!(n, 0);
    }

    #[test]
    fn ambiguous_const_soft_fails() {
        // Two `const N` definitions → ambiguous across scopes, so the name is
        // dropped from resolution and the loop is left intact.
        let (out, n) = f(
            "const N = 4; function g() { const N = 2; } /* @unroll */ for (let i = 0; i < N; i++) { f(i); }",
        );
        assert!(out.contains("for ("), "loop kept: {out}");
        assert_eq!(n, 0);
    }

    #[test]
    fn negative_start() {
        // `i = -2` (unary-minus literal) → unroll -2,-1,0,1.
        let (out, n) = f("/* @unroll */ for (let i = -2; i < 2; i++) { f(i); }");
        for c in ["f(-2)", "f(-1)", "f(0)", "f(1)"] {
            assert!(out.contains(c), "missing {c} in: {out}");
        }
        assert!(!out.contains("f(2)") && !out.contains("for ("), "got: {out}");
        assert_eq!(n, 1);
    }

    #[test]
    fn catch_clause_shadow_not_substituted() {
        // `catch (i)` rebinds `i`; reads inside the clause must keep `i`, while
        // `use(i)` after the try gets the iteration value.
        let (out, n) = f(
            "/* @unroll */ for (let i = 0; i < 2; i++) { try { g(); } catch (i) { h(i); } use(i); }",
        );
        assert_eq!(out.matches("h(i)").count(), 2, "catch read preserved twice: {out}");
        assert!(out.contains("use(0)") && out.contains("use(1)"), "post-try substituted: {out}");
        assert!(
            !out.contains("h(0)") && !out.contains("h(1)"),
            "catch read not substituted: {out}"
        );
        assert!(!out.contains("for ("), "got: {out}");
        assert_eq!(n, 1);
    }

    #[test]
    fn inclusive_bound() {
        // `i <= 3` from 1 → 1,2,3 (inclusive endpoint).
        let (out, n) = f("/* @unroll */ for (let i = 1; i <= 3; i++) { f(i); }");
        assert!(out.contains("f(1)") && out.contains("f(2)") && out.contains("f(3)"), "got: {out}");
        assert!(!out.contains("f(4)") && !out.contains("for ("), "got: {out}");
        assert_eq!(n, 1);
    }

    #[test]
    fn step_plus_n() {
        // `i += 2`, i < 6 → 0,2,4.
        let (out, n) = f("/* @unroll */ for (let i = 0; i < 6; i += 2) { f(i); }");
        assert!(out.contains("f(0)") && out.contains("f(2)") && out.contains("f(4)"), "got: {out}");
        assert!(!out.contains("f(6)") && !out.contains("for ("), "got: {out}");
        assert_eq!(n, 1);
    }

    #[test]
    fn break_in_body_soft_fails() {
        // Loop-escaping `break` → soft-fail; loop kept intact (count 0).
        let (out, n) = f("/* @unroll */ for (let i = 0; i < 3; i++) { if (i == 1) break; f(i); }");
        assert!(out.contains("for ("), "loop kept: {out}");
        assert!(!out.contains("@unroll"), "marker stripped: {out}");
        assert_eq!(n, 0);
    }

    #[test]
    fn inner_shadowing_not_substituted() {
        // A `let i` inside the body shadows the loop var → must NOT be replaced
        // by the iteration value; only the loop-var reads are substituted.
        let (out, n) = f("/* @unroll */ for (let i = 0; i < 2; i++) { let i = 99; f(i); }");
        assert_eq!(out.matches("let i = 99").count(), 2, "shadow preserved twice: {out}");
        assert!(!out.contains("for ("), "got: {out}");
        // The body's `f(i)` reads the shadow, so neither f(0) nor f(1) appears.
        assert!(!out.contains("f(0)") && !out.contains("f(1)"), "shadow read kept: {out}");
        assert_eq!(n, 1);
    }

    #[test]
    fn empty_range_removes_loop() {
        // i < 0 from 0 → zero iterations; loop expands to nothing.
        let (out, n) = f("/* @unroll */ for (let i = 0; i < 0; i++) { f(i); }");
        assert!(!out.contains("for (") && !out.contains("f("), "got: {out}");
        assert_eq!(n, 1);
    }

    #[test]
    fn unannotated_left_alone() {
        // No directive in the source → pass is a no-op (early return).
        let (out, n) = f("for (let i = 0; i < 3; i++) { f(i); }");
        assert!(out.contains("for ("), "got: {out}");
        assert_eq!(n, 0);
    }

    #[test]
    fn nested_unroll_loops_both_expand() {
        let (out, n) = f(
            "/* @unroll */ for (let i = 0; i < 2; i++) { /* @unroll */ for (let j = 0; j < 2; j++) { f(i, j); } }",
        );
        for pair in ["f(0, 0)", "f(0, 1)", "f(1, 0)", "f(1, 1)"] {
            assert!(out.contains(pair), "missing {pair} in: {out}");
        }
        assert!(!out.contains("for ("), "got: {out}");
        assert_eq!(n, 2);
    }
}
