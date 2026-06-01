// Targeted regression: renameForFlatten was changed to rewrite references
// via `binding.referencePaths` instead of Babel's `Scope.rename` (which does
// a fresh subtree traversal). The optimization is only sound if scope info
// is up-to-date with the AST when rename runs.
//
// In compilecat's pipeline, prior phases (inline-functions, sroa,
// inline-variables-pre) mutate the AST without an explicit `scope.crawl()`.
// If any of those mutations introduce Identifier nodes that reference a
// binding's name without showing up in `binding.referencePaths`, the
// optimized rename misses them — leaving dangling references to the
// pre-rename name.
//
// These tests construct that exact scenario and assert the rewritten code
// is identical to Babel's `Scope.rename` baseline.

import generate from '@babel/generator';
import { parse } from '@babel/parser';
import traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { makeDeclaredNamesUnique, renameForFlatten } from '../src/compiler/normalize';

function gen(node: t.Node): string {
    return ((generate as unknown as { default?: typeof generate }).default ?? (generate as unknown as typeof generate))(node).code.replace(/\s+/g, ' ').trim();
}

// Apply rename via the optimization under test.
function runOptimized(file: t.File, mutateBefore?: (file: t.File) => void): string {
    if (mutateBefore) mutateBefore(file);
    (traverse as unknown as (n: t.Node, v: object) => void)(file, {
        Function: { exit(path: NodePath<t.Function>) { renameForFlatten(path); } },
    });
    return gen(file);
}

// Baseline: traverse the same way, but rewrite via Babel's `scope.rename`.
function runBaseline(file: t.File, mutateBefore?: (file: t.File) => void): string {
    if (mutateBefore) mutateBefore(file);
    (traverse as unknown as (n: t.Node, v: object) => void)(file, {
        Function: {
            exit(fnPath: NodePath<t.Function>) {
                const fnScope = fnPath.scope;
                const allNames = new Set<string>(Object.keys(fnScope.bindings));
                fnPath.traverse({
                    Scope: {
                        enter(p) {
                            if (p.isFunction()) { p.skip(); return; }
                            if (p.scope === fnScope) return;
                            for (const baseName of Object.keys(p.scope.bindings)) {
                                const binding = p.scope.bindings[baseName];
                                if (binding === undefined) continue;
                                if (binding.scope !== p.scope) continue;
                                if (binding.kind === 'param') continue;
                                if (allNames.has(baseName)) {
                                    let id = 1;
                                    let newName = `${baseName}__${id}`;
                                    while (allNames.has(newName)) { id++; newName = `${baseName}__${id}`; }
                                    p.scope.rename(baseName, newName);
                                    allNames.add(newName);
                                } else {
                                    allNames.add(baseName);
                                }
                            }
                        },
                    },
                });
            },
        },
    });
    return gen(file);
}

function parseFile(code: string): t.File {
    const file = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
    makeDeclaredNamesUnique(file);
    return file;
}

function assertSame(code: string, mutate?: (file: t.File) => void): void {
    const a = runOptimized(parseFile(code), mutate);
    const b = runBaseline(parseFile(code), mutate);
    expect(a).toBe(b);
}

describe('renameForFlatten — equivalence vs Babel Scope.rename', () => {
    it('matches baseline on no-collision input', () => {
        assertSame('function f() { var x = 1; return x; }');
    });

    it('matches baseline on simple shadow', () => {
        assertSame('function f() { var x = 1; { let x = 2; sink(x); } return x; }');
    });

    it('matches baseline on sibling-block lets', () => {
        assertSame('function f() { { let i = 1; sink(i); } { let i = 2; sink(i); } }');
    });

    it('matches baseline on update-expression write in inner block', () => {
        assertSame('function f() { let x = 1; { let x = 2; x++; sink(x); } return x; }');
    });

    it('matches baseline on compound-assignment write in inner block', () => {
        assertSame('function f() { let x = 1; { let x = 2; x += 5; sink(x); } return x; }');
    });

    it('matches baseline on destructuring assignment in inner block', () => {
        assertSame('function f() { let a = 1; { let a = 2, b = 3; [a, b] = [b, a]; sink(a, b); } return a; }');
    });

    it('matches baseline on inner function-declaration shadow', () => {
        assertSame('function outer() { var k = 1; { function k() { return 42; } sink(k()); } return k; }');
    });

    it('matches baseline on shorthand object property reference', () => {
        assertSame('function f() { let x = 1; { let x = 2; sink({ x }); } return { x }; }');
    });

    it('matches baseline on computed member access', () => {
        assertSame('function f(arr) { let i = 0; { let i = 5; sink(arr[i]); } return arr[i]; }');
    });

    it('matches baseline on default param referencing outer name', () => {
        assertSame('function f(p) { let t = p; { let t = 5; function g(x = t) { return x; } sink(g()); } return t; }');
    });

    it('matches baseline on try-catch param', () => {
        assertSame('function f() { let e = 1; try { throw 2; } catch (e) { sink(e); } return e; }');
    });
});

describe('renameForFlatten — STALE binding.referencePaths', () => {
    // Force scope crawl, then mutate AST to introduce new references that
    // aren't in `binding.referencePaths`. This is what prior pipeline phases
    // do (inline-functions splices donor bodies in without re-crawling).

    it('handles spliced-in reference to outer binding', () => {
        // Outer `s` has one reference; we splice in another reference in the
        // inner block AFTER scope is crawled. Then rename the inner shadow.
        const code = `
            function f() {
                let s = 1;
                {
                    let s = 2;
                    sink(s);
                }
                return s;
            }
        `;
        assertSame(code, (file) => {
            // Find function `f`, force scope crawl.
            (traverse as unknown as (n: t.Node, v: object) => void)(file, {
                FunctionDeclaration(p: NodePath<t.FunctionDeclaration>) {
                    p.scope.crawl();
                    // Splice a NEW reference to outer `s` into the inner block:
                    // change `sink(s)` to `sink(s + s)` where the second `s` is fresh.
                    p.traverse({
                        CallExpression(call: NodePath<t.CallExpression>) {
                            if (t.isIdentifier(call.node.callee) && call.node.callee.name === 'sink') {
                                const old = call.node.arguments[0];
                                if (t.isIdentifier(old)) {
                                    // Splice in: sink(s + s) — second s is a NEW node not in referencePaths
                                    const freshRef = t.identifier(old.name);
                                    call.node.arguments[0] = t.binaryExpression('+', old, freshRef);
                                    call.stop();
                                }
                            }
                        },
                    });
                    p.stop();
                },
            });
        });
    });

    it('handles spliced-in reference to inner binding (the one being renamed)', () => {
        const code = `
            function f() {
                let s = 1;
                {
                    let s = 2;
                    sink(s);
                }
                return s;
            }
        `;
        assertSame(code, (file) => {
            (traverse as unknown as (n: t.Node, v: object) => void)(file, {
                FunctionDeclaration(p: NodePath<t.FunctionDeclaration>) {
                    p.scope.crawl();
                    // Find the inner block and add a fresh `s` reference after `sink(s)`.
                    p.traverse({
                        BlockStatement(b: NodePath<t.BlockStatement>) {
                            if (b.node === p.node.body) return;
                            // Add: sink(s); — a fresh identifier not in referencePaths
                            b.node.body.push(
                                t.expressionStatement(t.callExpression(t.identifier('sink'), [t.identifier('s')])),
                            );
                            b.stop();
                        },
                    });
                    p.stop();
                },
            });
        });
    });

    it('handles spliced-in write to inner binding (stale constantViolations)', () => {
        const code = `
            function f() {
                let s = 1;
                {
                    let s = 2;
                    sink(s);
                }
                return s;
            }
        `;
        assertSame(code, (file) => {
            (traverse as unknown as (n: t.Node, v: object) => void)(file, {
                FunctionDeclaration(p: NodePath<t.FunctionDeclaration>) {
                    p.scope.crawl();
                    p.traverse({
                        BlockStatement(b: NodePath<t.BlockStatement>) {
                            if (b.node === p.node.body) return;
                            // Add: s = 99;
                            b.node.body.push(
                                t.expressionStatement(
                                    t.assignmentExpression('=', t.identifier('s'), t.numericLiteral(99)),
                                ),
                            );
                            b.stop();
                        },
                    });
                    p.stop();
                },
            });
        });
    });

    it('handles spliced-in BLOCK with declarations (whole subtree mutation)', () => {
        // Most realistic: prior phase splices a whole block in. The block
        // has its own declarations + references. Scope was crawled BEFORE the
        // splice so the entire subtree is invisible to `binding.referencePaths`.
        const code = `
            function f() {
                let s = 1;
                return s;
            }
        `;
        assertSame(code, (file) => {
            (traverse as unknown as (n: t.Node, v: object) => void)(file, {
                FunctionDeclaration(p: NodePath<t.FunctionDeclaration>) {
                    p.scope.crawl();
                    // Splice in a block that declares `s` (shadows outer) + reads it.
                    // None of this is in any existing binding's referencePaths.
                    const splice = t.blockStatement([
                        t.variableDeclaration('let', [t.variableDeclarator(t.identifier('s'), t.numericLiteral(99))]),
                        t.expressionStatement(t.callExpression(t.identifier('sink'), [t.identifier('s')])),
                        t.expressionStatement(
                            t.assignmentExpression('+=', t.identifier('s'), t.numericLiteral(1)),
                        ),
                        t.expressionStatement(t.callExpression(t.identifier('sink'), [t.identifier('s')])),
                    ]);
                    p.node.body.body.unshift(splice);
                    p.stop();
                },
            });
        });
    });
});
