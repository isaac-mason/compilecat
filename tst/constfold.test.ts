import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import * as Effects from '../src/plugin/analyses/effects';
import * as Zones from '../src/plugin/analyses/zones';
import { applyConstfold } from '../src/plugin/transforms/constfold';
import { generate } from '../src/plugin/util/babel';

function run(code: string): string {
	const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
	applyConstfold(ast, { zones: Zones.init(), effects: Effects.init() });
	return generate(ast, { retainLines: false, comments: false }).code.trim();
}

function normalize(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

describe('plugin-alt/transforms/constfold', () => {
	it('folds literal arithmetic', () => {
		const input = `
			/* @cc-sroa */
			function f() {
				return 1 + 2 * 3;
			}
		`;
		const expected = `
			function f() {
				return 7;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('folds literal division and subtraction', () => {
		const input = `
			/* @cc-sroa */
			function f() {
				return 10 - 4 / 2;
			}
		`;
		const expected = `
			function f() {
				return 8;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('treats unary-negated literal as numeric', () => {
		const input = `
			/* @cc-sroa */
			function f() {
				return -5 + 2;
			}
		`;
		const expected = `
			function f() {
				return -3;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('skips division by zero', () => {
		const input = `
			/* @cc-sroa */
			function f() {
				return 1 / 0;
			}
		`;
		// untouched: we don't want to synthesize Infinity literals
		expect(normalize(run(input))).toBe(normalize(input.replace('/* @cc-sroa */', '')));
	});

	it('folds x + 0 → x', () => {
		const input = `
			/* @cc-sroa */
			function f(x) {
				return x + 0;
			}
		`;
		const expected = `
			function f(x) {
				return x;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('folds 0 + x → x', () => {
		const input = `
			/* @cc-sroa */
			function f(x) {
				return 0 + x;
			}
		`;
		const expected = `
			function f(x) {
				return x;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('folds x * 1 → x', () => {
		const input = `
			/* @cc-sroa */
			function f(x) {
				return x * 1;
			}
		`;
		const expected = `
			function f(x) {
				return x;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('folds x / 1 → x', () => {
		const input = `
			/* @cc-sroa */
			function f(x) {
				return x / 1;
			}
		`;
		const expected = `
			function f(x) {
				return x;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('does not drop side effects on identity folds', () => {
		// x*1 must NOT fold when x may be impure: sideEffect() must still run
		const input = `
			/* @cc-sroa */
			function f() {
				return sideEffect() * 1;
			}
		`;
		const expected = `
			function f() {
				return sideEffect() * 1;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('does nothing outside an opt-in zone', () => {
		const input = `
			function f() {
				return 1 + 2;
			}
		`;
		const expected = `
			function f() {
				return 1 + 2;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('folds nested combinations to fixpoint via exit traversal', () => {
		// inner fold (3+4 → 7) must finish before outer (x*7 doesn't fold further)
		const input = `
			/* @cc-sroa */
			function f(x) {
				return x + (3 + 4);
			}
		`;
		const expected = `
			function f(x) {
				return x + 7;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});
});
