// Port of jscomp/InlineFunctions.java (subset).
//
// Drives FunctionInjector: discovers candidate callees and call sites within
// a single Program, classifies each, and performs the splice.
//
// Operates on a single Program — in bundle-mode this is the entire chunk
// after rollup has resolved imports. No cross-file resolution; if you can
// see the callee in the program, it's a candidate.
//
//   - Candidate callees:
//     - `function NAME(...) { ... }` declarations at any block scope
//     - `const NAME = (...) => { ... }` / `const NAME = function (...) { ... }`
//   - Trigger:
//     - declaration carries an `@inline` JSDoc / leading block comment, OR
//     - call expression carries an `@inline` leading block comment, OR
//     - call sits inside a `@flatten`-annotated function
//   - Call sites:
//     - `NAME(args)` — Identifier callee matching a known candidate
//   - No method calls, no `this`/`arguments`, no recursion.
//
// Discovery is name-keyed. We don't model scope shadowing — if two callees
// share a name (top-level vs. nested), we conservatively treat the
// outermost as the only candidate.

import * as t from '@babel/types';

import { commentIsFlattenDirective, commentIsInlineDirective, hasLeadingDirective } from './directives';
import { type CallSite, type Callee, classifyCallee, inlineBlock, inlineDirect } from './function-injector';
import { getSlot } from './node-util';

export type InlineResult = {
    /** Number of distinct candidates that were resolved at least once. */
    inlined: number;
    /** Call sites attempted (DIRECT or BLOCK). */
    calls: number;
    /** Call sites where injection succeeded. */
    succeeded: number;
};

type Candidate = {
    name: string;
    callee: Callee;
    /** True when the declaration carries `@inline` (apply at every call). */
    declAnnotated: boolean;
    /** Path-index info for stripping the original declaration after we've
     *  consumed all uses, when declAnnotated is true. */
    declRef?: { parent: t.BlockStatement | t.Program; index: number };
};

// ---------------------------------------------------------------------------
// Public entry.

export function inlineFunctions(root: t.Node): InlineResult {
    const result: InlineResult = { inlined: 0, calls: 0, succeeded: 0 };

    const candidates = new Map<string, Candidate>();
    discoverCandidates(root, candidates);

    if (candidates.size === 0) return result;

    const sites = collectCallSites(root, candidates);

    let nextId = 0;
    const opts = { nextId: () => nextId++ };

    for (const { candidate, site } of sites) {
        const fn = candidate.callee.fn;
        const cls = classifyCallee(fn);
        if (cls.mode === 'NO') continue;

        result.calls++;
        let ok = false;
        if (cls.mode === 'DIRECT') {
            ok = inlineDirect(candidate.callee, site);
            if (!ok) {
                ok = inlineBlock(candidate.callee, site, opts);
            }
        } else {
            ok = inlineBlock(candidate.callee, site, opts);
        }
        if (ok) result.succeeded++;
    }

    if (result.succeeded > 0) result.inlined = candidates.size;

    stripFullyInlinedDecls(candidates, sites);

    return result;
}

// ---------------------------------------------------------------------------
// Candidate discovery.

function discoverCandidates(root: t.Node, out: Map<string, Candidate>): void {
    visitWithParents(root, (n, parent, _key, index) => {
        if (t.isFunctionDeclaration(n) && n.id) {
            const params = paramNames(n);
            if (params === null) return;
            const annotated = hasInlineAnnotation(n, parent);
            const c: Candidate = {
                name: n.id.name,
                callee: { fn: n, paramNames: params },
                declAnnotated: annotated,
            };
            if (parent && (t.isBlockStatement(parent) || t.isProgram(parent)) && index !== undefined) {
                c.declRef = { parent: parent as t.BlockStatement | t.Program, index };
            }
            if (!out.has(n.id.name)) out.set(n.id.name, c);
            return;
        }
        if (t.isVariableDeclaration(n) && n.declarations.length === 1) {
            const d = n.declarations[0];
            if (t.isIdentifier(d.id) && (t.isArrowFunctionExpression(d.init) || t.isFunctionExpression(d.init))) {
                const params = paramNames(d.init);
                if (params === null) return;
                const annotated = hasInlineAnnotation(n, parent) || hasInlineAnnotation(d.init);
                const c: Candidate = {
                    name: d.id.name,
                    callee: { fn: d.init, paramNames: params },
                    declAnnotated: annotated,
                };
                if (parent && (t.isBlockStatement(parent) || t.isProgram(parent)) && index !== undefined) {
                    c.declRef = { parent: parent as t.BlockStatement | t.Program, index };
                }
                if (!out.has(d.id.name)) out.set(d.id.name, c);
            }
        }
    });
}

function paramNames(fn: t.Function): string[] | null {
    const out: string[] = [];
    for (const p of fn.params) {
        if (!t.isIdentifier(p)) return null;
        out.push(p.name);
    }
    return out;
}

function hasInlineAnnotation(n: t.Node, parent: t.Node | null = null): boolean {
    return hasLeadingDirective(n, parent, commentIsInlineDirective);
}

function hasFlattenAnnotation(n: t.Node, parent: t.Node | null = null): boolean {
    return hasLeadingDirective(n, parent, commentIsFlattenDirective);
}

// ---------------------------------------------------------------------------
// Call site collection.

type Site = { candidate: Candidate; site: CallSite };

function collectCallSites(root: t.Node, candidates: Map<string, Candidate>): Site[] {
    const sites: Site[] = [];

    const flattenStack: boolean[] = [false];

    const walk = (
        n: t.Node,
        parent: t.Node | null,
        key: string,
        index: number | undefined,
        stmtCtx: { parent: t.BlockStatement | t.Program; index: number; stmt: t.Statement } | null,
    ): void => {
        const enteringFn = t.isFunction(n);
        if (enteringFn) {
            flattenStack.push(hasFlattenAnnotation(n, parent));
        }

        let nextStmtCtx = stmtCtx;
        if (
            parent &&
            (t.isBlockStatement(parent) || t.isProgram(parent)) &&
            key === 'body' &&
            index !== undefined &&
            t.isStatement(n)
        ) {
            nextStmtCtx = {
                parent: parent as t.BlockStatement | t.Program,
                index,
                stmt: n as t.Statement,
            };
        }

        if (t.isCallExpression(n) && nextStmtCtx !== null && parent !== null) {
            const cand = resolveCandidateForCall(n, candidates);
            if (cand !== null) {
                const callsiteAnnotated = hasInlineAnnotationOnCall(n, parent, key);
                const enclosingFlatten = flattenStack[flattenStack.length - 1];
                if (cand.declAnnotated || callsiteAnnotated || enclosingFlatten) {
                    sites.push({
                        candidate: cand,
                        site: {
                            call: n,
                            enclosingStatement: nextStmtCtx.stmt,
                            statementParent: nextStmtCtx.parent,
                            statementIndex: nextStmtCtx.index,
                            callParent: parent,
                            callKey: key,
                            callIndex: index,
                        },
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
                    if (c) walk(c, n, k, i, nextStmtCtx);
                }
            } else {
                walk(child, n, k, undefined, nextStmtCtx);
            }
        }

        if (enteringFn) flattenStack.pop();
    };

    walk(root, null, '', undefined, null);

    return sites;
}

function resolveCandidateForCall(call: t.CallExpression, candidates: Map<string, Candidate>): Candidate | null {
    const callee = call.callee;
    if (t.isIdentifier(callee)) return candidates.get(callee.name) ?? null;
    return null;
}

function hasInlineAnnotationOnCall(call: t.CallExpression, parent: t.Node, key: string): boolean {
    if (hasInlineAnnotation(call)) return true;
    if (key === 'expression' && t.isExpressionStatement(parent) && hasInlineAnnotation(parent)) {
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Decl stripping.

function stripFullyInlinedDecls(candidates: Map<string, Candidate>, sites: Site[]): void {
    const succeededByName = new Map<string, number>();
    for (const s of sites) {
        succeededByName.set(s.candidate.name, (succeededByName.get(s.candidate.name) ?? 0) + 1);
    }

    for (const [name, c] of candidates) {
        if (!c.declAnnotated) continue;
        if (!c.declRef) continue;
        if ((succeededByName.get(name) ?? 0) === 0) continue;
        const anyResidual = anyResidualReference(c.declRef.parent, name, c.declRef.index);
        if (anyResidual) continue;
        c.declRef.parent.body.splice(c.declRef.index, 1);
        for (const other of candidates.values()) {
            if (other.declRef && other.declRef.parent === c.declRef.parent && other.declRef.index > c.declRef.index) {
                other.declRef.index--;
            }
        }
    }
}

function anyResidualReference(parent: t.BlockStatement | t.Program, name: string, skipIndex: number): boolean {
    let found = false;
    for (let i = 0; i < parent.body.length; i++) {
        if (i === skipIndex) continue;
        const stmt = parent.body[i];
        visit(stmt, (n, parentNode, key) => {
            if (found) return;
            if (t.isIdentifier(n) && n.name === name && !isWriteContext(n, parentNode, key)) {
                found = true;
            }
        });
        if (found) return true;
    }
    return false;
}

function isWriteContext(n: t.Identifier, parent: t.Node | null, key: string): boolean {
    if (parent === null) return false;
    if (t.isVariableDeclarator(parent) && key === 'id') return true;
    if (t.isFunctionDeclaration(parent) && key === 'id') return true;
    if (t.isFunctionExpression(parent) && key === 'id') return true;
    if (t.isAssignmentExpression(parent) && key === 'left') return true;
    if (t.isUpdateExpression(parent) && key === 'argument') return true;
    if (t.isMemberExpression(parent) && key === 'property' && !parent.computed) return true;
    if (t.isObjectProperty(parent) && key === 'key' && !parent.computed) return true;
    if (t.isLabeledStatement(parent) && key === 'label') return true;
    if (t.isBreakStatement(parent) && key === 'label') return true;
    if (t.isContinueStatement(parent) && key === 'label') return true;
    void n;
    return false;
}

// ---------------------------------------------------------------------------
// Tiny visitor utilities.

function visit(root: t.Node, fn: (n: t.Node, parent: t.Node | null, key: string, index?: number) => void): void {
    const walk = (n: t.Node, parent: t.Node | null, key: string, index?: number): void => {
        fn(n, parent, key, index);
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c) walk(c, n, k, i);
                }
            } else {
                walk(child, n, k);
            }
        }
    };
    walk(root, null, '');
}

function visitWithParents(root: t.Node, fn: (n: t.Node, parent: t.Node | null, key: string, index?: number) => void): void {
    visit(root, fn);
}
