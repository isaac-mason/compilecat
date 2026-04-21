import { parse } from '@babel/parser';
import { describe, expect, it, vi } from 'vitest';
import { applyUnroll } from '../src/plugin/transforms/unroll';
import { generate } from '../src/plugin/util/babel';

function run(code: string): string {
	const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
	applyUnroll(ast);
	return generate(ast, { retainLines: false, comments: false }).code.trim();
}

describe('plugin-alt/transforms/unroll — basic for', () => {
	it('unrolls `i < N`', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 4; i++) { arr[i] = i; }
		`);
		expect(out).toContain('arr[0] = 0');
		expect(out).toContain('arr[1] = 1');
		expect(out).toContain('arr[2] = 2');
		expect(out).toContain('arr[3] = 3');
		expect(out).not.toContain('for');
	});

	it('unrolls `i <= N`', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i <= 2; i++) { arr[i] = i; }
		`);
		expect(out).toContain('arr[0] = 0');
		expect(out).toContain('arr[1] = 1');
		expect(out).toContain('arr[2] = 2');
		expect(out).not.toContain('arr[3]');
	});

	it('unrolls with non-zero start', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 2; i < 5; i++) { arr[i] = i * 2; }
		`);
		expect(out).toContain('arr[2] = 2 * 2');
		expect(out).toContain('arr[3] = 3 * 2');
		expect(out).toContain('arr[4] = 4 * 2');
		expect(out).not.toContain('arr[0]');
	});

	it('unrolls `i += step`', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 6; i += 2) { arr[i] = i; }
		`);
		expect(out).toContain('arr[0] = 0');
		expect(out).toContain('arr[2] = 2');
		expect(out).toContain('arr[4] = 4');
		expect(out).not.toContain('arr[1]');
	});

	it('accepts ++i update syntax', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 3; ++i) { arr[i] = i; }
		`);
		expect(out).toContain('arr[0] = 0');
		expect(out).toContain('arr[1] = 1');
		expect(out).toContain('arr[2] = 2');
	});

	it('handles single-statement body without braces', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 3; i++) arr[i] = i;
		`);
		expect(out).toContain('arr[0] = 0');
		expect(out).toContain('arr[2] = 2');
		expect(out).not.toContain('for');
	});

	it('removes a zero-iteration loop', () => {
		const out = run(`
			const before = 1;
			/* @cc-unroll */
			for (let i = 5; i < 3; i++) { arr[i] = i; }
			const after = 2;
		`);
		expect(out).not.toContain('arr[');
		expect(out).not.toContain('for (');
		expect(out).toContain('before');
		expect(out).toContain('after');
	});
});

describe('plugin-alt/transforms/unroll — substitution', () => {
	it('substitutes in complex expressions', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 3; i++) { mat[i * 3 + 0] = row[i]; }
		`);
		expect(out).toContain('mat[0 * 3 + 0] = row[0]');
		expect(out).toContain('mat[1 * 3 + 0] = row[1]');
		expect(out).toContain('mat[2 * 3 + 0] = row[2]');
	});

	it('does not substitute shadowed param in nested function', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 2; i++) {
				const fn = (i: number) => { return i; };
				arr[i] = fn(99);
			}
		`);
		expect(out).toContain('(i: number)');
		expect(out).toContain('return i');
	});

	it('does not substitute property keys with the same name', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 2; i++) { obj.i = i; }
		`);
		expect(out).toContain('obj.i = 0');
		expect(out).toContain('obj.i = 1');
	});
});

describe('plugin-alt/transforms/unroll — nested', () => {
	it('unrolls nested loops in a single apply() call', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 2; i++) {
				/* @cc-unroll */
				for (let j = 0; j < 2; j++) { mat[i * 2 + j] = i + j; }
			}
		`);
		expect(out).toContain('mat[0 * 2 + 0] = 0 + 0');
		expect(out).toContain('mat[0 * 2 + 1] = 0 + 1');
		expect(out).toContain('mat[1 * 2 + 0] = 1 + 0');
		expect(out).toContain('mat[1 * 2 + 1] = 1 + 1');
		expect(out).not.toContain('for');
	});

	it('unrolls triple-nested loops', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 2; i++) {
				/* @cc-unroll */
				for (let j = 0; j < 2; j++) {
					/* @cc-unroll */
					for (let k = 0; k < 2; k++) { result[i * 4 + j * 2 + k] = i + j + k; }
				}
			}
		`);
		expect(out).not.toContain('for');
		expect(out).toContain('result[0 * 4 + 0 * 2 + 0] = 0 + 0 + 0');
		expect(out).toContain('result[1 * 4 + 1 * 2 + 1] = 1 + 1 + 1');
	});
});

describe('plugin-alt/transforms/unroll — skip conditions', () => {
	it('skips when loop has break and warns', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 4; i++) {
				if (i === 2) break;
				arr[i] = i;
			}
		`);
		expect(out).toContain('for');
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('break/continue/return'));
		spy.mockRestore();
	});

	it('skips when loop has continue', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 4; i++) {
				if (i === 2) continue;
				arr[i] = i;
			}
		`);
		expect(out).toContain('for');
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('break/continue/return'));
		spy.mockRestore();
	});

	it('skips when loop has return', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = run(`
			function foo() {
				/* @cc-unroll */
				for (let i = 0; i < 4; i++) {
					if (i === 2) return;
					arr[i] = i;
				}
			}
		`);
		expect(out).toContain('for');
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('break/continue/return'));
		spy.mockRestore();
	});

	it('does NOT flag break inside a nested loop', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 3; i++) {
				for (let j = 0; j < 10; j++) { if (j === 5) break; }
				arr[i] = i;
			}
		`);
		expect(out).toContain('arr[0] = 0');
		expect(out).toContain('arr[1] = 1');
		expect(out).toContain('arr[2] = 2');
	});

	it('does NOT flag return inside a nested function', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 2; i++) {
				const fn = () => { return i; };
				arr[i] = fn();
			}
		`);
		expect(out).not.toContain('for (let i');
		expect(out).toContain('arr[0]');
		expect(out).toContain('arr[1]');
	});

	it('skips and warns when init is not a numeric literal', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = run(`
			const start = 0;
			/* @cc-unroll */
			for (let i = start; i < 4; i++) { arr[i] = i; }
		`);
		expect(out).toContain('for');
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('could not determine loop shape'));
		spy.mockRestore();
	});

	it('skips when bound is not a numeric literal', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = run(`
			const n = 4;
			/* @cc-unroll */
			for (let i = 0; i < n; i++) { arr[i] = i; }
		`);
		expect(out).toContain('for');
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('could not determine loop shape'));
		spy.mockRestore();
	});

	it('skips `i--`', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = run(`
			/* @cc-unroll */
			for (let i = 4; i < 10; i--) { arr[i] = i; }
		`);
		expect(out).toContain('for');
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('could not determine loop shape'));
		spy.mockRestore();
	});

	it('does not touch loops without @cc-unroll', () => {
		const out = run(`
			for (let i = 0; i < 4; i++) { arr[i] = i; }
		`);
		expect(out).toContain('for');
	});
});

describe('plugin-alt/transforms/unroll — iteration counts', () => {
	it('i < N produces exactly N iterations', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 5; i++) { process(i); }
		`);
		expect(out.match(/process\(\d+\)/g)).toHaveLength(5);
		expect(out).toContain('process(0)');
		expect(out).toContain('process(4)');
		expect(out).not.toContain('process(5)');
	});

	it('i <= N produces exactly N+1 iterations', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i <= 4; i++) { process(i); }
		`);
		expect(out.match(/process\(\d+\)/g)).toHaveLength(5);
		expect(out).toContain('process(4)');
		expect(out).not.toContain('process(5)');
	});

	it('step correctly truncates non-divisible range', () => {
		const out = run(`
			/* @cc-unroll */
			for (let i = 0; i < 7; i += 3) { process(i); }
		`);
		expect(out.match(/process\(\d+\)/g)).toHaveLength(3);
		expect(out).toContain('process(0)');
		expect(out).toContain('process(3)');
		expect(out).toContain('process(6)');
		expect(out).not.toContain('process(7)');
	});
});

describe('plugin-alt/transforms/unroll — for-of', () => {
	it('unrolls inline array literal', () => {
		const out = run(`
			/* @cc-unroll */
			for (const key of ["x", "y", "z"]) { process(key); }
		`);
		expect(out).toContain('process("x")');
		expect(out).toContain('process("y")');
		expect(out).toContain('process("z")');
		expect(out).not.toContain('for');
	});

	it('unrolls when iterable is a const binding', () => {
		const out = run(`
			const KEYS = ["foo", "bar"];
			/* @cc-unroll */
			for (const key of KEYS) { obj[key] = 1; }
		`);
		expect(out).toContain('obj["foo"] = 1');
		expect(out).toContain('obj["bar"] = 1');
	});

	it('substitutes identifier iterable elements as-is', () => {
		const out = run(`
			const Y = "y_val";
			/* @cc-unroll */
			for (const v of [42, "hello", Y, true]) { process(v); }
		`);
		expect(out).toContain('process(42)');
		expect(out).toContain('process("hello")');
		expect(out).toContain('process(Y)');
		expect(out).toContain('process(true)');
	});

	it('removes empty-array for-of', () => {
		const out = run(`
			const before = 1;
			/* @cc-unroll */
			for (const x of []) { process(x); }
			const after = 2;
		`);
		expect(out).not.toContain('process');
		expect(out).not.toContain('for (');
		expect(out).toContain('before');
		expect(out).toContain('after');
	});

	it('skips non-resolvable iterable', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = run(`
			/* @cc-unroll */
			for (const key of getKeys()) { process(key); }
		`);
		expect(out).toContain('for');
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('could not resolve for-of iterable'));
		spy.mockRestore();
	});

	it('skips let-bound iterable', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = run(`
			let keys = ["a", "b"];
			/* @cc-unroll */
			for (const key of keys) { process(key); }
		`);
		expect(out).toContain('for');
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('could not resolve for-of iterable'));
		spy.mockRestore();
	});

	it('skips destructuring left-hand side', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = run(`
			/* @cc-unroll */
			for (const [a, b] of [[1, 2], [3, 4]]) { process(a, b); }
		`);
		expect(out).toContain('for');
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('must declare a single identifier'));
		spy.mockRestore();
	});

	it('nested for-of × for works', () => {
		const out = run(`
			const AXES = ["x", "y", "z"];
			/* @cc-unroll */
			for (let i = 0; i < 2; i++) {
				/* @cc-unroll */
				for (const axis of AXES) { result[i][axis] = 0; }
			}
		`);
		expect(out).toContain('result[0]["x"] = 0');
		expect(out).toContain('result[0]["y"] = 0');
		expect(out).toContain('result[0]["z"] = 0');
		expect(out).toContain('result[1]["x"] = 0');
		expect(out).not.toContain('for');
	});
});
