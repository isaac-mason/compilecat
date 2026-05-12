// Scalar Replacement of Aggregates — directive-driven.
//
// Converts `const v = [a, b, c]` + constant-index accesses (`v[0]`, `v[1]`,
// `v[2]`) into scalar locals `let v_0 = a, v_1 = b, v_2 = c` with member
// accesses rewritten to `v_0`, `v_1`, etc.
//
// Opt-in via `@sroa` on either the declaration itself or any enclosing
// function/block. Conservative escape analysis: we scan the enclosing scope
// (function body or program) and reject any reference to the binding's name
// that isn't a constant-index member read or write.

import * as t from '@babel/types';

import { commentIsSroaDirective, hasLeadingDirective } from './directives';
import { getSlot, setSlot } from './node-util';

const MIN_FIELDS = 2;
const MAX_FIELDS = 16;

export type SroaResult = {
    sroad: number;
};

type Candidate = {
    name: string;
    size: number;
    initExprs: t.Expression[];
    declarator: t.VariableDeclarator;
    declStmt: t.VariableDeclaration;
    declStmtParent: t.BlockStatement | t.Program;
    declStmtIndex: number;
    scope: t.Node;
};

export function applySroa(root: t.Node): SroaResult {
    const candidates = collectCandidates(root);
    if (candidates.length === 0) return { sroad: 0 };

    const safe: Candidate[] = [];
    for (const c of candidates) {
        if (passesEscapeAnalysis(c)) safe.push(c);
    }
    if (safe.length === 0) return { sroad: 0 };

    rewriteDeclarations(safe);
    rewriteAccesses(root, safe);
    return { sroad: safe.length };
}

// ---------------------------------------------------------------------------
// Phase 1 — discover annotated `const v = [...]` declarations.

function collectCandidates(root: t.Node): Candidate[] {
    const out: Candidate[] = [];

    const sroaScopeStack: boolean[] = [false];

    const walk = (n: t.Node, parent: t.Node | null, _key: string, index: number | undefined, scope: t.Node): void => {
        const enteringFn = t.isFunction(n);
        const enteringScope = enteringFn || t.isProgram(n);
        const annotated = sroaScopeStack[sroaScopeStack.length - 1] || hasSroaAnnotation(n, parent);
        if (enteringScope) {
            sroaScopeStack.push(annotated);
        }

        const nextScope = enteringScope ? n : scope;

        if (t.isVariableDeclaration(n) && parent && index !== undefined) {
            const declAnnot = annotated || hasSroaAnnotation(n, parent);
            for (const d of n.declarations) {
                if (!declAnnot && !hasSroaAnnotation(d)) continue;
                if (!t.isIdentifier(d.id) || !d.init) continue;
                const init = inferInitializer(d.init);
                if (!init) continue;
                if (parent && (t.isBlockStatement(parent) || t.isProgram(parent)) && typeof index === 'number') {
                    out.push({
                        name: d.id.name,
                        size: init.size,
                        initExprs: init.initExprs,
                        declarator: d,
                        declStmt: n,
                        declStmtParent: parent as t.BlockStatement | t.Program,
                        declStmtIndex: index,
                        scope: nextScope,
                    });
                }
            }
        }

        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c) walk(c, n, k, i, nextScope);
                }
            } else {
                walk(child, n, k, undefined, nextScope);
            }
        }

        if (enteringScope) sroaScopeStack.pop();
    };

    walk(root, null, '', undefined, root);
    return out;
}

function inferInitializer(init: t.Expression): { size: number; initExprs: t.Expression[] } | null {
    if (!t.isArrayExpression(init)) return null;
    const size = init.elements.length;
    if (size < MIN_FIELDS || size > MAX_FIELDS) return null;
    const exprs: t.Expression[] = [];
    for (const el of init.elements) {
        if (el === null || t.isSpreadElement(el)) return null;
        exprs.push(el);
    }
    return { size, initExprs: exprs };
}

function hasSroaAnnotation(n: t.Node, parent: t.Node | null = null): boolean {
    return hasLeadingDirective(n, parent, commentIsSroaDirective);
}

// ---------------------------------------------------------------------------
// Phase 2 — escape analysis. Reject if any reference is anything other than:
//   - the declarator id itself
//   - a constant-index MemberExpression (`name[<lit>]`) used as RHS or LHS
//   - the constant index is in [0, size)

function passesEscapeAnalysis(c: Candidate): boolean {
    let safe = true;

    const visit = (n: t.Node | null | undefined, parent: t.Node | null, key: string): void => {
        if (!safe || !n) return;

        if (t.isIdentifier(n) && n.name === c.name) {
            if (n === c.declarator.id) return;
            if (!isReadOrAssignContext(parent, key)) return;
            // Allow MemberExpression(name, NumericLiteral, computed=true) where
            // the member reference is the object of the expression.
            if (parent && t.isMemberExpression(parent) && key === 'object') {
                if (parent.computed && t.isNumericLiteral(parent.property)) {
                    const idx = parent.property.value;
                    if (idx >= 0 && idx < c.size && Number.isInteger(idx)) return;
                }
            }
            safe = false;
            return;
        }

        // Don't descend into nested functions that shadow `name` as a param.
        if (t.isFunction(n)) {
            for (const p of n.params) {
                if (paramNameIs(p, c.name)) return;
            }
        }

        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const cc of child) {
                    if (cc) visit(cc, n, k);
                }
            } else {
                visit(child, n, k);
            }
        }
    };

    visit(c.scope, null, '');
    return safe;
}

function paramNameIs(p: t.Node, name: string): boolean {
    if (t.isIdentifier(p)) return p.name === name;
    if (t.isAssignmentPattern(p)) return paramNameIs(p.left, name);
    if (t.isRestElement(p)) return paramNameIs(p.argument, name);
    return false;
}

function isReadOrAssignContext(parent: t.Node | null, key: string): boolean {
    if (parent === null) return false;
    if (t.isVariableDeclarator(parent) && key === 'id') return false;
    if (t.isFunctionDeclaration(parent) && key === 'id') return false;
    if (t.isFunctionExpression(parent) && key === 'id') return false;
    if (t.isClassDeclaration(parent) && key === 'id') return false;
    if (t.isClassExpression(parent) && key === 'id') return false;
    if (t.isLabeledStatement(parent) && key === 'label') return false;
    if (t.isBreakStatement(parent) && key === 'label') return false;
    if (t.isContinueStatement(parent) && key === 'label') return false;
    if (t.isMemberExpression(parent) && key === 'property' && !parent.computed) return false;
    if (t.isObjectProperty(parent) && key === 'key' && !parent.computed) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Phase 3 — declaration rewrite.

function rewriteDeclarations(safe: Candidate[]): void {
    for (const c of safe) {
        const newDecls: t.VariableDeclarator[] = [];
        for (let i = 0; i < c.size; i++) {
            const scalar = `${c.name}_${i}`;
            const init = c.initExprs[i] ?? t.identifier('undefined');
            newDecls.push(t.variableDeclarator(t.identifier(scalar), t.cloneNode(init, true, false)));
        }

        const idx = c.declStmt.declarations.indexOf(c.declarator);
        if (idx === -1) continue;

        if (c.declStmt.declarations.length === 1) {
            c.declStmt.kind = 'let';
            c.declStmt.declarations = newDecls;
        } else {
            c.declStmt.declarations.splice(idx, 1, ...newDecls);
        }
    }
}

// ---------------------------------------------------------------------------
// Phase 4 — access rewrite. We scan each safe candidate's scope and replace
// matching `name[<idx>]` with `name_<idx>`.

function rewriteAccesses(root: t.Node, safe: Candidate[]): void {
    const byScope = new Map<t.Node, Map<string, Candidate>>();
    for (const c of safe) {
        let m = byScope.get(c.scope);
        if (!m) {
            m = new Map();
            byScope.set(c.scope, m);
        }
        m.set(c.name, c);
    }
    if (byScope.size === 0) return;

    // Walk; track current "active scope" stack.
    const scopeStack: t.Node[] = [];

    const visit = (n: t.Node | null | undefined, parent: t.Node | null, key: string, index: number | undefined): void => {
        if (!n) return;

        const opensScope = byScope.has(n);
        if (opensScope) scopeStack.push(n);

        // Member expression rewrite.
        if (
            t.isMemberExpression(n) &&
            n.computed &&
            t.isIdentifier(n.object) &&
            t.isNumericLiteral(n.property) &&
            parent !== null
        ) {
            for (let i = scopeStack.length - 1; i >= 0; i--) {
                const m = byScope.get(scopeStack[i])!;
                const c = m.get(n.object.name);
                if (c) {
                    const idx = n.property.value;
                    if (idx >= 0 && idx < c.size && Number.isInteger(idx)) {
                        const replacement = t.identifier(`${c.name}_${idx}`);
                        setSlot(parent, key, index, replacement);
                    }
                    break;
                }
            }
        }

        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c) visit(c, n, k, i);
                }
            } else {
                visit(child, n, k, undefined);
            }
        }

        if (opensScope) scopeStack.pop();
    };

    visit(root, null, '', undefined);
}
