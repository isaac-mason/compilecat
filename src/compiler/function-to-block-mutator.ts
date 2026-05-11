// Port of jscomp/FunctionToBlockMutator.java (subset).
//
// Given a callee function body and the arguments at a call site, produce a
// BlockStatement that, when spliced into the caller in place of the call,
// computes the same result as invoking the function. Returns inside the body
// are rewritten to `_r = expr; break LABEL;` so the labeled outer block exits
// the inlined region instead of the caller.
//
// Two modes correspond to FunctionInjector classifications:
//
//   - DIRECT: body is a single `return EXPR;`. Caller substitutes
//     parameter→arg in EXPR and uses it as the call expression's replacement.
//     This file does not handle DIRECT — see FunctionInjector.ts for that path.
//
//   - BLOCK: body has any other shape. Caller invokes mutateForBlockInline
//     here to get a labeled block that writes its result to a fresh temp
//     `_r` (or whatever the caller picked) and breaks out for any return.
//
// Limitations (all match Closure's port limits):
//   - No `this` rewriting — caller must reject method-call inlining.
//   - No `arguments` rewriting — caller must reject bodies that read
//     `arguments`.
//   - No try/catch, generators, async, await, yield in body — caller checks.
//   - No destructuring/rest/default params.
//   - All free names assumed unique to caller (caller-side α-rename if not).

import * as t from '@babel/types';

import {
    gatherCallArgumentsNeedingTemps,
    gatherModifiedParameters,
    injectArguments,
} from './function-argument-injector';
import { getSlot, setSlot } from './node-util';

export type BlockMutateInput = {
    body: t.BlockStatement;
    /** Names of the callee's parameters, in order. */
    params: string[];
    /** Argument expressions at the call site, already cloned. */
    args: t.Expression[];
    /** Label used on the wrapper block; caller picks a unique name. */
    label: string;
    /** Name of the result temp used in `_r = X; break LABEL;`. */
    resultName: string;
    /** When false, return statements are rewritten as bare `break LABEL;`
     *  (caller doesn't need the result — e.g. function used as a statement). */
    needsResult: boolean;
};

export type BlockMutateOutput = {
    /** Either a LabeledStatement (when interior returns force a `break LABEL;`
     *  out of the inlined region) or a plain BlockStatement (when the only
     *  return — if any — is the body's last statement and gets rewritten as a
     *  fall-through assignment). Mirrors Closure's `replaceReturns` returning
     *  a labelled wrapper only when `returnCount > 0` after handling the
     *  trailing return. */
    block: t.Statement;
    /** True when at least one return was rewritten — i.e. `_r` is initialized
     *  on at least one path. Caller may choose to declare `_r` only when this
     *  is true. */
    hasResultWrite: boolean;
};

export function mutateForBlockInline(input: BlockMutateInput): BlockMutateOutput {
    const { body, params, args, label, resultName, needsResult } = input;

    // 1. Decide which params need a `let X = arg;` temp vs. direct
    //    substitution. Mirrors Closure's FunctionArgumentInjector. The common
    //    case for compilecat's library inlines is a callee like
    //    `function f(out) { out[0] = ...; ... }` invoked as `f(targetArr)` —
    //    `out`'s arg is a simple Identifier, so it substitutes directly and
    //    the prologue ends up empty.
    const paramSet = new Set(params);
    const modified = gatherModifiedParameters(body, paramSet);
    const argsForClassify: t.Expression[] = params.map((_, i) => args[i] ?? undefinedExpr());
    const { needsTemp } = gatherCallArgumentsNeedingTemps(body, params, argsForClassify, modified);

    // 2. Substitute non-temp params directly into the body. Each substituted
    //    arg gets cloned per use by injectArguments.
    const replacements = new Map<string, t.Expression>();
    for (let i = 0; i < params.length; i++) {
        const name = params[i];
        if (needsTemp.has(name)) continue;
        replacements.set(name, argsForClassify[i]);
    }
    injectArguments(body, replacements);

    // 3. Build the prologue for the params that DO need a temp.
    const prologue: t.Statement[] = [];
    for (let i = 0; i < params.length; i++) {
        const name = params[i];
        if (!needsTemp.has(name)) continue;
        prologue.push(
            t.variableDeclaration('let', [
                t.variableDeclarator(t.identifier(name), argsForClassify[i]),
            ]),
        );
    }

    // 4. Closure's `replaceReturns` (FunctionToBlockMutator.java:408) special-
    //    cases a trailing `return X;` — the function's last statement. That
    //    return falls through naturally, so it can be rewritten as a plain
    //    assignment (or expression statement) with no `break LABEL;` needed.
    //    If no other returns remain after that rewrite, the labeled wrapper
    //    can be dropped entirely and the inlined region is just a BlockStatement
    //    that the simplifier will flatten into the parent.
    let hasResultWrite = false;
    const onWrite = () => {
        hasResultWrite = true;
    };

    const hasReturnAtExit = endsWithReturn(body);
    const interiorReturns = countShallowReturns(body) - (hasReturnAtExit ? 1 : 0);

    if (hasReturnAtExit) {
        const last = body.body[body.body.length - 1] as t.ReturnStatement;
        const replacement = makeTrailingReturnReplacement(
            last.argument,
            resultName,
            needsResult,
            onWrite,
        );
        body.body.splice(body.body.length - 1, 1, ...replacement);
    }

    // Port of FunctionToBlockMutator.java:447-450 (addDummyAssignment): when a
    // result is required but the body has no return-at-exit, append
    // `_r = void 0;` so `_r` is initialized on every fall-through path. Without
    // this, downstream reads of `_r` could observe a previous BLOCK-inline's
    // value when the function falls off the end.
    if (needsResult && !hasReturnAtExit) {
        body.body.push(
            t.expressionStatement(
                t.assignmentExpression('=', t.identifier(resultName), undefinedExpr()),
            ),
        );
        hasResultWrite = true;
    }

    if (interiorReturns > 0) {
        rewriteReturns(body, label, resultName, needsResult, onWrite);
        const block = t.blockStatement([...prologue, ...body.body]);
        const labeled = t.labeledStatement(t.identifier(label), block);
        return { block: labeled, hasResultWrite };
    }

    return {
        block: t.blockStatement([...prologue, ...body.body]),
        hasResultWrite,
    };
}

/** Closure's `NodeUtil.newUndefinedNode` — `void 0`. Shadow-proof and one
 *  byte shorter than `undefined`. */
function undefinedExpr(): t.Expression {
    return t.unaryExpression('void', t.numericLiteral(0));
}

function countShallowReturns(root: t.Node): number {
    let count = 0;
    const walk = (n: t.Node): void => {
        if (t.isFunction(n)) return;
        if (t.isReturnStatement(n)) count++;
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) if (c) walk(c);
            } else {
                walk(child);
            }
        }
    };
    for (const k of t.VISITOR_KEYS[root.type] ?? []) {
        const child = getSlot(root, k);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (const c of child) if (c) walk(c);
        } else {
            walk(child);
        }
    }
    return count;
}

function endsWithReturn(body: t.BlockStatement): boolean {
    const last = body.body[body.body.length - 1];
    return last !== undefined && t.isReturnStatement(last);
}

function makeTrailingReturnReplacement(
    arg: t.Expression | null | undefined,
    resultName: string,
    needsResult: boolean,
    onWrite: () => void,
): t.Statement[] {
    if (needsResult) {
        const rhs = arg ?? undefinedExpr();
        onWrite();
        return [
            t.expressionStatement(
                t.assignmentExpression('=', t.identifier(resultName), rhs),
            ),
        ];
    }
    if (arg && hasSideEffects(arg)) return [t.expressionStatement(arg)];
    return [];
}

// ---------------------------------------------------------------------------
// Return rewriter.
//
// Replaces every `return X;` reachable from `root` (without crossing into a
// nested function) with either:
//   needsResult=true:   `{ _r = X; break LABEL; }` (or just `break LABEL;` if X is undefined)
//   needsResult=false:  `break LABEL;`

function rewriteReturns(
    root: t.Node,
    label: string,
    resultName: string,
    needsResult: boolean,
    onWrite: () => void,
): void {
    const walk = (n: t.Node, parent: t.Node, key: string, index?: number): void => {
        // Don't descend into nested functions — their returns belong to them.
        if (t.isFunction(n) || t.isClassBody(n)) return;

        // Process children first; then handle this node.
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

        if (t.isReturnStatement(n)) {
            const replacement = makeReturnReplacement(
                n.argument,
                label,
                resultName,
                needsResult,
                onWrite,
            );
            if (index !== undefined) {
                const arr = getSlot(parent, key) as t.Statement[];
                arr.splice(index, 1, ...replacement);
            } else {
                // ReturnStatement under a non-array slot (e.g. IfStatement.consequent).
                // Wrap replacement in a BlockStatement so the slot accepts it.
                setSlot(parent, key, undefined, t.blockStatement(replacement));
            }
        }
    };

    for (const k of t.VISITOR_KEYS[root.type] ?? []) {
        const child = getSlot(root, k);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (c) walk(c, root, k, i);
            }
        } else {
            walk(child, root, k);
        }
    }
}

function makeReturnReplacement(
    arg: t.Expression | null | undefined,
    label: string,
    resultName: string,
    needsResult: boolean,
    onWrite: () => void,
): t.Statement[] {
    const out: t.Statement[] = [];
    if (needsResult) {
        const rhs = arg ?? undefinedExpr();
        out.push(
            t.expressionStatement(
                t.assignmentExpression('=', t.identifier(resultName), rhs),
            ),
        );
        onWrite();
    } else if (arg && hasSideEffects(arg)) {
        // Result discarded but expression has side effects — keep them.
        out.push(t.expressionStatement(arg));
    }
    out.push(t.breakStatement(t.identifier(label)));
    return out;
}

function hasSideEffects(n: t.Node): boolean {
    // Conservative: anything other than a literal or simple identifier may
    // have side effects. Used only by the discard-result path.
    if (t.isLiteral(n)) return false;
    if (t.isIdentifier(n)) return false;
    return true;
}
