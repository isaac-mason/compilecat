import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';

import { buildControlFlowGraph, computeFallThrough } from '../src/compiler/control-flow-analysis';
import { Branch, IMPLICIT_RETURN } from '../src/compiler/control-flow-graph';
import type { CfgNode, ControlFlowGraph } from '../src/compiler/control-flow-graph';

function parseFn(code: string): t.Function {
    const file = parse(code, { plugins: ['typescript'] });
    const stmt = file.program.body[0];
    if (!t.isFunctionDeclaration(stmt)) throw new Error('expected function declaration');
    return stmt;
}

function buildFor(code: string): ControlFlowGraph {
    const fn = parseFn(code);
    const cfg = buildControlFlowGraph({ root: fn.body });
    if (cfg === null) throw new Error('expected CFG, got bailout');
    return cfg;
}

function succsOf(_cfg: ControlFlowGraph, node: CfgNode): Array<[t.Node | typeof IMPLICIT_RETURN, Branch]> {
    return node.outEdges.map((e) => [e.destination.value as t.Node | typeof IMPLICIT_RETURN, e.value]);
}

function findCfgNode(cfg: ControlFlowGraph, pred: (n: t.Node) => boolean): CfgNode {
    for (const n of cfg.nodes.values()) {
        if (n.value !== IMPLICIT_RETURN && pred(n.value as t.Node)) return n;
    }
    throw new Error('no matching CFG node');
}

describe('ControlFlowAnalysis', () => {
    it('builds an entry+implicit-return for an empty function', () => {
        const cfg = buildFor('function f() {}');
        expect(cfg.entry).toBeDefined();
        expect(cfg.implicitReturn).toBeDefined();
        // Empty body block → UNCOND to follow → implicit return.
        const succs = succsOf(cfg, cfg.entry);
        expect(succs.some(([n, b]) => n === IMPLICIT_RETURN && b === Branch.UNCOND)).toBe(true);
    });

    it('linearises a straight-line block', () => {
        const cfg = buildFor('function f() { a; b; c; }');
        const a = findCfgNode(
            cfg,
            (n) => t.isExpressionStatement(n) && t.isIdentifier(n.expression) && n.expression.name === 'a',
        );
        const b = findCfgNode(
            cfg,
            (n) => t.isExpressionStatement(n) && t.isIdentifier(n.expression) && n.expression.name === 'b',
        );
        const c = findCfgNode(
            cfg,
            (n) => t.isExpressionStatement(n) && t.isIdentifier(n.expression) && n.expression.name === 'c',
        );
        expect(succsOf(cfg, a).some(([n, br]) => n === b.value && br === Branch.UNCOND)).toBe(true);
        expect(succsOf(cfg, b).some(([n, br]) => n === c.value && br === Branch.UNCOND)).toBe(true);
        expect(succsOf(cfg, c).some(([n, br]) => n === IMPLICIT_RETURN && br === Branch.UNCOND)).toBe(true);
    });

    it('emits ON_TRUE / ON_FALSE for if/else (via wrapping blocks)', () => {
        const cfg = buildFor('function f() { if (cond) { a; } else { b; } }');
        const ifNode = findCfgNode(cfg, t.isIfStatement);
        const succs = succsOf(cfg, ifNode);
        const onTrue = succs.find(([_, br]) => br === Branch.ON_TRUE);
        const onFalse = succs.find(([_, br]) => br === Branch.ON_FALSE);
        expect(onTrue && t.isBlockStatement(onTrue[0] as t.Node)).toBe(true);
        expect(onFalse && t.isBlockStatement(onFalse[0] as t.Node)).toBe(true);
        // Within each block, UNCOND lands on the inner expression.
        const trueBlock = findCfgNode(cfg, (n) => n === (onTrue![0] as t.Node));
        const trueBody = succsOf(cfg, trueBlock)[0][0] as t.ExpressionStatement;
        expect((trueBody.expression as t.Identifier).name).toBe('a');
    });

    it('if without else falls through ON_FALSE', () => {
        const cfg = buildFor('function f() { if (cond) { a; } b; }');
        const ifNode = findCfgNode(cfg, t.isIfStatement);
        const onFalse = succsOf(cfg, ifNode).find(([_, br]) => br === Branch.ON_FALSE);
        expect(onFalse).toBeDefined();
        const target = onFalse![0];
        expect(t.isExpressionStatement(target as t.Node)).toBe(true);
        expect(((target as t.ExpressionStatement).expression as t.Identifier).name).toBe('b');
    });

    it('models while as ON_TRUE→body, ON_FALSE→follow, body→while', () => {
        const cfg = buildFor('function f() { while (cond) { a; } b; }');
        const whileNode = findCfgNode(cfg, t.isWhileStatement);
        const aStmt = findCfgNode(
            cfg,
            (n) => t.isExpressionStatement(n) && t.isIdentifier(n.expression) && n.expression.name === 'a',
        );
        const bStmt = findCfgNode(
            cfg,
            (n) => t.isExpressionStatement(n) && t.isIdentifier(n.expression) && n.expression.name === 'b',
        );
        const succs = succsOf(cfg, whileNode);
        const onTrue = succs.find(([_, br]) => br === Branch.ON_TRUE);
        const onFalse = succs.find(([_, br]) => br === Branch.ON_FALSE);
        expect(onTrue && t.isBlockStatement(onTrue[0] as t.Node)).toBe(true);
        expect(onFalse && (onFalse[0] as t.Node) === bStmt.value).toBe(true);
        // The body's exit must come back to the while node.
        expect(succsOf(cfg, aStmt).some(([n]) => n === whileNode.value)).toBe(true);
    });

    it('omits ON_FALSE on while(true)', () => {
        const cfg = buildFor('function f() { while (true) { a; } }');
        const whileNode = findCfgNode(cfg, t.isWhileStatement);
        const succs = succsOf(cfg, whileNode);
        expect(succs.some(([_, br]) => br === Branch.ON_FALSE)).toBe(false);
        expect(succs.some(([_, br]) => br === Branch.ON_TRUE)).toBe(true);
    });

    it('routes for(init;cond;update){body} through update', () => {
        const cfg = buildFor('function f() { for (var i = 0; i < n; i++) { a; } }');
        const forNode = findCfgNode(cfg, t.isForStatement);
        const aStmt = findCfgNode(
            cfg,
            (n) => t.isExpressionStatement(n) && t.isIdentifier(n.expression) && n.expression.name === 'a',
        );
        // body exit -> update -> for
        const bodyExitTarget = succsOf(cfg, aStmt)[0][0] as t.Node;
        expect(t.isUpdateExpression(bodyExitTarget)).toBe(true);
        const updateNode = findCfgNode(cfg, (n) => n === bodyExitTarget);
        expect(succsOf(cfg, updateNode).some(([n]) => n === forNode.value)).toBe(true);
    });

    it('return goes to implicit return', () => {
        const cfg = buildFor('function f() { return; }');
        const ret = findCfgNode(cfg, t.isReturnStatement);
        expect(succsOf(cfg, ret).some(([n, br]) => n === IMPLICIT_RETURN && br === Branch.UNCOND)).toBe(true);
    });

    it('break exits the enclosing loop', () => {
        const cfg = buildFor('function f() { while (cond) { break; } a; }');
        const brk = findCfgNode(cfg, t.isBreakStatement);
        const aStmt = findCfgNode(
            cfg,
            (n) => t.isExpressionStatement(n) && t.isIdentifier(n.expression) && n.expression.name === 'a',
        );
        expect(succsOf(cfg, brk).some(([n]) => n === aStmt.value)).toBe(true);
    });

    it('continue jumps to loop header (or update for vanilla for)', () => {
        const cfg1 = buildFor('function f() { while (cond) { continue; a; } }');
        const cont = findCfgNode(cfg1, t.isContinueStatement);
        const w = findCfgNode(cfg1, t.isWhileStatement);
        expect(succsOf(cfg1, cont).some(([n]) => n === w.value)).toBe(true);

        const cfg2 = buildFor('function f() { for (var i = 0; i < n; i++) { continue; } }');
        const cont2 = findCfgNode(cfg2, t.isContinueStatement);
        const target = succsOf(cfg2, cont2)[0][0] as t.Node;
        expect(t.isUpdateExpression(target)).toBe(true);
    });

    it('switch with cases routes through case ON_TRUE/ON_FALSE', () => {
        const cfg = buildFor('function f(x) { switch (x) { case 1: a; break; case 2: b; break; } c; }');
        const sw = findCfgNode(cfg, t.isSwitchStatement);
        // Switch -> first non-default case
        const succs = succsOf(cfg, sw);
        const target = succs[0][0] as t.Node;
        expect(t.isSwitchCase(target)).toBe(true);
    });

    it('bare-case statements fall through to next sibling in the same consequent (not next case)', () => {
        // Regression: computeFollowNode for SwitchCase-parented statements
        // used to skip the within-consequent sibling walk and jump straight
        // to the next case. That breaks the CFG for bare `case X: stmt; break;`
        // form (no `{ ... }` wrapper) — `stmt` would appear to flow into the
        // next case's first statement, bypassing the trailing `break`. Live-
        // variables analysis then misreports liveness across the switch and
        // dead-assignment elimination strips real writes.
        const cfg = buildFor(
            'function f(x) { let v; switch (x) { case 1: v = 1; break; case 2: v = 2; break; } return v; }',
        );
        const case1Assign = findCfgNode(
            cfg,
            (n) =>
                t.isExpressionStatement(n) &&
                t.isAssignmentExpression(n.expression) &&
                t.isNumericLiteral(n.expression.right) &&
                n.expression.right.value === 1,
        );
        const succs = succsOf(cfg, case1Assign);
        // Must land on the BreakStatement next to it, not on the case-2
        // ExpressionStatement (which would mean we silently fell through).
        expect(succs.length).toBe(1);
        expect(t.isBreakStatement(succs[0][0] as t.Node)).toBe(true);
    });

    it('skips nested function bodies in outer CFG', () => {
        const cfg = buildFor('function f() { var g = function() { inner; }; outer; }');
        // The outer CFG should reach `outer;`, but `inner;` should NOT be a
        // CFG node in this CFG (it lives in the inner function's CFG).
        for (const node of cfg.nodes.values()) {
            if (node.value === IMPLICIT_RETURN) continue;
            const v = node.value as t.Node;
            if (t.isExpressionStatement(v) && t.isIdentifier(v.expression)) {
                expect(v.expression.name).not.toBe('inner');
            }
        }
    });

    it('bails on try/catch', () => {
        const fn = parseFn('function f() { try { a; } catch (e) { b; } }');
        expect(buildControlFlowGraph({ root: fn.body })).toBeNull();
    });

    it('bails on async / generator / await / yield', () => {
        const asyncFn = parse('async function f() { return 1; }', { plugins: ['typescript'] }).program
            .body[0] as t.FunctionDeclaration;
        expect(buildControlFlowGraph({ root: asyncFn })).toBeNull();
        const gen = parse('function* g() { yield 1; }', { plugins: ['typescript'] }).program.body[0] as t.FunctionDeclaration;
        expect(buildControlFlowGraph({ root: gen })).toBeNull();
        const withAwait = parse('async function f() { await foo(); }', { plugins: ['typescript'] }).program
            .body[0] as t.FunctionDeclaration;
        expect(buildControlFlowGraph({ root: withAwait })).toBeNull();
    });

    it('bails on with', () => {
        const fn = parseFn('function f(o) { with (o) { a; } }');
        expect(buildControlFlowGraph({ root: fn.body })).toBeNull();
    });

    it('computeFallThrough sees through do-while and labels', () => {
        const fn = parseFn('function f() { do { a; } while (cond); }');
        const doStmt = fn.body.body[0] as t.DoWhileStatement;
        expect(computeFallThrough(doStmt)).toBe(doStmt.body);
    });

    it('assigns priorities such that entry < implicit-return', () => {
        const cfg = buildFor('function f() { a; b; }');
        expect(cfg.entry.priority).toBeGreaterThan(0);
        expect(cfg.implicitReturn.priority).toBeGreaterThan(cfg.entry.priority);
    });
});
