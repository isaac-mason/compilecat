//! Port of `tri.ts` (jscomp `Tri.java`) — three-valued logic.
//!
//! `True`/`False` behave as ordinary booleans; `Unknown` is "could be either",
//! so any op returning a definite `Tri` must yield the same result for both
//! substitutions of `Unknown`. Encoded as `i8` (-1/0/1) so the lattice ops are
//! plain min/max/negate, exactly as the TS/Java versions.

use oxc_ast::ast::*;

pub const FALSE: i8 = -1;
pub const UNKNOWN: i8 = 0;
pub const TRUE: i8 = 1;

pub type Tri = i8;

pub fn tri_or(a: Tri, b: Tri) -> Tri {
    a.max(b)
}

pub fn tri_and(a: Tri, b: Tri) -> Tri {
    a.min(b)
}

pub fn tri_not(a: Tri) -> Tri {
    -a
}

pub fn tri_xor(a: Tri, b: Tri) -> Tri {
    -a * b
}

pub fn tri_to_boolean(a: Tri, fallback: bool) -> bool {
    match a {
        TRUE => true,
        FALSE => false,
        _ => fallback,
    }
}

pub fn tri_for_boolean(b: bool) -> Tri {
    if b {
        TRUE
    } else {
        FALSE
    }
}

/// Boolean coercion of an AST node, ignoring side effects (Closure's
/// `NodeUtil.getBooleanValue`). `Unknown` when not statically determinable.
pub fn get_boolean_value(n: &Expression) -> Tri {
    match n {
        Expression::BooleanLiteral(b) => tri_for_boolean(b.value),
        Expression::NumericLiteral(num) => tri_for_boolean(num.value != 0.0),
        Expression::StringLiteral(s) => tri_for_boolean(!s.value.is_empty()),
        Expression::NullLiteral(_) => FALSE,
        Expression::Identifier(id) => match id.name.as_str() {
            "undefined" | "NaN" => FALSE,
            "Infinity" => TRUE,
            _ => UNKNOWN,
        },
        Expression::UnaryExpression(u) => match u.operator {
            UnaryOperator::Void => FALSE,
            UnaryOperator::LogicalNot => tri_not(get_boolean_value(&u.argument)),
            _ => UNKNOWN,
        },
        Expression::ObjectExpression(_)
        | Expression::ArrayExpression(_)
        | Expression::FunctionExpression(_)
        | Expression::ArrowFunctionExpression(_)
        | Expression::RegExpLiteral(_) => TRUE,
        Expression::TemplateLiteral(t) if t.expressions.is_empty() => {
            let cooked = t.quasis.first().and_then(|q| q.value.cooked.as_ref());
            tri_for_boolean(cooked.is_some_and(|c| !c.is_empty()))
        }
        _ => UNKNOWN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lattice_ops() {
        assert_eq!(tri_or(TRUE, FALSE), TRUE);
        assert_eq!(tri_or(FALSE, UNKNOWN), UNKNOWN);
        assert_eq!(tri_and(TRUE, FALSE), FALSE);
        assert_eq!(tri_and(TRUE, UNKNOWN), UNKNOWN);
        assert_eq!(tri_not(TRUE), FALSE);
        assert_eq!(tri_not(UNKNOWN), UNKNOWN);
        assert_eq!(tri_xor(TRUE, TRUE), FALSE);
        assert_eq!(tri_xor(TRUE, FALSE), TRUE);
        assert_eq!(tri_to_boolean(UNKNOWN, true), true);
    }

    fn b(src: &str) -> Tri {
        let allocator = oxc_allocator::Allocator::default();
        let source = format!("x = ({src});");
        let program = crate::parse_program(&allocator, &source, oxc_span::SourceType::ts());
        let oxc_ast::ast::Statement::ExpressionStatement(es) = &program.body[0] else {
            panic!("not expr stmt")
        };
        let oxc_ast::ast::Expression::AssignmentExpression(a) = &es.expression else {
            panic!("not assign")
        };
        get_boolean_value(&a.right)
    }

    #[test]
    fn boolean_value() {
        assert_eq!(b("true"), TRUE);
        assert_eq!(b("0"), FALSE);
        assert_eq!(b("'hi'"), TRUE);
        assert_eq!(b("''"), FALSE);
        assert_eq!(b("null"), FALSE);
        assert_eq!(b("undefined"), FALSE);
        assert_eq!(b("{}"), TRUE);
        assert_eq!(b("[]"), TRUE);
        assert_eq!(b("!1"), FALSE);
        assert_eq!(b("xyz"), UNKNOWN);
    }
}
