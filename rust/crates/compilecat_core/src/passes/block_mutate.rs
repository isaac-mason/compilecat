//! Port of `src/compiler/function-to-block-mutator.ts` (jscomp's
//! FunctionToBlockMutator subset).
//!
//! Turns a callee body + call-site args into a statement that computes the same
//! result, so a multi-statement body — **including one with `return`s** — can be
//! spliced in place of a call. Returns become `result = X; break LABEL;`; a
//! trailing `return X;` falls through as `result = X;` (no break, no label when
//! it's the only return). This is the core that makes general BLOCK inlining
//! real (DIRECT handles only single-return bodies).
//!
//! Param handling: each param passed in gets a `let p = arg;` prologue temp.
//! The caller (`build_block_plan`) decides *which* params to pass — it
//! substitutes simple identifier/literal args for non-reassigned params
//! directly into the body and only sends the rest here (reassigned params, or
//! side-effecting args that must be evaluated once). The caller is also
//! responsible for α-rename when an arg references a param name.

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast::{AstBuilder, NONE};
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_span::SPAN;

pub(crate) struct BlockMutateInput<'a> {
    /// Cloned callee body statements (owned; mutated in place).
    pub body_stmts: Vec<Statement<'a>>,
    pub params: Vec<String>,
    /// Cloned arg expressions; index i pairs with params[i] (missing → `void 0`).
    pub args: Vec<Expression<'a>>,
    pub label: String,
    pub result_name: String,
    /// When false, returns become bare `break LABEL;` (statement-position call).
    pub needs_result: bool,
}

pub(crate) struct BlockMutateOutput<'a> {
    /// A LabeledStatement (interior returns force `break LABEL;`) or a plain
    /// BlockStatement (no interior returns).
    pub block: Statement<'a>,
    /// Whether `result` is written on at least one path. Consumed by the
    /// expression-position shape (gate task 15) to skip an unused `let _result;`.
    #[allow(dead_code)]
    pub has_result_write: bool,
}

pub(crate) fn mutate_for_block_inline<'a>(
    allocator: &'a Allocator,
    input: BlockMutateInput<'a>,
) -> BlockMutateOutput<'a> {
    let ast = AstBuilder::new(allocator);
    let BlockMutateInput { mut body_stmts, params, args, label, result_name, needs_result } = input;
    let label: &'a str = allocator.alloc_str(&label);
    let result_name: &'a str = allocator.alloc_str(&result_name);

    // Prologue: bind each passed param to its arg. Emit `const` unless the param
    // is REBOUND in the body (`p = …` / `p++` / destructured target) — a member
    // or element write (`p[0] = …`, `p.x = …`) mutates the object the binding
    // points at, not the binding, so it stays const-able. (The params that reach
    // here are the eval-once temps + genuinely reassigned params; most are the
    // former and become `const`, tidying the inlined output.)
    let mut prologue: Vec<Statement<'a>> = Vec::with_capacity(params.len());
    let mut args = args.into_iter();
    for p in &params {
        let arg = args.next().unwrap_or_else(|| void_expr(&ast));
        let name: &'a str = allocator.alloc_str(p);
        let kind = if is_reassigned(&body_stmts, p) {
            VariableDeclarationKind::Let
        } else {
            VariableDeclarationKind::Const
        };
        let bid = ast.binding_pattern_binding_identifier(SPAN, name);
        let declr = ast.variable_declarator(SPAN, kind, bid, NONE, Some(arg), false);
        prologue.push(Statement::VariableDeclaration(ast.alloc(ast.variable_declaration(
            SPAN,
            kind,
            ast.vec1(declr),
            false,
        ))));
    }

    let mut has_result_write = false;

    let has_return_at_exit = matches!(body_stmts.last(), Some(Statement::ReturnStatement(_)));
    let interior_returns = count_shallow_returns(&body_stmts) - usize::from(has_return_at_exit);

    // Trailing `return X;` → `result = X;` (fall-through; no break).
    if has_return_at_exit {
        if let Some(Statement::ReturnStatement(ret)) = body_stmts.pop() {
            let arg = ret.unbox().argument;
            if needs_result {
                let rhs = arg.unwrap_or_else(|| void_expr(&ast));
                body_stmts.push(assign_stmt(&ast, result_name, rhs));
                has_result_write = true;
            } else if let Some(e) = arg {
                if expr_has_side_effects(&e) {
                    body_stmts.push(ast.statement_expression(SPAN, e));
                }
            }
        }
    }

    // Result required but body falls off the end → `result = undefined;`.
    if needs_result && !has_return_at_exit {
        body_stmts.push(assign_stmt(&ast, result_name, void_expr(&ast)));
        has_result_write = true;
    }

    // Interior returns → `result = X; break LABEL;`, wrap in a labeled block.
    if interior_returns > 0 {
        let mut rw =
            ReturnRewriter { ast: &ast, label, result_name, needs_result, has_write: false };
        for s in body_stmts.iter_mut() {
            rw.visit_statement(s);
        }
        has_result_write |= rw.has_write;

        let block = block_of(&ast, prologue, body_stmts);
        let labeled = ast.statement_labeled(SPAN, ast.label_identifier(SPAN, label), block);
        return BlockMutateOutput { block: labeled, has_result_write };
    }

    let block = block_of(&ast, prologue, body_stmts);
    BlockMutateOutput { block, has_result_write }
}

/// Whether `name` is REBOUND anywhere in `stmts`: a whole-identifier assignment
/// (`name = …`, `name += …`), an update (`name++`), a destructuring target
/// (`[name] = …`), or a `for (name of …)` head — every write reaches the leaf
/// `AssignmentTargetIdentifier`. A member/element write (`name[0] = …`, `name.x =
/// …`) is NOT a rebind (it mutates the pointed-at object), so it doesn't count and
/// the binding stays const-able.
fn is_reassigned(stmts: &[Statement], name: &str) -> bool {
    struct V<'n> {
        name: &'n str,
        found: bool,
    }
    impl<'a> Visit<'a> for V<'_> {
        // `p = …`, `p += …`, and destructuring leaves (`[p] = …`, `({x: p} = …)`),
        // which recurse into this same node. A member/element target
        // (`p.x`/`p[0]`) is `Static/ComputedMemberExpression`, not an identifier
        // target — correctly ignored (it mutates the object, not the binding).
        fn visit_assignment_target(&mut self, t: &AssignmentTarget<'a>) {
            if let AssignmentTarget::AssignmentTargetIdentifier(id) = t {
                if id.name == self.name {
                    self.found = true;
                }
            }
            walk::walk_assignment_target(self, t);
        }
        // Object-destructuring shorthand `({p} = …)` binds via a distinct node.
        fn visit_assignment_target_property_identifier(
            &mut self,
            p: &AssignmentTargetPropertyIdentifier<'a>,
        ) {
            if p.binding.name == self.name {
                self.found = true;
            }
            walk::walk_assignment_target_property_identifier(self, p);
        }
        // `p++` / `--p`.
        fn visit_update_expression(&mut self, u: &UpdateExpression<'a>) {
            if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = &u.argument {
                if id.name == self.name {
                    self.found = true;
                }
            }
            walk::walk_update_expression(self, u);
        }
    }
    let mut v = V { name, found: false };
    for s in stmts {
        v.visit_statement(s);
    }
    v.found
}

/// `{ ...prologue, ...stmts }`.
fn block_of<'a>(
    ast: &AstBuilder<'a>,
    prologue: Vec<Statement<'a>>,
    stmts: Vec<Statement<'a>>,
) -> Statement<'a> {
    let mut out = ast.vec_with_capacity(prologue.len() + stmts.len());
    for s in prologue {
        out.push(s);
    }
    for s in stmts {
        out.push(s);
    }
    Statement::BlockStatement(ast.alloc(ast.block_statement(SPAN, out)))
}

/// `undefined` (matches the codebase's existing inline residue shape).
fn void_expr<'a>(ast: &AstBuilder<'a>) -> Expression<'a> {
    ast.expression_identifier(SPAN, "undefined")
}

/// `result = rhs;`.
fn assign_stmt<'a>(
    ast: &AstBuilder<'a>,
    result_name: &'a str,
    rhs: Expression<'a>,
) -> Statement<'a> {
    let target = AssignmentTarget::from(
        ast.simple_assignment_target_assignment_target_identifier(SPAN, result_name),
    );
    let assign = ast.expression_assignment(SPAN, AssignmentOperator::Assign, target, rhs);
    ast.statement_expression(SPAN, assign)
}

/// Conservative: only literals and bare identifiers are side-effect-free.
fn expr_has_side_effects(e: &Expression) -> bool {
    !matches!(
        e,
        Expression::NumericLiteral(_)
            | Expression::StringLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::BigIntLiteral(_)
            | Expression::Identifier(_)
    )
}

/// Count `return`s reachable without crossing into a nested function.
fn count_shallow_returns(stmts: &[Statement]) -> usize {
    struct Counter {
        count: usize,
    }
    impl<'a> Visit<'a> for Counter {
        fn visit_return_statement(&mut self, _: &ReturnStatement<'a>) {
            self.count += 1;
        }
        fn visit_function(&mut self, _: &Function<'a>, _: oxc_semantic::ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _: &ArrowFunctionExpression<'a>) {}
    }
    let mut c = Counter { count: 0 };
    for s in stmts {
        c.visit_statement(s);
    }
    c.count
}

/// Rewrites each `return X;` (not in a nested function) to a block
/// `{ result = X; break LABEL; }` — uniform so it's valid in both statement-list
/// and bare-slot (`if (c) return x`) positions without array splicing.
struct ReturnRewriter<'a, 'b> {
    ast: &'b AstBuilder<'a>,
    label: &'a str,
    result_name: &'a str,
    needs_result: bool,
    has_write: bool,
}

impl<'a> VisitMut<'a> for ReturnRewriter<'a, '_> {
    fn visit_function(&mut self, _: &mut Function<'a>, _: oxc_semantic::ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _: &mut ArrowFunctionExpression<'a>) {}

    fn visit_statement(&mut self, stmt: &mut Statement<'a>) {
        let arg = if let Statement::ReturnStatement(ret) = stmt {
            Some(ret.argument.take())
        } else {
            None
        };
        if let Some(arg) = arg {
            *stmt = self.return_block(arg);
            return;
        }
        walk_mut::walk_statement(self, stmt);
    }
}

impl<'a> ReturnRewriter<'a, '_> {
    fn return_block(&mut self, arg: Option<Expression<'a>>) -> Statement<'a> {
        let mut stmts = self.ast.vec();
        if self.needs_result {
            let rhs = arg.unwrap_or_else(|| void_expr(self.ast));
            stmts.push(assign_stmt(self.ast, self.result_name, rhs));
            self.has_write = true;
        } else if let Some(e) = arg {
            if expr_has_side_effects(&e) {
                stmts.push(self.ast.statement_expression(SPAN, e));
            }
        }
        stmts.push(
            self.ast.statement_break(SPAN, Some(self.ast.label_identifier(SPAN, self.label))),
        );
        Statement::BlockStatement(self.ast.alloc(self.ast.block_statement(SPAN, stmts)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::CloneIn;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;

    /// Parse `function f(...){...}`, run the mutator with the given args (as
    /// bare identifiers) + result mode, and return the codegen of the block.
    fn run(fn_src: &str, args: &[&str], needs_result: bool) -> String {
        let allocator = Allocator::default();
        let program = crate::parse_program(&allocator, fn_src, SourceType::ts());
        let Statement::FunctionDeclaration(f) = &program.body[0] else { panic!("not a fn decl") };
        let params: Vec<String> = f
            .params
            .items
            .iter()
            .map(|p| match &p.pattern {
                BindingPattern::BindingIdentifier(id) => id.name.to_string(),
                _ => panic!("non-ident param"),
            })
            .collect();
        let body_stmts: Vec<Statement> =
            f.body.as_ref().unwrap().statements.iter().map(|s| s.clone_in(&allocator)).collect();

        let ast = AstBuilder::new(&allocator);
        let arg_exprs: Vec<Expression> =
            args.iter().map(|a| ast.expression_identifier(SPAN, allocator.alloc_str(a))).collect();

        let out = mutate_for_block_inline(
            &allocator,
            BlockMutateInput {
                body_stmts,
                params,
                args: arg_exprs,
                label: "_l".into(),
                result_name: "_r".into(),
                needs_result,
            },
        );
        let prog = ast.program(
            SPAN,
            SourceType::ts(),
            "",
            ast.vec(),
            None,
            ast.vec(),
            ast.vec1(out.block),
        );
        Codegen::new().build(&prog).code
    }

    #[test]
    fn trailing_return_falls_through_no_label() {
        let out = run("function f(a) { return a + 1; }", &["A"], true);
        assert!(out.contains("const a = A"), "read-only param → const:\n{out}");
        assert!(out.contains("_r = a + 1"), "{out}");
        assert!(!out.contains("break"), "no break for a sole trailing return:\n{out}");
        assert!(!out.contains("_l:"), "no label needed:\n{out}");
    }

    #[test]
    fn early_return_uses_label_and_break() {
        let out = run("function f(a) { if (a > 0) return 1; return 2; }", &["A"], true);
        assert!(out.contains("_l:"), "labeled block for interior return:\n{out}");
        assert!(out.contains("_r = 1"), "{out}");
        assert!(out.contains("break _l"), "interior return breaks:\n{out}");
        assert!(out.contains("_r = 2"), "trailing return falls through:\n{out}");
    }

    #[test]
    fn reassigned_param_stays_let() {
        // `a` is rebound (`a = a + 1`) → must keep `let` (const would be illegal).
        let out = run("function f(a) { a = a + 1; return a; }", &["A"], true);
        assert!(out.contains("let a = A"), "rebound param stays let:\n{out}");
        assert!(!out.contains("const a = A"), "must not be const:\n{out}");
    }

    #[test]
    fn member_write_param_is_const() {
        // `o[0] = …` mutates the object, not the binding → stays const-able.
        let out = run("function f(o) { o[0] = 1; return o; }", &["O"], true);
        assert!(out.contains("const o = O"), "member-write param → const:\n{out}");
    }

    #[test]
    fn void_statement_position_no_result() {
        let out = run("function f(a) { g(a); }", &["A"], false);
        assert!(out.contains("const a = A"), "read-only param → const:\n{out}");
        assert!(out.contains("g(a)"), "{out}");
        assert!(!out.contains("_r"), "no result temp for needs_result=false:\n{out}");
        assert!(!out.contains("break"), "{out}");
    }

    #[test]
    fn fall_off_end_with_result_assigns_undefined() {
        let out = run("function f(a) { g(a); }", &["A"], true);
        assert!(out.contains("g(a)"), "{out}");
        assert!(out.contains("_r = undefined"), "dummy assignment on fall-through:\n{out}");
        assert!(!out.contains("break"), "no interior returns → no break:\n{out}");
    }

    #[test]
    fn multiple_interior_returns_all_break() {
        let out = run(
            "function f(a) { if (a === 1) return 10; if (a === 2) return 20; return 30; }",
            &["A"],
            true,
        );
        assert_eq!(out.matches("break _l").count(), 2, "two interior returns break:\n{out}");
        assert!(out.contains("_r = 30"), "trailing falls through:\n{out}");
    }
}
