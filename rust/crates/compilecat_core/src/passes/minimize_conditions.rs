//! Port of `src/compiler/peephole-minimize-conditions.ts` (Closure
//! PeepholeMinimizeConditions). Bottom-up boolean minimization.
//!
//! Self-contained sub-transforms (no `MinimizedCondition` shorter-form
//! machinery required):
//!   - `tryMinimizeNot`: `!!x → x`; `!(a == b) → a != b` (and `===`/`!==`).
//!     Relational `< <= > >=` are NOT negated — NaN-unsafe (Closure skips them).
//!   - hook shortcuts: `c ? true : false → !!c`; `c ? false : true → !c`;
//!     `c ? a : a → a` (same-arm fold, gated on a pure test — `ContentEq`).
//!   - `performConditionSubstitutions` (boolean context): `x ? true : y → x||y`,
//!     `x ? y : false → x&&y`, plus the short-circuit constant folds
//!     `x || TRUE → TRUE`, `x && FALSE → FALSE`, `x || FALSE → x`,
//!     `x && TRUE → x` (the operand-dropping folds are gated on a pure LHS;
//!     an impure LHS becomes a `(x, K)` comma sequence). "Boolean context" =
//!     the test of an `if`/`while`/`for`/`do`/ternary, or an operand of
//!     `!`/`&&`/`||`, matching Closure's `inBooleanContext` recursion.
//!   - nested `if (x) { if (y) Z; }` → `if (x && y) Z;` (no else on either,
//!     outer body is exactly the single inner if).
//!   - `tryJoinForCondition`: `for (init; cond; upd) { if (c) break; ... }`
//!     → `for (init; cond && !c; upd) { ... }` (break-if must be the first
//!     statement, no else, unlabeled break).
//!
//! Intentionally NOT ported (readability choice — the downstream minifier does
//! size collapsing): if/else → ternary collapse (`tryMinimizeIf` ternary
//! shapes), `if (x) foo()` → `x && foo()`. Deferred: full `MinimizedCondition`
//! shorter-form selection, `tryRemoveRepeatedStatements`, and the CFG-dependent
//! exit transforms.

use oxc_allocator::{Allocator, TakeIn};
use oxc_ast::ast::*;
use oxc_ast::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::{ContentEq, GetSpan, SPAN};

use super::util::{as_boolean, is_pure};

pub fn run<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> u32 {
    run_with(allocator, program, super::gate::Gate::ungated())
}

pub fn run_with<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    gate: super::gate::Gate,
) -> u32 {
    let mut v = Minimizer { ast: AstBuilder::new(allocator), count: 0, gate };
    v.visit_program(program);
    v.count
}

struct Minimizer<'a> {
    ast: AstBuilder<'a>,
    count: u32,
    gate: super::gate::Gate,
}

impl<'a> VisitMut<'a> for Minimizer<'a> {
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
        let s = self.gate.enter_scope(GetSpan::span(stmt).start);
        walk_mut::walk_statement(self, stmt);
        if self.gate.active {
            // Boolean-context substitution on loop / if test slots, then the
            // statement-shape rewrites.
            match stmt {
                Statement::IfStatement(i) => {
                    self.subst_in_place(&mut i.test);
                    self.minimize_cond_slot(&mut i.test);
                    self.try_nested_if_to_and(stmt);
                }
                Statement::WhileStatement(w) => {
                    self.subst_in_place(&mut w.test);
                    self.minimize_cond_slot(&mut w.test);
                }
                Statement::DoWhileStatement(d) => {
                    self.subst_in_place(&mut d.test);
                    self.minimize_cond_slot(&mut d.test);
                }
                Statement::ForStatement(f) => {
                    self.try_join_for_condition(f);
                    if let Some(test) = &mut f.test {
                        self.subst_in_place(test);
                        self.minimize_cond_slot(test);
                    }
                }
                _ => {}
            }
        }
        self.gate.exit(s);
    }
    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expr);
        if self.gate.active {
            // A ternary test and the operand of `!` are boolean contexts — run
            // condition substitution and cost-based minimization on those slots.
            //
            // NOTE: We do NOT call `subst_in_place` on the operands of `&&`/`||`
            // here.  `perform_condition_substitutions` is sound ONLY in a genuine
            // boolean context (one where only the truthiness of the result
            // matters, not its value).  A `&&`/`||` expression in a value
            // position (e.g. `return A && B`) has its VALUE returned — so
            // simplifying `B` by truthiness alone corrupts the output.
            //
            // The statement-level handlers (if/while/for/do) call
            // `subst_in_place` on the condition slot, and
            // `perform_condition_substitutions` already recurses into nested
            // `&&`/`||` children when it is called from a known boolean context.
            // Duplicating that recursion here was the source of Bug B: the right
            // operand of a value-context `&&`/`||` was being treated as boolean
            // context, silently dropping the operand's value.
            match expr {
                Expression::ConditionalExpression(c) => {
                    self.subst_in_place(&mut c.test);
                    self.minimize_cond_slot(&mut c.test);
                }
                Expression::UnaryExpression(u)
                    if u.operator == UnaryOperator::LogicalNot =>
                {
                    self.subst_in_place(&mut u.argument);
                    self.minimize_cond_slot(&mut u.argument);
                }
                _ => {}
            }
            if let Some(rep) = self.try_minimize(expr) {
                *expr = rep;
                self.count += 1;
            }
        }
    }
}

impl<'a> Minimizer<'a> {
    fn alloc(&self) -> &'a Allocator {
        self.ast.allocator
    }

    /// Cost-based condition minimization (Closure's MinimizedCondition): build the
    /// positive + De-Morgan-negated forms, keep the cheaper. Replaces the slot.
    fn minimize_cond_slot(&mut self, slot: &mut Expression<'a>) {
        use super::minimized_condition::{Mc, Style};
        let mc = Mc::new(self.alloc());
        let taken = slot.take_in(self.alloc());
        let cond = mc.from_condition(taken);
        let m = mc.get_minimized(cond, Style::PreferUnnegated);
        match m.node {
            Some(node) => {
                if m.changed {
                    self.count += 1;
                }
                *slot = node;
            }
            None => unreachable!("PreferUnnegated never returns the sentinel"),
        }
    }

    fn try_minimize(&self, expr: &mut Expression<'a>) -> Option<Expression<'a>> {
        match expr {
            Expression::UnaryExpression(u) if u.operator == UnaryOperator::LogicalNot => {
                self.minimize_not(u)
            }
            Expression::ConditionalExpression(c) => self.minimize_hook(c),
            _ => None,
        }
    }

    fn minimize_not(&self, u: &mut UnaryExpression<'a>) -> Option<Expression<'a>> {
        match &mut u.argument {
            // `!!x` → x — ONLY when `x` is already boolean. `!!x` is `ToBoolean(x)`,
            // so dropping the double-negation is NOT identity for a value (`!!5` is
            // `true`, not `5`) — it's only sound when `x` is boolean-valued (a
            // comparison / inner `!` / boolean literal) or in a boolean context (the
            // if/while/`?:`-test slots, handled by `minimize_cond_slot`). This
            // general value-context path must guard. (Closure keeps `!!a` for
            // unknown `a`; a fuzzer-invisible miscompile the Closure-diff caught.)
            Expression::UnaryExpression(inner)
                if inner.operator == UnaryOperator::LogicalNot
                    && is_boolean_valued(&inner.argument) =>
            {
                Some(inner.argument.take_in(self.alloc()))
            }
            // `!(a == b)` → `a != b` (equality ops only; relational is NaN-unsafe)
            Expression::BinaryExpression(b) => {
                let neg = negate_equality(b.operator)?;
                let left = b.left.take_in(self.alloc());
                let right = b.right.take_in(self.alloc());
                Some(self.ast.expression_binary(SPAN, left, neg, right))
            }
            // NOTE: De Morgan (`!(a||b)` → `!a && !b`) reduces ~19 divergences but a
            // naive distribution broke three.js behavioral parity (precedence edge
            // case). Needs the precedence-safe / cost-based MinimizedCondition port
            // (E2) — see CUTOVER_PLAN §6b. Deferred.
            _ => None,
        }
    }

    fn minimize_hook(&self, c: &mut ConditionalExpression<'a>) -> Option<Expression<'a>> {
        // `c ? a : a` → `a` when `c` is pure (dropping it is sound) and both
        // arms are structurally identical.
        if is_pure(&c.test) && c.consequent.content_eq(&c.alternate) {
            return Some(c.consequent.take_in(self.alloc()));
        }
        let cons = as_bool_lit(&c.consequent);
        let alt = as_bool_lit(&c.alternate);
        match (cons, alt) {
            // `c ? true : false` → `!!c`
            (Some(true), Some(false)) => {
                let test = c.test.take_in(self.alloc());
                Some(self.not(self.not(test)))
            }
            // `c ? false : true` → `!c`
            (Some(false), Some(true)) => {
                let test = c.test.take_in(self.alloc());
                Some(self.not(test))
            }
            _ => None,
        }
    }

    fn not(&self, e: Expression<'a>) -> Expression<'a> {
        self.ast.expression_unary(SPAN, UnaryOperator::LogicalNot, e)
    }

    fn logical(
        &self,
        op: LogicalOperator,
        left: Expression<'a>,
        right: Expression<'a>,
    ) -> Expression<'a> {
        self.ast.expression_logical(SPAN, left, op, right)
    }

    // ── performConditionSubstitutions ───────────────────────────────────────
    // Run boolean-context substitution on a slot, replacing in place and
    // counting when it changed the node. Recurses into nested &&/||/?: the way
    // Closure's `performConditionSubstitutions` does.

    fn subst_in_place(&mut self, slot: &mut Expression<'a>) {
        if self.perform_condition_substitutions(slot) {
            self.count += 1;
        }
    }

    /// Returns `true` if the expression at `slot` was rewritten.
    fn perform_condition_substitutions(&self, slot: &mut Expression<'a>) -> bool {
        match slot {
            Expression::LogicalExpression(l)
                if matches!(l.operator, LogicalOperator::And | LogicalOperator::Or) =>
            {
                let mut changed = self.perform_condition_substitutions(&mut l.left);
                changed |= self.perform_condition_substitutions(&mut l.right);

                // RHS truthiness only when side-effect-free (Closure's
                // `getSideEffectFreeBooleanValue`).
                let rval = if is_pure(&l.right) { as_boolean(&l.right) } else { None };
                if let Some(rval) = rval {
                    let op = l.operator;
                    // x || FALSE → x ;  x && TRUE → x
                    if (op == LogicalOperator::Or && !rval)
                        || (op == LogicalOperator::And && rval)
                    {
                        let left = l.left.take_in(self.alloc());
                        *slot = left;
                        return true;
                    }
                    // x || TRUE → TRUE ;  x && FALSE → FALSE
                    if is_pure(&l.left) {
                        let right = l.right.take_in(self.alloc());
                        *slot = right;
                        return true;
                    }
                    // side-effecting LHS + known RHS → `(x, K)` comma sequence.
                    let left = l.left.take_in(self.alloc());
                    let right = l.right.take_in(self.alloc());
                    let seq = self.ast.vec_from_array([left, right]);
                    *slot = self.ast.expression_sequence(SPAN, seq);
                    return true;
                }
                changed
            }
            Expression::ConditionalExpression(c) => {
                let mut changed = self.perform_condition_substitutions(&mut c.consequent);
                changed |= self.perform_condition_substitutions(&mut c.alternate);

                let t_val = if is_pure(&c.consequent) { as_boolean(&c.consequent) } else { None };
                let f_val = if is_pure(&c.alternate) { as_boolean(&c.alternate) } else { None };

                // x ? true : false → x ;  x ? false : true → !x.
                if t_val == Some(true) && f_val == Some(false) {
                    *slot = c.test.take_in(self.alloc());
                    return true;
                }
                if t_val == Some(false) && f_val == Some(true) {
                    let test = c.test.take_in(self.alloc());
                    *slot = self.not(test);
                    return true;
                }
                // x ? true : y → x || y.
                if t_val == Some(true) {
                    let test = c.test.take_in(self.alloc());
                    let alt = c.alternate.take_in(self.alloc());
                    *slot = self.logical(LogicalOperator::Or, test, alt);
                    return true;
                }
                // x ? y : false → x && y.
                if f_val == Some(false) {
                    let test = c.test.take_in(self.alloc());
                    let cons = c.consequent.take_in(self.alloc());
                    *slot = self.logical(LogicalOperator::And, test, cons);
                    return true;
                }
                // x ? x : y → x || y (pure, identical test/consequent).
                if is_pure(&c.test)
                    && is_pure(&c.consequent)
                    && c.test.content_eq(&c.consequent)
                {
                    let cons = c.consequent.take_in(self.alloc());
                    let alt = c.alternate.take_in(self.alloc());
                    *slot = self.logical(LogicalOperator::Or, cons, alt);
                    return true;
                }
                changed
            }
            _ => false,
        }
    }

    // ── nested if → && ──────────────────────────────────────────────────────
    // `if (x) { if (y) Z; }` → `if (x && y) Z;` when neither if has an else and
    // the outer body is exactly the single inner if.

    fn try_nested_if_to_and(&mut self, stmt: &mut Statement<'a>) {
        let Statement::IfStatement(outer) = stmt else { return };
        if outer.alternate.is_some() {
            return;
        }
        // Outer body must be a block with exactly one statement: an if w/o else.
        let inner_ok = match &outer.consequent {
            Statement::BlockStatement(b) if b.body.len() == 1 => {
                matches!(&b.body[0], Statement::IfStatement(i) if i.alternate.is_none())
            }
            _ => false,
        };
        if !inner_ok {
            return;
        }
        // Extract the inner if.
        let Statement::BlockStatement(block) = &mut outer.consequent else { return };
        let Statement::IfStatement(inner) = block.body[0].take_in(self.alloc()) else {
            return;
        };
        let mut inner = inner.unbox();
        let outer_test = outer.test.take_in(self.alloc());
        let combined = self.logical(LogicalOperator::And, outer_test, inner.test.take_in(self.alloc()));
        outer.test = combined;
        outer.consequent = inner.consequent.take_in(self.alloc());
        self.count += 1;
    }

    // ── tryJoinForCondition ─────────────────────────────────────────────────
    // `for (init; cond; upd) { if (c) break; ...rest }`
    //   → `for (init; cond && !c; upd) { ...rest }`
    // The break-if must be the first body statement, unlabeled break, no else.

    fn try_join_for_condition(&mut self, f: &mut ForStatement<'a>) {
        let Statement::BlockStatement(body) = &mut f.body else { return };
        if body.body.is_empty() {
            return;
        }
        // First statement must be `if (c) break;` (break possibly block-wrapped),
        // no else.
        let first_ok = match &body.body[0] {
            Statement::IfStatement(i) if i.alternate.is_none() => {
                is_unlabeled_break_branch(&i.consequent)
            }
            _ => false,
        };
        if !first_ok {
            return;
        }
        // Take the if's test, drop the break-if statement.
        let Statement::IfStatement(first_if) = body.body.remove(0) else { return };
        let mut first_if = first_if.unbox();
        let negated = self.not(first_if.test.take_in(self.alloc()));
        match &mut f.test {
            Some(test) => {
                let cond = test.take_in(self.alloc());
                f.test = Some(self.logical(LogicalOperator::And, cond, negated));
            }
            None => f.test = Some(negated),
        }
        self.count += 1;
    }
}

/// `break;` or `{ break; }` with no label.
fn is_unlabeled_break_branch(stmt: &Statement) -> bool {
    match stmt {
        Statement::BreakStatement(b) => b.label.is_none(),
        Statement::BlockStatement(b) if b.body.len() == 1 => {
            matches!(&b.body[0], Statement::BreakStatement(br) if br.label.is_none())
        }
        _ => false,
    }
}

/// True if evaluating `e` ALWAYS yields a boolean — so `!!e` ≡ `e` and dropping
/// the double-negation is sound even in a value context. Comparisons, an inner
/// `!`, and boolean literals qualify; a bare identifier / arithmetic does NOT
/// (`!!x` would coerce). Conservative — logical `&&`/`||` return an operand, not
/// necessarily a boolean, so they're excluded.
fn is_boolean_valued(e: &Expression) -> bool {
    match e {
        Expression::BooleanLiteral(_) => true,
        Expression::UnaryExpression(u) => u.operator == UnaryOperator::LogicalNot,
        Expression::BinaryExpression(b) => matches!(
            b.operator,
            BinaryOperator::LessThan
                | BinaryOperator::LessEqualThan
                | BinaryOperator::GreaterThan
                | BinaryOperator::GreaterEqualThan
                | BinaryOperator::Equality
                | BinaryOperator::Inequality
                | BinaryOperator::StrictEquality
                | BinaryOperator::StrictInequality
                | BinaryOperator::In
                | BinaryOperator::Instanceof
        ),
        Expression::ParenthesizedExpression(p) => is_boolean_valued(&p.expression),
        _ => false,
    }
}

fn negate_equality(op: BinaryOperator) -> Option<BinaryOperator> {
    Some(match op {
        BinaryOperator::Equality => BinaryOperator::Inequality,
        BinaryOperator::Inequality => BinaryOperator::Equality,
        BinaryOperator::StrictEquality => BinaryOperator::StrictInequality,
        BinaryOperator::StrictInequality => BinaryOperator::StrictEquality,
        _ => return None,
    })
}

fn as_bool_lit(e: &Expression) -> Option<bool> {
    match e {
        Expression::BooleanLiteral(b) => Some(b.value),
        _ => None,
    }
}



#[cfg(test)]
mod tests {
    use super::*;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;

    fn mc(src: &str) -> (String, u32) {
        let allocator = Allocator::default();
        let mut program = crate::parse_program(&allocator, src, SourceType::ts());
        let n = run(&allocator, &mut program);
        (Codegen::new().build(&program).code.replace('\n', " "), n)
    }

    // ── implemented: `!` push-down over (in)equality, `!!` cancel, boolean
    //    ternary → (double-)negation, HOOK negation-flip ──

    // ── MinimizedCondition (cost-based De Morgan) ──

    #[test]
    fn de_morgan_when_cheaper_in_if_test() {
        // Guard-inversion shape: `!(!a || !b)` → `a && b` (cheaper: fewer `!`,
        // no outer paren). Cost-gated so it only fires when it pays.
        let out = mc("function f(a, b) { if (!(!a || !b)) g(); }").0;
        assert!(out.contains("if (a && b)"), "De Morgan applied:\n{out}");
        assert!(!out.contains("!(!a"), "outer negation removed:\n{out}");
    }

    #[test]
    fn de_morgan_picks_cheaper_form_by_cost() {
        // `!(a && b)`: positive `!(a&&b)` costs 3 (the `!` + paren-pair for the
        // `&&` child); the De Morgan form `!a || !b` costs 2 (two `!`s, no paren).
        // The cost model picks the cheaper `!a || !b`.
        let out = mc("function f(a, b) { if (!(a && b)) g(); }").0;
        assert!(out.contains("!a || !b"), "cost model picks cheaper De Morgan form:\n{out}");
    }

    #[test]
    fn inverts_not_over_equality() {
        assert!(mc("var b = !(a == 1);").0.contains("a != 1"));
        assert!(mc("var b = !(a === 1);").0.contains("a !== 1"));
        assert!(mc("var b = !(a != 1);").0.contains("a == 1"));
        assert!(mc("var b = !(a !== 1);").0.contains("a === 1"));
    }

    #[test]
    fn does_not_invert_not_over_relational() {
        // NaN-unsafe: `!(x < 1)` is NOT `x >= 1` (both false for NaN). Closure
        // and we leave relational comparisons alone.
        assert!(mc("var b = !(a < 1);").0.contains("!(a < 1)"));
    }

    #[test]
    fn cancels_double_negation() {
        // `!!x` for unknown `x` is `ToBoolean(x)`, NOT `x` — must be KEPT in a value
        // context (`!!5` is `true`, not `5`).
        assert!(mc("var b = !!x;").0.contains("!!x"), "value !!x kept: {}", mc("var b = !!x;").0);
        // But a boolean-valued inner cancels: `!!(a < c)` → `a < c`.
        let out = mc("var b = !!(a < c);").0;
        assert!(out.contains("a < c") && !out.contains("!!"), "boolean-valued cancels: {out}");
    }

    #[test]
    fn boolean_ternary_to_negation() {
        assert!(mc("var x = c ? false : true;").0.contains("var x = !c"));
        assert!(mc("var x = c ? true : false;").0.contains("var x = !!c"));
    }

    #[test]
    fn flips_hook_off_a_negated_condition() {
        // `(!(a == b)) ? X : Y` → no surviving double-negation.
        let out = mc("var v = (!(a == b)) ? X : Y;").0;
        assert!(!out.contains("!!"), "no double negation:\n{out}");
    }

    // ── intentional: if/else pairs are NOT collapsed to ternaries (a readability
    //    choice; the downstream minifier does size-collapsing) ──

    #[test]
    fn preserves_if_else_return_shape() {
        let out = mc("function f(c) { if (c) return 1; else return 2; }").0;
        assert!(!out.contains("? 1 : 2") && out.contains("if (c)"), "{out}");
    }

    #[test]
    fn preserves_if_else_assignment_shape() {
        let out = mc("function f(c) { if (c) x = 1; else x = 2; }").0;
        assert!(!out.contains("? 1 : 2") && out.contains("if (c)"), "{out}");
    }

    // ── performConditionSubstitutions in a boolean context ──

    #[test]
    fn condition_substitution_or() {
        // `x ? true : y` → `x || y` (test of an `if` is a boolean context).
        let out = mc("function f(x, y) { if (x ? true : y) sink(); }").0;
        assert!(out.contains("if (x || y)"), "{out}");
    }

    #[test]
    fn condition_substitution_and() {
        // `x ? y : false` → `x && y` (boolean context).
        let out = mc("function f(x, y) { if (x ? y : false) sink(); }").0;
        assert!(out.contains("if (x && y)"), "{out}");
    }

    // ── short-circuit constant fold ──

    #[test]
    fn short_circuit_constant_fold() {
        // `x || true` → `true` (pure x, boolean context).
        let out = mc("function f(x) { if (x || true) sink(); }").0;
        assert!(out.contains("if (true)"), "{out}");
    }

    #[test]
    fn short_circuit_fold_and_false() {
        // `x && false` → `false` (pure x).
        let out = mc("function f(x) { if (x && false) sink(); }").0;
        assert!(out.contains("if (false)"), "{out}");
    }

    #[test]
    fn short_circuit_fold_drops_const_operand() {
        // `x || false` → `x` ;  `x && true` → `x`.
        assert!(mc("function f(x) { while (x || false) sink(); }").0.contains("while (x)"));
        assert!(mc("function f(x) { while (x && true) sink(); }").0.contains("while (x)"));
    }

    #[test]
    fn short_circuit_impure_lhs_becomes_comma() {
        // Side-effecting LHS must be preserved as a `(x, true)` comma sequence.
        let out = mc("function f() { if (g() || true) sink(); }").0;
        assert!(out.contains("g(), true"), "{out}");
    }

    // ── ternary same-arm fold ──

    #[test]
    fn ternary_same_arm_fold() {
        // `c ? 1 : 1` → `1` (pure cond).
        assert!(mc("var x = c ? 1 : 1;").0.contains("var x = 1"));
    }

    #[test]
    fn ternary_same_arm_keeps_impure_cond() {
        // Impure test (`g()`) must NOT be dropped.
        let out = mc("var x = g() ? 1 : 1;").0;
        assert!(out.contains("g() ? 1 : 1"), "{out}");
    }

    // ── nested if → && ──

    #[test]
    fn nested_if_to_and() {
        // `if (x) { if (y) foo(); }` → `if (x && y) foo();`.
        let out = mc("function f(x, y) { if (x) { if (y) foo(); } }").0;
        assert!(out.contains("x && y"), "nested-if join:\n{out}");
    }

    #[test]
    fn nested_if_to_and_skips_with_outer_else() {
        // Outer else present → no join (the else would change meaning).
        let out = mc("function f(x, y) { if (x) { if (y) foo(); } else bar(); }").0;
        assert!(!out.contains("x && y"), "{out}");
    }

    #[test]
    fn nested_if_to_and_skips_with_inner_else() {
        // Inner else present → no join.
        let out = mc("function f(x, y) { if (x) { if (y) foo(); else baz(); } }").0;
        assert!(!out.contains("x && y"), "{out}");
    }

    // ── tryJoinForCondition ──

    #[test]
    fn join_for_condition() {
        // `for (...; i < 10; ...) { if (done()) break; foo(); }`
        //   → for-test becomes `i < 10 && !done()`.
        let out =
            mc("function f() { for (var i = 0; i < 10; i++) { if (done()) break; foo(); } }").0;
        assert!(out.contains("!done()"), "for-header should carry !done():\n{out}");
        assert!(out.contains("i < 10 && !done()"), "{out}");
    }

    #[test]
    fn join_for_condition_no_test() {
        // No existing for-test → the negated break-cond becomes the test.
        let out = mc("function f() { for (;;) { if (done()) break; foo(); } }").0;
        assert!(out.contains("!done()"), "{out}");
    }

    // ── intentional: still NOT ported (readability — downstream minifier does
    //    these). Pins so a future port flips them intentionally. ──

    #[test]
    fn preserves_if_to_and_statement() {
        // `if (x) foo();` is NOT folded to `x && foo();`.
        let out = mc("function f(x) { if (x) foo(); }").0;
        assert!(out.contains("if (x)") && !out.contains("x && foo"), "{out}");
    }

    // ── value-context &&/|| must NOT be simplified by boolean-only rules ──

    #[test]
    fn value_context_or_rhs_not_simplified() {
        // `A || (p || 1)` in a return position: `p || 1` is NOT in boolean context
        // — `p`'s VALUE matters (if p is truthy it is returned). Must not fold to
        // `A || 1` (dropping `p`). The flattened form `q < 0 || p || 1` (same
        // semantics, parentheses dropped) is acceptable.
        let out = mc("function f(p, q) { return (q < 0) || (p || 1); }").0;
        // `p` must still appear as an operand in the return value.
        assert!(out.contains("p || 1"), "p must still be in result:\n{out}");
    }

    #[test]
    fn value_context_and_rhs_const_not_folded() {
        // `p && (q && 5)` in return: `q && 5` returns `q` (falsy) or `5` (truthy).
        // Boolean-only fold `x && TRUE → x` (dropping the `5`) is wrong here.
        let out = mc("function f(p, q) { return p && (q && 5); }").0;
        assert!(out.contains("q && 5"), "q&&5 preserved:\n{out}");
    }

    #[test]
    fn value_context_and_rhs_ternary_not_rewritten() {
        // `p && (p ? 1 : q)`: the ternary is NOT in boolean context; `x ? truthy : y`
        // → `x || y` is wrong here (changes the returned value from `1` to `p`).
        let out = mc("function f(p, q) { return p && (p ? 1 : q); }").0;
        assert!(out.contains("p ? 1 : q") || out.contains("p?1:q"), "ternary preserved:\n{out}");
        assert!(!out.contains("p || q"), "must not rewrite to p||q:\n{out}");
    }

    #[test]
    fn boolean_context_and_nested_ternary_still_simplified() {
        // `if ((x ? true : y) && z)` — the ternary IS in boolean context (as test of
        // `&&` which is test of `if`). `x ? true : y` → `x || y` must still fire.
        let out = mc("function f(x, y, z) { if ((x ? true : y) && z) sink(); }").0;
        assert!(out.contains("x || y") || out.contains("(x||y)"), "boolean-ctx ternary simplified:\n{out}");
    }
}
