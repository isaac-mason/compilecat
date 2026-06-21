//! Port of `src/compiler/normalize.ts` — structural normalization only
//! (Closure `NormalizeStatements`). The α-rename (`renameForFlatten`) is a
//! separate, scope-aware pass run from `simplify`, not here.
//!
//! Four transforms, all pure AST shape — no scope/CFG analysis:
//!   1. blockless arrow body  →  `{ return expr }`
//!   2. if/for/while/do/with statement-child slots  →  BlockStatement
//!   3. multi-declarator `var/let/const`  →  one statement each
//!   4. hoist `for (var a = …; …)` init out of the loop header
//!
//! These give downstream passes the invariants they assume (every function
//! body / loop body is a block; one binding per declaration).

use oxc_allocator::{Allocator, TakeIn};
use oxc_ast::ast::*;
use oxc_ast::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_span::GetSpan;

pub fn run<'a>(allocator: &'a Allocator, program: &mut Program<'a>) {
    let mut v = Normalizer { ast: AstBuilder::new(allocator) };
    v.visit_program(program);
}

struct Normalizer<'a> {
    ast: AstBuilder<'a>,
}

impl<'a> Normalizer<'a> {
    /// Wrap a non-block statement slot in a `BlockStatement`.
    fn blockify(&self, stmt: &mut Statement<'a>) {
        if matches!(stmt, Statement::BlockStatement(_)) {
            return;
        }
        let span = stmt.span();
        let inner = stmt.take_in(self.ast.allocator);
        let body = self.ast.vec1(inner);
        *stmt = Statement::BlockStatement(self.ast.alloc(self.ast.block_statement(span, body)));
    }

    /// Rebuild a statement list: extract `var` for-init, split multi-declarator
    /// declarations. Mirrors `normalizeStatementList` in normalize.ts.
    fn normalize_statement_list(&self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        let mut out = self.ast.vec_with_capacity(stmts.len());
        let taken = stmts.take_in(self.ast.allocator);
        for mut stmt in taken {
            // Pass A — extract a `var` for-init, hoisting it before the loop.
            // `let`/`const` are left in place (per-iteration block scoping). The
            // hoisted decl flows through `push_decl`, so a multi-declarator init
            // (`for (var i=0, n=10; …)`) is split just like any other — matching
            // Closure's pass-A-feeds-pass-B ordering.
            if let Statement::ForStatement(for_stmt) = &mut stmt {
                let is_var = matches!(
                    &for_stmt.init,
                    Some(ForStatementInit::VariableDeclaration(vd))
                        if vd.kind == VariableDeclarationKind::Var
                );
                if is_var {
                    if let Some(ForStatementInit::VariableDeclaration(vd)) = for_stmt.init.take() {
                        self.push_decl(&mut out, vd);
                    }
                }
            }

            // Pass B — split multi-declarator decls into one statement each.
            match stmt {
                Statement::VariableDeclaration(vd) => self.push_decl(&mut out, vd),
                other => out.push(other),
            }
        }
        *stmts = out;
    }

    /// Push a variable declaration, splitting a multi-declarator one into a
    /// statement per declarator.
    fn push_decl(
        &self,
        out: &mut oxc_allocator::Vec<'a, Statement<'a>>,
        mut vd: oxc_allocator::Box<'a, VariableDeclaration<'a>>,
    ) {
        if vd.declarations.len() <= 1 {
            out.push(Statement::VariableDeclaration(vd));
            return;
        }
        let kind = vd.kind;
        let declare = vd.declare;
        let span = vd.span;
        for d in vd.declarations.take_in(self.ast.allocator) {
            let one = self.ast.vec1(d);
            out.push(Statement::VariableDeclaration(
                self.ast.alloc(self.ast.variable_declaration(span, kind, one, declare)),
            ));
        }
    }
}

impl<'a> VisitMut<'a> for Normalizer<'a> {
    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        self.normalize_statement_list(stmts);
        walk_mut::walk_statements(self, stmts);
    }

    fn visit_arrow_function_expression(&mut self, node: &mut ArrowFunctionExpression<'a>) {
        if node.expression {
            if let Some(Statement::ExpressionStatement(es)) = node.body.statements.first_mut() {
                let span = es.span;
                let expr = es.expression.take_in(self.ast.allocator);
                node.body.statements[0] = Statement::ReturnStatement(
                    self.ast.alloc(self.ast.return_statement(span, Some(expr))),
                );
            }
            node.expression = false;
        }
        walk_mut::walk_arrow_function_expression(self, node);
    }

    fn visit_if_statement(&mut self, node: &mut IfStatement<'a>) {
        self.blockify(&mut node.consequent);
        if let Some(alt) = node.alternate.as_mut() {
            self.blockify(alt);
        }
        walk_mut::walk_if_statement(self, node);
    }

    fn visit_for_statement(&mut self, node: &mut ForStatement<'a>) {
        self.blockify(&mut node.body);
        walk_mut::walk_for_statement(self, node);
    }

    fn visit_while_statement(&mut self, node: &mut WhileStatement<'a>) {
        self.blockify(&mut node.body);
        walk_mut::walk_while_statement(self, node);
    }

    fn visit_do_while_statement(&mut self, node: &mut DoWhileStatement<'a>) {
        self.blockify(&mut node.body);
        walk_mut::walk_do_while_statement(self, node);
    }

    fn visit_for_in_statement(&mut self, node: &mut ForInStatement<'a>) {
        self.blockify(&mut node.body);
        walk_mut::walk_for_in_statement(self, node);
    }

    fn visit_for_of_statement(&mut self, node: &mut ForOfStatement<'a>) {
        self.blockify(&mut node.body);
        walk_mut::walk_for_of_statement(self, node);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;

    fn norm(src: &str) -> String {
        let allocator = Allocator::default();
        let mut program = crate::parse_program(&allocator, src, SourceType::ts());
        run(&allocator, &mut program);
        Codegen::new().build(&program).code
    }

    // ── multi-declarator splitting ──

    #[test]
    fn splits_multi_declarator_var_in_function() {
        let out = norm("function f() { var a = 1, b = 2; sink(a + b); }");
        assert!(out.contains("var a = 1;"), "{out}");
        assert!(out.contains("var b = 2;"), "{out}");
        // each declarator gets its own statement (no comma-joined decl)
        assert!(!out.contains("var a = 1, b = 2"), "{out}");
    }

    #[test]
    fn splits_multi_declarator_let_at_top_level() {
        let out = norm("let a = 1, b = 2;");
        assert!(out.contains("let a = 1;"), "{out}");
        assert!(out.contains("let b = 2;"), "{out}");
        assert!(!out.contains("let a = 1, b = 2"), "{out}");
    }

    #[test]
    fn splits_multi_declarator_const_at_top_level() {
        let out = norm("const a = 1, b = 2;");
        assert!(out.contains("const a = 1;"), "{out}");
        assert!(out.contains("const b = 2;"), "{out}");
        assert!(!out.contains("const a = 1, b = 2"), "{out}");
    }

    #[test]
    fn leaves_single_declarator_var_alone() {
        let out = norm("var a = 1;");
        assert!(out.contains("var a = 1;"), "{out}");
    }

    // ── for-init hoisting ──

    #[test]
    fn hoists_var_for_init_out_of_header() {
        let out = norm("for (var i = 0; i < 10; i++) sink(i);");
        // the var declaration is lifted before the loop, header init now empty
        assert!(out.contains("var i = 0;"), "{out}");
        assert!(out.contains("for (; i < 10; i++)"), "{out}");
    }

    #[test]
    fn blockifies_for_body() {
        let out = norm("for (var i = 0; i < 10; i++) sink(i);");
        // non-block loop body becomes a block
        assert!(out.contains('{') && out.contains("sink(i)"), "{out}");
        assert!(!out.contains("i++) sink(i);"), "body should be wrapped in a block:\n{out}");
    }

    #[test]
    fn leaves_let_for_init_alone() {
        let out = norm("for (let i = 0; i < 10; i++) sink(i);");
        // block-scoped: init stays inside the header, not hoisted
        assert!(out.contains("for (let i = 0; i < 10; i++)"), "{out}");
    }

    // ── for-in / for-of ──

    /// CONSERVATIVE: the structural normalizer hoists only the `init` of a plain
    /// `ForStatement`; `for (var x in y)` is left untouched (no `var x;` lift).
    /// The input implies a hoist, but Rust does less here — pin the actual shape.
    #[test]
    fn conservative_leaves_for_in_var_unhoisted() {
        let out = norm("for (var x in y) {}");
        assert!(out.contains("for (var x in y)"), "{out}");
        // no hoisted `var x;` statement before the loop
        let before_loop = &out[..out.find("for").unwrap()];
        assert!(!before_loop.contains("var x"), "for-in var is not hoisted:\n{out}");
    }

    #[test]
    fn leaves_let_for_of_alone() {
        let out = norm("for (let x of y) {}");
        assert!(out.contains("for (let x of y)"), "{out}");
    }

    // ── arrow body rewriting ──

    #[test]
    fn rewrites_blockless_arrow_body() {
        let out = norm("var f = (x) => x + 1;");
        assert!(out.contains("return x + 1"), "expression body becomes a return:\n{out}");
        assert!(out.contains('{') && out.contains('}'), "{out}");
    }

    #[test]
    fn leaves_block_arrow_body_alone() {
        let out = norm("var g = (x) => { return x + 1; };");
        assert!(out.contains("return x + 1"), "{out}");
    }

    // ── no α-rename here (cross-function reuse left alone) ──

    #[test]
    fn cross_function_name_reuse_left_alone() {
        let out = norm("function a() { var x = 1; } function b() { var x = 2; }");
        // structural normalize does NOT rename; both `x` bindings stay `x`
        assert!(out.contains("var x = 1;"), "{out}");
        assert!(out.contains("var x = 2;"), "{out}");
    }
}
