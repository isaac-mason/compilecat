import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import * as Effects from '../src/plugin/analyses/effects';
import { createFileCache } from '../src/plugin/analyses/fileindex';
import type { FileReader } from '../src/plugin/analyses/resolve';
import { applyInline } from '../src/plugin/transforms/inline';
import { generate } from '../src/plugin/util/babel';

function runFile(code: string, absolutePath = '/proj/main.ts'): string {
	const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
	applyInline(ast, absolutePath, { effects: Effects.init() });
	return generate(ast, { retainLines: false, comments: false }).code.trim();
}

function runProject(files: Record<string, string>, entry: string): string {
	const reader: FileReader = (abs) =>
		Object.prototype.hasOwnProperty.call(files, abs) ? files[abs] : null;
	const cache = createFileCache();
	const ast = parse(files[entry], { sourceType: 'module', plugins: ['typescript'] });
	applyInline(ast, entry, {
		effects: Effects.init(),
		fileCache: cache,
		fileReader: reader,
	});
	return generate(ast, { retainLines: false, comments: false }).code.trim();
}

describe('plugin-alt/transforms/inline — @flatten', () => {
	it('inlines unannotated local calls inside a zoned function', () => {
		const code = `
			function neg(x) { return -x; }
			function add(a, b) { return a + b; }

			/* @flatten */
			export function work(x, y) {
				return add(neg(x), y);
			}
		`;
		const out = runFile(code);
		// scope the negative assertion to the `work` body — `function neg(...)`
		// and `function add(...)` declarations stay, it's the *calls* that go.
		const workBody = out.slice(out.indexOf('function work'));
		expect(workBody).not.toMatch(/\bneg\(/);
		expect(workBody).not.toMatch(/\badd\(/);
		expect(out).toContain('-x');
	});

	it('does NOT inline local calls outside a zone', () => {
		const code = `
			function neg(x) { return -x; }

			export function work(x) {
				return neg(x);
			}
		`;
		const out = runFile(code);
		// no zone, no callsite opt-in, no decl annotation → stays a call
		expect(out).toMatch(/\bneg\(x\)/);
	});

	it('fixpoints across chained unannotated callees', () => {
		const code = `
			function a(x) { return x + 1; }
			function b(x) { return a(x) * 2; }
			function c(x) { return b(x) - 3; }

			/* @flatten */
			export function work(x) {
				return c(x);
			}
		`;
		const out = runFile(code);
		const workBody = out.slice(out.indexOf('function work'));
		expect(workBody).not.toMatch(/\b[abc]\(/);
		expect(out).toContain('x + 1');
	});

	it('is distinct from @inline (does not cause cross-file callsite opt-in elsewhere)', () => {
		// `@flatten` on `work` opts in every call *inside work*. It must
		// NOT retroactively opt in unannotated calls elsewhere in the file.
		const code = `
			function helper(x) { return x * 10; }

			/* @flatten */
			export function work(x) {
				return helper(x);
			}

			export function untouched(x) {
				return helper(x);
			}
		`;
		const out = runFile(code);
		// work() got helper inlined
		expect(out).toMatch(/return x \* 10|x \* 10/);
		// untouched() still calls helper
		expect(out).toMatch(/function untouched[\s\S]*helper\(x\)/);
	});

	it('inlines cross-file unannotated imports inside a zone', () => {
		const files = {
			'/proj/util.ts': `
				export function square(x) { return x * x; }
			`,
			'/proj/main.ts': `
				import { square } from './util';

				/* @flatten */
				export function work(x) {
					return square(x) + 1;
				}
			`,
		};
		const out = runProject(files, '/proj/main.ts');
		expect(out).not.toMatch(/\bsquare\(/);
		expect(out).toContain('x * x');
	});

	it('leaves a breadcrumb with the original callsite text', () => {
		const code = `
			function cube(out, x) { out[0] = x; out[1] = x * x; out[2] = x * x * x; }

			/* @flatten */
			export function work(buf, v) {
				cube(buf, v);
			}
		`;
		const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
		applyInline(ast, '/proj/main.ts', { effects: Effects.init() });
		const out = generate(ast, { retainLines: false }).code;
		// breadcrumb preserves the arg names as authored
		expect(out).toContain('@applied-inline cube(buf, v)');
	});
});
