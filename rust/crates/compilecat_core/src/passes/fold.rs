//! Port of `src/compiler/peephole-fold-constants.ts` (Closure
//! PeepholeFoldConstants subset). Bottom-up single pass; folds statically
//! computable expressions.
//!
//! Covered: numeric arithmetic, bitwise/shift, numeric identities (x+0, x*1, …
//! when the kept side is pure), string concat, unary -/+/!/~/typeof, logical
//! &&/||/?? on a known LHS, literal-literal comparisons, bigint arithmetic
//! (`+ - *`) and bigint comparisons on literal operands, and optional-chain
//! folding (`null?.x` → `undefined`) over oxc's `ChainExpression`.
//!
//! Deferred (TODO): regex / object / array literals as operands (no concrete
//! behavior to port yet), tagged templates, bigint `/` `%` `**` and
//! bitwise/shift on bigint.

use oxc_allocator::{Allocator, TakeIn};
use oxc_ast::ast::*;
use oxc_ast::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::{GetSpan, SPAN};

use super::gate::Gate;
use super::util::{as_boolean, is_pure};

/// Returns the number of nodes folded. `gate` restricts mutation to opted-in
/// functions (worklist #4); `run` is the ungated whole-program entry.
pub fn run<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> u32 {
    run_with(allocator, program, Gate::ungated())
}

pub fn run_with<'a>(allocator: &'a Allocator, program: &mut Program<'a>, gate: Gate) -> u32 {
    let mut v = Folder { ast: AstBuilder::new(allocator), folded: 0, gate };
    v.visit_program(program);
    v.folded
}

struct Folder<'a> {
    ast: AstBuilder<'a>,
    folded: u32,
    gate: Gate,
}

impl<'a> VisitMut<'a> for Folder<'a> {
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
        let s = self.gate.enter_scope(stmt.span().start);
        walk_mut::walk_statement(self, stmt);
        self.gate.exit(s);
    }
    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        // Bottom-up: fold children first, then this node.
        walk_mut::walk_expression(self, expr);
        if self.gate.active {
            if let Some(replacement) = self.fold(expr) {
                *expr = replacement;
                self.folded += 1;
            }
        }
    }
}

impl<'a> Folder<'a> {
    fn fold(&self, expr: &mut Expression<'a>) -> Option<Expression<'a>> {
        match expr {
            Expression::UnaryExpression(_) => self.fold_unary(expr),
            Expression::BinaryExpression(_) => self.fold_binary(expr),
            Expression::LogicalExpression(_) => self.fold_logical(expr),
            Expression::ChainExpression(_) => self.fold_chain(expr),
            _ => None,
        }
    }

    // ── builders ────────────────────────────────────────────────────────────

    /// Closure's `numericLiteral`: negative values become `-<lit>` (UnaryNegation
    /// over a positive literal), the canonical oxc shape.
    fn num(&self, value: f64) -> Expression<'a> {
        if value < 0.0 {
            let lit = self.ast.expression_numeric_literal(SPAN, -value, None, NumberBase::Decimal);
            self.ast.expression_unary(SPAN, UnaryOperator::UnaryNegation, lit)
        } else {
            self.ast.expression_numeric_literal(SPAN, value, None, NumberBase::Decimal)
        }
    }

    fn string(&self, value: &str) -> Expression<'a> {
        self.ast.expression_string_literal(SPAN, self.ast.str(value), None)
    }

    fn boolean(&self, value: bool) -> Expression<'a> {
        self.ast.expression_boolean_literal(SPAN, value)
    }

    /// Build a `BigIntLiteral` from an `i128`. oxc stores the value as a base-10
    /// string with no underscores and codegen appends the `n` suffix (and wraps
    /// negatives in parens where precedence requires).
    fn bigint(&self, value: i128) -> Expression<'a> {
        let s = self.ast.str(&value.to_string());
        self.ast.expression_big_int_literal(SPAN, s, None, BigintBase::Decimal)
    }

    // ── unary ───────────────────────────────────────────────────────────────

    fn fold_unary(&self, expr: &mut Expression<'a>) -> Option<Expression<'a>> {
        let Expression::UnaryExpression(u) = expr else { return None };
        match u.operator {
            UnaryOperator::Typeof => typeof_literal(&u.argument).map(|s| self.string(s)),
            UnaryOperator::LogicalNot => as_boolean(&u.argument).map(|b| self.boolean(!b)),
            UnaryOperator::UnaryNegation => {
                // `-<numeric>` is already canonical — leave it.
                if matches!(&u.argument, Expression::NumericLiteral(_)) {
                    return None;
                }
                // `-(-x)` on a literal → x
                if let Expression::UnaryExpression(inner) = &u.argument {
                    if inner.operator == UnaryOperator::UnaryNegation {
                        if let Expression::NumericLiteral(lit) = &inner.argument {
                            return Some(self.num(lit.value));
                        }
                    }
                }
                None
            }
            UnaryOperator::UnaryPlus => match &mut u.argument {
                Expression::StringLiteral(s) => {
                    let v: f64 = s.value.parse().ok()?;
                    if v.is_finite() {
                        Some(self.num(v))
                    } else {
                        None
                    }
                }
                Expression::NumericLiteral(_) => Some(u.argument.take_in(self.ast.allocator)),
                Expression::BooleanLiteral(b) => Some(self.num(if b.value { 1.0 } else { 0.0 })),
                _ => None,
            },
            UnaryOperator::BitwiseNot => {
                let v = as_numeric(&u.argument)?;
                Some(self.num(f64::from(!to_int32(v))))
            }
            _ => None,
        }
    }

    // ── binary ──────────────────────────────────────────────────────────────

    fn fold_binary(&self, expr: &mut Expression<'a>) -> Option<Expression<'a>> {
        let Expression::BinaryExpression(b) = expr else { return None };
        let op = b.operator;

        // BigInt: both operands must be bigint literals (bigint never mixes with
        // number at runtime). Covers `+ - *` (with exact i128 arithmetic; bail on
        // overflow) and comparisons; `/ % **` and bitwise/shift are deferred.
        if let (Some(l), Some(r)) = (as_bigint(&b.left), as_bigint(&b.right)) {
            if let Some(v) = eval_bigint_binary(op, l, r) {
                return Some(self.bigint(v));
            }
            if let Some(c) = eval_bigint_comparison(op, l, r) {
                return Some(self.boolean(c));
            }
            return None;
        }

        let lv = as_numeric(&b.left);
        let rv = as_numeric(&b.right);

        // Numeric arithmetic.
        if let (Some(l), Some(r)) = (lv, rv) {
            if let Some(folded) = eval_numeric_binary(op, l, r) {
                if folded.is_finite() {
                    return Some(self.num(folded));
                }
            }
        }

        // String concat.
        if op == BinaryOperator::Addition {
            match (&b.left, &b.right) {
                (Expression::StringLiteral(l), Expression::StringLiteral(r)) => {
                    return Some(self.string(&format!("{}{}", l.value, r.value)));
                }
                (Expression::StringLiteral(l), _) if rv.is_some() => {
                    return Some(self.string(&format!(
                        "{}{}",
                        l.value,
                        js_num_to_string(rv.unwrap())
                    )));
                }
                (_, Expression::StringLiteral(r)) if lv.is_some() => {
                    return Some(self.string(&format!(
                        "{}{}",
                        js_num_to_string(lv.unwrap()),
                        r.value
                    )));
                }
                _ => {}
            }
        }

        // Identities (drop one side — only when the kept side is pure).
        let alloc = self.ast.allocator;
        let keep_left = rv == Some(0.0) && op == BinaryOperator::Addition && is_pure(&b.left)
            || rv == Some(0.0) && op == BinaryOperator::Subtraction && is_pure(&b.left)
            || rv == Some(1.0) && op == BinaryOperator::Multiplication && is_pure(&b.left)
            || rv == Some(1.0) && op == BinaryOperator::Division && is_pure(&b.left);
        let keep_right = lv == Some(0.0) && op == BinaryOperator::Addition && is_pure(&b.right)
            || lv == Some(1.0) && op == BinaryOperator::Multiplication && is_pure(&b.right);
        if keep_left {
            return Some(b.left.take_in(alloc));
        }
        if keep_right {
            return Some(b.right.take_in(alloc));
        }

        // Comparisons on literal-literal.
        eval_comparison(op, &b.left, &b.right).map(|c| self.boolean(c))
    }

    // ── logical ─────────────────────────────────────────────────────────────

    fn fold_logical(&self, expr: &mut Expression<'a>) -> Option<Expression<'a>> {
        let Expression::LogicalExpression(l) = expr else { return None };
        match l.operator {
            LogicalOperator::And => match as_boolean(&l.left) {
                Some(false) if is_pure(&l.left) => Some(l.left.take_in(self.ast.allocator)),
                Some(true) if is_pure(&l.left) => Some(l.right.take_in(self.ast.allocator)),
                _ => None,
            },
            LogicalOperator::Or => match as_boolean(&l.left) {
                Some(true) if is_pure(&l.left) => Some(l.left.take_in(self.ast.allocator)),
                Some(false) if is_pure(&l.left) => Some(l.right.take_in(self.ast.allocator)),
                _ => None,
            },
            LogicalOperator::Coalesce => {
                if is_nullish(&l.left) {
                    Some(l.right.take_in(self.ast.allocator))
                } else if matches!(
                    &l.left,
                    Expression::NumericLiteral(_)
                        | Expression::StringLiteral(_)
                        | Expression::BooleanLiteral(_)
                ) && is_pure(&l.left)
                {
                    Some(l.left.take_in(self.ast.allocator))
                } else {
                    None
                }
            }
        }
    }

    // ── optional chain ────────────────────────────────────────────────────────

    /// Fold an optional chain whose *leading* base is a `null`/`undefined`
    /// literal to `undefined`.
    ///
    /// oxc models `a?.b?.c` / `null?.foo` / `null?.()` as a single
    /// `ChainExpression` wrapping nested member/call expressions. We descend the
    /// `object`/`callee` spine to the leading base; we only fold when (a) that
    /// base is literally `null`/`undefined`, and (b) the chain contains at least
    /// one `optional: true` link (so a bare `({}).foo` — not a chain — and a
    /// chain with an unknown head like `a?.b?.c` are both left untouched).
    fn fold_chain(&self, expr: &mut Expression<'a>) -> Option<Expression<'a>> {
        let Expression::ChainExpression(chain) = expr else { return None };
        let mut node: &Expression = chain_element_object(&chain.expression)?;
        let mut saw_optional = chain_element_is_optional(&chain.expression);
        // Walk the spine to the leading base.
        loop {
            match node {
                Expression::StaticMemberExpression(m) => {
                    saw_optional |= m.optional;
                    node = &m.object;
                }
                Expression::ComputedMemberExpression(m) => {
                    saw_optional |= m.optional;
                    node = &m.object;
                }
                Expression::PrivateFieldExpression(m) => {
                    saw_optional |= m.optional;
                    node = &m.object;
                }
                Expression::CallExpression(c) => {
                    saw_optional |= c.optional;
                    node = &c.callee;
                }
                other => {
                    if saw_optional && is_nullish(other) {
                        return Some(self.ast.expression_identifier(SPAN, "undefined"));
                    }
                    return None;
                }
            }
        }
    }
}

/// The `object`/`callee` of the outermost element of a `ChainExpression`.
fn chain_element_object<'a, 'b>(el: &'b ChainElement<'a>) -> Option<&'b Expression<'a>> {
    Some(match el {
        ChainElement::CallExpression(c) => &c.callee,
        ChainElement::StaticMemberExpression(m) => &m.object,
        ChainElement::ComputedMemberExpression(m) => &m.object,
        ChainElement::PrivateFieldExpression(m) => &m.object,
        ChainElement::TSNonNullExpression(_) => return None,
    })
}

fn chain_element_is_optional(el: &ChainElement) -> bool {
    match el {
        ChainElement::CallExpression(c) => c.optional,
        ChainElement::StaticMemberExpression(m) => m.optional,
        ChainElement::ComputedMemberExpression(m) => m.optional,
        ChainElement::PrivateFieldExpression(m) => m.optional,
        ChainElement::TSNonNullExpression(_) => false,
    }
}

// ── value helpers ───────────────────────────────────────────────────────────

fn as_numeric(e: &Expression) -> Option<f64> {
    match e {
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

/// A bigint literal's exact value as `i128`, handling a leading unary `-`.
/// Returns `None` if the literal doesn't fit in `i128` (we bail rather than
/// fold inexactly). oxc stores `value` as a base-10 string with no underscores.
fn as_bigint(e: &Expression) -> Option<i128> {
    match e {
        Expression::BigIntLiteral(lit) => lit.value.as_str().parse::<i128>().ok(),
        Expression::UnaryExpression(u) if u.operator == UnaryOperator::UnaryNegation => {
            if let Expression::BigIntLiteral(lit) = &u.argument {
                lit.value.as_str().parse::<i128>().ok().and_then(i128::checked_neg)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn is_nullish(e: &Expression) -> bool {
    matches!(e, Expression::NullLiteral(_))
        || matches!(e, Expression::Identifier(id) if id.name == "undefined")
}

fn typeof_literal(e: &Expression) -> Option<&'static str> {
    Some(match e {
        Expression::StringLiteral(_) => "string",
        Expression::NumericLiteral(_) => "number",
        Expression::BooleanLiteral(_) => "boolean",
        Expression::NullLiteral(_) => "object",
        Expression::Identifier(id) if id.name == "undefined" => "undefined",
        Expression::FunctionExpression(_) | Expression::ArrowFunctionExpression(_) => "function",
        _ => return None,
    })
}

fn eval_numeric_binary(op: BinaryOperator, l: f64, r: f64) -> Option<f64> {
    Some(match op {
        BinaryOperator::Addition => l + r,
        BinaryOperator::Subtraction => l - r,
        BinaryOperator::Multiplication => l * r,
        BinaryOperator::Division => {
            if r == 0.0 {
                return None;
            }
            l / r
        }
        BinaryOperator::Remainder => {
            if r == 0.0 {
                return None;
            }
            l % r
        }
        BinaryOperator::Exponential => l.powf(r),
        BinaryOperator::BitwiseAnd => f64::from(to_int32(l) & to_int32(r)),
        BinaryOperator::BitwiseOR => f64::from(to_int32(l) | to_int32(r)),
        BinaryOperator::BitwiseXOR => f64::from(to_int32(l) ^ to_int32(r)),
        // JS masks the shift count to 5 bits.
        BinaryOperator::ShiftLeft => f64::from(to_int32(l).wrapping_shl(to_uint32(r) & 31)),
        BinaryOperator::ShiftRight => f64::from(to_int32(l).wrapping_shr(to_uint32(r) & 31)),
        BinaryOperator::ShiftRightZeroFill => {
            f64::from(to_uint32(l).wrapping_shr(to_uint32(r) & 31))
        }
        _ => return None,
    })
}

/// BigInt `+ - *` on exact `i128` operands. Returns `None` on overflow (bail
/// rather than wrap) or for unsupported operators (`/ % **`, bitwise/shift).
fn eval_bigint_binary(op: BinaryOperator, l: i128, r: i128) -> Option<i128> {
    match op {
        BinaryOperator::Addition => l.checked_add(r),
        BinaryOperator::Subtraction => l.checked_sub(r),
        BinaryOperator::Multiplication => l.checked_mul(r),
        _ => None,
    }
}

/// BigInt comparisons on exact `i128` operands. Equality/relational on bigint is
/// total (no NaN), so these are always sound.
fn eval_bigint_comparison(op: BinaryOperator, l: i128, r: i128) -> Option<bool> {
    Some(match op {
        BinaryOperator::Equality | BinaryOperator::StrictEquality => l == r,
        BinaryOperator::Inequality | BinaryOperator::StrictInequality => l != r,
        BinaryOperator::LessThan => l < r,
        BinaryOperator::LessEqualThan => l <= r,
        BinaryOperator::GreaterThan => l > r,
        BinaryOperator::GreaterEqualThan => l >= r,
        _ => return None,
    })
}

fn eval_comparison(op: BinaryOperator, left: &Expression, right: &Expression) -> Option<bool> {
    if let (Some(l), Some(r)) = (as_numeric(left), as_numeric(right)) {
        return Some(match op {
            BinaryOperator::LessThan => l < r,
            BinaryOperator::LessEqualThan => l <= r,
            BinaryOperator::GreaterThan => l > r,
            BinaryOperator::GreaterEqualThan => l >= r,
            BinaryOperator::Equality | BinaryOperator::StrictEquality => l == r,
            BinaryOperator::Inequality | BinaryOperator::StrictInequality => l != r,
            _ => return None,
        });
    }
    if let (Expression::StringLiteral(l), Expression::StringLiteral(r)) = (left, right) {
        let (l, r) = (l.value.as_str(), r.value.as_str());
        return Some(match op {
            BinaryOperator::Equality | BinaryOperator::StrictEquality => l == r,
            BinaryOperator::Inequality | BinaryOperator::StrictInequality => l != r,
            BinaryOperator::LessThan => l < r,
            BinaryOperator::LessEqualThan => l <= r,
            BinaryOperator::GreaterThan => l > r,
            BinaryOperator::GreaterEqualThan => l >= r,
            _ => return None,
        });
    }
    if let (Expression::BooleanLiteral(l), Expression::BooleanLiteral(r)) = (left, right) {
        return Some(match op {
            BinaryOperator::Equality | BinaryOperator::StrictEquality => l.value == r.value,
            BinaryOperator::Inequality | BinaryOperator::StrictInequality => l.value != r.value,
            _ => return None,
        });
    }
    None
}

// JS ToInt32 / ToUint32 (ECMA-262 §7.1) — fold semantics must match runtime.
fn to_uint32(n: f64) -> u32 {
    if !n.is_finite() || n == 0.0 {
        return 0;
    }
    let n = n.trunc();
    let two32 = 4_294_967_296.0_f64;
    let mut m = n % two32;
    if m < 0.0 {
        m += two32;
    }
    m as u32
}

fn to_int32(n: f64) -> i32 {
    to_uint32(n) as i32
}

/// JS `String(n)` for the cases fold produces — integers print without a
/// decimal point. Non-integers fall back to Rust's shortest round-trip, which
/// matches JS for the common range. (Full ToString parity is a TODO.)
fn js_num_to_string(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
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
    fn typeof_literal_folds_to_type_string() {
        let (out, n) = f(r#"var t = typeof "x";"#);
        assert!(out.contains(r#"var t = "string""#), "got: {out}");
        assert_eq!(n, 1);
        assert!(f("var t = typeof 1;").0.contains(r#"var t = "number""#));
        assert!(f("var t = typeof true;").0.contains(r#"var t = "boolean""#));
    }

    #[test]
    fn logical_not_folds_to_boolean() {
        assert!(f("var b = !0;").0.contains("var b = true"));
        assert!(f("var b = !1;").0.contains("var b = false"));
        assert!(f(r#"var b = !"";"#).0.contains("var b = true"));
    }

    #[test]
    fn unary_plus_string_to_number() {
        let (out, n) = f(r#"var n = +"123";"#);
        assert!(out.contains("var n = 123"), "got: {out}");
        assert_eq!(n, 1);
    }

    #[test]
    fn double_negation_of_literal() {
        let (out, n) = f("var x = -(-5);");
        assert!(out.contains("var x = 5"), "got: {out}");
        assert_eq!(n, 1);
    }

    #[test]
    fn numeric_comparisons() {
        let (out, n) = f("var a = 1 < 2, b = 2 === 2, c = 5 <= 4;");
        assert!(
            out.contains("a = true") && out.contains("b = true") && out.contains("c = false"),
            "got: {out}"
        );
        assert_eq!(n, 3);
    }

    #[test]
    fn string_comparisons() {
        let (out, n) = f(r#"var a = "a" === "a", b = "a" < "b";"#);
        assert!(out.contains("a = true") && out.contains("b = true"), "got: {out}");
        assert_eq!(n, 2);
    }

    #[test]
    fn non_literal_add_not_folded() {
        let (out, n) = f("function f(a, b) { return a + b; }");
        assert!(out.contains("return a + b"), "got: {out}");
        assert_eq!(n, 0);
    }

    // ── bigint arithmetic ────────────────────────────────────────────────────

    #[test]
    fn folds_bigint_arithmetic() {
        let (out, n) = f("var x = 1n + 2n;");
        assert!(out.contains("var x = 3n"), "got: {out}");
        assert_eq!(n, 1);

        assert!(f("var x = 5n - 3n;").0.contains("var x = 2n"));
        assert!(f("var x = 4n * 3n;").0.contains("var x = 12n"));
        // Negative-result subtraction.
        assert!(f("var x = 1n - 4n;").0.contains("var x = -3n"));
        // Comparisons.
        assert!(f("var b = 1n === 1n;").0.contains("var b = true"));
        assert!(f("var b = 1n !== 2n;").0.contains("var b = true"));
        assert!(f("var b = 2n > 1n;").0.contains("var b = true"));
        assert!(f("var b = 2n <= 1n;").0.contains("var b = false"));
    }

    #[test]
    fn bigint_unsupported_ops_left_alone() {
        // `/ % **` and bitwise/shift on bigint are deferred — must not fold or
        // crash, and must never coerce to Number arithmetic.
        let (out, n) = f("var x = 6n / 2n;");
        assert!(out.contains("6n / 2n"), "got: {out}");
        assert_eq!(n, 0);
        // Mixed bigint/number is a runtime TypeError — never fold it.
        assert_eq!(f("var x = 1n + 2;").1, 0);
    }

    // ── optional chain ───────────────────────────────────────────────────────

    #[test]
    fn folds_optional_chain_on_nullish_base() {
        // Nullish leading base → whole chain folds to `undefined`.
        let (out, n) = f("var x = null?.foo;");
        assert!(out.contains("var x = undefined"), "got: {out}");
        assert_eq!(n, 1);
        assert!(f("var x = undefined?.foo;").0.contains("var x = undefined"));
        assert!(f("var x = null?.();").0.contains("var x = undefined"));
        assert!(f("var x = null?.bar();").0.contains("var x = undefined"));

        // Non-nullish / unknown leading base → left untouched.
        assert_eq!(f("var x = a?.b;").1, 0);
        assert_eq!(f("var x = a?.b?.c;").1, 0);
        assert!(f("var x = ({})?.foo;").0.contains("?."));
    }
}
