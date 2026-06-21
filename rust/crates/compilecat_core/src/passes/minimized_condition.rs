//! Port of `jscomp/MinimizedCondition.java` (`src/compiler/minimized-condition.ts`).
//!
//! Builds two equivalent forms of a boolean condition — `positive` (original
//! semantics) and `negative` (original negated) — each with an estimated cost
//! (`+1` per leading `!`, `+2` per parenthesis-forcing child). `get_minimized`
//! picks the cheaper, enabling De Morgan where it pays (`!(a||b)` → `!a && !b`)
//! while NEVER over-applying (the naive distribution broke three.js — this is
//! the cost-gated, precedence-correct version).
//!
//! Eager (clone-based) rather than Closure's lazy MeasuredNode: oxc's borrow
//! model makes lazy AST refs painful, and conditions are small. Cost is computed
//! bottom-up as forms are built.

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::ast::*;
use oxc_ast::AstBuilder;
use oxc_span::SPAN;

const SENTINEL: usize = usize::MAX;

pub struct Measured<'a> {
    /// None = sentinel (never picked).
    pub node: Option<Expression<'a>>,
    pub cost: usize,
    pub changed: bool,
}

pub struct MinCond<'a> {
    pub positive: Measured<'a>,
    pub negative: Measured<'a>,
}

pub enum Style {
    PreferUnnegated,
    /// Used by the if-statement shape rewrites (not yet ported); kept for API
    /// completeness with Closure's `getMinimized`.
    #[allow(dead_code)]
    AllowLeadingNot,
}

pub struct Mc<'a> {
    ast: AstBuilder<'a>,
    alloc: &'a Allocator,
}

impl<'a> Mc<'a> {
    pub fn new(alloc: &'a Allocator) -> Self {
        Mc { ast: AstBuilder::new(alloc), alloc }
    }

    fn leaf(&self, n: Expression<'a>) -> Measured<'a> {
        Measured { node: Some(n), cost: 0, changed: false }
    }

    fn sentinel(&self) -> Measured<'a> {
        Measured { node: None, cost: SENTINEL, changed: true }
    }

    fn clone_m(&self, m: &Measured<'a>) -> Measured<'a> {
        Measured {
            node: m.node.as_ref().map(|n| n.clone_in(self.alloc)),
            cost: m.cost,
            changed: m.changed,
        }
    }

    /// Build a condition's minimized forms. Only recurses into `!`, `&&`/`||`,
    /// `?:`, and sequence (≥2) — like Closure's `fromConditionNode`.
    pub fn from_condition(&self, n: Expression<'a>) -> MinCond<'a> {
        let recurse = matches!(&n,
            Expression::UnaryExpression(u) if u.operator == UnaryOperator::LogicalNot)
            || matches!(&n, Expression::LogicalExpression(l)
                if matches!(l.operator, LogicalOperator::And | LogicalOperator::Or))
            || matches!(&n, Expression::ConditionalExpression(_))
            || matches!(&n, Expression::SequenceExpression(s) if s.expressions.len() >= 2);
        if recurse {
            self.compute(n)
        } else {
            let neg = self.negate(self.leaf(n.clone_in(self.alloc)));
            MinCond { positive: self.leaf(n), negative: self.changed(neg) }
        }
    }

    fn compute(&self, n: Expression<'a>) -> MinCond<'a> {
        match n {
            Expression::UnaryExpression(u) if u.operator == UnaryOperator::LogicalNot => {
                let u = u.unbox();
                let sub = self.compute(u.argument);
                // positive = best( !sub.positive , sub.negative )
                let not_pos = self.not_node(self.clone_m(&sub.positive));
                let positive = self.pick(not_pos, self.clone_m(&sub.negative));
                // negative = best( negate(sub.negative) , sub.positive )
                let neg_neg = self.negate(self.clone_m(&sub.negative));
                let negative = self.pick(neg_neg, sub.positive);
                self.mk(positive, negative)
            }
            Expression::LogicalExpression(l)
                if matches!(l.operator, LogicalOperator::And | LogicalOperator::Or) =>
            {
                let l = l.unbox();
                let comp_op = if l.operator == LogicalOperator::And {
                    LogicalOperator::Or
                } else {
                    LogicalOperator::And
                };
                let op = l.operator;
                let left = self.compute(l.left);
                let right = self.compute(l.right);

                let pos_a = self.logical_node(op, self.clone_m(&left.positive), self.clone_m(&right.positive));
                let comp_b =
                    self.logical_node(comp_op, self.clone_m(&left.negative), self.clone_m(&right.negative));
                let positive = self.pick(pos_a, self.negate(comp_b));

                let pos_a2 = self.logical_node(op, self.clone_m(&left.positive), self.clone_m(&right.positive));
                let comp_b2 = self.logical_node(comp_op, left.negative, right.negative);
                let negative = self.pick(self.negate(pos_a2), self.changed(comp_b2));
                self.mk(positive, negative)
            }
            Expression::ConditionalExpression(c) => {
                let c = c.unbox();
                let test = self.leaf(c.test);
                let then_s = self.compute(c.consequent);
                let else_s = self.compute(c.alternate);
                let positive = self.cond_node(self.clone_m(&test), then_s.positive, else_s.positive);
                let negative = self.cond_node(test, then_s.negative, else_s.negative);
                self.mk(positive, negative)
            }
            other => {
                let pos = self.leaf(other);
                let neg = self.negate(self.clone_m(&pos));
                self.mk(pos, neg)
            }
        }
    }

    fn mk(&self, positive: Measured<'a>, negative: Measured<'a>) -> MinCond<'a> {
        MinCond { positive, negative: self.changed(negative) }
    }

    fn changed(&self, mut m: Measured<'a>) -> Measured<'a> {
        m.changed = true;
        m
    }

    fn pick(&self, a: Measured<'a>, b: Measured<'a>) -> Measured<'a> {
        if a.cost == b.cost {
            if b.changed {
                a
            } else {
                b
            }
        } else if a.cost < b.cost {
            a
        } else {
            b
        }
    }

    fn one_level_cost(&self, is_not: bool, parent_prec: u8, children: &[&Measured<'a>]) -> usize {
        let mut cost = if is_not { 1 } else { 0 };
        for c in children {
            if let Some(n) = &c.node {
                if precedence(n) < parent_prec {
                    cost += 2;
                }
            }
        }
        cost
    }

    fn not_node(&self, m: Measured<'a>) -> Measured<'a> {
        let Some(node) = m.node else { return m };
        let cost = m.cost + self.one_level_cost(true, UNARY_PREC, &[&Measured { node: Some(node.clone_in(self.alloc)), cost: 0, changed: false }]);
        Measured {
            node: Some(self.ast.expression_unary(SPAN, UnaryOperator::LogicalNot, node)),
            cost,
            changed: m.changed,
        }
    }

    fn logical_node(&self, op: LogicalOperator, left: Measured<'a>, right: Measured<'a>) -> Measured<'a> {
        let prec = logical_prec(op);
        let extra = self.one_level_cost(false, prec, &[&left, &right]);
        let cost = left.cost + right.cost + extra;
        let changed = left.changed || right.changed;
        let (Some(l), Some(r)) = (left.node, right.node) else {
            return self.sentinel();
        };
        Measured { node: Some(self.ast.expression_logical(SPAN, l, op, r)), cost, changed }
    }

    fn cond_node(&self, test: Measured<'a>, cons: Measured<'a>, alt: Measured<'a>) -> Measured<'a> {
        let extra = self.one_level_cost(false, COND_PREC, &[&test, &cons, &alt]);
        let cost = test.cost + cons.cost + alt.cost + extra;
        let changed = test.changed || cons.changed || alt.changed;
        let (Some(t), Some(c), Some(a)) = (test.node, cons.node, alt.node) else {
            return self.sentinel();
        };
        Measured { node: Some(self.ast.expression_conditional(SPAN, t, c, a)), cost, changed }
    }

    /// Negate a measured node: flip equality ops, strip a leading `!`, else wrap.
    fn negate(&self, m: Measured<'a>) -> Measured<'a> {
        let Some(node) = &m.node else { return m };
        match node {
            Expression::BinaryExpression(b) => {
                let flipped = match b.operator {
                    BinaryOperator::Equality => Some(BinaryOperator::Inequality),
                    BinaryOperator::Inequality => Some(BinaryOperator::Equality),
                    BinaryOperator::StrictEquality => Some(BinaryOperator::StrictInequality),
                    BinaryOperator::StrictInequality => Some(BinaryOperator::StrictEquality),
                    _ => None,
                };
                if let Some(op) = flipped {
                    let Some(Expression::BinaryExpression(b)) = m.node else { unreachable!() };
                    let b = b.unbox();
                    return Measured {
                        node: Some(self.ast.expression_binary(SPAN, b.left, op, b.right)),
                        cost: m.cost,
                        changed: true,
                    };
                }
                self.changed(self.not_node(m))
            }
            Expression::UnaryExpression(u) if u.operator == UnaryOperator::LogicalNot => {
                // strip the `!`
                let Some(Expression::UnaryExpression(u)) = m.node else { unreachable!() };
                let u = u.unbox();
                self.changed(self.leaf(u.argument))
            }
            _ => self.changed(self.not_node(m)),
        }
    }

    pub fn get_minimized(&self, mc: MinCond<'a>, style: Style) -> Measured<'a> {
        let pos_is_not = is_measured_not(&mc.positive);
        match style {
            Style::PreferUnnegated => mc.positive,
            Style::AllowLeadingNot => {
                if pos_is_not || mc.positive.cost <= mc.negative.cost {
                    mc.positive
                } else {
                    self.not_node(self.changed(mc.negative))
                }
            }
        }
    }
}

pub fn is_measured_not(m: &Measured) -> bool {
    matches!(&m.node, Some(Expression::UnaryExpression(u)) if u.operator == UnaryOperator::LogicalNot)
}

const UNARY_PREC: u8 = 16;
const COND_PREC: u8 = 3;
fn logical_prec(op: LogicalOperator) -> u8 {
    match op {
        LogicalOperator::Coalesce => 4,
        LogicalOperator::Or => 5,
        LogicalOperator::And => 6,
    }
}

/// Operator precedence, matching `node-util.ts::precedence`.
fn precedence(e: &Expression) -> u8 {
    match e {
        Expression::SequenceExpression(_) => 1,
        Expression::AssignmentExpression(_) | Expression::YieldExpression(_) => 2,
        Expression::ConditionalExpression(_) => 3,
        Expression::LogicalExpression(l) => logical_prec(l.operator),
        Expression::BinaryExpression(b) => match b.operator {
            BinaryOperator::BitwiseOR => 7,
            BinaryOperator::BitwiseXOR => 8,
            BinaryOperator::BitwiseAnd => 9,
            BinaryOperator::Equality
            | BinaryOperator::Inequality
            | BinaryOperator::StrictEquality
            | BinaryOperator::StrictInequality => 10,
            BinaryOperator::LessThan
            | BinaryOperator::LessEqualThan
            | BinaryOperator::GreaterThan
            | BinaryOperator::GreaterEqualThan
            | BinaryOperator::In
            | BinaryOperator::Instanceof => 11,
            BinaryOperator::ShiftLeft | BinaryOperator::ShiftRight | BinaryOperator::ShiftRightZeroFill => 12,
            BinaryOperator::Addition | BinaryOperator::Subtraction => 13,
            BinaryOperator::Multiplication | BinaryOperator::Division | BinaryOperator::Remainder => 14,
            BinaryOperator::Exponential => 15,
        },
        Expression::UnaryExpression(_) => 16,
        _ => 18, // primary / call / member — highest, never needs parens
    }
}
