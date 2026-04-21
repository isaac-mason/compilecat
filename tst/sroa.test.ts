import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { applySroa } from '../src/plugin/transforms/sroa';
import { generate } from '../src/plugin/util/babel';

function run(code: string): string {
	const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
	applySroa(ast);
	return generate(ast, { retainLines: false, comments: false }).code.trim();
}

describe('plugin-alt/transforms/sroa — opt-in gating', () => {
	it('does not run without any @cc-sroa annotation', () => {
		const input = `
			const v = [1, 2, 3];
			const x = v[0];
		`;
		const out = run(input);
		expect(out).toContain('[1, 2, 3]');
		expect(out).not.toContain('v_0');
	});

	it('runs when the VariableDeclaration has @cc-sroa', () => {
		const input = `
			/* @cc-sroa */
			const v = [1, 2, 3];
			const x = v[0] + v[1] + v[2];
		`;
		const out = run(input);
		expect(out).toContain('v_0');
		expect(out).not.toContain('[1, 2, 3]');
	});

	it('runs when the enclosing function has @cc-sroa', () => {
		const input = `
			/* @cc-sroa */
			function test() {
				const v = [1, 2, 3];
				return v[0] + v[1] + v[2];
			}
		`;
		const out = run(input);
		expect(out).toContain('v_0');
		expect(out).not.toContain('[1, 2, 3]');
	});

	it('runs on an annotated arrow function bound to const', () => {
		const input = `
			/* @cc-sroa */
			const test = () => {
				const v = [1, 2, 3];
				return v[0] + v[1] + v[2];
			};
		`;
		const out = run(input);
		expect(out).toContain('v_0');
	});

	it('does not cross into a sibling function without annotation', () => {
		const input = `
			/* @cc-sroa */
			function annotated() {
				const a = [1, 2, 3];
				return a[0] + a[1] + a[2];
			}
			function plain() {
				const b = [1, 2, 3];
				return b[0] + b[1] + b[2];
			}
		`;
		const out = run(input);
		expect(out).toContain('a_0');
		expect(out).not.toContain('b_0');
		expect(out).toContain('const b = [1, 2, 3]');
	});
});

describe('plugin-alt/transforms/sroa — decomposition', () => {
	it('decomposes a vec3 literal', () => {
		const input = `
			/* @cc-sroa */
			const v = [1, 2, 3];
			const x = v[0];
			const y = v[1];
			const z = v[2];
		`;
		const out = run(input);
		expect(out).toMatch(/let v_0 = 1/);
		expect(out).toMatch(/v_1 = 2/);
		expect(out).toMatch(/v_2 = 3/);
		expect(out).toContain('const x = v_0');
	});

	it('handles writes to components', () => {
		const input = `
			/* @cc-sroa */
			let v = [0, 0, 0];
			v[0] = 5;
			v[1] = 10;
			v[2] = 15;
		`;
		const out = run(input);
		expect(out).toContain('v_0 = 5');
		expect(out).toContain('v_1 = 10');
		expect(out).toContain('v_2 = 15');
	});

	it('handles compound assignments', () => {
		const input = `
			/* @cc-sroa */
			let v = [1, 2, 3];
			v[0] += 10;
			v[1] *= 2;
		`;
		const out = run(input);
		expect(out).toContain('v_0 += 10');
		expect(out).toContain('v_1 *= 2');
	});

	it('keeps variable expressions in the literal', () => {
		const input = `
			/* @cc-sroa */
			function test(x, y, z) {
				const v = [x, y, z];
				const sum = v[0] + v[1] + v[2];
				return sum;
			}
		`;
		const out = run(input);
		expect(out).toContain('v_0 = x');
		expect(out).toContain('v_1 = y');
		expect(out).toContain('v_2 = z');
	});
});

describe('plugin-alt/transforms/sroa — escape analysis', () => {
	it('skips when passed to a function', () => {
		const input = `
			/* @cc-sroa */
			const v = [1, 2, 3];
			someFunction(v);
			const x = v[0];
		`;
		const out = run(input);
		expect(out).toContain('[1, 2, 3]');
	});

	it('skips when aliased via assignment', () => {
		const input = `
			/* @cc-sroa */
			const v = [1, 2, 3];
			const other = v;
			console.log(other);
		`;
		const out = run(input);
		expect(out).toContain('[1, 2, 3]');
	});

	it('skips when returned', () => {
		const input = `
			/* @cc-sroa */
			function foo() {
				const v = [1, 2, 3];
				return v;
			}
		`;
		const out = run(input);
		expect(out).toContain('[1, 2, 3]');
	});

	it('skips computed-index access with non-literal', () => {
		const input = `
			/* @cc-sroa */
			const v = [1, 2, 3];
			const i = 0;
			const x = v[i];
		`;
		const out = run(input);
		expect(out).toContain('[1, 2, 3]');
	});

	it('skips member-property access (e.g. .length)', () => {
		const input = `
			/* @cc-sroa */
			const v = [1, 2, 3];
			const len = v.length;
		`;
		const out = run(input);
		expect(out).toContain('[1, 2, 3]');
	});

	it('skips spread', () => {
		const input = `
			/* @cc-sroa */
			const v = [1, 2, 3];
			const copy = [...v];
		`;
		const out = run(input);
		expect(out).toContain('[1, 2, 3]');
	});

	it('skips out-of-bounds index', () => {
		const input = `
			/* @cc-sroa */
			const v = [1, 2, 3];
			const x = v[5];
		`;
		const out = run(input);
		expect(out).toContain('[1, 2, 3]');
	});
});

describe('plugin-alt/transforms/sroa — scope awareness', () => {
	it('replaces function-local even when module-scope same name escapes', () => {
		const input = `
			const rotation = [0, 0, 0];
			externalFunction(rotation);

			/* @cc-sroa */
			function test() {
				const rotation = [1, 2, 3];
				return rotation[0] + rotation[1] + rotation[2];
			}
		`;
		const out = run(input);
		expect(out).toContain('rotation_0 = 1');
		expect(out).toContain('externalFunction(rotation)');
	});

	it('replaces one candidate even when a sibling escapes', () => {
		const input = `
			/* @cc-sroa */
			const safe = [1, 2, 3];
			/* @cc-sroa */
			const escaping = [4, 5, 6];
			const x = safe[0] + safe[1] + safe[2];
			externalFunction(escaping);
		`;
		const out = run(input);
		expect(out).toContain('safe_0');
		expect(out).not.toContain('escaping_0');
		expect(out).toContain('[4, 5, 6]');
	});
});

describe('plugin-alt/transforms/sroa — type annotation cross-check', () => {
	it('respects a tuple type alias', () => {
		const input = `
			type Vec3 = [number, number, number];
			/* @cc-sroa */
			const v: Vec3 = [1, 2, 3];
			const x = v[0] + v[1] + v[2];
		`;
		const out = run(input);
		expect(out).toContain('v_0');
	});
});
