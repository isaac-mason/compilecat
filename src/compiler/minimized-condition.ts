// Port of jscomp/MinimizedCondition.java.
//
// Builds two equivalent representations of a boolean condition — `positive`
// (the original semantics) and `negative` (the original negated). Each carries
// an estimated cost (negation chars + parenthesis pairs), enabling callers to
// pick the cheaper shape and apply De Morgan's law where it pays off.
//
// Shape:
//   - `MeasuredNode` is a lazy AST builder. `node` is the root; `children` is
//     either null (leaf — emit `node` as-is) or an array of MeasuredNode
//     describing the rebuilt children.
//   - `buildReplacement` walks the tree and assembles a fresh Babel node
//     tailored to the parent's type (UnaryExpression / LogicalExpression /
//     BinaryExpression / ConditionalExpression / SequenceExpression).
//
// The negative side of an `unoptimized` condition is a sentinel with
// `Number.MAX_SAFE_INTEGER` length so that `getMinimized` never picks it.

import * as t from '@babel/types';

import { precedence } from './node-util';

export type MinimizationStyle = 'PREFER_UNNEGATED' | 'ALLOW_LEADING_NOT';

export type MeasuredNode = {
    node: t.Node | null;
    children: MeasuredNode[] | null;
    length: number;
    changed: boolean;
};

export type MinimizedCondition = {
    positive: MeasuredNode;
    negative: MeasuredNode;
};

// ---------------------------------------------------------------------------
// Constructors.

export function fromConditionNode(n: t.Node): MinimizedCondition {
    if (
        (t.isUnaryExpression(n) && n.operator === '!') ||
        t.isLogicalExpression(n) ||
        t.isConditionalExpression(n) ||
        (t.isSequenceExpression(n) && n.expressions.length >= 2)
    ) {
        return computeMinimizedCondition(n);
    }
    return unoptimized(n);
}

export function unoptimized(n: t.Node): MinimizedCondition {
    return {
        positive: { node: n, children: null, length: 0, changed: false },
        negative: { node: null, children: null, length: Number.MAX_SAFE_INTEGER, changed: true },
    };
}

function mkMC(positive: MeasuredNode, negative: MeasuredNode): MinimizedCondition {
    return { positive, negative: change(negative) };
}

// ---------------------------------------------------------------------------
// Recursive cost computation.

function computeMinimizedCondition(n: t.Node): MinimizedCondition {
    if (t.isUnaryExpression(n) && n.operator === '!') {
        const subtree = computeMinimizedCondition(n.argument);
        const positive = pickBest(addNode(n, [subtree.positive]), subtree.negative);
        const negative = pickBest(negate(subtree.negative), subtree.positive);
        return mkMC(positive, negative);
    }

    if (t.isLogicalExpression(n) && (n.operator === '&&' || n.operator === '||')) {
        // Closure builds a synthetic `complementNode` of the opposite operator,
        // shared by the negative-side cost compare. We mirror that.
        const complement = t.logicalExpression(n.operator === '&&' ? '||' : '&&', n.left, n.right);
        const left = computeMinimizedCondition(n.left);
        const right = computeMinimizedCondition(n.right);

        const positive = pickBest(
            addNode(n, [left.positive, right.positive]),
            negate(addNode(complement, [left.negative, right.negative])),
        );
        const negative = pickBest(
            negate(addNode(n, [left.positive, right.positive])),
            change(addNode(complement, [left.negative, right.negative])),
        );
        return mkMC(positive, negative);
    }

    if (t.isConditionalExpression(n)) {
        const cond = forNode(n.test);
        const thenS = computeMinimizedCondition(n.consequent);
        const elseS = computeMinimizedCondition(n.alternate);
        const positive = addNode(n, [cond, thenS.positive, elseS.positive]);
        const negative = addNode(n, [cond, thenS.negative, elseS.negative]);
        return mkMC(positive, negative);
    }

    if (t.isSequenceExpression(n) && n.expressions.length >= 2) {
        const last = n.expressions[n.expressions.length - 1];
        const lhsNodes = n.expressions.slice(0, -1).map(forNode);
        const rhsSubtree = computeMinimizedCondition(last);
        const positive = addNode(n, [...lhsNodes, rhsSubtree.positive]);
        const negative = addNode(n, [...lhsNodes, rhsSubtree.negative]);
        return mkMC(positive, negative);
    }

    const pos = forNode(n);
    const neg = negate(pos);
    return mkMC(pos, neg);
}

// ---------------------------------------------------------------------------
// MeasuredNode primitives.

function forNode(n: t.Node): MeasuredNode {
    return { node: n, children: null, length: 0, changed: false };
}

function addNode(parent: t.Node, children: MeasuredNode[]): MeasuredNode {
    let cost = 0;
    let ch = false;
    for (const c of children) {
        cost += c.length;
        if (c.changed) ch = true;
    }
    cost += estimateCostOneLevel(parent, children);
    return { node: parent, children, length: cost, changed: ch };
}

function estimateCostOneLevel(parent: t.Node, children: MeasuredNode[]): number {
    let cost = 0;
    if (t.isUnaryExpression(parent) && parent.operator === '!') cost++;
    const parentPrec = precedence(parent);
    for (const c of children) {
        if (c.node !== null && precedence(c.node) < parentPrec) cost += 2;
    }
    return cost;
}

function pickBest(a: MeasuredNode, b: MeasuredNode): MeasuredNode {
    if (a.length === b.length) return b.changed ? a : b;
    return a.length < b.length ? a : b;
}

function change(m: MeasuredNode): MeasuredNode {
    if (m.changed) return m;
    return { node: m.node, children: m.children, length: m.length, changed: true };
}

function addNot(m: MeasuredNode): MeasuredNode {
    if (m.node === null) return m;
    const notNode = t.unaryExpression('!', m.node as t.Expression);
    return change(addNode(notNode, [m]));
}

function negate(m: MeasuredNode): MeasuredNode {
    if (m.node === null) return m;
    if (t.isBinaryExpression(m.node)) {
        switch (m.node.operator) {
            case '==':
                return updateOperator(m, '!=');
            case '!=':
                return updateOperator(m, '==');
            case '===':
                return updateOperator(m, '!==');
            case '!==':
                return updateOperator(m, '===');
        }
    }
    if (t.isUnaryExpression(m.node) && m.node.operator === '!') return withoutNot(m);
    return addNot(m);
}

function updateOperator(m: MeasuredNode, op: t.BinaryExpression['operator']): MeasuredNode {
    const orig = m.node as t.BinaryExpression;
    if (t.isPrivateName(orig.left)) return addNot(m);
    const newNode = t.binaryExpression(op, orig.left, orig.right);
    const children = m.children ?? normalizeChildren(orig);
    return { node: newNode, children, length: m.length, changed: true };
}

function withoutNotInternal(m: MeasuredNode): MeasuredNode {
    if (m.node === null || !t.isUnaryExpression(m.node) || m.node.operator !== '!') {
        throw new Error('withoutNot: expected NOT');
    }
    const children = m.children ?? normalizeChildren(m.node);
    return change(children[0]);
}

function normalizeChildren(node: t.Node): MeasuredNode[] {
    if (t.isUnaryExpression(node)) return [forNode(node.argument)];
    if (t.isLogicalExpression(node)) return [forNode(node.left), forNode(node.right)];
    if (t.isBinaryExpression(node)) {
        if (t.isPrivateName(node.left)) return [];
        return [forNode(node.left), forNode(node.right)];
    }
    if (t.isConditionalExpression(node)) {
        return [forNode(node.test), forNode(node.consequent), forNode(node.alternate)];
    }
    if (t.isSequenceExpression(node)) return node.expressions.map(forNode);
    return [];
}

// ---------------------------------------------------------------------------
// Public surface used by PeepholeMinimizeConditions.

export function getMinimized(mc: MinimizedCondition, style: MinimizationStyle): MeasuredNode {
    if (style === 'PREFER_UNNEGATED' || isMeasuredNot(mc.positive) || mc.positive.length <= mc.negative.length) {
        return mc.positive;
    }
    return addNot(mc.negative);
}

export function isMeasuredNot(m: MeasuredNode): boolean {
    return m.node !== null && t.isUnaryExpression(m.node) && m.node.operator === '!';
}

export function withoutNot(m: MeasuredNode): MeasuredNode {
    return withoutNotInternal(m);
}

export function isLowerPrecedenceThan(m: MeasuredNode, prec: number): boolean {
    return m.node !== null && precedence(m.node) < prec;
}

export function willChange(m: MeasuredNode, original: t.Node): boolean {
    return m.node !== original || m.changed;
}

export function buildReplacement(m: MeasuredNode): t.Node {
    if (m.node === null) throw new Error('buildReplacement: sentinel');
    if (m.children === null) return m.node;
    const kids = m.children.map(buildReplacement);
    return assembleNode(m.node, kids);
}

function assembleNode(parent: t.Node, kids: t.Node[]): t.Node {
    if (t.isUnaryExpression(parent)) {
        return t.unaryExpression(parent.operator, kids[0] as t.Expression, parent.prefix);
    }
    if (t.isLogicalExpression(parent)) {
        return t.logicalExpression(parent.operator, kids[0] as t.Expression, kids[1] as t.Expression);
    }
    if (t.isBinaryExpression(parent)) {
        if (t.isPrivateName(parent.left)) return parent;
        return t.binaryExpression(parent.operator, kids[0] as t.Expression, kids[1] as t.Expression);
    }
    if (t.isConditionalExpression(parent)) {
        return t.conditionalExpression(kids[0] as t.Expression, kids[1] as t.Expression, kids[2] as t.Expression);
    }
    if (t.isSequenceExpression(parent)) {
        return t.sequenceExpression(kids as t.Expression[]);
    }
    return parent;
}
