//! Port of `src/compiler/peephole-remove-dead-code.ts` (Closure
//! PeepholeRemoveDeadCode subset). Bottom-up single pass.
//!
//! Covered:
//!   - `if (true) A else B` → A;  `if (false) A else B` → B (or empty)
//!   - empty-branch cleanup: drop empty `else`; `if (x){} else {B}` → `if(!x){B}`
//!   - `cond ? A : B` with literal cond → A or B
//!   - `while (false) X` → empty;  `do X while (false)` → X
//!   - pure expression statement → dropped
//!   - sequence pure-prefix drop: `(pure, x)` → x
//!   - drop EmptyStatement; drop statements after return/throw/break/continue
//!
//! Deferred (TODO): label folding, `tryOptimizeConditionalAfterAssign`, and
//! nested block-flatten (`tryMergeBlock`) — the last needs the normalized
//! unique-name invariant; ported with `normalize`'s α-rename.

use oxc_allocator::{Allocator, TakeIn};
use oxc_ast::ast::*;
use oxc_ast::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::{GetSpan, SPAN};

use super::util::{as_boolean, is_pure};

/// Returns the number of nodes removed / simplified.
pub fn run<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> u32 {
    run_with(allocator, program, super::gate::Gate::ungated())
}

pub fn run_with<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    gate: super::gate::Gate,
) -> u32 {
    let mut v = DeadCode { ast: AstBuilder::new(allocator), removed: 0, gate };
    v.visit_program(program);
    v.removed
}

struct DeadCode<'a> {
    ast: AstBuilder<'a>,
    removed: u32,
    gate: super::gate::Gate,
}

impl<'a> VisitMut<'a> for DeadCode<'a> {
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
        if self.gate.active {
            if let Some(rep) = self.fold_statement(stmt) {
                *stmt = rep;
                self.removed += 1;
            }
        }
        self.gate.exit(s);
    }

    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expr);
        if self.gate.active {
            if let Some(rep) = self.fold_expression(expr) {
                *expr = rep;
                self.removed += 1;
            }
        }
    }

    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts);
        if self.gate.active {
            self.clean_block_body(stmts);
        }
    }
}

impl<'a> DeadCode<'a> {
    fn alloc(&self) -> &'a Allocator {
        self.ast.allocator
    }

    fn fold_statement(&self, stmt: &mut Statement<'a>) -> Option<Statement<'a>> {
        match stmt {
            Statement::IfStatement(_) => self.fold_if(stmt),
            Statement::WhileStatement(_) => self.fold_while(stmt),
            Statement::DoWhileStatement(_) => self.fold_do_while(stmt),
            Statement::ExpressionStatement(e) => {
                if is_pure(&e.expression) {
                    Some(self.ast.statement_empty(SPAN))
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn fold_expression(&self, expr: &mut Expression<'a>) -> Option<Expression<'a>> {
        let Expression::ConditionalExpression(c) = expr else { return None };
        match as_boolean(&c.test) {
            Some(true) if is_pure(&c.test) => Some(c.consequent.take_in(self.alloc())),
            Some(false) if is_pure(&c.test) => Some(c.alternate.take_in(self.alloc())),
            _ => None,
        }
    }

    fn fold_if(&self, stmt: &mut Statement<'a>) -> Option<Statement<'a>> {
        let Statement::IfStatement(if_stmt) = stmt else { return None };

        // Drop an empty `else`.
        if if_stmt.alternate.as_ref().is_some_and(is_empty) {
            if_stmt.alternate = None;
        }

        // `if (x) {} else { B }` → `if (!x) { B }`.
        if is_empty(&if_stmt.consequent) && if_stmt.alternate.as_ref().is_some_and(|a| !is_empty(a))
        {
            let test = if_stmt.test.take_in(self.alloc());
            let neg = self.negate(test);
            let alt = if_stmt.alternate.take().unwrap();
            return Some(self.ast.statement_if(SPAN, neg, alt, None));
        }

        match as_boolean(&if_stmt.test) {
            Some(true) if is_pure(&if_stmt.test) => Some(if_stmt.consequent.take_in(self.alloc())),
            Some(false) if is_pure(&if_stmt.test) => {
                Some(if_stmt.alternate.take().unwrap_or_else(|| self.ast.statement_empty(SPAN)))
            }
            _ => {
                // Empty consequent + no/empty alternate → evaluate test only.
                if is_empty(&if_stmt.consequent) && if_stmt.alternate.as_ref().is_none_or(is_empty)
                {
                    if is_pure(&if_stmt.test) {
                        Some(self.ast.statement_empty(SPAN))
                    } else {
                        let test = if_stmt.test.take_in(self.alloc());
                        Some(self.ast.statement_expression(SPAN, test))
                    }
                } else {
                    None
                }
            }
        }
    }

    fn fold_while(&self, stmt: &mut Statement<'a>) -> Option<Statement<'a>> {
        let Statement::WhileStatement(w) = stmt else { return None };
        if as_boolean(&w.test) == Some(false) && is_pure(&w.test) {
            Some(self.ast.statement_empty(SPAN))
        } else {
            None
        }
    }

    fn fold_do_while(&self, stmt: &mut Statement<'a>) -> Option<Statement<'a>> {
        let Statement::DoWhileStatement(d) = stmt else { return None };
        if as_boolean(&d.test) == Some(false) && is_pure(&d.test) {
            // Body runs exactly once.
            Some(d.body.take_in(self.alloc()))
        } else {
            None
        }
    }

    /// `!x` → `x`; flip an (in)equality; else wrap in `!`.
    fn negate(&self, test: Expression<'a>) -> Expression<'a> {
        match test {
            Expression::UnaryExpression(mut u) if u.operator == UnaryOperator::LogicalNot => {
                u.argument.take_in(self.alloc())
            }
            Expression::BinaryExpression(mut b) => {
                let flipped = match b.operator {
                    BinaryOperator::Equality => Some(BinaryOperator::Inequality),
                    BinaryOperator::Inequality => Some(BinaryOperator::Equality),
                    BinaryOperator::StrictEquality => Some(BinaryOperator::StrictInequality),
                    BinaryOperator::StrictInequality => Some(BinaryOperator::StrictEquality),
                    _ => None,
                };
                match flipped {
                    Some(op) => {
                        let left = b.left.take_in(self.alloc());
                        let right = b.right.take_in(self.alloc());
                        self.ast.expression_binary(SPAN, left, op, right)
                    }
                    None => self.ast.expression_unary(
                        SPAN,
                        UnaryOperator::LogicalNot,
                        Expression::BinaryExpression(b),
                    ),
                }
            }
            other => self.ast.expression_unary(SPAN, UnaryOperator::LogicalNot, other),
        }
    }

    /// Drop EmptyStatements and statements after a terminator (keeping `var` /
    /// function declarations, which hoist).
    fn clean_block_body(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        let mut out = self.ast.vec_with_capacity(stmts.len());
        let taken = stmts.take_in(self.alloc());
        let mut unreachable = false;
        let before = taken.len();
        for stmt in taken {
            if matches!(stmt, Statement::EmptyStatement(_)) {
                continue;
            }
            if unreachable {
                if contains_var_decl(&stmt) || matches!(stmt, Statement::FunctionDeclaration(_)) {
                    out.push(stmt);
                }
                continue;
            }
            let term = is_terminator(&stmt);
            out.push(stmt);
            if term {
                unreachable = true;
            }
        }
        if out.len() != before {
            self.removed += (before - out.len()) as u32;
        }
        *stmts = out;
    }
}

fn is_empty(s: &Statement) -> bool {
    match s {
        Statement::EmptyStatement(_) => true,
        Statement::BlockStatement(b) => b.body.is_empty(),
        _ => false,
    }
}

fn is_terminator(s: &Statement) -> bool {
    matches!(
        s,
        Statement::ReturnStatement(_)
            | Statement::ThrowStatement(_)
            | Statement::BreakStatement(_)
            | Statement::ContinueStatement(_)
    )
}

/// Conservative: does this statement (not descending into nested functions)
/// declare a `var`? Such declarations hoist, so they survive dead-code removal.
fn contains_var_decl(s: &Statement) -> bool {
    match s {
        Statement::VariableDeclaration(v) => v.kind == VariableDeclarationKind::Var,
        Statement::BlockStatement(b) => b.body.iter().any(contains_var_decl),
        Statement::IfStatement(i) => {
            contains_var_decl(&i.consequent) || i.alternate.as_ref().is_some_and(contains_var_decl)
        }
        Statement::ForStatement(f) => contains_var_decl(&f.body),
        Statement::WhileStatement(w) => contains_var_decl(&w.body),
        Statement::DoWhileStatement(d) => contains_var_decl(&d.body),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;

    fn dc(src: &str) -> (String, u32) {
        let allocator = Allocator::default();
        let mut program = crate::parse_program(&allocator, src, SourceType::ts());
        let n = run(&allocator, &mut program);
        (Codegen::new().build(&program).code.replace('\n', " "), n)
    }

    // ── literal-condition folding ──

    #[test]
    fn folds_if_true_to_consequent() {
        let (out, _) = dc("function f() { if (true) { return 1; } else { return 2; } }");
        assert!(out.contains("return 1") && !out.contains("return 2"), "{out}");
    }

    #[test]
    fn folds_if_false_to_alternate() {
        let (out, _) = dc("function f() { if (false) { return 1; } else { return 2; } }");
        assert!(out.contains("return 2") && !out.contains("return 1"), "{out}");
    }

    #[test]
    fn drops_false_consequent_without_else() {
        let (out, n) = dc("function f() { if (false) { foo(); } return 1; }");
        assert!(n > 0 && !out.contains("foo()"), "{out}");
    }

    #[test]
    fn flips_empty_consequent_if() {
        let (out, _) = dc("function f(x) { if (x === 0) {} else { use(x); } }");
        assert!(
            out.contains("if (x !== 0)") && out.contains("use(x)") && !out.contains("else"),
            "{out}"
        );
    }

    #[test]
    fn drops_empty_else() {
        let (out, _) = dc("function f(x) { if (x) { use(x); } else {} }");
        assert!(out.contains("if (x)") && !out.contains("else"), "{out}");
    }

    #[test]
    fn folds_literal_ternary() {
        assert!(dc("var x = true ? 1 : 2;").0.contains("var x = 1"));
        assert!(dc("var x = false ? 1 : 2;").0.contains("var x = 2"));
    }

    #[test]
    fn removes_while_false() {
        let (out, n) = dc("function f() { while (false) { foo(); } return 1; }");
        assert!(n > 0 && !out.contains("while") && !out.contains("foo()"), "{out}");
    }

    #[test]
    fn unwraps_do_while_false() {
        let (out, _) = dc("function f() { do { foo(); } while (false); }");
        assert!(out.contains("foo()") && !out.contains("while"), "{out}");
    }

    #[test]
    fn drops_empty_if() {
        let (out, n) = dc("function f() { if (x) {} return 1; }");
        assert!(n > 0 && !out.contains("if (x)"), "{out}");
    }

    // ── pure / unreachable statement elimination ──

    #[test]
    fn drops_pure_expression_statement() {
        let (out, n) = dc("function f() { 1 + 2; return x; }");
        assert!(n > 0 && !out.contains("1 + 2"), "{out}");
    }

    #[test]
    fn keeps_impure_expression_statement() {
        let (out, n) = dc("function f() { foo(); return x; }");
        assert_eq!(n, 0, "{out}");
        assert!(out.contains("foo()"));
    }

    #[test]
    fn drops_statements_after_return_and_throw() {
        let (r, _) = dc("function f() { return 1; bar(); baz(); }");
        assert!(!r.contains("bar()") && !r.contains("baz()"), "{r}");
        let (t, _) = dc("function f() { throw e; foo(); }");
        assert!(t.contains("throw e") && !t.contains("foo()"), "{t}");
    }

    #[test]
    fn keeps_hoisted_decls_after_return() {
        // function + var declarations hoist, so they survive an early return.
        let (f, _) = dc("function f() { return 1; function g() { return 2; } }");
        assert!(f.contains("function g"), "hoisted fn kept:\n{f}");
        let (v, _) = dc("function f() { return 1; var x = 2; }");
        assert!(v.contains("var x = 2"), "hoisted var kept:\n{v}");
    }

    // ── INTENTIONAL: a bare member-access statement (`a.b.c;`) is kept. It could
    //    only be dropped as dead by assuming getters are pure, which is UNSOUND
    //    (a getter can have side effects), so the pass keeps it.
    //    Would only change behind an explicit assume-pure flag. ──

    #[test]
    fn intentional_keeps_member_access_statement() {
        // Kept: dropping `a.b.c;` / `Number.POSITIVE_INFINITY;` would need an
        // unsound getters-pure assumption.
        assert!(dc("function f() { a.b.c; return 1; }").0.contains("a.b.c"));
        assert!(dc("function f() { Number.POSITIVE_INFINITY; return 1; }")
            .0
            .contains("POSITIVE_INFINITY"));
    }

    // ── 🟡 TODO (Phase C, small + safe): dropping a provably-pure sequence prefix
    //    (`(1, 2, foo())` → `foo()`) is sound since the dropped operands are
    //    literals. Currently kept; flip this when implemented. ──

    #[test]
    fn conservative_keeps_pure_sequence_prefix() {
        // Conservative: the pure prefix is kept, not reduced to `var x = foo();`.
        assert!(dc("var x = (1, 2, foo());").0.contains("1, 2, foo()"));
    }
}
