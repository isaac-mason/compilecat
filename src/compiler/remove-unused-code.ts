// Port of jscomp/RemoveUnusedCode.java (subset).
//
// Closure's RemoveUnusedCode is a 3000+ LOC monolith handling unused vars,
// params, properties, prototype methods, default-export trimming, etc. We
// port the slice that delivers the visible wins after inlining:
//
//   - Unused `let|const|var` declarators (with pure or no init).
//   - Unused `function NAME() {}` declarations.
//   - Unused named / default / namespace import specifiers.
//   - Import declarations whose every specifier became unused after the
//     specifier sweep (whole statement dropped).
//
// What's intentionally out of v1 scope (and lives in adjacent passes):
//   - Param trimming → `OptimizeParameters` (Phase 8).
//   - Property-side cleanup (unused `obj.foo = ...`) → already ports as
//     `DeadPropertyAssignmentElimination` (Phase 8).
//   - Destructuring patterns. Bail; the pattern shape is rare in inlined
//     output.
//
// We rely on Babel's scope analysis (`path.scope.getBinding(name)`) for
// reference counts instead of porting Closure's `ReferenceCollector` —
// Babel already maintains references / constantViolations / kind, which is
// what this pass consumes. Iterates to fixpoint because removing one
// reference can make another binding unused.

import * as t from '@babel/types';

import { mayHaveSideEffects } from './ast-analyzer';
import { traverse } from './babel-interop';

export type RemoveUnusedResult = {
    /** `let|const|var` declarators removed. */
    removedDeclarators: number;
    /** `function NAME() {}` declarations removed. */
    removedFunctionDecls: number;
    /** Individual import specifiers removed (counts each name). */
    removedImportSpecifiers: number;
    /** Whole `import ... from '…'` statements removed. */
    removedImportDeclarations: number;
};

export type RemoveUnusedOptions = {
    /** Declarators / function decls inside a function not in this set are
     *  skipped. If omitted, every declarator is visited (legacy/test
     *  behavior). */
    touched?: WeakSet<t.Function>;
};

export function removeUnusedCode(ast: t.File, options: RemoveUnusedOptions = {}): RemoveUnusedResult {
    const total: RemoveUnusedResult = {
        removedDeclarators: 0,
        removedFunctionDecls: 0,
        removedImportSpecifiers: 0,
        removedImportDeclarations: 0,
    };

    // Iterate to fixpoint. Each round does a fresh `traverse()` so scope info
    // is rebuilt against the mutated AST.
    while (true) {
        const round = sweep(ast, options);
        if (sumOf(round) === 0) break;
        total.removedDeclarators += round.removedDeclarators;
        total.removedFunctionDecls += round.removedFunctionDecls;
        total.removedImportSpecifiers += round.removedImportSpecifiers;
        total.removedImportDeclarations += round.removedImportDeclarations;
    }
    return total;
}

function sumOf(r: RemoveUnusedResult): number {
    return r.removedDeclarators + r.removedFunctionDecls + r.removedImportSpecifiers + r.removedImportDeclarations;
}

function sweep(ast: t.File, options: RemoveUnusedOptions): RemoveUnusedResult {
    const stats: RemoveUnusedResult = {
        removedDeclarators: 0,
        removedFunctionDecls: 0,
        removedImportSpecifiers: 0,
        removedImportDeclarations: 0,
    };

    const touched = options.touched;
    const gateByEnclosingFn = (path: { getFunctionParent(): { node: t.Function } | null }): boolean => {
        if (!touched) return true;
        const fnParent = path.getFunctionParent();
        if (!fnParent) return true; // top-level — always visit
        return touched.has(fnParent.node);
    };

    traverse(ast, {
        // Force a scope rebuild at the start of each sweep — `path.remove()`
        // calls in the previous round don't decrement reference counts on
        // *other* bindings, so without this, e.g. removing `b` won't make
        // `a` (only used by b) drop to 0 references.
        Program(path) {
            path.scope.crawl();
        },
        VariableDeclarator(path) {
            if (!gateByEnclosingFn(path)) return;
            // v1: only simple `let|const|var x = ...;` — skip destructuring.
            if (!t.isIdentifier(path.node.id)) return;
            const binding = path.scope.getBinding(path.node.id.name);
            if (!binding) return;
            if (binding.references > 0) return;
            // Reassigned-but-never-read: a write-only var. Conservative —
            // keep it; the assignments may carry side effects in their RHS,
            // and DeadAssignmentsElimination is the right tool for that.
            if (binding.constantViolations.length > 0) return;
            // If init has side effects we can't drop it silently. Closure
            // hoists the init expression as a sibling ExpressionStatement;
            // for v1 we keep the whole declarator rather than rewrite.
            const init = path.node.init;
            if (init && mayHaveSideEffects(init)) return;
            // Don't strip exported declarations.
            if (path.parentPath?.parent && t.isExportDeclaration(path.parentPath.parent)) return;
            path.remove();
            stats.removedDeclarators++;
        },

        FunctionDeclaration(path) {
            if (!gateByEnclosingFn(path)) return;
            const id = path.node.id;
            if (!id) return;
            // Don't strip exported function decls.
            if (path.parent && t.isExportDeclaration(path.parent)) return;
            const binding = path.scope.getBinding(id.name);
            if (!binding) return;
            if (binding.references > 0) return;
            if (binding.constantViolations.length > 0) return;
            path.remove();
            stats.removedFunctionDecls++;
        },

        ClassDeclaration(path) {
            if (!gateByEnclosingFn(path)) return;
            const id = path.node.id;
            if (!id) return;
            if (path.parent && t.isExportDeclaration(path.parent)) return;
            const binding = path.scope.getBinding(id.name);
            if (!binding) return;
            if (binding.references > 0) return;
            if (binding.constantViolations.length > 0) return;
            // Bail if any field initializer or computed key may have side
            // effects — Closure preserves classes whose evaluation observably
            // changes program state. Conservative: keep on any non-trivial
            // body member.
            if (classBodyMayHaveSideEffects(path.node.body)) return;
            // superClass evaluation may also have effects.
            if (path.node.superClass && mayHaveSideEffects(path.node.superClass)) return;
            path.remove();
            stats.removedFunctionDecls++;
        },

        ImportDeclaration(path) {
            const specs = path.node.specifiers;
            // Side-effect-only import (`import 'foo';`). Leave alone — the
            // module is being loaded for its top-level effects.
            if (specs.length === 0) return;

            const keep: typeof specs = [];
            let removedHere = 0;
            for (const spec of specs) {
                const local = spec.local.name;
                const binding = path.scope.getBinding(local);
                if (binding && (binding.references > 0 || binding.constantViolations.length > 0)) {
                    keep.push(spec);
                } else {
                    removedHere++;
                }
            }
            if (removedHere === 0) return;

            if (keep.length === 0) {
                // All specifiers are unused. Drop the whole declaration —
                // we treat the import as semantically-empty after specifier
                // removal (matches Closure). Side-effect-only imports above
                // are preserved by the early return on `specs.length === 0`.
                path.remove();
                stats.removedImportDeclarations++;
                stats.removedImportSpecifiers += removedHere;
            } else {
                path.node.specifiers = keep;
                stats.removedImportSpecifiers += removedHere;
            }
        },
    });

    return stats;
}

// True if any class body member could observably evaluate at class-definition
// time. Method definitions are inert (the function literals are values, not
// calls); static fields and computed keys are not.
function classBodyMayHaveSideEffects(body: t.ClassBody): boolean {
    for (const member of body.body) {
        // Computed keys evaluate at class-definition time.
        // union narrowing
        if ((member as any).computed && (member as any).key && mayHaveSideEffects((member as any).key)) {
            return true;
        }
        if (t.isClassProperty(member) || t.isClassPrivateProperty(member)) {
            if (member.static && member.value && mayHaveSideEffects(member.value)) {
                return true;
            }
        }
        if (t.isStaticBlock(member)) return true;
    }
    return false;
}
