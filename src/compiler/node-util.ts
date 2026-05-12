// Port of jscomp/NodeUtil.java (subset).
//
// NodeUtil in Closure is ~5000 LOC of Rhino-AST helpers. We port only what
// the algorithms we're bringing over actually need, on Babel types.
//
// Helpers added incrementally as ControlFlowAnalysis / DataFlowAnalysis /
// liveness passes consume them.

import * as t from '@babel/types';

/**
 * The condition-bearing child of a control structure. Mirrors Closure's
 * `getConditionExpression` — null for things like `for(;;)` where the test
 * slot is empty.
 */
export function getConditionExpression(node: t.Node): t.Expression | null {
    if (
        t.isIfStatement(node) ||
        t.isWhileStatement(node) ||
        t.isDoWhileStatement(node) ||
        t.isConditionalExpression(node)
    ) {
        return node.test;
    }
    if (t.isForStatement(node)) {
        return node.test ?? null;
    }
    return null;
}

/**
 * Whether `node` is a statement (control-flow-significant). Closure uses this
 * to decide what gets its own CFG node. Babel's `t.isStatement` covers most
 * of this but excludes `SwitchCase` (which we treat as case body sequence
 * elements), so the test composes both.
 */
export function isStatement(node: t.Node): boolean {
    return t.isStatement(node);
}

/**
 * Whether `node` is a loop construct. Used by ControlFlowAnalysis when
 * resolving break/continue targets.
 */
export function isLoop(node: t.Node): boolean {
    return (
        t.isWhileStatement(node) ||
        t.isDoWhileStatement(node) ||
        t.isForStatement(node) ||
        t.isForInStatement(node) ||
        t.isForOfStatement(node)
    );
}

/**
 * Whether `node` is a target for an unlabeled `break`. In ECMAScript that's
 * any loop or a switch.
 */
export function isBreakTarget(node: t.Node): boolean {
    return isLoop(node) || t.isSwitchStatement(node);
}

/**
 * Whether `node` is a target for an unlabeled `continue` — loops only.
 */
export function isContinueTarget(node: t.Node): boolean {
    return isLoop(node);
}

/**
 * Babel models a `for(;;)` body as the LAST child. Closure's NodeUtil exposes
 * helpers to navigate this; here it's just `.body` for every loop kind.
 */
export function getLoopBody(loop: t.Node): t.Statement | null {
    if (
        t.isWhileStatement(loop) ||
        t.isDoWhileStatement(loop) ||
        t.isForStatement(loop) ||
        t.isForInStatement(loop) ||
        t.isForOfStatement(loop)
    ) {
        return loop.body;
    }
    return null;
}

/**
 * Whether node introduces a new function scope. Mirrors Closure's
 * `isFunctionDeclaration` / `isFunction` group — for our purposes we treat
 * all function-like things uniformly (the CFG builder bails on async /
 * generator at the body level rather than here).
 */
export function isFunction(node: t.Node): boolean {
    return t.isFunction(node);
}

/**
 * The body of a function-like node (always a BlockStatement in practice for
 * declarations and named expressions; arrow-with-expression-body is the
 * exception — caller must handle that case explicitly if it cares).
 */
export function getFunctionBody(fn: t.Function): t.BlockStatement | t.Expression {
    return fn.body;
}

/**
 * Port of NodeUtil.isStatementBlock (NodeUtil.java:2170):
 *   return n.isRoot() || n.isScript() || n.isBlock() || n.isModuleBody();
 *
 * Babel has no ROOT or MODULE_BODY token — Program covers both.
 */
export function isStatementBlock(n: t.Node): boolean {
    return t.isProgram(n) || t.isBlockStatement(n);
}

/**
 * Port of NodeUtil.canMergeBlock (NodeUtil.java:2516):
 *
 *   for (Node c = block.getFirstChild(); c != null; c = c.getNext()) {
 *     switch (c.getToken()) {
 *       case LABEL -> {
 *         if (canMergeBlock(c)) continue; else return false;
 *       }
 *       case CONST, LET, CLASS, FUNCTION -> { return false; }
 *       default -> { continue; }
 *     }
 *   }
 *   return true;
 *
 * Babel mapping:
 *   LABEL    → LabeledStatement
 *   CONST    → VariableDeclaration with kind === 'const'
 *   LET      → VariableDeclaration with kind === 'let'
 *   CLASS    → ClassDeclaration
 *   FUNCTION → FunctionDeclaration
 *
 * Closure's recursive `canMergeBlock(c)` on a LABEL iterates the LABEL's
 * children — label name (NAME, default branch) plus the labeled statement
 * (which falls into one of the cases). The LabeledStatement node in Babel
 * has a single body slot; we replicate the same semantics by inspecting it.
 */
export function canMergeBlock(block: t.BlockStatement): boolean {
    for (const c of block.body) {
        if (!canMergeBlockChild(c)) return false;
    }
    return true;
}

function canMergeBlockChild(c: t.Node): boolean {
    if (t.isLabeledStatement(c)) {
        // Closure recurses into the LABEL — its children are the label name
        // (always safe) and the labeled statement (must itself be safe).
        return canMergeBlockChild(c.body);
    }
    if (t.isVariableDeclaration(c) && (c.kind === 'const' || c.kind === 'let')) return false;
    if (t.isClassDeclaration(c)) return false;
    if (t.isFunctionDeclaration(c)) return false;
    return true;
}

/**
 * Port of NodeUtil.tryMergeBlock (NodeUtil.java:2490):
 *
 *   boolean canMerge = ignoreBlockScopedDeclarations || canMergeBlock(block);
 *   if (isStatementBlock(parent) && canMerge) {
 *     // splice block's children up into parent in-place; detach block
 *     return true;
 *   }
 *   return false;
 *
 * Babel doesn't expose Closure's child-pointer API, so the caller passes the
 * parent statement array and the index of the block within it; we splice
 * directly. Returns the number of statements spliced in (== the block's
 * child count) when the merge happened, or 0 when it was rejected.
 */
export function tryMergeBlock(
    block: t.BlockStatement,
    parentBody: t.Statement[],
    indexInParent: number,
    parent: t.Node,
    ignoreBlockScopedDeclarations: boolean,
): number {
    if (!isStatementBlock(parent)) return 0;
    const canMerge = ignoreBlockScopedDeclarations || canMergeBlock(block);
    if (!canMerge) return 0;
    // Even when names are ancestor-unique, sibling block-scoped decls inside
    // the same statement-list can still collide on merge. Block-flatten with
    // `ignoreBlockScopedDeclarations=true` assumes nested names are unique
    // vs ancestors; it does NOT assume sibling-block uniqueness. Refuse the
    // merge when splicing would introduce a duplicate let/const/class/fn
    // binding name into `parentBody`.
    if (ignoreBlockScopedDeclarations) {
        const incoming = collectBlockScopedNames(block.body);
        if (incoming.size > 0) {
            for (let i = 0; i < parentBody.length; i++) {
                if (i === indexInParent) continue;
                const sibling = parentBody[i];
                if (sibling === undefined) continue;
                if (siblingDeclaresAny(sibling, incoming)) return 0;
            }
        }
    }
    const inserted = block.body.length;
    parentBody.splice(indexInParent, 1, ...block.body);
    return inserted;
}

function collectBlockScopedNames(stmts: t.Statement[]): Set<string> {
    const out = new Set<string>();
    for (const s of stmts) collectBlockScopedNamesInto(s, out);
    return out;
}

function collectBlockScopedNamesInto(s: t.Node, out: Set<string>): void {
    if (t.isLabeledStatement(s)) {
        collectBlockScopedNamesInto(s.body, out);
        return;
    }
    if (t.isVariableDeclaration(s) && (s.kind === 'const' || s.kind === 'let')) {
        for (const d of s.declarations) collectPatternNames(d.id, out);
        return;
    }
    if (t.isClassDeclaration(s) && s.id !== null && s.id !== undefined) {
        out.add(s.id.name);
        return;
    }
    if (t.isFunctionDeclaration(s) && s.id !== null && s.id !== undefined) {
        out.add(s.id.name);
        return;
    }
}

function siblingDeclaresAny(s: t.Node, names: Set<string>): boolean {
    const declared = new Set<string>();
    collectBlockScopedNamesInto(s, declared);
    for (const n of declared) if (names.has(n)) return true;
    return false;
}

function collectPatternNames(pat: t.Node, out: Set<string>): void {
    if (t.isIdentifier(pat)) {
        out.add(pat.name);
        return;
    }
    if (t.isArrayPattern(pat)) {
        for (const el of pat.elements) if (el !== null) collectPatternNames(el, out);
        return;
    }
    if (t.isObjectPattern(pat)) {
        for (const prop of pat.properties) {
            if (t.isRestElement(prop)) collectPatternNames(prop.argument, out);
            else if (t.isObjectProperty(prop)) collectPatternNames(prop.value as t.Node, out);
        }
        return;
    }
    if (t.isRestElement(pat)) {
        collectPatternNames(pat.argument, out);
        return;
    }
    if (t.isAssignmentPattern(pat)) {
        collectPatternNames(pat.left, out);
        return;
    }
}

/**
 * Closure's `isLiteralValue` — recognises primitive literal nodes used by
 * dataflow / fold passes. The `includeFunctions` flag matches Closure's
 * second-arg convention.
 */
export function isLiteralValue(node: t.Node, includeFunctions: boolean): boolean {
    if (
        t.isStringLiteral(node) ||
        t.isNumericLiteral(node) ||
        t.isBooleanLiteral(node) ||
        t.isNullLiteral(node) ||
        t.isBigIntLiteral(node) ||
        t.isRegExpLiteral(node)
    ) {
        return true;
    }
    if (t.isTemplateLiteral(node) && node.expressions.length === 0) return true;
    if (t.isUnaryExpression(node) && node.operator === 'void') {
        return isLiteralValue(node.argument, includeFunctions);
    }
    if (includeFunctions && t.isFunction(node)) return true;
    return false;
}

/**
 * Identifier nodes that name a binding (LHS of declaration, function param,
 * write target). Closure spells this `isName`; on Babel we just check for an
 * Identifier or a destructuring pattern element.
 */
export function isName(node: t.Node): node is t.Identifier {
    return t.isIdentifier(node);
}

/** Convenience: true if node is `undefined` keyword usage (an Identifier). */
export function isUndefined(node: t.Node): boolean {
    return t.isIdentifier(node) && node.name === 'undefined';
}

// ---------------------------------------------------------------------------
// Operator precedence (mirrors Closure's NodeUtil.precedence). Higher is
// tighter binding. Used by MinimizedCondition cost estimation and by the
// peephole `if(c)foo()` → `c&&foo()` decision (we only do the rewrite when
// the parens cost is favourable).

export const AND_PRECEDENCE = 6;
export const OR_PRECEDENCE = 5;

export function precedence(node: t.Node): number {
    if (t.isSequenceExpression(node)) return 1;
    if (t.isAssignmentExpression(node) || t.isYieldExpression(node)) return 2;
    if (t.isConditionalExpression(node)) return 3;
    if (t.isLogicalExpression(node)) {
        switch (node.operator) {
            case '??': return 4;
            case '||': return 5;
            case '&&': return 6;
        }
    }
    if (t.isBinaryExpression(node)) {
        switch (node.operator) {
            case '|': return 7;
            case '^': return 8;
            case '&': return 9;
            case '==': case '!=': case '===': case '!==': return 10;
            case '<': case '<=': case '>': case '>=': case 'in': case 'instanceof': return 11;
            case '<<': case '>>': case '>>>': return 12;
            case '+': case '-': return 13;
            case '*': case '/': case '%': return 14;
            case '**': return 15;
        }
    }
    if (t.isUnaryExpression(node)) return 16;
    if (t.isUpdateExpression(node)) return node.prefix ? 16 : 17;
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) return 18;
    if (
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node) ||
        t.isNewExpression(node)
    ) return 19;
    return 20;
}

// ---------------------------------------------------------------------------
// Structural AST equality (subset). Mirrors Closure's `isEquivalentTo` /
// `areNodesEqualForInlining` enough for peephole decisions: identifier name,
// literal value, and recursive structural compare across the node types our
// passes touch. Returns false for anything we don't recognize — conservative.

export function areNodesEqual(a: t.Node, b: t.Node): boolean {
    if (a.type !== b.type) return false;
    if (t.isIdentifier(a) && t.isIdentifier(b)) return a.name === b.name;
    if (t.isNumericLiteral(a) && t.isNumericLiteral(b)) return a.value === b.value;
    if (t.isStringLiteral(a) && t.isStringLiteral(b)) return a.value === b.value;
    if (t.isBooleanLiteral(a) && t.isBooleanLiteral(b)) return a.value === b.value;
    if (t.isNullLiteral(a) && t.isNullLiteral(b)) return true;
    if (t.isThisExpression(a) && t.isThisExpression(b)) return true;
    if (t.isReturnStatement(a) && t.isReturnStatement(b)) {
        const ax = a.argument;
        const bx = (b as t.ReturnStatement).argument;
        if (ax === null && bx === null) return true;
        if (ax === null || bx === null) return false;
        if (ax === undefined && bx === undefined) return true;
        if (ax === undefined || bx === undefined) return false;
        return areNodesEqual(ax, bx);
    }
    if (t.isThrowStatement(a) && t.isThrowStatement(b)) {
        return areNodesEqual(a.argument, (b as t.ThrowStatement).argument);
    }
    if (t.isExpressionStatement(a) && t.isExpressionStatement(b)) {
        return areNodesEqual(a.expression, (b as t.ExpressionStatement).expression);
    }
    if (t.isBreakStatement(a) && t.isBreakStatement(b)) {
        const al = a.label;
        const bl = (b as t.BreakStatement).label;
        if (!al && !bl) return true;
        if (!al || !bl) return false;
        return al.name === bl.name;
    }
    if (t.isContinueStatement(a) && t.isContinueStatement(b)) {
        const al = a.label;
        const bl = (b as t.ContinueStatement).label;
        if (!al && !bl) return true;
        if (!al || !bl) return false;
        return al.name === bl.name;
    }
    if (t.isBlockStatement(a) && t.isBlockStatement(b)) {
        const bb = b as t.BlockStatement;
        if (a.body.length !== bb.body.length) return false;
        for (let i = 0; i < a.body.length; i++) {
            if (!areNodesEqual(a.body[i], bb.body[i])) return false;
        }
        return true;
    }
    if (t.isMemberExpression(a) && t.isMemberExpression(b)) {
        if (a.computed !== b.computed) return false;
        return areNodesEqual(a.object, b.object) && areNodesEqual(a.property, b.property);
    }
    if (t.isBinaryExpression(a) && t.isBinaryExpression(b)) {
        if (a.operator !== b.operator) return false;
        if (t.isPrivateName(a.left) || t.isPrivateName(b.left)) return false;
        return areNodesEqual(a.left, b.left) && areNodesEqual(a.right, b.right);
    }
    if (t.isLogicalExpression(a) && t.isLogicalExpression(b)) {
        if (a.operator !== b.operator) return false;
        return areNodesEqual(a.left, b.left) && areNodesEqual(a.right, b.right);
    }
    if (t.isUnaryExpression(a) && t.isUnaryExpression(b)) {
        if (a.operator !== b.operator) return false;
        return areNodesEqual(a.argument, b.argument);
    }
    if (t.isConditionalExpression(a) && t.isConditionalExpression(b)) {
        return (
            areNodesEqual(a.test, b.test) &&
            areNodesEqual(a.consequent, b.consequent) &&
            areNodesEqual(a.alternate, b.alternate)
        );
    }
    if (t.isCallExpression(a) && t.isCallExpression(b)) {
        if (a.arguments.length !== b.arguments.length) return false;
        if (!t.isExpression(a.callee) || !t.isExpression(b.callee)) return false;
        if (!areNodesEqual(a.callee, b.callee)) return false;
        for (let i = 0; i < a.arguments.length; i++) {
            const aa = a.arguments[i];
            const bb = b.arguments[i];
            if (!t.isExpression(aa) || !t.isExpression(bb)) return false;
            if (!areNodesEqual(aa, bb)) return false;
        }
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Dynamic AST slot access.
//
// Babel's typed AST has no public typed surface for "set the child of `node`
// at key `k` (and array index `i`)" — every consumer is expected to know the
// concrete child shape. Bottom-up rewriters that work generically across node
// types do need this, so we centralise the cast in one place rather than
// scattering `(parent as any)[key]` across each pass.

type SlotMap = Record<string, t.Node | (t.Node | null)[] | null | undefined>;

/** Read `parent[key]` without losing exhaustiveness on the concrete type. */
export function getSlot(parent: t.Node, key: string): t.Node | (t.Node | null)[] | null | undefined {
    return (parent as unknown as SlotMap)[key];
}

/**
 * Strip TypeScript-only AST nodes from a tree, in place. The inliner clones a
 * callee body and splices it into the consumer; if the callee was TS, the
 * cloned body carries `: T` annotations on local declarations, `expr as T`
 * wrappers, etc. Those have no business showing up in the consumer's scope
 * — the consumer authored bare JS-shaped calls, not a typed re-declaration —
 * and downstream TS transforms sometimes fail to strip them when they appear
 * inside an inlined-block label (depends on context). Conservatively clear
 * everything TS-only here so the inlined block is shaped like JS regardless
 * of the donor file.
 *
 * Scope: annotation slots on identifiers / params / declarators / functions,
 * and the three type-assertion expression wrappers (`as`, `<T>x`, `x!`).
 * Doesn't touch TS-only top-level decls (type aliases, interfaces, enums) —
 * those don't appear inside an inlined function body in practice and are
 * stripped by the downstream TS transform on the consumer's authored shape.
 */
export function stripTypeScriptOnly(node: t.Node): void {
    const visit = (n: t.Node | null | undefined): void => {
        if (n === null || n === undefined) return;
        if (typeof (n as { type?: unknown }).type !== 'string') return;

        // Unwrap type-assertion expression wrappers by replacing the slot
        // that holds them with the inner expression. We can't replace `n`
        // in-place from this scope, so the caller handles wrappers via the
        // parent-slot walk below — this is the leaf case for everything
        // else.
        const slot = n as unknown as Record<string, unknown>;

        // Identifiers, RestElements, AssignmentPatterns, ObjectPatterns,
        // ArrayPatterns all carry `typeAnnotation`. Same key for params
        // and declarator ids. Clearing is safe even if absent.
        if ('typeAnnotation' in slot) slot.typeAnnotation = null;
        // Function-like nodes carry `returnType` + `typeParameters`.
        if ('returnType' in slot) slot.returnType = null;
        if ('typeParameters' in slot) slot.typeParameters = null;
        // `decorators` carries type info on parameter decorators — rare in
        // function bodies, leave as-is to avoid stripping user runtime
        // decorators.

        // Walk children, replacing type-assertion expression wrappers as we
        // descend so the parent's slot ends up pointing at the inner expr.
        for (const key of Object.keys(slot)) {
            const v = slot[key];
            if (Array.isArray(v)) {
                for (let i = 0; i < v.length; i++) {
                    const child = v[i] as t.Node | null | undefined;
                    if (child !== null && child !== undefined && typeof (child as { type?: unknown }).type === 'string') {
                        const unwrapped = unwrapTypeAssertion(child as t.Node);
                        if (unwrapped !== child) v[i] = unwrapped;
                        visit(v[i] as t.Node);
                    }
                }
            } else if (v !== null && v !== undefined && typeof (v as { type?: unknown }).type === 'string') {
                const unwrapped = unwrapTypeAssertion(v as t.Node);
                if (unwrapped !== v) slot[key] = unwrapped;
                visit(slot[key] as t.Node);
            }
        }
    };
    visit(node);
}

function unwrapTypeAssertion(n: t.Node): t.Node {
    // `expr as T`, `<T>expr`, `expr!` — all three preserve runtime semantics
    // and the wrapper is purely a type-system marker, so unwrap to the inner.
    let cur = n;
    while (
        t.isTSAsExpression(cur) ||
        t.isTSTypeAssertion(cur) ||
        t.isTSNonNullExpression(cur) ||
        t.isTSSatisfiesExpression(cur) ||
        t.isTSInstantiationExpression(cur)
    ) {
        cur = cur.expression;
    }
    return cur;
}

/** Write `parent[key]` (or `parent[key][index]` if `index` provided). */
export function setSlot(
    parent: t.Node,
    key: string,
    index: number | undefined,
    value: t.Node | null,
): void {
    const obj = parent as unknown as Record<string, t.Node | (t.Node | null)[] | null>;
    if (index !== undefined) (obj[key] as (t.Node | null)[])[index] = value;
    else obj[key] = value;
}
