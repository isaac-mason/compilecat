import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import * as Effects from '../src/plugin/analyses/effects';
import { applyInline } from '../src/plugin/transforms/inline';
import { generate } from '../src/plugin/util/babel';

function run(code: string): string {
	const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
	applyInline(ast, '/virtual/test.ts', { effects: Effects.init() });
	return generate(ast, { retainLines: false, comments: false }).code.trim();
}

describe('plugin-alt/transforms/inline — control-flow positions', () => {
	it('inlines a call inside an `if` condition', () => {
		const input = `
			/* @cc-inline */
			function sq(x) { return x * x; }
			export function work(v) {
				if (sq(v) > 4) {
					return 'big';
				}
				return 'small';
			}
		`;
		const out = run(input);
		const workBody = out.slice(out.indexOf('function work'));
		expect(workBody).not.toMatch(/\bsq\(/);
		expect(workBody).toMatch(/if\s*\(v\s*\*\s*v\s*>\s*4\)/);
	});

	it('inlines a call inside a `while` condition', () => {
		const input = `
			/* @cc-inline */
			function dec(x) { return x - 1; }
			export function work(n) {
				while (dec(n) > 0) {
					n = dec(n);
				}
				return n;
			}
		`;
		const out = run(input);
		const workBody = out.slice(out.indexOf('function work'));
		expect(workBody).not.toMatch(/\bdec\(/);
		expect(workBody).toMatch(/while\s*\(n\s*-\s*1\s*>\s*0\)/);
	});

	it('inlines a call inside a `for` condition', () => {
		const input = `
			/* @cc-inline */
			function limit(i) { return i + 1; }
			export function work(n) {
				for (let i = 0; i < limit(n); i++) {
				}
			}
		`;
		const out = run(input);
		const workBody = out.slice(out.indexOf('function work'));
		expect(workBody).not.toMatch(/\blimit\(/);
		expect(workBody).toMatch(/i\s*<\s*n\s*\+\s*1/);
	});

	it('inlines a call inside both branches of a ternary', () => {
		const input = `
			/* @cc-inline */
			function a(x) { return x * 2; }
			/* @cc-inline */
			function b(x) { return x * 3; }
			export function work(cond, v) {
				return cond ? a(v) : b(v);
			}
		`;
		const out = run(input);
		const workBody = out.slice(out.indexOf('function work'));
		expect(workBody).not.toMatch(/\ba\(v\)/);
		expect(workBody).not.toMatch(/\bb\(v\)/);
		expect(workBody).toMatch(/v\s*\*\s*2/);
		expect(workBody).toMatch(/v\s*\*\s*3/);
	});

	it('inlines a call on the RHS of a short-circuit expression', () => {
		const input = `
			/* @cc-inline */
			function doubled(x) { return x * 2; }
			export function work(flag, v) {
				return flag && doubled(v);
			}
		`;
		const out = run(input);
		const workBody = out.slice(out.indexOf('function work'));
		expect(workBody).not.toMatch(/\bdoubled\(/);
		expect(workBody).toMatch(/flag\s*&&\s*v\s*\*\s*2/);
	});

	it('inlines a call that is an argument to another call', () => {
		const input = `
			/* @cc-inline */
			function sq(x) { return x * x; }
			export function work(a, b) {
				return Math.max(sq(a), sq(b));
			}
		`;
		const out = run(input);
		const workBody = out.slice(out.indexOf('function work'));
		expect(workBody).not.toMatch(/\bsq\(/);
		expect(workBody).toMatch(/Math\.max\(a\s*\*\s*a,\s*b\s*\*\s*b\)/);
	});

	it('void-return callee in expression position: does not produce bogus substitution', () => {
		// A void function has no value to splice into an expression slot.
		// Current behavior is to leave the call alone when it sits in an
		// expression position (since `recognizeCallsite` won't match, the body
		// isn't simple-return, and `inlineExpressionPosition` requires a return
		// argument). Guards against silently emitting `undefined`.
		const input = `
			/* @cc-inline */
			function touch(arr) {
				arr[0] = 1;
			}
			export function work(buf, other) {
				// touch() is void — using it as a value would be nonsense.
				return other + touch(buf);
			}
		`;
		const out = run(input);
		// We don't care whether the inliner leaves it as a call or bails —
		// what matters is the output doesn't contain a bare `undefined` slot
		// that would read back as NaN at runtime.
		const workBody = out.slice(out.indexOf('function work'));
		expect(workBody).not.toMatch(/other\s*\+\s*undefined/);
	});
});
