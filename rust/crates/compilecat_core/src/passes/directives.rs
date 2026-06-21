//! Shared directive-comment scanning. A directive is a `/* @inline */`-style
//! marker; passes collect the span of the declaration each is attached to.
//!
//! Centralizes what was copy-pasted across every pass: the comment scan
//! (`&source[comment.span] + text.contains("@x")`), the directive token list,
//! and the `export`-annotation propagation that always followed the scan.

use std::collections::HashSet;

use oxc_ast::ast::{ArrowFunctionExpression, Function, Program};
use oxc_ast_visit::{walk, Visit};
use oxc_semantic::ScopeFlags;
use oxc_span::GetSpan;

/// The authored optimization directives. `@optimize` is a combo that implies
/// `@flatten` + `@sroa` + `@unroll` (matching `src/compiler/directives.ts`); each
/// pass includes `@optimize` in its token list where that implication applies.
pub(crate) const DIRECTIVES: [&str; 5] = ["@inline", "@flatten", "@sroa", "@unroll", "@optimize"];

/// `true` if `source` contains any compilecat directive — the cheap host
/// pre-filter (skip parsing directive-free files). Mirrors
/// `ANY_DIRECTIVE_IN_SOURCE` / `/@(?:inline|flatten|sroa|unroll|optimize)\b/`.
pub(crate) fn any_in_source(source: &str) -> bool {
    source.contains('@') && DIRECTIVES.iter().any(|d| source.contains(d))
}

/// Spans (each comment's `attached_to` token start) of comments whose text
/// contains any of `tokens`.
pub(crate) fn annotated_spans(program: &Program, tokens: &[&str]) -> HashSet<u32> {
    let src = program.source_text;
    let mut spans = HashSet::new();
    for c in &program.comments {
        let text = &src[c.span.start as usize..c.span.end as usize];
        if tokens.iter().any(|t| text.contains(t)) {
            spans.insert(c.attached_to);
        }
    }
    spans
}

/// As [`annotated_spans`], then propagate annotations on an exported declaration
/// (which attach to `export`) to the inner declaration — the common case for
/// decl-level directives.
pub(crate) fn annotated_spans_with_exports(program: &Program, tokens: &[&str]) -> HashSet<u32> {
    let mut spans = annotated_spans(program, tokens);
    super::util::expand_export_annotations(program, &mut spans);
    spans
}

/// Span-starts of the **directive-attached constructs** the optimization/cleanup
/// tier may touch — a function, arrow, bare block (`/* @optimize */ { … }`), or
/// loop. The gate ([`super::gate::Gate`]) keeps everything *inside* one of these
/// active (so a `@optimize` block opts in its whole subtree), resetting only at
/// nested function boundaries (functions are independent units). Code not inside
/// any opted-in construct is left byte-identical.
pub(crate) fn touched_spans(program: &Program) -> HashSet<u32> {
    let mut spans = annotated_spans_with_exports(program, &DIRECTIVES);
    // Also opt in functions a producing pass *modified*: inlining (incl.
    // cross-file `@inline` into an otherwise-undirected consumer), SROA, and
    // unroll splice compiler-generated nodes — which carry `SPAN(0,0)` — into the
    // function. Detecting that marks the modified function so its residue gets
    // cleaned — the touched set is "directive-marked ∪ modified" — without
    // over-reaching (generated nodes only exist where a pass produced code).
    let mut v = GeneratedFns { stack: Vec::new(), touched: &mut spans };
    v.visit_program(program);
    spans
}

struct GeneratedFns<'s> {
    stack: Vec<u32>, // enclosing function span-starts
    touched: &'s mut HashSet<u32>,
}
impl<'a> Visit<'a> for GeneratedFns<'_> {
    fn visit_function(&mut self, f: &Function<'a>, flags: ScopeFlags) {
        self.stack.push(f.span.start);
        walk::walk_function(self, f, flags);
        self.stack.pop();
    }
    fn visit_arrow_function_expression(&mut self, a: &ArrowFunctionExpression<'a>) {
        self.stack.push(a.span.start);
        walk::walk_arrow_function_expression(self, a);
        self.stack.pop();
    }
    fn enter_node(&mut self, kind: oxc_ast::AstKind<'a>) {
        // A generated node (span 0) marks every enclosing function as modified.
        if kind.span().start == 0 && kind.span().end == 0 {
            for &s in &self.stack {
                self.touched.insert(s);
            }
        }
    }
}
