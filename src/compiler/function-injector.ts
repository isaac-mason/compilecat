// Port of jscomp/FunctionInjector.java (subset).
//
// Two responsibilities:
//   1. Classify a (callee, callsite) pair as DIRECT, BLOCK, or NO inline.
//   2. Perform the splice for the chosen mode.
//
// DIRECT is the fast path: callee body is a single `return EXPR;`. Args are
// substituted into EXPR; the call expression is replaced with the result.
//
// BLOCK is the general path: emit a labeled block that binds params, runs
// the (cloned) body with returns rewritten via FunctionToBlockMutator, and
// stores the value in a `_<callee>__result_<n>` temp. The call expression is
// replaced by that temp; the labeled block is hoisted to a sibling statement
// before the callsite's enclosing statement.
//
// Generated names follow Closure's `JSCompiler_inline_*` convention with a
// `_compilecat_` prefix on the label (which is globally findable) and a
// shorter callee-prefixed shape on the result temp (local to one function):
//   - label:  `_compilecat_inline_label_<callee>_<n>` (callee elided if anon)
//   - result: `_<callee>__result_<n>` (anon: `_result_<n>`)
//   - param:  unchanged in the common case. Renamed to `<orig>__<callee>`
//             (anon: `<orig>__<n>`) only when an arg expression references
//             `<orig>` as an identifier (the `let x = x.method();` shadow
//             class). Normalize bumps further with `__N` on actual collision.
//
// Limitations (v1):
//   - No `this` rewriting — we reject method calls and `this` references.
//   - No `arguments` rewriting — reject bodies that read it.
//   - No try/catch / generator / async / await / yield in body.
//   - No destructuring / rest / default params on the callee.
//   - Caller passes already-cloned body + args to keep ownership simple.

import * as t from '@babel/types';

import { mayHaveSideEffects } from './ast-analyzer';
import { generate } from './babel-interop';
import { mutateForBlockInline } from './function-to-block-mutator';
import { getSlot, setSlot, stripTypeScriptOnly } from './node-util';

export type InliningMode = 'DIRECT' | 'BLOCK' | 'NO';

export type InjectorOptions = {
    /** Used to allocate fresh `_compilecat_inline_*` ids. */
    nextId: () => number;
};

// ---------------------------------------------------------------------------
// Classification.

export type Callee = {
    /** Function declaration / expression / arrow whose body is to be inlined. */
    fn: t.Function;
    /** Names of declared parameters (only simple identifiers supported). */
    paramNames: string[];
};

export function classifyCallee(fn: t.Function): { mode: InliningMode; reason?: string } {
    if (fn.async) return { mode: 'NO', reason: 'async' };
    if (fn.generator) return { mode: 'NO', reason: 'generator' };
    if (!t.isBlockStatement(fn.body)) {
        // Arrow with expression body: treat as DIRECT.
        return { mode: 'DIRECT' };
    }
    for (const p of fn.params) {
        if (!t.isIdentifier(p)) return { mode: 'NO', reason: 'non-identifier param' };
    }
    if (bodyReadsThisOrArguments(fn.body)) {
        return { mode: 'NO', reason: 'reads this/arguments' };
    }
    if (bodyHasUnsupportedConstruct(fn.body)) {
        return { mode: 'NO', reason: 'unsupported construct' };
    }

    // DIRECT iff body is a single ReturnStatement (with expression).
    const stmts = fn.body.body;
    if (stmts.length === 1 && t.isReturnStatement(stmts[0]) && stmts[0].argument) {
        return { mode: 'DIRECT' };
    }
    if (stmts.length === 0) {
        // empty body — value is undefined; DIRECT still works.
        return { mode: 'DIRECT' };
    }
    return { mode: 'BLOCK' };
}

function bodyReadsThisOrArguments(body: t.BlockStatement): boolean {
    return t.traverseFast(body, (n) => {
        // Non-arrow functions get their own `this` / `arguments`.
        if (t.isFunction(n) && !t.isArrowFunctionExpression(n)) return t.traverseFast.skip;
        if (t.isThisExpression(n)) return t.traverseFast.stop;
        if (t.isIdentifier(n) && n.name === 'arguments') return t.traverseFast.stop;
        return undefined;
    });
}

function bodyHasUnsupportedConstruct(body: t.BlockStatement): boolean {
    return t.traverseFast(body, (n) => {
        if (t.isTryStatement(n) || t.isWithStatement(n) || t.isYieldExpression(n) || t.isAwaitExpression(n)) {
            return t.traverseFast.stop;
        }
        // Don't descend into nested functions — their try/yield is fine.
        if (t.isFunction(n)) return t.traverseFast.skip;
        return undefined;
    });
}

// ---------------------------------------------------------------------------
// CallSite shape.

export type CallSite = {
    /** The CallExpression to inline. */
    call: t.CallExpression;
    /** The statement that contains the CallExpression — used as the splice
     *  point for BLOCK mode hoisting. Must be inside a BlockStatement body. */
    enclosingStatement: t.Statement;
    /** The BlockStatement (or Program) holding the enclosing statement, plus
     *  the index of the enclosing statement inside it. */
    statementParent: t.BlockStatement | t.Program;
    statementIndex: number;
    /** Parent of the CallExpression and key/index for in-place replacement. */
    callParent: t.Node;
    callKey: string;
    callIndex?: number;
};

// ---------------------------------------------------------------------------
// Splice — DIRECT.
//
// Replace the CallExpression with a substituted clone of the callee's
// return-expression. Argument substitution is by α-rename in the cloned body.

export function inlineDirect(callee: Callee, site: CallSite): boolean {
    const fn = callee.fn;
    const args = site.call.arguments;
    if (!allArgsExpressions(args)) return false;
    if (args.length > callee.paramNames.length) return false; // ignore extras for v1

    let valueExpr: t.Expression;
    if (t.isBlockStatement(fn.body)) {
        const stmts = fn.body.body;
        if (stmts.length === 0) {
            valueExpr = t.identifier('undefined');
        } else if (stmts.length === 1 && t.isReturnStatement(stmts[0]) && stmts[0].argument) {
            valueExpr = t.cloneNode(stmts[0].argument, true);
        } else {
            return false;
        }
    } else {
        valueExpr = t.cloneNode(fn.body as t.Expression, true);
    }
    // Strip TS-only annotations from the value expression — same reasoning as
    // the BLOCK path: don't carry donor-side type markers into the consumer.
    stripTypeScriptOnly(valueExpr);

    // Build name → expression substitution map.
    const subs = new Map<string, t.Expression>();
    for (let i = 0; i < callee.paramNames.length; i++) {
        const a = args[i];
        if (a === undefined) {
            subs.set(callee.paramNames[i], t.identifier('undefined'));
        } else {
            subs.set(callee.paramNames[i], t.cloneNode(a as t.Expression, true));
        }
    }

    // Substitution is safe under α-rename only when each arg is used exactly
    // once OR the arg has no side effects. Otherwise, reads would re-execute
    // a side effect. Be conservative: count uses; bail if any arg with side
    // effects is used more than once. (Closure punts via temps; we leave that
    // to the BLOCK path to keep DIRECT tight.)
    const useCounts = countParamUses(valueExpr, callee.paramNames);
    for (const name of callee.paramNames) {
        const arg = subs.get(name);
        if (arg !== undefined && (useCounts.get(name) ?? 0) > 1 && mayHaveSideEffects(arg)) {
            return false;
        }
    }

    const breadcrumb = breadcrumbFor(site.call);
    valueExpr = substituteIdentifiers(valueExpr, subs);
    replaceCall(site, valueExpr);
    // Tag the enclosing statement so the breadcrumb prints on its own line
    // rather than mid-expression next to the substituted value.
    tagInlined(site.enclosingStatement, breadcrumb);
    return true;
}

// ---------------------------------------------------------------------------
// Call-site shape (CallSiteType in FunctionInjector.java).
//
// Mirrors Closure's recognizeCallSite. Knowing the surrounding shape lets us
// reuse an existing variable as the result temp instead of emitting a fresh
// `_<callee>__result_<n>`:
//
//   statement   `foo();`              → no result needed; splice replaces stmt
//   init        `let x = foo();`      → reuse `x`; drop the init, splice block
//                                       after the (now-uninitialized) decl
//   assign      `x = foo();`          → reuse `x`; splice replaces the
//                                       assignment statement
//   expression  anything else         → fresh `_<callee>__result_<n>`

type CallsiteShape =
    | { kind: 'statement' }
    | { kind: 'init'; declarator: t.VariableDeclarator; declaration: t.VariableDeclaration; name: string }
    | { kind: 'assign'; assignment: t.AssignmentExpression; name: string }
    | { kind: 'expression' };

function recognizeCallsite(site: CallSite): CallsiteShape {
    // statement: `foo();`
    if (t.isExpressionStatement(site.callParent) && site.callParent === site.enclosingStatement) {
        return { kind: 'statement' };
    }

    // init: `let|var x = foo();` (skip const — would require kind change).
    if (
        t.isVariableDeclarator(site.callParent) &&
        site.callKey === 'init' &&
        t.isVariableDeclaration(site.enclosingStatement) &&
        site.enclosingStatement.declarations.length === 1 &&
        site.enclosingStatement.declarations[0] === site.callParent &&
        (site.enclosingStatement.kind === 'let' || site.enclosingStatement.kind === 'var') &&
        t.isIdentifier(site.callParent.id)
    ) {
        return {
            kind: 'init',
            declarator: site.callParent,
            declaration: site.enclosingStatement,
            name: site.callParent.id.name,
        };
    }

    // assign: `x = foo();`
    if (
        t.isAssignmentExpression(site.callParent) &&
        site.callParent.operator === '=' &&
        site.callKey === 'right' &&
        t.isIdentifier(site.callParent.left) &&
        t.isExpressionStatement(site.enclosingStatement) &&
        site.enclosingStatement.expression === site.callParent
    ) {
        return {
            kind: 'assign',
            assignment: site.callParent,
            name: site.callParent.left.name,
        };
    }

    return { kind: 'expression' };
}

// ---------------------------------------------------------------------------
// Splice — BLOCK.

export function inlineBlock(callee: Callee, site: CallSite, options: InjectorOptions): boolean {
    const fn = callee.fn;
    if (!t.isBlockStatement(fn.body)) return false;
    const args = site.call.arguments;
    if (!allArgsExpressions(args)) return false;
    if (args.length > callee.paramNames.length) return false;

    const id = options.nextId();
    const cn = calleeName(callee.fn);
    const label = cn === null ? `_compilecat_inline_label_${id}` : `_compilecat_inline_label_${cn}_${id}`;

    // Clone body and args. Strip TS-only annotations from the cloned body so
    // the inlined block doesn't carry `: T` markers from the (TS) donor into
    // the consumer's authored shape. See `stripTypeScriptOnly` for rationale.
    const clonedBody = t.cloneNode(fn.body, true);
    stripTypeScriptOnly(clonedBody);
    const clonedArgs: t.Expression[] = [];
    for (let i = 0; i < callee.paramNames.length; i++) {
        const a = args[i];
        clonedArgs.push(a === undefined ? t.identifier('undefined') : t.cloneNode(a as t.Expression, true));
    }

    // Conditional alpha-rename. Rename a param P only when some arg references
    // P as an identifier — otherwise the prologue `let P = arg;` would emit
    // `let P = …P…;` and the RHS read would resolve to the new inner binding
    // (TDZ on let; pre-FunctionArgumentInjector this surfaced as `let dbvt =
    // dbvt;` inlining `ins(dbvt, ...)` inside `add(dbvt, ...)`).
    //
    // When we do rename, use `<orig>__<callee>` (or `<orig>__<inlineId>` for
    // anon callees) so the suffix carries meaning. Normalize handles any
    // collision afterward via its standard `__N` retry — but the common case
    // doesn't rename at all, leaving the original parameter names intact in
    // the bundle.
    const argFreeNames = new Set<string>();
    for (const a of clonedArgs) collectIdentifierNames(a, argFreeNames);

    const freshParams: string[] = [];
    const renames = new Map<string, string>();
    for (let i = 0; i < callee.paramNames.length; i++) {
        const orig = callee.paramNames[i];
        if (argFreeNames.has(orig)) {
            const suffix = cn === null ? String(id) : cn;
            const fresh = `${orig}__${suffix}`;
            freshParams.push(fresh);
            renames.set(orig, fresh);
        } else {
            freshParams.push(orig);
        }
    }
    if (renames.size > 0) renameInBody(clonedBody, renames);

    let shape = recognizeCallsite(site);

    // Reusing an existing variable name is unsafe if the donor body has free
    // reads of that name — those would resolve to the consumer's variable
    // instead of the donor module's, changing semantics. Demote to expression
    // shape in that case.
    if ((shape.kind === 'init' || shape.kind === 'assign') && bodyHasFreeRefTo(clonedBody, shape.name, freshParams)) {
        shape = { kind: 'expression' };
    }

    // Decide resultName + needsResult per shape.
    // Callee-prefixed shape (`_<callee>__result_<n>`) reads as "the value of
    // X" in the bundle. Anonymous callee → `_result_<n>`. The result temp is
    // local to one function; we don't need the `_compilecat_` global prefix
    // that the label carries.
    const fallbackResult = cn === null ? `_result_${id}` : `_${cn}__result_${id}`;
    let resultName: string;
    let needsResult: boolean;
    switch (shape.kind) {
        case 'statement':
            resultName = fallbackResult; // unused
            needsResult = false;
            break;
        case 'init':
        case 'assign':
            resultName = shape.name;
            needsResult = true;
            break;
        case 'expression':
            resultName = fallbackResult;
            needsResult = true;
            break;
    }

    const out = mutateForBlockInline({
        body: clonedBody,
        params: freshParams,
        args: clonedArgs,
        label,
        resultName,
        needsResult,
    });

    // Look up the enclosing statement's index dynamically — earlier inlines
    // on sibling statements may have shifted the array since `site` was
    // collected, making `site.statementIndex` stale.
    const insertIdx = site.statementParent.body.indexOf(site.enclosingStatement);
    if (insertIdx < 0) return false;
    const breadcrumb = breadcrumbFor(site.call);

    switch (shape.kind) {
        case 'statement': {
            // Replace `foo();` with the labeled block.
            tagInlined(out.block, breadcrumb);
            site.statementParent.body.splice(insertIdx, 1, out.block);
            return true;
        }
        case 'init': {
            // `let x = foo();` → `let x;` followed by the labeled block.
            // Drop the initializer in place; insert the block after.
            shape.declarator.init = null;
            tagInlined(out.block, breadcrumb);
            site.statementParent.body.splice(insertIdx + 1, 0, out.block);
            return true;
        }
        case 'assign': {
            // `x = foo();` → labeled block (which writes `x` on each return).
            tagInlined(out.block, breadcrumb);
            site.statementParent.body.splice(insertIdx, 1, out.block);
            return true;
        }
        case 'expression': {
            // Hoist `let _<callee>__result_<n>;` and the labeled
            // block before the enclosing statement; replace the call with the
            // result temp.
            const tempDecl = t.variableDeclaration('let', [t.variableDeclarator(t.identifier(resultName))]);
            tagInlined(tempDecl, breadcrumb);
            const inserts: t.Statement[] = [tempDecl, out.block];
            replaceCall(site, t.identifier(resultName));
            site.statementParent.body.splice(insertIdx, 0, ...inserts);
            return true;
        }
    }
}

/**
 * Render the original call expression concisely (e.g. `vec3.add(out, a, b)`)
 * so the breadcrumb points back at authored source. Mirrors the classic
 * tree's `breadcrumbFor` in `src/plugin/transforms/inline.ts`.
 */
function breadcrumbFor(call: t.CallExpression): string {
    const src = generate(t.cloneNode(call, true, false), {
        concise: true,
        comments: false,
        retainLines: false,
    }).code;
    return src.replace(/\s+/g, ' ').trim();
}

function tagInlined(node: t.Node, sig: string): void {
    t.addComment(node, 'leading', ` @applied-inline ${sig} `);
}

// Collect identifier names that appear in `expr`. Conservative: returns every
// identifier in a value-bearing position (skips non-computed member/object
// property keys, which are syntactic labels rather than references). Used by
// the conditional-rename check — false positives only cause an unnecessary
// rename, never a missed one.
function collectIdentifierNames(expr: t.Node, out: Set<string>): void {
    const walk = (n: t.Node | null | undefined, parent: t.Node | null, key: string): void => {
        if (!n || typeof n !== 'object' || !('type' in n)) return;

        if (t.isIdentifier(n)) {
            if (parent && t.isMemberExpression(parent) && key === 'property' && !parent.computed) return;
            if (parent && t.isOptionalMemberExpression(parent) && key === 'property' && !parent.computed) return;
            if (parent && (t.isObjectProperty(parent) || t.isObjectMethod(parent)) && key === 'key' && !parent.computed) return;
            out.add(n.name);
            return;
        }

        for (const k of Object.keys(n)) {
            if (
                k === 'type' ||
                k === 'loc' ||
                k === 'start' ||
                k === 'end' ||
                k === 'leadingComments' ||
                k === 'trailingComments' ||
                k === 'innerComments' ||
                k === 'extra'
            )
                continue;
            const v = (n as unknown as Record<string, unknown>)[k];
            if (Array.isArray(v)) {
                for (const item of v) walk(item as t.Node, n, k);
            } else if (v && typeof v === 'object' && 'type' in (v as object)) {
                walk(v as t.Node, n, k);
            }
        }
    };
    walk(expr, null, '');
}

// True iff `name` appears as a free read in `body` (not shadowed by a nested
// scope, not in a write/key context, not equal to one of the post-rename param
// names — those have been renamed and won't collide).
function bodyHasFreeRefTo(body: t.BlockStatement, name: string, paramNames: string[]): boolean {
    if (paramNames.includes(name)) return false; // shouldn't happen post-rename
    let found = false;

    const walk = (n: t.Node, parent: t.Node | null, key: string, shadowed: boolean): void => {
        if (found || !n) return;

        // Nested function: `name` is shadowed if it's a param or the function's
        // own id.
        if (t.isFunction(n)) {
            let nestedShadow = shadowed;
            for (const p of n.params) {
                collectParamNames(p, (pn) => {
                    if (pn === name) nestedShadow = true;
                });
            }
            if ((t.isFunctionExpression(n) || t.isFunctionDeclaration(n)) && n.id?.name === name) {
                nestedShadow = true;
            }
            descend(n, nestedShadow);
            return;
        }

        // Block scope: `let/const/class/function-decl` of `name` shadows it.
        if (t.isBlockStatement(n)) {
            let blockShadow = shadowed;
            for (const s of n.body) {
                if (t.isVariableDeclaration(s)) {
                    for (const d of s.declarations) {
                        if (t.isIdentifier(d.id) && d.id.name === name) blockShadow = true;
                    }
                } else if ((t.isFunctionDeclaration(s) || t.isClassDeclaration(s)) && s.id?.name === name) {
                    blockShadow = true;
                }
            }
            descend(n, blockShadow);
            return;
        }

        if (!shadowed && t.isIdentifier(n) && n.name === name && parent !== null && isReferenceContext(parent, key)) {
            found = true;
            return;
        }

        descend(n, shadowed);
    };

    const descend = (n: t.Node, shadowed: boolean): void => {
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c) walk(c, n, k, shadowed);
                }
            } else {
                walk(child, n, k, shadowed);
            }
        }
    };

    descend(body, false);
    return found;
}

// ---------------------------------------------------------------------------
// Helpers.

function allArgsExpressions(args: (t.Expression | t.SpreadElement | t.ArgumentPlaceholder)[]): args is t.Expression[] {
    for (const a of args) {
        if (t.isSpreadElement(a) || t.isArgumentPlaceholder(a)) return false;
    }
    return true;
}

function replaceCall(site: CallSite, replacement: t.Expression): void {
    setSlot(site.callParent, site.callKey, site.callIndex, replacement);
}

function countParamUses(root: t.Node, params: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const p of params) counts.set(p, 0);
    t.traverseFast(root, (n) => {
        if (t.isFunction(n)) return t.traverseFast.skip; // shadowed
        if (t.isIdentifier(n) && counts.has(n.name)) {
            counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
        }
        return undefined;
    });
    return counts;
}

// Scope-aware identifier rename across a body. For each Identifier reference
// of a name in `renames`, rewrite to the fresh name unless an inner scope
// shadows it (nested function with same param name, or block with same
// let/const/class/function-decl name).
function renameInBody(body: t.BlockStatement, renames: Map<string, string>): void {
    const visit = (n: t.Node, active: Map<string, string>): void => {
        if (active.size === 0) return;

        // Function creates a new scope. Filter out names shadowed by params or
        // own function-id (for FunctionExpression).
        if (t.isFunction(n)) {
            const filtered = new Map(active);
            for (const p of n.params) collectParamNames(p, (n) => filtered.delete(n));
            if ((t.isFunctionExpression(n) || t.isFunctionDeclaration(n)) && n.id) {
                filtered.delete(n.id.name);
            }
            if (filtered.size === 0) return;
            descend(n, filtered);
            return;
        }

        // Block scope filters out let/const/class/function-decl + var (var
        // doesn't actually scope to block but our callees are simple).
        if (t.isBlockStatement(n)) {
            const filtered = filterByBlockDecls(active, n);
            if (filtered.size === 0) return;
            descend(n, filtered);
            return;
        }

        descend(n, active);
    };

    const descend = (n: t.Node, active: Map<string, string>): void => {
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (!c) continue;
                    if (t.isIdentifier(c) && active.has(c.name) && isReferenceContext(n, k)) {
                        c.name = active.get(c.name)!;
                    } else {
                        visit(c, active);
                    }
                }
            } else {
                if (t.isIdentifier(child) && active.has(child.name) && isReferenceContext(n, k)) {
                    child.name = active.get(child.name)!;
                } else {
                    visit(child, active);
                }
            }
        }
    };

    descend(body, renames);
}

function collectParamNames(p: t.Node, drop: (name: string) => void): void {
    if (t.isIdentifier(p)) drop(p.name);
    else if (t.isAssignmentPattern(p)) collectParamNames(p.left, drop);
    else if (t.isRestElement(p)) collectParamNames(p.argument, drop);
}

function filterByBlockDecls(active: Map<string, string>, block: t.BlockStatement): Map<string, string> {
    let filtered: Map<string, string> | null = null;
    for (const s of block.body) {
        if (t.isVariableDeclaration(s)) {
            for (const d of s.declarations) {
                if (t.isIdentifier(d.id) && active.has(d.id.name)) {
                    filtered ??= new Map(active);
                    filtered.delete(d.id.name);
                }
            }
        } else if (t.isFunctionDeclaration(s) && s.id && active.has(s.id.name)) {
            filtered ??= new Map(active);
            filtered.delete(s.id.name);
        } else if (t.isClassDeclaration(s) && s.id && active.has(s.id.name)) {
            filtered ??= new Map(active);
            filtered.delete(s.id.name);
        }
    }
    return filtered ?? active;
}

function isReferenceContext(parent: t.Node, key: string): boolean {
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
    if (t.isObjectMethod(parent) && key === 'key' && !parent.computed) return false;
    return true;
}

function substituteIdentifiers(root: t.Expression, subs: Map<string, t.Expression>): t.Expression {
    let rootReplacement: t.Expression | null = null;

    const visit = (n: t.Node, parent: t.Node | null, key: string, index: number | undefined): void => {
        if (t.isFunction(n)) return; // shadowed
        if (t.isIdentifier(n) && subs.has(n.name)) {
            // Skip Identifier in non-reference contexts (non-computed member
            // `.prop`, object property key, etc.). Without this guard, inlining
            // `clamp(x, 0, 1)` into `Math.max(min, Math.min(max, value))` would
            // rewrite the `max`/`min` property identifiers into NumericLiterals,
            // producing `Math[1](0, Math[0](1, x))`.
            // Skip Identifier in write contexts too. For root expression
            // substitution, we're typically in a read context; LHS-of-assign
            // would mean we're rewriting params, which our classifier rejects
            // for v1 (parameter mutation in callee → BLOCK or NO).
            if (parent !== null && !isReferenceContext(parent, key)) return;
            const sub = t.cloneNode(subs.get(n.name)!, true);
            if (parent === null) rootReplacement = sub;
            else setSlot(parent, key, index, sub);
            return;
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
    };

    visit(root, null, '', undefined);
    return rootReplacement ?? root;
}

// Best-effort callee name for embedding in generated label names. Returns
// null for arrow / anonymous function expressions; the caller emits the
// shorter `_compilecat_inline_label_<id>` shape in that case.
function calleeName(fn: t.Function): string | null {
    if ((t.isFunctionDeclaration(fn) || t.isFunctionExpression(fn)) && fn.id) {
        return fn.id.name;
    }
    return null;
}
