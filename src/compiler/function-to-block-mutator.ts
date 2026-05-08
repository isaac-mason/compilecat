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
    block: t.LabeledStatement;
    /** True when at least one return was rewritten — i.e. `_r` is initialized
     *  on at least one path. Caller may choose to declare `_r` only when this
     *  is true. */
    hasResultWrite: boolean;
};

export function mutateForBlockInline(input: BlockMutateInput): BlockMutateOutput {
    const { body, params, args, label, resultName, needsResult } = input;

    // 1. Build the parameter-binding prologue. We bind each param to its arg
    //    via a `let` declaration. Closure does scalar substitution where safe;
    //    we punt and always bind, leaving redundant binds for the simplifier
    //    to clean up.
    const prologue: t.Statement[] = [];
    for (let i = 0; i < params.length; i++) {
        const arg = args[i] ?? t.identifier('undefined');
        prologue.push(
            t.variableDeclaration('let', [t.variableDeclarator(t.identifier(params[i]), arg)]),
        );
    }

    // 2. Rewrite returns inside the cloned body.
    let hasResultWrite = false;
    rewriteReturns(body, label, resultName, needsResult, () => {
        hasResultWrite = true;
    });

    // 3. Wrap [...prologue, ...body.body] in a block, then label it.
    const block = t.blockStatement([...prologue, ...body.body]);
    const labeled = t.labeledStatement(t.identifier(label), block);

    return { block: labeled, hasResultWrite };
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
        const rhs = arg ?? t.identifier('undefined');
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
