//! Port of `src/compiler/minimize-exit-points.ts` (Closure MinimizeExitPoints).
//! Replaces explicit trailing exits (`return;`/`break;`/`continue;`) with
//! implicit fall-through.
//!
//! First cut — the high-value, well-defined core:
//!   - drop a block's trailing matching exit (function-tail `return;`,
//!     loop-tail `continue;`, labeled-block-tail `break L;`)
//!   - recurse into if-branches (and nested blocks) to drop their trailing exits
//!
//! Each enclosing structure sets the exit kind its body can shed: function →
//! `return;`, loop → `continue;`, `L: { … }` → `break L;`. Only *argument-less*
//! returns and label-matched breaks/continues are redundant.
//!
//! Deferred (TODO): if-block sibling-hoisting (`if(c){A;return} B` →
//! `if(c){A}else{B}`), switch-case exit minimization, try/labeled recursion,
//! `do … while(false)` break.

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast::AstBuilder;
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_semantic::ScopeFlags;
use oxc_span::{GetSpan, SPAN};

#[derive(Clone)]
enum Exit {
    Return,
    Break(Option<String>),
    Continue(Option<String>),
}

pub fn run<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> u32 {
    run_with(allocator, program, super::gate::Gate::ungated())
}

pub fn run_with<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    gate: super::gate::Gate,
) -> u32 {
    let mut v = Minimizer { count: 0, gate, ast: AstBuilder::new(allocator) };
    v.visit_program(program);
    v.count
}

struct Minimizer<'a> {
    count: u32,
    gate: super::gate::Gate,
    ast: AstBuilder<'a>,
}

impl<'a> VisitMut<'a> for Minimizer<'a> {
    fn visit_function(&mut self, func: &mut Function<'a>, flags: ScopeFlags) {
        let s = self.gate.enter_fn(func.span.start);
        walk_mut::walk_function(self, func, flags);
        if self.gate.active {
            if let Some(body) = func.body.as_mut() {
                self.minimize_block(&mut body.statements, &Exit::Return);
            }
        }
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

    fn visit_while_statement(&mut self, n: &mut WhileStatement<'a>) {
        walk_mut::walk_while_statement(self, n);
        if self.gate.active {
            self.minimize_body(&mut n.body, &Exit::Continue(None));
        }
    }
    fn visit_for_statement(&mut self, n: &mut ForStatement<'a>) {
        walk_mut::walk_for_statement(self, n);
        if self.gate.active {
            self.minimize_body(&mut n.body, &Exit::Continue(None));
        }
    }
    fn visit_for_in_statement(&mut self, n: &mut ForInStatement<'a>) {
        walk_mut::walk_for_in_statement(self, n);
        if self.gate.active {
            self.minimize_body(&mut n.body, &Exit::Continue(None));
        }
    }
    fn visit_for_of_statement(&mut self, n: &mut ForOfStatement<'a>) {
        walk_mut::walk_for_of_statement(self, n);
        if self.gate.active {
            self.minimize_body(&mut n.body, &Exit::Continue(None));
        }
    }
    fn visit_labeled_statement(&mut self, n: &mut LabeledStatement<'a>) {
        walk_mut::walk_labeled_statement(self, n);
        if self.gate.active {
            let label = n.label.name.to_string();
            self.minimize_body(&mut n.body, &Exit::Break(Some(label)));
        }
    }

    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts);
        if self.gate.active {
            self.unwrap_dead_labels(stmts);
        }
    }
}

impl<'a> Minimizer<'a> {
    /// Once sibling-hoisting has stripped a labeled block's `break L`s, the label
    /// is dead. Splice such a block's body into the parent list (inlined-body
    /// locals are uniquified, so merging scopes is safe).
    fn unwrap_dead_labels(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        if !stmts.iter().any(|s| matches!(s, Statement::LabeledStatement(l)
            if matches!(&l.body, Statement::BlockStatement(_)) && !label_referenced(&l.body, l.label.name.as_str())))
        {
            return;
        }
        let taken = std::mem::replace(stmts, self.ast.vec());
        let mut out = self.ast.vec_with_capacity(taken.len());
        for stmt in taken {
            match stmt {
                Statement::LabeledStatement(l)
                    if matches!(&l.body, Statement::BlockStatement(_))
                        && !label_referenced(&l.body, l.label.name.as_str()) =>
                {
                    let l = l.unbox();
                    let Statement::BlockStatement(b) = l.body else { unreachable!() };
                    for s in b.unbox().body {
                        out.push(s);
                    }
                    self.count += 1;
                }
                other => out.push(other),
            }
        }
        *stmts = out;
    }

    fn minimize_body(&mut self, stmt: &mut Statement<'a>, exit: &Exit) {
        match stmt {
            Statement::BlockStatement(b) => self.minimize_block(&mut b.body, exit),
            other => self.minimize_into(other, exit),
        }
    }

    fn minimize_into(&mut self, stmt: &mut Statement<'a>, exit: &Exit) {
        match stmt {
            Statement::IfStatement(if_) => {
                self.minimize_body(&mut if_.consequent, exit);
                if let Some(alt) = if_.alternate.as_mut() {
                    self.minimize_body(alt, exit);
                }
            }
            Statement::BlockStatement(b) => self.minimize_block(&mut b.body, exit),
            _ => {}
        }
    }

    fn minimize_block(&mut self, body: &mut oxc_allocator::Vec<'a, Statement<'a>>, exit: &Exit) {
        // Sibling-hoist pass: for each `if` whose branch ends in a matching exit,
        // move the if's following siblings into the opposite branch and drop the
        // now-redundant exit (`if(c){A;break L} B` → `if(c){A} else {B}`). This is
        // what lets the trailing pass + label-unwrap clear the inline scaffolding.
        let mut i = 0;
        while i < body.len() {
            if matches!(&body[i], Statement::IfStatement(_)) {
                self.try_hoist_if_exits(body, i, true, exit);
                if matches!(&body[i], Statement::IfStatement(if_) if if_.alternate.is_some()) {
                    self.try_hoist_if_exits(body, i, false, exit);
                }
            }
            if i + 1 >= body.len() {
                break;
            }
            i += 1;
        }

        // Trailing pass: drop a tail matching exit; recurse into the new tail.
        // (Not a `while let`: the structure is drop-all-matching-tails via
        // `continue`, then recurse once into the surviving tail and `break`.)
        #[allow(clippy::while_let_loop)]
        loop {
            let Some(last) = body.last() else { break };
            if matching_exit(last, exit) {
                body.pop();
                self.count += 1;
                continue;
            }
            if let Some(last) = body.last_mut() {
                self.minimize_into(last, exit);
            }
            break;
        }
    }

    /// Port of `tryMinimizeIfBlockExits`. When the `if` at `body[i]`'s
    /// consequent (`working_on_consequent`) or alternate ends in a matching
    /// exit, move the if's following siblings into the opposite branch and
    /// remove that exit.
    fn try_hoist_if_exits(
        &mut self,
        body: &mut oxc_allocator::Vec<'a, Statement<'a>>,
        i: usize,
        working_on_consequent: bool,
        exit: &Exit,
    ) {
        // Pre-check: src branch exists and ends in a matching exit.
        {
            let Statement::IfStatement(if_) = &body[i] else { return };
            let src =
                if working_on_consequent { Some(&if_.consequent) } else { if_.alternate.as_ref() };
            let Some(src) = src else { return };
            if !branch_ends_in_exit(src, exit) {
                return;
            }
        }
        // Need following siblings to move.
        if i + 1 >= body.len() {
            return;
        }
        let moving: Vec<Statement<'a>> = body.drain(i + 1..).collect();

        let Statement::IfStatement(if_) = &mut body[i] else { return };
        // Remove the matched exit from the src branch.
        if working_on_consequent {
            remove_branch_exit(&mut if_.consequent, &mut self.ast);
        } else if let Some(alt) = if_.alternate.as_mut() {
            remove_branch_exit(alt, &mut self.ast);
        }
        // Append the moved siblings to the opposite branch.
        if working_on_consequent {
            match if_.alternate.as_mut() {
                Some(Statement::BlockStatement(b)) => {
                    for s in moving {
                        b.body.push(s);
                    }
                }
                Some(_) => {
                    let existing = if_.alternate.take().unwrap();
                    if_.alternate = Some(self.block_of(std::iter::once(existing).chain(moving)));
                }
                None => {
                    if_.alternate = Some(self.block_of(moving));
                }
            }
        } else {
            match &mut if_.consequent {
                Statement::BlockStatement(b) => {
                    for s in moving {
                        b.body.push(s);
                    }
                }
                _ => {
                    let existing =
                        std::mem::replace(&mut if_.consequent, self.ast.statement_empty(SPAN));
                    if_.consequent = self.block_of(std::iter::once(existing).chain(moving));
                }
            }
        }
        self.count += 1;
    }

    fn block_of(&self, stmts: impl IntoIterator<Item = Statement<'a>>) -> Statement<'a> {
        let mut v = self.ast.vec();
        for s in stmts {
            v.push(s);
        }
        self.ast.statement_block(SPAN, v)
    }
}

/// True if `branch` (a block whose last stmt is, or a single stmt that is) a
/// matching exit.
fn branch_ends_in_exit(branch: &Statement, exit: &Exit) -> bool {
    match branch {
        Statement::BlockStatement(b) => b.body.last().is_some_and(|s| matching_exit(s, exit)),
        other => matching_exit(other, exit),
    }
}

/// Remove the trailing matching exit from a branch: pop it from a block, or
/// replace a bare single-statement branch with an empty block.
fn remove_branch_exit<'a>(branch: &mut Statement<'a>, ast: &mut AstBuilder<'a>) {
    match branch {
        Statement::BlockStatement(b) => {
            b.body.pop();
        }
        other => {
            *other = ast.statement_block(SPAN, ast.vec());
        }
    }
}

/// True if a `break`/`continue` targeting `label` appears in `stmt` (not inside
/// a nested function). Labels generated by inlining are unique, so an exact
/// name match is sufficient (no shadowing concern).
fn label_referenced(stmt: &Statement, label: &str) -> bool {
    use oxc_ast_visit::Visit;
    struct V<'l> {
        label: &'l str,
        found: bool,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_break_statement(&mut self, b: &BreakStatement<'a>) {
            if b.label.as_ref().is_some_and(|l| l.name == self.label) {
                self.found = true;
            }
        }
        fn visit_continue_statement(&mut self, c: &ContinueStatement<'a>) {
            if c.label.as_ref().is_some_and(|l| l.name == self.label) {
                self.found = true;
            }
        }
        fn visit_function(&mut self, _f: &Function<'a>, _: ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {}
    }
    let mut v = V { label, found: false };
    v.visit_statement(stmt);
    v.found
}

fn matching_exit(stmt: &Statement, exit: &Exit) -> bool {
    match exit {
        Exit::Return => {
            matches!(stmt, Statement::ReturnStatement(r) if r.argument.is_none())
        }
        Exit::Break(label) => match stmt {
            Statement::BreakStatement(b) => label_matches(&b.label, label),
            _ => false,
        },
        Exit::Continue(label) => match stmt {
            Statement::ContinueStatement(c) => label_matches(&c.label, label),
            _ => false,
        },
    }
}

fn label_matches(actual: &Option<LabelIdentifier>, want: &Option<String>) -> bool {
    match (actual, want) {
        (None, None) => true,
        (Some(a), Some(w)) => a.name == w.as_str(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;

    fn me(src: &str) -> (String, u32) {
        let allocator = Allocator::default();
        let mut program = crate::parse_program(&allocator, src, SourceType::ts());
        let n = run(&allocator, &mut program);
        (Codegen::new().build(&program).code.replace('\n', " "), n)
    }

    #[test]
    fn drops_redundant_trailing_return() {
        let (out, n) = me("function f() { foo(); return; }");
        assert!(n > 0 && !out.contains("return"), "{out}");
    }

    #[test]
    fn drops_redundant_trailing_continue() {
        let (out, n) = me("function f() { for (var i = 0; i < 10; i++) { foo(); continue; } }");
        assert!(n > 0 && !out.contains("continue"), "{out}");
    }

    #[test]
    fn drops_redundant_trailing_labeled_break() {
        let (out, n) = me("function f() { foo: { bar(); break foo; } }");
        assert!(n > 0 && !out.contains("break foo"), "{out}");
        assert!(out.contains("bar()"), "body preserved:\n{out}");
    }

    #[test]
    fn hoists_trailing_siblings_into_else_on_return() {
        // `if (c) { return; } a(); b();` → `if (c) {} else { a(); b(); }`
        let (out, n) = me("function f(c) { if (c) { return; } a(); b(); }");
        assert!(n > 0 && !out.contains("return"), "{out}");
        assert!(out.contains("else"), "siblings hoisted into else:\n{out}");
    }

    #[test]
    fn rewrites_inliner_labeled_break_into_if_else() {
        // The BLOCK-inliner residue: a labeled flag-write + fall-through →
        // reorganized into if/else (no surviving labeled break).
        let (out, n) = me("function f(c) { _label: { if (c) { x = 1; break _label; } x = 2; } }");
        assert!(n > 0 && !out.contains("break _label"), "{out}");
        assert!(out.contains("else"), "{out}");
    }

    #[test]
    fn skips_exits_inside_a_finally_block() {
        // A `return` in a finalizer must NOT be minimized (it alters semantics).
        let (out, _) = me("function f() { try { foo(); } finally { bar(); return; } }");
        assert!(out.contains("finally") && out.contains("return"), "finalizer untouched:\n{out}");
    }
}
