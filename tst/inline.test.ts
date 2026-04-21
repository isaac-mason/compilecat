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

function normalize(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

describe('plugin-alt/transforms/inline (v1: single-file)', () => {
	it('inlines a simple-return function at a const init', () => {
		const input = `
			/* @cc-inline */
			function add(a, b) { return a + b; }
			const x = add(1, 2);
		`;
		const expected = `
			const x = 1 + 2;
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('inlines at statement form (discards return when pure)', () => {
		const input = `
			/* @cc-inline */
			function write(out, i, v) { out[i] = v; return out; }
			write(arr, 0, 99);
		`;
		const expected = `
			arr[0] = 99;
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('inlines at assignment RHS', () => {
		const input = `
			/* @cc-inline */
			function add(a, b) { return a + b; }
			let y;
			y = add(10, 20);
		`;
		const expected = `
			let y;
			y = 10 + 20;
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('inlines at return-statement arg', () => {
		const input = `
			/* @cc-inline */
			function add(a, b) { return a + b; }
			function caller(x) { return add(x, 1); }
		`;
		const expected = `
			function caller(x) { return x + 1; }
		`;
		expect(normalize(run(input))).toBe(normalize(expected));
	});

	it('hoists impure args once into _arg_ temps', () => {
		const input = `
			/* @cc-inline */
			function square(a) { return a * a; }
			const s = square(sideEffect());
		`;
		const out = run(input);
		// sideEffect() should be called exactly once, hoisted to a const
		expect(out).toContain('const _arg_a_');
		expect(out.match(/sideEffect\(\)/g)?.length).toBe(1);
	});

	it('does not hoist pure args (identifier / member chain)', () => {
		const input = `
			/* @cc-inline */
			function square(a) { return a * a; }
			const s = square(obj.prop);
		`;
		const out = run(input);
		expect(out).not.toContain('_arg_a_');
		expect(out).toContain('obj.prop * obj.prop');
	});

	it('renames locals with a per-call suffix', () => {
		const input = `
			/* @cc-inline */
			function f(x) {
				const tmp = x + 1;
				return tmp * 2;
			}
			const a = f(10);
			const b = f(20);
		`;
		const out = run(input);
		// each inlining gets its own tmp_N so they don't clash
		expect(out).toContain('const tmp_');
		// no references to the original 'tmp' name (which would be a collision)
		expect(out).not.toMatch(/\btmp\s*=/);
	});

	it('removes inlined function declarations after inlining', () => {
		const input = `
			/* @cc-inline */
			function add(a, b) { return a + b; }
			const x = add(1, 2);
		`;
		const out = run(input);
		expect(out).not.toContain('function add');
	});

	it('handles imperative bodies with writes + trailing return', () => {
		const input = `
			/* @cc-inline */
			function add(a, b, out) {
				out[0] = a[0] + b[0];
				out[1] = a[1] + b[1];
				out[2] = a[2] + b[2];
				return out;
			}
			const r = add(p, q, tmp);
		`;
		const out = run(input);
		expect(out).toContain('tmp[0] = p[0] + q[0]');
		expect(out).toContain('tmp[1] = p[1] + q[1]');
		expect(out).toContain('tmp[2] = p[2] + q[2]');
		expect(out).toContain('const r = tmp');
	});

	it('inlines callees in bottom-up order (nested inlineables)', () => {
		const input = `
			/* @cc-inline */
			function square(a) { return a * a; }
			/* @cc-inline */
			function sumOfSquares(x, y) {
				return square(x) + square(y);
			}
			const s = sumOfSquares(3, 4);
		`;
		const out = run(input);
		// both callers have been fully inlined at the consumer callsite
		expect(out).toContain('3 * 3 + 4 * 4');
		expect(out).not.toContain('square');
		expect(out).not.toContain('sumOfSquares');
	});

	it('skips functions with control-flow bodies', () => {
		const input = `
			/* @cc-inline */
			function choose(a, b, cond) {
				if (cond) return a;
				return b;
			}
			const x = choose(1, 2, true);
		`;
		// v1 bails on if-statements — function stays, callsite stays
		const out = run(input);
		expect(out).toContain('function choose');
		expect(out).toContain('choose(1, 2, true)');
	});

	it('bails on recursive inlineable functions', () => {
		const input = `
			/* @cc-inline */
			function fact(n) { return n * fact(n - 1); }
			const x = fact(3);
		`;
		const out = run(input);
		expect(out).toContain('function fact');
		expect(out).toContain('fact(3)');
	});

	it('does not inline unannotated functions', () => {
		const input = `
			function add(a, b) { return a + b; }
			const x = add(1, 2);
		`;
		const out = run(input);
		expect(out).toContain('function add');
		expect(out).toContain('add(1, 2)');
	});

	it('inlines through an export', () => {
		const input = `
			/* @cc-inline */
			export function add(a, b) { return a + b; }
			const x = add(1, 2);
		`;
		const out = run(input);
		expect(out).toContain('const x = 1 + 2');
		expect(out).not.toContain('function add');
	});
});
