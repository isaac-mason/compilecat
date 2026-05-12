// Port of jscomp/FunctionArgumentInjector.java (subset).
//
// Decides which (param, arg) pairs at an inlined call site can be substituted
// directly into the body and which require a temporary `let X = arg;` binding.
// Direct substitution avoids emitting the prologue and (in the common case
// where every arg substitutes) the surrounding wrapper block as well.
//
// Rules (mirror Closure's gatherCallArgumentsNeedingTemps):
//   1. Param reassigned in body → needs temp (would change semantics if
//      substituted: the outer arg expression would be the LHS of an assign).
//   2. Arg side-effect-free AND param has 0 references → no temp (drop arg).
//   3. Arg has side effects → needs temp (must evaluate exactly once).
//   4. Arg may create fresh mutable state (object/array literal, `new`) AND
//      param has > 0 references → needs temp (otherwise the body would
//      observe a fresh object per use, breaking identity).
//   5. Arg has > 1 references in body — duplicate the arg expression?
//      - Identifier / literal → no temp (cheap, value-stable for our subset).
//      - anything else → needs temp (cost / side-effect risk).
//   6. Otherwise (single reference, side-effect-free, simple arg) → no temp.
//
// Cascade: if any param P needs a temp, every param BEFORE P in declaration
// order also needs a temp. This preserves the original left-to-right
// evaluation order of the call's argument list — the temp prologue runs
// `let pN = argN` in declaration order, so any earlier arg with side effects
// must run first via its own temp.
//
// Limitations / departures from Closure:
//   - No `this` handling. Caller (function-injector.ts) rejects calls that
//     read `this`.
//   - No `arguments` handling. Same.
//   - No CodingConvention.isExported check. We assume Identifier args don't
//     alias an exported global mutated mid-body — which is the common case
//     and what compilecat's directive-gated inliner targets.
//   - Trivial-body fast path (Closure's `isTrivialBody`) not ported — its
//     net effect is to allow more substitutions, never to forbid one. The
//     base rules already handle our hot cases.

import * as t from '@babel/types';

import { mayHaveSideEffects } from './ast-analyzer';
import { getSlot, setSlot } from './node-util';

/**
 * Find every parameter (by name) that is reassigned anywhere in the body.
 * Reassignment includes `=`, compound assigns (`+=` etc.), `++`/`--`, and
 * destructuring writes. Property writes (`out[0] = ...`, `out.x = ...`) are
 * NOT reassignments — they mutate the referent, not the binding.
 */
export function gatherModifiedParameters(body: t.BlockStatement, paramNames: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    if (paramNames.size === 0) return out;

    t.traverseFast(body, (n) => {
        if (t.isAssignmentExpression(n) && t.isIdentifier(n.left) && paramNames.has(n.left.name)) {
            out.add(n.left.name);
            return;
        }
        if (t.isUpdateExpression(n) && t.isIdentifier(n.argument) && paramNames.has(n.argument.name)) {
            out.add(n.argument.name);
            return;
        }
        // Conservative: any destructuring pattern targeting a param counts as
        // a reassignment. We don't currently allow destructuring params on the
        // callee side, but a caller-side destructuring assign that writes to
        // the param name (post-alpha-rename, unlikely) would still trip this.
        if (t.isArrayPattern(n) || t.isObjectPattern(n)) {
            t.traverseFast(n, (m) => {
                if (t.isIdentifier(m) && paramNames.has(m.name)) out.add(m.name);
            });
        }
    });
    return out;
}

export type ArgClassification = {
    /** Set of param names that require a `let X = arg;` temp binding. Params
     *  not in this set are substituted directly into the body. */
    needsTemp: Set<string>;
};

export function gatherCallArgumentsNeedingTemps(
    body: t.BlockStatement,
    paramNames: readonly string[],
    args: readonly t.Expression[],
    modifiedParameters: ReadonlySet<string>,
): ArgClassification {
    const needsTemp = new Set<string>(modifiedParameters);
    if (paramNames.length === 0) return { needsTemp };

    // Reference counts per param across the body. Identifier reads only —
    // declaration-id contexts (var/function/etc.) are excluded.
    const refCounts = countParamReferences(body, paramNames);

    // Walk in declaration order; track the highest-position param that needs
    // a temp so we can apply the cascade afterward.
    let cascadeIndex = -1;
    for (let i = 0; i < paramNames.length; i++) {
        const name = paramNames[i];
        const arg = args[i];
        const refs = refCounts.get(name) ?? 0;

        if (needsTemp.has(name)) {
            cascadeIndex = i;
            continue;
        }
        if (arg === undefined) continue; // missing arg — caller handles default

        const requires = paramNeedsTemp(arg, refs);
        if (requires) {
            needsTemp.add(name);
            cascadeIndex = i;
        }
    }

    // Cascade: every param at index <= cascadeIndex needs a temp.
    if (cascadeIndex >= 0) {
        for (let i = 0; i <= cascadeIndex; i++) needsTemp.add(paramNames[i]);
    }

    return { needsTemp };
}

function paramNeedsTemp(arg: t.Expression, refCount: number): boolean {
    const argSideEffects = mayHaveSideEffects(arg);

    // Rule 2: side-effect-free + unused → drop.
    if (!argSideEffects && refCount === 0) return false;

    // Rule 3: side effects must be evaluated exactly once.
    if (argSideEffects) return true;

    // Rule 4: fresh mutable state (object/array/regex/new) — substituting
    // would create a new instance per use, observably different from the
    // original (single-instance) semantics.
    if (createsMutableState(arg) && refCount > 0) return true;

    // Rules 5 & 6: side-effect-free, no mutable state. Single ref always
    // safe; multi-ref safe if arg is cheap and value-stable.
    if (refCount <= 1) return false;
    return !isCheapToDuplicate(arg);
}

function createsMutableState(arg: t.Expression): boolean {
    return (
        t.isObjectExpression(arg) ||
        t.isArrayExpression(arg) ||
        t.isRegExpLiteral(arg) ||
        t.isNewExpression(arg) ||
        t.isFunctionExpression(arg) ||
        t.isArrowFunctionExpression(arg) ||
        t.isClassExpression(arg)
    );
}

function isCheapToDuplicate(arg: t.Expression): boolean {
    if (t.isIdentifier(arg)) return true;
    if (t.isNullLiteral(arg) || t.isBooleanLiteral(arg)) return true;
    if (t.isNumericLiteral(arg) || t.isBigIntLiteral(arg)) return true;
    if (t.isStringLiteral(arg)) return arg.value.length < 2;
    return false;
}

function countParamReferences(body: t.BlockStatement, paramNames: readonly string[]): Map<string, number> {
    const set = new Set(paramNames);
    const counts = new Map<string, number>();
    for (const n of paramNames) counts.set(n, 0);

    const visit = (n: t.Node, parent: t.Node | null, key: string): void => {
        if (t.isIdentifier(n) && set.has(n.name) && parent !== null && isReferenceContext(parent, key)) {
            counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c) visit(c, n, k);
                }
            } else {
                visit(child, n, k);
            }
        }
    };
    visit(body, null, '');
    return counts;
}

/**
 * Substitute each Identifier reference matching a key in `replacements` with
 * a deep clone of the corresponding expression. Mirrors Closure's
 * FunctionArgumentInjector.inject — declaration-id contexts and nested-scope
 * shadowing are respected.
 */
export function injectArguments(body: t.BlockStatement, replacements: Map<string, t.Expression>): void {
    if (replacements.size === 0) return;

    const visit = (n: t.Node, active: Map<string, t.Expression>): void => {
        if (active.size === 0) return;

        // Function creates a new scope. Filter shadowed names.
        if (t.isFunction(n)) {
            const filtered = new Map(active);
            for (const p of n.params) collectParamNames(p, (pn) => filtered.delete(pn));
            if ((t.isFunctionExpression(n) || t.isFunctionDeclaration(n)) && n.id) {
                filtered.delete(n.id.name);
            }
            if (filtered.size === 0) return;
            descend(n, filtered);
            return;
        }

        // Block scope — filter let/const/class/function-decl names.
        if (t.isBlockStatement(n)) {
            const filtered = filterByBlockDecls(active, n);
            if (filtered.size === 0) return;
            descend(n, filtered);
            return;
        }

        descend(n, active);
    };

    const descend = (n: t.Node, active: Map<string, t.Expression>): void => {
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (!c) continue;
                    if (t.isIdentifier(c) && active.has(c.name) && isReferenceContext(n, k)) {
                        const sub = t.cloneNode(active.get(c.name)!, true);
                        setSlot(n, k, i, sub);
                    } else {
                        visit(c, active);
                    }
                }
            } else {
                if (t.isIdentifier(child) && active.has(child.name) && isReferenceContext(n, k)) {
                    const sub = t.cloneNode(active.get(child.name)!, true);
                    setSlot(n, k, undefined, sub);
                } else {
                    visit(child, active);
                }
            }
        }
    };

    descend(body, replacements);
}

function collectParamNames(p: t.Node, drop: (name: string) => void): void {
    if (t.isIdentifier(p)) drop(p.name);
    else if (t.isAssignmentPattern(p)) collectParamNames(p.left, drop);
    else if (t.isRestElement(p)) collectParamNames(p.argument, drop);
}

function filterByBlockDecls<V>(active: Map<string, V>, block: t.BlockStatement): Map<string, V> {
    let filtered: Map<string, V> | null = null;
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
