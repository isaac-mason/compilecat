import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import * as Effects from '../src/plugin/analyses/effects';
import { applyInline } from '../src/plugin/transforms/inline';
import { generate } from '../src/plugin/util/babel';

function run(code: string): string {
	const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
	applyInline(ast, '/virtual/main.ts', { effects: Effects.init() });
	return generate(ast, { retainLines: false, comments: false }).code.trim();
}

describe('plugin-alt/transforms/inline — callsite annotations (single-file)', () => {
	it('inlines a non-annotated local function when the callsite opts in', () => {
		const input = `
			function add(a, b) { return a + b; }
			const r = /* @cc-inline */ add(3, 4);
			const s = add(5, 6);
		`;
		const out = run(input);
		// annotated call inlined; unannotated left; decl preserved since some calls remain
		expect(out).toContain('3 + 4');
		expect(out).toContain('add(5, 6)');
		expect(out).toContain('function add');
	});

	it('inlines via callsite annotation on the parent ExpressionStatement', () => {
		const input = `
			function effect(v) { sink(v); }
			/* @cc-inline */ effect(42);
		`;
		const out = run(input);
		expect(out).toContain('sink(42)');
		expect(out).not.toContain('effect(42)');
	});

	it('leaves other calls of the same function intact', () => {
		const input = `
			function square(x) { return x * x; }
			const a = /* @cc-inline */ square(2);
			const b = square(3);
		`;
		const out = run(input);
		expect(out).toContain('2 * 2');
		expect(out).toContain('square(3)');
	});

	it('does nothing when the annotated callee cannot be resolved', () => {
		const input = `
			const r = /* @cc-inline */ unknownFunc(1, 2);
		`;
		const out = run(input);
		expect(out).toContain('unknownFunc(1, 2)');
	});
});
