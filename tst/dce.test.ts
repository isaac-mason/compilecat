import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import * as Effects from '../src/plugin/analyses/effects';
import * as Zones from '../src/plugin/analyses/zones';
import { applyDce } from '../src/plugin/transforms/dce';
import { generate } from '../src/plugin/util/babel';

/**
 * Run DCE on `code` and return the regenerated source. Compares against
 * `expected` after normalizing whitespace so small formatting differences
 * don't cause spurious failures.
 */
function runDce(code: string): string {
	const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
	applyDce(ast, { zones: Zones.init(), effects: Effects.init() });
	return generate(ast, { retainLines: false, comments: false }).code.trim();
}

function normalize(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

describe('plugin-alt/transforms/dce', () => {
	it('eliminates a dead binding inside an @sroa zone', () => {
		const input = `
			/* @sroa */
			function f() {
				let dead = 0;
				return 42;
			}
		`;
		const expected = `
			function f() {
				return 42;
			}
		`;
		expect(normalize(runDce(input))).toBe(normalize(expected));
	});

	it('eliminates a dead binding along with its writes', () => {
		const input = `
			/* @sroa */
			function f() {
				let dead = 0;
				dead = 5;
				dead = 7;
				return 42;
			}
		`;
		const expected = `
			function f() {
				return 42;
			}
		`;
		expect(normalize(runDce(input))).toBe(normalize(expected));
	});

	it('preserves side effects when dead binding has impure writes', () => {
		const input = `
			/* @sroa */
			function f() {
				let dead = 0;
				dead = sideEffect();
				return 42;
			}
		`;
		const expected = `
			function f() {
				sideEffect();
				return 42;
			}
		`;
		expect(normalize(runDce(input))).toBe(normalize(expected));
	});

	it('preserves side effects in an impure initializer', () => {
		const input = `
			/* @sroa */
			function f() {
				let dead = sideEffect();
				return 42;
			}
		`;
		const expected = `
			function f() {
				sideEffect();
				return 42;
			}
		`;
		expect(normalize(runDce(input))).toBe(normalize(expected));
	});

	it('leaves live bindings alone', () => {
		const input = `
			/* @sroa */
			function f() {
				let x = 0;
				x = 5;
				return x;
			}
		`;
		// v1 does not yet collapse dead-init + single-write → const. It preserves
		// everything because x has a read.
		const expected = `
			function f() {
				let x = 0;
				x = 5;
				return x;
			}
		`;
		expect(normalize(runDce(input))).toBe(normalize(expected));
	});

	it('does nothing outside an opt-in zone', () => {
		const input = `
			function f() {
				let dead = 0;
				return 42;
			}
		`;
		const expected = `
			function f() {
				let dead = 0;
				return 42;
			}
		`;
		expect(normalize(runDce(input))).toBe(normalize(expected));
	});

	it('removes dead declarators alongside live ones in the same statement', () => {
		const input = `
			/* @sroa */
			function f() {
				let live = 1, dead = 0;
				return live;
			}
		`;
		const expected = `
			function f() {
				let live = 1;
				return live;
			}
		`;
		expect(normalize(runDce(input))).toBe(normalize(expected));
	});

	it('removes dead binding declared with const (zero references)', () => {
		const input = `
			/* @sroa */
			function f() {
				const dead = 42;
				return 1;
			}
		`;
		const expected = `
			function f() {
				return 1;
			}
		`;
		expect(normalize(runDce(input))).toBe(normalize(expected));
	});

	it('@inline zone also enables DCE', () => {
		const input = `
			/* @inline */
			function helper() {
				let dead = 0;
				return 1;
			}
		`;
		const expected = `
			function helper() {
				return 1;
			}
		`;
		expect(normalize(runDce(input))).toBe(normalize(expected));
	});

	it('only clears declarators inside the annotated function', () => {
		// annotation on helper should not leak DCE into unrelated other()
		const input = `
			/* @sroa */
			function helper() {
				let dead = 0;
				return 1;
			}
			function other() {
				let alsoDead = 0;
				return 2;
			}
		`;
		const expected = `
			function helper() {
				return 1;
			}
			function other() {
				let alsoDead = 0;
				return 2;
			}
		`;
		expect(normalize(runDce(input))).toBe(normalize(expected));
	});
});
