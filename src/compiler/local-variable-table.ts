// Helper used by LiveVariablesAnalysis (and downstream DeadAssignmentsElim).
//
// Closure has a full Scope/Var/ScopeCreator stack (jscomp/Scope.java +
// SyntacticScopeCreator etc., ~1000 LOC). For our v1 we don't need that
// generality — we just need:
//
//   1. An enumeration of every local-to-this-function variable (params +
//      var/let/const/function declarations at any nesting inside the function
//      body) keyed by name in declaration order. This becomes the variable
//      index space the BitSet lattices use.
//
//   2. A predicate "was variable X referenced inside a nested function?",
//      which marks X as ESCAPED — escaped locals are treated as live-out at
//      the implicit return so liveness analysis doesn't drop their stores.
//
// Limitations vs Closure (deliberately taken to keep this small and to avoid
// the ScopeCreator port):
//
//   - We don't model lexical shadowing inside the function. Two separate
//     `let x` in non-overlapping inner blocks collapse to "the same x" for
//     analysis purposes. This is over-conservative: liveness sees more uses,
//     DAE eliminates fewer stores. Always safe.
//
//   - We don't distinguish between locals and outer-scope captures. A name
//     used inside the function that wasn't declared here is ignored entirely
//     (we never index it). DAE never touches it; safe.
//
// If/when we hit a real correctness issue from this, we either upgrade to a
// proper scope walker or port jscomp/Scope.java.

import * as t from '@babel/types';

import { getSlot } from './node-util';

export type LocalVariableTable = {
    /** Insertion-ordered map: name → index in the BitSet lattice. */
    readonly indexByName: Map<string, number>;
    /** Names whose values can be observed after the function returns
     *  (closure capture, `arguments` aliasing). Treated as live-out. */
    readonly escaped: Set<string>;
    /** Total count — convenience. */
    readonly size: number;
};

export function buildLocalVariableTable(fn: t.Function): LocalVariableTable {
    const indexByName = new Map<string, number>();
    const escaped = new Set<string>();

    const addLocal = (name: string) => {
        if (!indexByName.has(name)) indexByName.set(name, indexByName.size);
    };

    // Params first (Closure indexes parameters before body locals).
    for (const param of fn.params) {
        for (const name of bindingNamesIn(param)) addLocal(name);
    }

    // Walk the body collecting var/let/const/function decl bindings. We
    // descend into nested blocks/loops/etc. but NOT into nested functions —
    // their locals belong to that function's table.
    const body = fn.body;
    if (t.isBlockStatement(body)) {
        collectDeclsIn(body, addLocal);
    }

    // Now find which collected locals are referenced from inside a nested
    // function (= escape via closure).
    if (t.isBlockStatement(body)) {
        collectEscapesIn(body, indexByName, escaped, /* insideNestedFn */ false);
    }

    // `arguments` use: if any reference to `arguments` exists in the
    // function (not inside a nested non-arrow function which has its own
    // arguments), Closure escapes ALL parameters. Mirror that.
    if (referencesArguments(fn)) {
        for (const param of fn.params) {
            for (const name of bindingNamesIn(param)) escaped.add(name);
        }
    }

    return { indexByName, escaped, size: indexByName.size };
}

// Returns the variable names introduced by a binding pattern (param or
// var/let/const target). Handles destructuring + rest + defaults.
function bindingNamesIn(node: t.Node): string[] {
    const out: string[] = [];
    const visit = (n: t.Node) => {
        if (t.isIdentifier(n)) {
            out.push(n.name);
            return;
        }
        if (t.isAssignmentPattern(n)) {
            visit(n.left);
            return;
        }
        if (t.isRestElement(n)) {
            visit(n.argument);
            return;
        }
        if (t.isArrayPattern(n)) {
            for (const el of n.elements) {
                if (el !== null) visit(el);
            }
            return;
        }
        if (t.isObjectPattern(n)) {
            for (const p of n.properties) {
                if (t.isRestElement(p)) {
                    visit(p.argument);
                } else if (t.isObjectProperty(p)) {
                    visit(p.value);
                }
            }
            return;
        }
        if (t.isVariableDeclarator(n)) {
            visit(n.id);
            return;
        }
    };
    visit(node);
    return out;
}

function collectDeclsIn(node: t.Node, addLocal: (name: string) => void): void {
    // Don't descend into nested functions — they have their own table.
    if (t.isFunction(node)) {
        // …unless we're at the very root, but the caller never passes the
        // function itself in here.
        if (t.isFunctionDeclaration(node) && node.id) {
            // function declarations bind their name in the enclosing scope —
            // so a `function inner() {}` inside our body adds `inner` as a
            // local of OUR function.
            addLocal(node.id.name);
        }
        return;
    }
    if (t.isVariableDeclaration(node)) {
        for (const d of node.declarations) {
            for (const name of bindingNamesIn(d.id)) addLocal(name);
        }
        // VariableDeclarator initializers might contain function expressions
        // that themselves should not contribute, but they could contain inner
        // var declarations only if those funcs aren't nested — which they are.
        // Stop here.
        return;
    }
    if (t.isCatchClause(node) && node.param) {
        for (const name of bindingNamesIn(node.param)) addLocal(name);
    }
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        const child = getSlot(node, key);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c) collectDeclsIn(c, addLocal);
            }
        } else {
            collectDeclsIn(child, addLocal);
        }
    }
}

function collectEscapesIn(
    node: t.Node,
    indexByName: Map<string, number>,
    escaped: Set<string>,
    insideNestedFn: boolean,
): void {
    if (t.isIdentifier(node)) {
        if (insideNestedFn && indexByName.has(node.name)) {
            escaped.add(node.name);
        }
        return;
    }

    const isFn = t.isFunction(node);
    const nestedNow = insideNestedFn || isFn;

    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        const child = getSlot(node, key);
        if (child === null || child === undefined) continue;
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c) collectEscapesIn(c, indexByName, escaped, nestedNow);
            }
        } else {
            collectEscapesIn(child, indexByName, escaped, nestedNow);
        }
    }
}

function referencesArguments(fn: t.Function): boolean {
    let found = false;
    const visit = (node: t.Node, insideNestedNonArrow: boolean) => {
        if (found) return;
        if (t.isIdentifier(node) && node.name === 'arguments' && !insideNestedNonArrow) {
            found = true;
            return;
        }
        // Arrow functions inherit `arguments` from their enclosing function;
        // declarations / expressions / methods get their own.
        const enters =
            (t.isFunctionDeclaration(node) ||
                t.isFunctionExpression(node) ||
                t.isObjectMethod(node) ||
                t.isClassMethod(node) ||
                t.isClassPrivateMethod(node)) &&
            node !== fn;
        const nested = insideNestedNonArrow || enters;
        for (const key of t.VISITOR_KEYS[node.type] ?? []) {
            const child = getSlot(node, key);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c) visit(c, nested);
                }
            } else {
                visit(child, nested);
            }
        }
    };
    visit(fn, false);
    return found;
}
