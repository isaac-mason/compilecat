// Loop unrolling — directive-driven (no Closure analogue).
//
// Replaces an opt-in `@unroll` loop with a flat sequence of its body, one
// copy per iteration, with the loop variable substituted by its concrete
// value. Supported shapes:
//
//   - for (let i = <lit>; i <(=) <lit>; i(++|+= <lit>)) { ... }
//   - for (const x of [<lit>, <lit>, ...]) { ... }
//
// Soft-fails (leaves the loop intact, strips the directive) when the trip
// count isn't statically known or the body has cross-loop control flow.
//
// Same identifier-substitution caveats as classic compilecat: we only rewrite
// reads that aren't shadowed by an inner declaration. We don't have a full
// scope analyzer here — we walk depth-first tracking inner shadowing
// declarations on the fly.

import * as t from '@babel/types';

import { DIRECTIVE_PATTERNS } from './directives';
import { getSlot, setSlot } from './node-util';

const MAX_UNROLL_ITERATIONS = 1024;
const MAX_UNROLL_PASSES = 16;

export type UnrollResult = {
    unrolled: number;
};

type LoopShape = {
    varName: string;
    start: number;
    bound: number;
    inclusive: boolean;
    step: number;
};

export function unrollLoops(root: t.Node): UnrollResult {
    let total = 0;
    for (let pass = 0; pass < MAX_UNROLL_PASSES; pass++) {
        const n = unrollPass(root);
        if (n === 0) break;
        total += n;
    }
    return { unrolled: total };
}

function unrollPass(root: t.Node): number {
    let count = 0;
    walkStatementLists(root, (body, inOptimize) => {
        for (let i = 0; i < body.length; i++) {
            const s = body[i];
            if (!hasUnrollAnnotation(s) && !inOptimize) continue;

            if (t.isForStatement(s)) {
                const out = expandFor(s);
                if (out !== null) {
                    body.splice(i, 1, ...out);
                    count++;
                    i += out.length - 1;
                    continue;
                }
                stripUnrollComments(s);
                continue;
            }
            if (t.isForOfStatement(s)) {
                const out = expandForOf(s);
                if (out !== null) {
                    body.splice(i, 1, ...out);
                    count++;
                    i += out.length - 1;
                    continue;
                }
                stripUnrollComments(s);
            }
        }
    });
    return count;
}

// ---------------------------------------------------------------------------
// for-statement unroll.

function expandFor(node: t.ForStatement): t.Statement[] | null {
    const shape = parseLoopShape(node);
    if (!shape) return null;
    const values = computeIterationValues(shape);
    if (!values) return null;
    if (values.length === 0) return [];
    if (bodyHasUnsafeControlFlow(node.body)) return null;

    const out: t.Statement[] = [];
    for (const v of values) {
        out.push(...iterationStmts(node.body, shape.varName, t.numericLiteral(v)));
    }
    return out;
}

function iterationStmts(body: t.Statement, varName: string, replacement: t.Expression): t.Statement[] {
    // Each iteration becomes its own BlockStatement so per-iteration
    // let/const/class/fn-decl bindings stay isolated. The simplifier's
    // demand-driven α-rename (see normalize.renameForFlatten) renames
    // colliding inner bindings before block-flatten merges them, so the
    // wrappers don't ossify — they collapse into the parent once names
    // are unique.
    if (t.isBlockStatement(body)) {
        const clonedBlock = t.cloneNode(body, true, true);
        substitute(clonedBlock, varName, replacement, false);
        return [clonedBlock];
    }
    return [cloneAndSubstitute(body, varName, replacement)];
}

function parseLoopShape(node: t.ForStatement): LoopShape | null {
    const init = node.init;
    if (!t.isVariableDeclaration(init) || init.declarations.length !== 1) return null;
    const decl = init.declarations[0];
    if (!t.isIdentifier(decl.id)) return null;
    if (!decl.init || !t.isNumericLiteral(decl.init)) return null;
    const varName = decl.id.name;
    const start = decl.init.value;

    const test = node.test;
    if (!test || !t.isBinaryExpression(test)) return null;
    if (!t.isIdentifier(test.left) || test.left.name !== varName) return null;
    if (!t.isNumericLiteral(test.right)) return null;
    const bound = test.right.value;
    let inclusive: boolean;
    if (test.operator === '<') inclusive = false;
    else if (test.operator === '<=') inclusive = true;
    else return null;

    const update = node.update;
    if (!update) return null;
    let step: number;
    if (t.isUpdateExpression(update)) {
        if (!t.isIdentifier(update.argument) || update.argument.name !== varName) return null;
        if (update.operator !== '++') return null;
        step = 1;
    } else if (t.isAssignmentExpression(update)) {
        if (!t.isIdentifier(update.left) || update.left.name !== varName) return null;
        if (!t.isNumericLiteral(update.right)) return null;
        if (update.operator !== '+=') return null;
        step = update.right.value;
    } else {
        return null;
    }
    if (step <= 0 || !Number.isInteger(step)) return null;
    return { varName, start, bound, inclusive, step };
}

function computeIterationValues(shape: LoopShape): number[] | null {
    const values: number[] = [];
    const limit = shape.inclusive ? shape.bound + 1 : shape.bound;
    for (let i = shape.start; i < limit; i += shape.step) {
        values.push(i);
        if (values.length > MAX_UNROLL_ITERATIONS) return null;
    }
    return values;
}

// ---------------------------------------------------------------------------
// for-of unroll over a literal array.

function expandForOf(node: t.ForOfStatement): t.Statement[] | null {
    if (!t.isVariableDeclaration(node.left)) return null;
    if (node.left.declarations.length !== 1) return null;
    const id = node.left.declarations[0].id;
    if (!t.isIdentifier(id)) return null;
    const varName = id.name;

    if (!t.isArrayExpression(node.right)) return null;
    const elements: t.Expression[] = [];
    for (const el of node.right.elements) {
        if (el === null || t.isSpreadElement(el)) return null;
        elements.push(el);
    }
    if (elements.length > MAX_UNROLL_ITERATIONS) return null;
    if (elements.length === 0) return [];
    if (bodyHasUnsafeControlFlow(node.body)) return null;

    const out: t.Statement[] = [];
    for (const el of elements) {
        out.push(...iterationStmts(node.body, varName, el));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Annotation matching.

function hasUnrollAnnotation(n: t.Node): boolean {
    const cs = (n.leadingComments ?? []) as t.Comment[];
    for (const c of cs) {
        if (DIRECTIVE_PATTERNS.unroll.test(c.value)) return true;
    }
    return false;
}

function stripUnrollComments(n: t.Node): void {
    if (!n.leadingComments) return;
    n.leadingComments = n.leadingComments.filter((c: t.Comment) => !DIRECTIVE_PATTERNS.unroll.test(c.value));
}

// ---------------------------------------------------------------------------
// Control-flow safety.

function bodyHasUnsafeControlFlow(body: t.Statement): boolean {
    return walk(body, false, false);

    function walk(n: t.Node, insideNestedLoop: boolean, insideFunction: boolean): boolean {
        if (t.isReturnStatement(n) && !insideFunction) return true;
        if ((t.isBreakStatement(n) || t.isContinueStatement(n)) && !insideNestedLoop) {
            return true;
        }
        let nl = insideNestedLoop;
        let nf = insideFunction;
        if (t.isFunction(n)) {
            nf = true;
            nl = true;
        }
        if (
            t.isForStatement(n) ||
            t.isWhileStatement(n) ||
            t.isDoWhileStatement(n) ||
            t.isForInStatement(n) ||
            t.isForOfStatement(n) ||
            t.isSwitchStatement(n)
        ) {
            nl = true;
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && walk(c, nl, nf)) return true;
                }
            } else {
                if (walk(child, nl, nf)) return true;
            }
        }
        return false;
    }
}

// ---------------------------------------------------------------------------
// Substitution. Walks a clone of the statement and replaces reads of varName
// with `replacement`, skipping declaration IDs and shadowed scopes.

function cloneAndSubstitute(stmt: t.Statement, varName: string, replacement: t.Expression): t.Statement {
    const cloned = t.cloneNode(stmt, true, true);
    substitute(cloned, varName, replacement, false);
    return cloned;
}

function substitute(n: t.Node, varName: string, replacement: t.Expression, shadowed: boolean): void {
    if (shadowed) {
        // Still descend in case a deeper scope un-shadows. (JS doesn't, but
        // keep it general.)
        descend(n, varName, replacement, shadowed);
        return;
    }

    if (t.isFunction(n) || t.isCatchClause(n) || t.isClassBody(n)) {
        // Function bodies create their own scope; if they declare a param or
        // local with the same name, we must not substitute inside.
        if (declaresName(n, varName)) {
            descend(n, varName, replacement, true);
            return;
        }
        descend(n, varName, replacement, false);
        return;
    }
    if (t.isBlockStatement(n) && blockDeclaresName(n, varName)) {
        descend(n, varName, replacement, true);
        return;
    }

    descend(n, varName, replacement, shadowed);
}

function descend(n: t.Node, varName: string, replacement: t.Expression, shadowed: boolean): void {
    for (const k of t.VISITOR_KEYS[n.type] ?? []) {
        const child = getSlot(n, k);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                const c = child[i];
                if (!c) continue;
                if (!shadowed && t.isIdentifier(c) && c.name === varName && isReadContext(n, k, c)) {
                    child[i] = t.cloneNode(replacement, true);
                } else {
                    substitute(c, varName, replacement, shadowed);
                }
            }
        } else {
            if (!shadowed && t.isIdentifier(child) && child.name === varName && isReadContext(n, k, child)) {
                setSlot(n, k, undefined, t.cloneNode(replacement, true));
            } else {
                substitute(child, varName, replacement, shadowed);
            }
        }
    }
}

function isReadContext(parent: t.Node, key: string, _id: t.Identifier): boolean {
    // Variable declarator id, function/class id, label, member property,
    // object key (non-computed), assignment LHS, update target, pattern parts —
    // all are non-read contexts.
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

function declaresName(n: t.Node, name: string): boolean {
    if (t.isFunction(n)) {
        for (const p of n.params) {
            if (paramDeclares(p, name)) return true;
        }
        if (t.isFunctionDeclaration(n) && n.id?.name === name) return true;
        return false;
    }
    if (t.isCatchClause(n)) {
        if (n.param && t.isIdentifier(n.param) && n.param.name === name) return true;
    }
    return false;
}

function paramDeclares(p: t.Node, name: string): boolean {
    if (t.isIdentifier(p)) return p.name === name;
    if (t.isAssignmentPattern(p)) return paramDeclares(p.left, name);
    if (t.isRestElement(p)) return paramDeclares(p.argument, name);
    return false;
}

function blockDeclaresName(b: t.BlockStatement, name: string): boolean {
    for (const s of b.body) {
        if (t.isVariableDeclaration(s) && (s.kind === 'let' || s.kind === 'const')) {
            for (const d of s.declarations) {
                if (t.isIdentifier(d.id) && d.id.name === name) return true;
            }
        }
        if (t.isFunctionDeclaration(s) && s.id?.name === name) return true;
        if (t.isClassDeclaration(s) && s.id?.name === name) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Statement-list traversal — invokes `cb` for every Block/Program body so the
// caller can splice in place.

function walkStatementLists(root: t.Node, cb: (body: t.Statement[], inOptimize: boolean) => void): void {
    const optimizeStack: boolean[] = [false];
    const visit = (n: t.Node | null | undefined): void => {
        if (n == null) return;
        const enteringFn = t.isFunction(n);
        if (enteringFn) {
            optimizeStack.push(hasOptimizeAnnotation(n));
        }
        if (t.isBlockStatement(n) || t.isProgram(n)) {
            cb(n.body as t.Statement[], optimizeStack[optimizeStack.length - 1]);
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c) visit(c);
                }
            } else {
                visit(child);
            }
        }
        if (enteringFn) optimizeStack.pop();
    };
    visit(root);
}

function hasOptimizeAnnotation(n: t.Node): boolean {
    const cs = (n.leadingComments ?? []) as t.Comment[];
    for (const c of cs) {
        if (DIRECTIVE_PATTERNS.optimize.test(c.value)) return true;
    }
    return false;
}
