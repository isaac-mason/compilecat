//! Shared analysis helpers used across passes (port of bits of
//! `src/compiler/ast-analyzer.ts`).

use std::collections::HashSet;

use oxc_ast::ast::*;
use oxc_span::GetSpan;

/// A directive comment on an exported declaration (`/* @x */ export function f`)
/// attaches to the `export` token, so its `attached_to` is the
/// `ExportNamedDeclaration` span — not the inner decl's. Passes key on the
/// decl's own span, so for each top-level `export <decl>` whose span is in
/// `spans`, propagate the annotation onto the inner declaration's span. Fixes
/// `@sroa`/`@inline`/… not firing on exported code.
pub fn expand_export_annotations(program: &Program, spans: &mut HashSet<u32>) {
    for stmt in &program.body {
        if let Statement::ExportNamedDeclaration(e) = stmt {
            if spans.contains(&e.span.start) {
                if let Some(decl) = &e.declaration {
                    spans.insert(decl.span().start);
                }
            }
        }
    }
}

/// Subset of `ast-analyzer.ts::isPure` — enough for the fold/dead-code rules.
/// `mayHaveSideEffects(n) == !is_pure(n)`.
pub fn is_pure(e: &Expression) -> bool {
    match e {
        Expression::NumericLiteral(_)
        | Expression::StringLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::RegExpLiteral(_)
        | Expression::Identifier(_)
        | Expression::ThisExpression(_)
        | Expression::FunctionExpression(_)
        | Expression::ArrowFunctionExpression(_) => true,
        Expression::UnaryExpression(u) => {
            !matches!(u.operator, UnaryOperator::Delete) && is_pure(&u.argument)
        }
        Expression::BinaryExpression(b) => {
            !matches!(b.operator, BinaryOperator::In | BinaryOperator::Instanceof)
                && is_pure(&b.left)
                && is_pure(&b.right)
        }
        Expression::LogicalExpression(l) => is_pure(&l.left) && is_pure(&l.right),
        Expression::ConditionalExpression(c) => {
            is_pure(&c.test) && is_pure(&c.consequent) && is_pure(&c.alternate)
        }
        Expression::SequenceExpression(s) => s.expressions.iter().all(is_pure),
        _ => false,
    }
}

/// Closure's `getBooleanValue` for literal operands — Some(bool) when the
/// truthiness is statically known, None otherwise.
pub fn as_boolean(e: &Expression) -> Option<bool> {
    match e {
        Expression::BooleanLiteral(b) => Some(b.value),
        Expression::NumericLiteral(n) => Some(n.value != 0.0),
        Expression::StringLiteral(s) => Some(!s.value.is_empty()),
        Expression::NullLiteral(_) => Some(false),
        Expression::Identifier(id) if id.name == "undefined" => Some(false),
        _ => None,
    }
}
