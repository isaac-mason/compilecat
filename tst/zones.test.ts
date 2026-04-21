import { parse } from '@babel/parser';
import { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import * as Zones from '../src/plugin/analyses/zones';
import { traverse } from '../src/plugin/util/babel';

function parseFile(code: string): t.File {
	return parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
}

/**
 * Find the first NodePath whose node type matches and whose enclosing function's
 * name matches `fnName` (or any if undefined). Utility for positioning queries
 * inside a specific function.
 */
function findPath(
	file: t.File,
	predicate: (path: NodePath) => boolean,
): NodePath {
	let found: NodePath | null = null;
	traverse(file, {
		enter(path) {
			if (found) return;
			if (predicate(path)) found = path;
		},
	});
	if (!found) throw new Error('no path matched predicate');
	return found;
}

describe('plugin-alt/analyses/zones', () => {
	it('no annotations → no zones active', () => {
		const file = parseFile(`
			function f(x) { return x + 1; }
		`);
		const state = Zones.init();
		const returnPath = findPath(file, (p) => p.isReturnStatement());
		expect(Zones.activeZones(state, returnPath).size).toBe(0);
		expect(Zones.isInZone(state, returnPath, 'inline')).toBe(false);
	});

	it('@cc-inline on enclosing function activates inline zone', () => {
		const file = parseFile(`
			/* @cc-inline */
			function f(x) { return x + 1; }
		`);
		const state = Zones.init();
		const returnPath = findPath(file, (p) => p.isReturnStatement());
		expect(Zones.isInZone(state, returnPath, 'inline')).toBe(true);
		expect(Zones.isInZone(state, returnPath, 'sroa')).toBe(false);
	});

	it('@cc-sroa and @cc-inline combined on the same function', () => {
		const file = parseFile(`
			/* @cc-inline @cc-sroa */
			function f(x) {
				const tmp = [0, 0, 0];
				return tmp[0] + x;
			}
		`);
		const state = Zones.init();
		const decl = findPath(file, (p) => p.isVariableDeclaration());
		expect(Zones.isInZone(state, decl, 'inline')).toBe(true);
		expect(Zones.isInZone(state, decl, 'sroa')).toBe(true);
		expect(Zones.isInZone(state, decl, 'unroll')).toBe(false);
	});

	it('annotation on outer function inherits to inner nodes', () => {
		const file = parseFile(`
			/* @cc-sroa */
			function outer() {
				function inner() {
					const x = 1;
					return x;
				}
				return inner();
			}
		`);
		const state = Zones.init();
		const innerDecl = findPath(
			file,
			(p) =>
				p.isVariableDeclaration() &&
				// skip the outer's own vars; here inner has the const x
				Boolean(p.node.declarations[0].id && 'name' in p.node.declarations[0].id && p.node.declarations[0].id.name === 'x'),
		);
		expect(Zones.isInZone(state, innerDecl, 'sroa')).toBe(true);
	});

	it('annotation on a VariableDeclaration covers its RHS', () => {
		const file = parseFile(`
			/* @cc-sroa */
			const scratch = [0, 0, 0];
		`);
		const state = Zones.init();
		const arr = findPath(file, (p) => p.isArrayExpression());
		expect(Zones.isInZone(state, arr, 'sroa')).toBe(true);
	});

	it('line-comment annotations are ignored (must be block comments)', () => {
		const file = parseFile(`
			// @cc-inline
			function f() { return 1; }
		`);
		const state = Zones.init();
		const ret = findPath(file, (p) => p.isReturnStatement());
		expect(Zones.isInZone(state, ret, 'inline')).toBe(false);
	});

	it('sibling functions do not share zone membership', () => {
		const file = parseFile(`
			/* @cc-inline */
			function a() { return 1; }
			function b() { return 2; }
		`);
		const state = Zones.init();
		let aRet: NodePath | null = null;
		let bRet: NodePath | null = null;
		traverse(file, {
			FunctionDeclaration(p) {
				const name = p.node.id?.name;
				const ret = p.get('body').get('body')[0] as NodePath;
				if (name === 'a') aRet = ret;
				if (name === 'b') bRet = ret;
			},
		});
		expect(aRet && Zones.isInZone(state, aRet, 'inline')).toBe(true);
		expect(bRet && Zones.isInZone(state, bRet, 'inline')).toBe(false);
	});

	it('caches: repeated queries return the same set reference', () => {
		const file = parseFile(`
			/* @cc-sroa */
			function f() { const x = 1; return x; }
		`);
		const state = Zones.init();
		const decl = findPath(file, (p) => p.isVariableDeclaration());
		const a = Zones.activeZones(state, decl);
		const b = Zones.activeZones(state, decl);
		expect(a).toBe(b);
	});

	it('invalidateAll drops the cache', () => {
		const file = parseFile(`
			/* @cc-sroa */
			function f() { const x = 1; return x; }
		`);
		const state = Zones.init();
		const decl = findPath(file, (p) => p.isVariableDeclaration());
		const a = Zones.activeZones(state, decl);
		Zones.invalidateAll(state);
		const b = Zones.activeZones(state, decl);
		// same content, but recomputed — reference inequality confirms the old entry is gone
		expect(a).not.toBe(b);
		expect([...b]).toEqual([...a]);
	});

	it('@cc-unroll on a loop activates the unroll zone for its body', () => {
		const file = parseFile(`
			function f(arr) {
				/* @cc-unroll */
				for (let i = 0; i < 3; i++) { arr[i] = 0; }
			}
		`);
		const state = Zones.init();
		const body = findPath(
			file,
			(p) => p.isBlockStatement() && Boolean(p.parentPath?.isForStatement()),
		);
		expect(Zones.isInZone(state, body, 'unroll')).toBe(true);
	});
});
