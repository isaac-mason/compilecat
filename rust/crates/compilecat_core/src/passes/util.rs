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

/// `Math.*` / `Number.*` / `JSON.*` static-member calls are total and pure, so a
/// call to one with side-effect-free args is itself side-effect-free. Conservative
/// allowlist (the builtins compilecat's numeric-target idiom uses); a future
/// `/*@__PURE__*/` honoring would extend the pure set here.
fn is_pure_builtin_callee(callee: &Expression) -> bool {
    matches!(callee, Expression::StaticMemberExpression(m)
        if matches!(&m.object, Expression::Identifier(o)
            if matches!(o.name.as_str(), "Math" | "Number" | "JSON")))
}

fn args_side_effect_free(args: &[Argument]) -> bool {
    args.iter().all(|a| match a {
        Argument::SpreadElement(s) => is_side_effect_free(&s.argument),
        _ => a.as_expression().is_some_and(is_side_effect_free),
    })
}

fn call_is_side_effect_free(c: &CallExpression) -> bool {
    // `c.pure` is the parser-set `/*@__PURE__*/` / `/*#__PURE__*/` marker (the
    // developer's escape hatch, à la Closure `@nosideeffects` / Terser / Rollup):
    // it asserts the callee is side-effect-free. The arguments are still evaluated,
    // so the whole call is side-effect-free only if they are too.
    (c.pure || is_pure_builtin_callee(&c.callee)) && args_side_effect_free(&c.arguments)
}

/// `true` if EVALUATING `e` has no observable side effect — i.e. it's safe to
/// drop, move, or re-order. This is the purity oracle for the optimizer's
/// Closure-aligned effect contract: per the annotated-region assumption a MEMBER
/// READ (`vec.x`) has no effectful getter (so field reads stay optimizable), and
/// a CALL is effectful UNLESS it's a known-pure builtin (`Math.*`) with
/// side-effect-free args. `new` / assignment / update / await / yield /
/// tagged-template / dynamic-import / `delete` are always effectful. Unlike the
/// permissive [`is_pure`] (which treats member reads as impure but is otherwise
/// used for fold/dce shape checks), use THIS for "may I drop/move this?".
pub fn is_side_effect_free(e: &Expression) -> bool {
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
        | Expression::ArrowFunctionExpression(_)
        | Expression::ClassExpression(_) => true,
        Expression::ParenthesizedExpression(p) => is_side_effect_free(&p.expression),
        Expression::TSAsExpression(t) => is_side_effect_free(&t.expression),
        Expression::TSSatisfiesExpression(t) => is_side_effect_free(&t.expression),
        Expression::TSNonNullExpression(t) => is_side_effect_free(&t.expression),
        Expression::TSTypeAssertion(t) => is_side_effect_free(&t.expression),
        Expression::TSInstantiationExpression(t) => is_side_effect_free(&t.expression),
        Expression::UnaryExpression(u) => {
            u.operator != UnaryOperator::Delete && is_side_effect_free(&u.argument)
        }
        Expression::BinaryExpression(b) => {
            is_side_effect_free(&b.left) && is_side_effect_free(&b.right)
        }
        Expression::LogicalExpression(l) => {
            is_side_effect_free(&l.left) && is_side_effect_free(&l.right)
        }
        Expression::ConditionalExpression(c) => {
            is_side_effect_free(&c.test)
                && is_side_effect_free(&c.consequent)
                && is_side_effect_free(&c.alternate)
        }
        Expression::SequenceExpression(s) => s.expressions.iter().all(is_side_effect_free),
        Expression::TemplateLiteral(t) => t.expressions.iter().all(is_side_effect_free),
        Expression::StaticMemberExpression(m) => is_side_effect_free(&m.object),
        Expression::PrivateFieldExpression(m) => is_side_effect_free(&m.object),
        Expression::ComputedMemberExpression(m) => {
            is_side_effect_free(&m.object) && is_side_effect_free(&m.expression)
        }
        Expression::ChainExpression(c) => match &c.expression {
            ChainElement::CallExpression(call) => call_is_side_effect_free(call),
            ChainElement::TSNonNullExpression(t) => is_side_effect_free(&t.expression),
            // optional MEMBER read (`a?.b`) — a read, assumed pure
            _ => true,
        },
        Expression::ArrayExpression(a) => a.elements.iter().all(|el| match el {
            ArrayExpressionElement::Elision(_) => true,
            ArrayExpressionElement::SpreadElement(_) => false,
            _ => el.as_expression().is_some_and(is_side_effect_free),
        }),
        Expression::ObjectExpression(o) => o.properties.iter().all(|p| match p {
            ObjectPropertyKind::ObjectProperty(prop) => {
                !prop.computed && is_side_effect_free(&prop.value)
            }
            ObjectPropertyKind::SpreadProperty(_) => false,
        }),
        Expression::CallExpression(c) => call_is_side_effect_free(c),
        // `new` is effectful unless `/*@__PURE__*/`-marked (and args are pure).
        Expression::NewExpression(n) => n.pure && args_side_effect_free(&n.arguments),
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
