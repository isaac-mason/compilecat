// Port of jscomp/InlineVariables.java.
//
// Closure's InlineVariables drives ReferenceCollector to find variables safe
// to inline. We reuse Babel's scope analysis (binding.referencePaths +
// binding.constantViolations) in place of porting ReferenceCollector, since
// the rest of compilecat is already on Babel scope (e.g. flow-sensitive
// inline). The three paths from InlineVariables.StandardVarExpert that we
// implement:
//
//   1. Single-use inline (Closure: `analyzeWithInitialValue` →
//      `numReadRefs == 1` + `canInline`). `const x = <pure>; ... x ...`
//      with one read → replace the read with init, drop declarator.
//
//   2. Multi-use immutable inline (Closure: `isWellDefined` +
//      `initialValueAnalysis.isImmutableValue()`). `const K = 42;` used N
//      times → clone the literal into each read site, drop declarator.
//
//   3. Alias inline (Closure: `VarIsAliasAnalysis` + `reanalyzeAfterAliasedVar`).
//      `let x = y` where `y` is a bare identifier that is well-defined +
//      assigned-once, and `x` is well-defined + assigned-once → replace
//      reads of `x` with the identifier `y`, drop declarator.
//      This is the post-inline-cleanup path: FunctionArgumentInjector
//      produces `let param = argName` aliases when arguments aren't
//      substituted directly; this pass collapses them.
//
// Mode is the equivalent of Closure's LOCALS_ONLY+module — we never inline
// exported bindings, but we don't have a "constants only" toggle.
//
// Iterates to fixpoint: inlining one binding can make another's reference
// count drop to 1, or unblock an alias chain (a → b → literal).

import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

import { mayHaveSideEffects } from './ast-analyzer';
import { traverse } from './babel-interop';

export type InlineVariablesResult = {
    /** Number of variables inlined (equal to declarators removed). */
    inlined: number;
};

export type InlineVariablesOptions = {
    /** Declarators inside a function not in this set are skipped. If omitted,
     *  every declarator is visited (legacy/test behavior). */
    touched?: WeakSet<t.Function>;
};

export function inlineVariables(ast: t.File, options: InlineVariablesOptions = {}): InlineVariablesResult {
    let total = 0;
    while (true) {
        const round = sweep(ast, options);
        if (round === 0) break;
        total += round;
    }
    return { inlined: total };
}

function sweep(ast: t.File, options: InlineVariablesOptions): number {
    let inlined = 0;
    const touched = options.touched;

    traverse(ast, {
        // Force a scope rebuild — our previous round's mutations may have
        // changed reference counts.
        Program(path) {
            path.scope.crawl();
        },

        VariableDeclarator(path) {
            // Touched-set gate: only inline declarators inside an opted-in
            // function. Top-level declarators are always considered.
            if (touched) {
                const fnParent = path.getFunctionParent();
                if (fnParent && !touched.has(fnParent.node)) return;
            }

            // v1: only `const|let x = INIT` — skip destructuring.
            if (!t.isIdentifier(path.node.id)) return;
            const init = path.node.init;
            if (!init) return;

            const name = path.node.id.name;
            const binding = path.scope.getBinding(name);
            if (!binding) return;

            // Treat `let` as inlineable only if it's never reassigned.
            if (binding.constantViolations.length > 0) return;

            // Don't strip exported declarations.
            if (path.parentPath?.parent && t.isExportDeclaration(path.parentPath.parent)) return;

            const refCount = binding.references;

            // Path 1: single-use inline (Closure analyzeWithInitialValue, numReadRefs==1).
            if (refCount === 1) {
                if (trySingleUseInline(path, init, binding)) inlined++;
                return;
            }

            // Path 2: multi-use immutable inline (Closure: well-defined + isImmutableValue).
            // Path 3: alias inline (Closure: VarIsAliasAnalysis → safe alias rewrite).
            if (refCount > 1) {
                if (tryMultiUseImmutableInline(path, init, binding)) {
                    inlined++;
                    return;
                }
                if (tryAliasInline(path, init, binding)) {
                    inlined++;
                    return;
                }
            }
        },
    });

    return inlined;
}

// Path 1: single-use inline. `const x = pure; ...x...` (exactly one read)
// → replace the read with init, drop declarator.
function trySingleUseInline(
    path: NodePath<t.VariableDeclarator>,
    init: t.Expression,
    binding: NonNullable<ReturnType<NodePath['scope']['getBinding']>>,
): boolean {
    // Init must be pure — we're moving it to a new evaluation point.
    if (mayHaveSideEffects(init)) return false;

    // Closure InlineVariables.StandardVarExpert.canMoveExpression — refuses to
    // relocate any expression that reads a property (GETPROP/GETELEM). The
    // property could be mutated between def and use, and this pass has no
    // flow-sensitive view to prove otherwise. FlowSensitiveInlineVariables
    // (paired with MustBeReachingVariableDef) is what handles that case.
    if (containsPropertyRead(init)) return false;

    const initPath = path.get('init') as NodePath<t.Expression | null | undefined>;
    if (!initPath.node) return false;
    if (initFreeVarsAreUnstable(initPath as NodePath<t.Expression>, path.scope)) return false;

    const refPath = binding.referencePaths[0];
    if (!refPath) return false;

    if (!isPlainRead(refPath)) return false;

    if (crossesAsyncBoundary(path, refPath)) return false;

    if (!isPrimitiveLiteral(init) && useIsInsideLoopOutOfDef(path, refPath)) return false;

    if (defIsConditional(path, refPath)) return false;

    refPath.replaceWith(t.cloneNode(init, /* deep */ true, /* withoutLoc */ false));
    path.remove();
    return true;
}

// Path 2: multi-use immutable inline. `const K = 42; ...K...K...` → clone
// the literal into each read site, drop declarator. Closure: this is the
// `isImmutableValue` branch of `analyzeWithInitialValue`. Restricted to
// primitive literals: re-evaluation is free (no allocation), the value is
// its own identity, no scope sensitivity.
function tryMultiUseImmutableInline(
    path: NodePath<t.VariableDeclarator>,
    init: t.Expression,
    binding: NonNullable<ReturnType<NodePath['scope']['getBinding']>>,
): boolean {
    if (!isPrimitiveLiteral(init)) return false;

    // All reference paths must be plain reads (not lvalues, not declarations).
    for (const ref of binding.referencePaths) {
        if (!isPlainRead(ref)) return false;
        if (crossesAsyncBoundary(path, ref)) return false;
        if (defIsConditional(path, ref)) return false;
    }

    for (const ref of binding.referencePaths) {
        ref.replaceWith(t.cloneNode(init, /* deep */ true, /* withoutLoc */ false));
    }
    path.remove();
    return true;
}

// Path 3: alias inline. `let x = y; ...x...x...` where `y` is a bare
// identifier whose binding is well-defined and assigned exactly once, and
// `x` itself is never reassigned → rewrite all reads of `x` to `y`, drop
// the declarator. Closure: VarIsAliasAnalysis + reanalyzeAfterAliasedVar
// success path.
//
// The contact-constraints post-inline shape — `let linVelA__5 = _linearVelocityA;`
// with N reads — is exactly this.
function tryAliasInline(
    path: NodePath<t.VariableDeclarator>,
    init: t.Expression,
    binding: NonNullable<ReturnType<NodePath['scope']['getBinding']>>,
): boolean {
    // Aliased value must be a bare identifier.
    if (!t.isIdentifier(init)) return false;
    const aliasedName = init.name;

    // Self-alias guard (Closure: `aliasedName.equals(v.getName()) ? null : ...`).
    if (t.isIdentifier(path.node.id) && path.node.id.name === aliasedName) return false;

    // Resolve aliased binding in x's enclosing scope.
    const aliasedBinding = path.scope.getBinding(aliasedName);
    if (!aliasedBinding) return false;

    // Aliased var must be well-defined + assigned-once. Bindings that are
    // never reassigned and whose declaration cannot be re-entered fit:
    //   - const / let / var with init, no constantViolations
    //   - function declaration (always hoisted+init'd)
    //   - class declaration
    //   - import binding
    //   - parameter (assigned at call, no body reassignment)
    if (!isWellDefinedAssignedOnce(aliasedBinding)) return false;

    // Async-boundary check vs the alias decl, identifier crossing rule.
    for (const ref of binding.referencePaths) {
        if (!isPlainRead(ref)) return false;
        if (crossesAsyncBoundary(path, ref)) return false;
        // At each ref site, the aliased name must resolve to the SAME binding.
        // If a nested function shadows `aliasedName`, rewriting would capture
        // the shadow instead.
        const refScopeBinding = ref.scope.getBinding(aliasedName);
        if (refScopeBinding !== aliasedBinding) return false;
        // The alias decl itself must be reachable from the ref site without
        // crossing a conditional that doesn't enclose the ref. Closure's
        // BasicBlock check via initBlock.provablyExecutesBefore. We approximate
        // with the existing defIsConditional helper.
        if (defIsConditional(path, ref)) return false;
    }

    // Rewrite all reads.
    for (const ref of binding.referencePaths) {
        ref.replaceWith(t.identifier(aliasedName));
    }
    path.remove();
    return true;
}

// True if a binding is "well-defined and assigned exactly once" (Closure:
// isWellDefinedAssignedOnce). Approximation on top of Babel scope:
//   - Param: yes, params are inited at call entry, no further writes count
//     unless constantViolations records body assignments.
//   - Function/class declaration: yes, hoisted+init'd at scope entry.
//   - Import binding: yes, read-only at module load.
//   - const/let/var: yes only if init is present at the decl AND no
//     constantViolations.
function isWellDefinedAssignedOnce(binding: NonNullable<ReturnType<NodePath['scope']['getBinding']>>): boolean {
    if (binding.constantViolations.length > 0) return false;

    const kind = binding.kind;
    if (kind === 'param') return true;
    if (kind === 'hoisted') return true; // function declaration
    if (kind === 'local' || kind === 'const' || kind === 'let' || kind === 'var') {
        // Babel's `BindingPath.node` is the VariableDeclarator (or similar).
        // Require it to have an init.
        const decl = binding.path.node;
        if (t.isVariableDeclarator(decl)) {
            return decl.init !== null && decl.init !== undefined;
        }
        // class/function declarations also fall here in some shapes.
        if (t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) return true;
        return false;
    }
    if (kind === 'module') return true; // import
    return false;
}

// A reference is a "plain read" if it's neither a declaration nor an
// lvalue. Mirrors Closure's `isValidReference`.
function isPlainRead(refPath: NodePath): boolean {
    if (!t.isIdentifier(refPath.node)) return false;
    const parent = refPath.parent;
    if (!parent) return false;
    // declaration id position
    if (t.isVariableDeclarator(parent) && parent.id === refPath.node) return false;
    // assignment LHS
    if (t.isAssignmentExpression(parent) && parent.left === refPath.node) return false;
    // update expression target (++/--)
    if (t.isUpdateExpression(parent)) return false;
    // function/class declaration name
    if (
        (t.isFunctionDeclaration(parent) ||
            t.isFunctionExpression(parent) ||
            t.isClassDeclaration(parent) ||
            t.isClassExpression(parent)) &&
        parent.id === refPath.node
    )
        return false;
    // parameter binding
    if (t.isFunction(parent) && Array.isArray(parent.params) && parent.params.includes(refPath.node as t.Identifier))
        return false;
    // export specifier — `local` must remain an Identifier; substituting a
    // literal there would violate the AST spec. Common in bundle-mode where
    // a chunk may carry `export { K }` after `const K = 42`.
    if (t.isExportSpecifier(parent)) return false;
    return true;
}

// True if init reads any identifier that may change between def site and
// use site. Property keys, member-access names, label names, etc. are
// skipped — handled by Babel's `ReferencedIdentifier` virtual visitor.
function initFreeVarsAreUnstable(initPath: NodePath<t.Expression>, scope: NodePath['scope']): boolean {
    let unstable = false;
    initPath.traverse({
        ReferencedIdentifier(p) {
            if (unstable) return;
            const b = scope.getBinding(p.node.name);
            if (!b) {
                // Global or `undefined` — can't prove stable.
                unstable = true;
                return;
            }
            if (b.constantViolations.length > 0) unstable = true;
        },
    });
    // Don't forget initPath itself if it's a bare identifier — `traverse`
    // visits children, not the root.
    if (!unstable && t.isIdentifier(initPath.node)) {
        const b = scope.getBinding(initPath.node.name);
        if (!b) return true;
        if (b.constantViolations.length > 0) return true;
    }
    return unstable;
}

function crossesAsyncBoundary(defPath: NodePath, usePath: NodePath): boolean {
    // Walk usePath upwards until we hit defPath's enclosing function (or
    // Program). If we cross any async / generator function boundary, bail.
    const defFn = defPath.getFunctionParent() ?? defPath.scope.getProgramParent().path;
    let p: NodePath | null = usePath;
    while (p && p.node !== defFn.node) {
        if (
            (t.isFunction(p.node) ||
                t.isFunctionDeclaration(p.node) ||
                t.isFunctionExpression(p.node) ||
                t.isArrowFunctionExpression(p.node)) &&
            // union narrowing
            ((p.node as any).async === true || (p.node as any).generator === true)
        ) {
            return true;
        }
        p = p.parentPath;
    }
    return false;
}

// True iff `node` (or any subexpression) is a property read. We treat these
// as unsafe to relocate because we have no flow-sensitive view that would
// prove the property isn't mutated between def and use.
function containsPropertyRead(node: t.Node): boolean {
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) return true;
    let found = false;
    // structural walk
    const walk = (n: any) => {
        if (found || n === null || typeof n !== 'object') return;
        if (Array.isArray(n)) {
            for (const c of n) walk(c);
            return;
        }
        if (typeof n.type !== 'string') return;
        if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') {
            found = true;
            return;
        }
        for (const k of Object.keys(n)) {
            if (
                k === 'loc' ||
                k === 'start' ||
                k === 'end' ||
                k === 'leadingComments' ||
                k === 'trailingComments' ||
                k === 'innerComments'
            )
                continue;
            walk(n[k]);
        }
    };
    walk(node);
    return found;
}

// A primitive literal is cheap to re-evaluate (no allocation, no observable
// side effect, value identity is the value itself). Safe to inline into a
// loop body.
function isPrimitiveLiteral(n: t.Expression): boolean {
    if (t.isNumericLiteral(n) || t.isStringLiteral(n) || t.isBooleanLiteral(n) || t.isNullLiteral(n) || t.isBigIntLiteral(n)) {
        return true;
    }
    if (t.isIdentifier(n) && n.name === 'undefined') return true;
    return false;
}

// True iff the def's binding is hoisted out of a conditional construct (if,
// switch case, &&/||/?? branch, or hook branch) that doesn't enclose the use.
// Inlining would relocate work from the conditional path to the unconditional
// site of the use.
function defIsConditional(defPath: NodePath, usePath: NodePath): boolean {
    // Collect the use's ancestor chain so we can check containment.
    const useAncestors = new Set<t.Node>();
    let up: NodePath | null = usePath;
    while (up) {
        useAncestors.add(up.node);
        up = up.parentPath;
    }
    let p: NodePath | null = defPath.parentPath;
    while (p) {
        if (useAncestors.has(p.node)) return false; // common ancestor reached
        if (
            t.isIfStatement(p.node) ||
            t.isSwitchCase(p.node) ||
            t.isConditionalExpression(p.node) ||
            (t.isLogicalExpression(p.node) && (p.node.operator === '&&' || p.node.operator === '||' || p.node.operator === '??'))
        ) {
            return true;
        }
        p = p.parentPath;
    }
    return false;
}

function useIsInsideLoopOutOfDef(defPath: NodePath, usePath: NodePath): boolean {
    // Walk up from use, stopping at any common ancestor with def. If we cross
    // a loop *before* reaching common ancestry, the use is inside a loop that
    // def is outside of → bail. If def lives inside the same loop (def runs
    // per-iteration too), the common ancestor sits between use and the loop,
    // so we stop short and return false.
    const defAncestors = new Set<t.Node>();
    let dp: NodePath | null = defPath;
    while (dp) {
        defAncestors.add(dp.node);
        dp = dp.parentPath;
    }
    let p: NodePath | null = usePath.parentPath;
    while (p) {
        if (defAncestors.has(p.node)) return false;
        if (
            t.isForStatement(p.node) ||
            t.isForInStatement(p.node) ||
            t.isForOfStatement(p.node) ||
            t.isWhileStatement(p.node) ||
            t.isDoWhileStatement(p.node)
        ) {
            return true;
        }
        p = p.parentPath;
    }
    return false;
}
