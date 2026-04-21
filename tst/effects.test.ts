import { parseExpression } from '@babel/parser';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import * as Effects from '../src/plugin/analyses/effects';

function parseExpr(code: string): t.Expression {
	return parseExpression(code, { plugins: ['typescript'] });
}

function pure(code: string): boolean {
	return Effects.isPure(Effects.init(), parseExpr(code));
}

// Minimal smoke test — the real test of effects is whether the transforms
// built on top (DCE, constfold, copyprop) produce correct output. Expand
// this file only when a transform hits a mis-classification we need to pin.
describe('plugin-alt/analyses/effects (smoke)', () => {
	it('classifies the cases transforms actually hit', () => {
		// Pure: leaf + member + arithmetic
		expect(pure('1')).toBe(true);
		expect(pure('foo')).toBe(true);
		expect(pure('a.b.c')).toBe(true);
		expect(pure('a[0]')).toBe(true);
		expect(pure('a * b + c')).toBe(true);
		expect(pure('!flag')).toBe(true);
		expect(pure('a ? 1 : 2')).toBe(true);
		expect(pure('[1, 2, 3]')).toBe(true);
		expect(pure('`hello ${name}`')).toBe(true);

		// Impure: calls, updates, assignments, dynamic side-effecters
		expect(pure('foo()')).toBe(false);
		expect(pure('new Foo()')).toBe(false);
		expect(pure('i++')).toBe(false);
		expect(pure('(x = 1)')).toBe(false);
		expect(pure('a[foo()]')).toBe(false);
		expect(pure('[...iter]')).toBe(false);
		expect(pure('`${foo()}`')).toBe(false);
		expect(pure('delete a.b')).toBe(false);
	});
});
