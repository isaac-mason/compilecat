import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import * as Zones from '../src/plugin/analyses/zones';
import { applyCopyprop } from '../src/plugin/transforms/copyprop';
import { generate } from '../src/plugin/util/babel';

function run(code: string): string {
	const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
	applyCopyprop(ast, { zones: Zones.init() });
	return generate(ast, { retainLines: false, comments: false }).code.trim();
}

function normalize(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

describe('plugin-alt/transforms/copyprop', () => {
	it('propagates const x = y and removes x', () => {
		const input = `
			/* @cc-sroa */
			function f(y) {
				const x = y;
				return x + x;
			}
		`;
		const expected = `
			function f(y) {
				return y + y;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('does nothing when y is re-assigned (not constant)', () => {
		const input = `
			/* @cc-sroa */
			function f() {
				let y = 1;
				const x = y;
				y = 2;
				return x;
			}
		`;
		// y is not constant — we can't safely propagate x → y
		const expected = `
			function f() {
				let y = 1;
				const x = y;
				y = 2;
				return x;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('does nothing when x is re-assigned', () => {
		const input = `
			/* @cc-sroa */
			function f(y) {
				let x = y;
				x = 5;
				return x;
			}
		`;
		const expected = `
			function f(y) {
				let x = y;
				x = 5;
				return x;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('skips when y is shadowed at the use site', () => {
		const input = `
			/* @cc-sroa */
			function f(y) {
				const x = y;
				{
					const y = 99;
					return x + y;
				}
			}
		`;
		// replacing x with y inside the inner block would read the inner y
		const expected = input.replace('/* @cc-sroa */', '');
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('does nothing outside an opt-in zone', () => {
		const input = `
			function f(y) {
				const x = y;
				return x;
			}
		`;
		const expected = `
			function f(y) {
				const x = y;
				return x;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('skips for-of loop decls', () => {
		const input = `
			/* @cc-sroa */
			function f(arr) {
				for (const x of arr) {
					console.log(x);
				}
			}
		`;
		const expected = input.replace('/* @cc-sroa */', '');
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('propagates param alias: const a = param; use a → use param', () => {
		const input = `
			/* @cc-sroa */
			function f(param) {
				const a = param;
				return a * a;
			}
		`;
		const expected = `
			function f(param) {
				return param * param;
			}
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('handles chained const aliases', () => {
		const input = `
			/* @cc-sroa */
			function f(y) {
				const a = y;
				const b = a;
				return b;
			}
		`;
		// first pass: propagate a → y (removes a). then declarator b = y.
		// second pass needed to clean up b — v1 is single-pass. Fixpoint is
		// the pipeline's job. Just assert one pass made progress.
		const out = run(input);
		expect(out).not.toContain('const a =');
		expect(out).toContain('return');
	});
});
