import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { indexFile } from '../src/plugin/analyses/discover';

function idx(code: string) {
	const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
	return indexFile('/virtual/test.ts', ast);
}

describe('plugin-alt/analyses/discover', () => {
	it('finds a decl-annotated @inline function', () => {
		const index = idx(`
			/* @inline */
			export function add(a, b) { return a + b; }
		`);
		const add = index.functions.get('add');
		expect(add).toBeDefined();
		expect(add?.hasInlineAnnotation).toBe(true);
		expect(add?.isSimpleReturn).toBe(true);
		expect(add?.params.length).toBe(2);
	});

	it('detects simple-return vs imperative bodies', () => {
		const index = idx(`
			/* @inline */
			export function add(a, b) {
				const tmp = a + b;
				return tmp;
			}
		`);
		const fn = index.functions.get('add');
		expect(fn?.isSimpleReturn).toBe(false);
	});

	it('skips unannotated functions but still indexes them', () => {
		const index = idx(`
			function inner() { return 1; }
			/* @inline */
			function outer() { return inner(); }
		`);
		expect(index.functions.get('inner')?.hasInlineAnnotation).toBe(false);
		expect(index.functions.get('outer')?.hasInlineAnnotation).toBe(true);
	});

	it('records function-to-function free refs', () => {
		const index = idx(`
			function inner() { return 1; }
			/* @inline */
			function outer() { return inner(); }
		`);
		expect(index.functions.get('outer')?.functionRefs.has('inner')).toBe(true);
	});

	it('records module-var refs', () => {
		const index = idx(`
			const K = 42;
			/* @inline */
			function getK() { return K; }
		`);
		expect(index.functions.get('getK')?.moduleVarRefs.has('K')).toBe(true);
	});

	it('indexes imports by style', () => {
		const index = idx(`
			import def, { foo as bar } from './mod';
			import * as NS from './ns';
		`);
		expect(index.imports.get('def')?.style).toBe('default');
		expect(index.imports.get('bar')?.style).toBe('named');
		expect(index.imports.get('bar')?.importedName).toBe('foo');
		expect(index.imports.get('NS')?.style).toBe('namespace');
	});

	it('records namespace re-exports', () => {
		const index = idx(`
			export * as box3 from './box3';
		`);
		expect(index.namespaceReexports.get('box3')).toBe('./box3');
	});

	it('propagates @inline annotation through export declarations', () => {
		const index = idx(`
			/* @inline */
			export function add(a, b) { return a + b; }
		`);
		expect(index.functions.get('add')?.hasInlineAnnotation).toBe(true);
	});

	it('indexes module-scope vars (non-function)', () => {
		const index = idx(`
			const scratch = [0, 0, 0];
			function use() { return scratch; }
		`);
		expect(index.moduleVars.has('scratch')).toBe(true);
		expect(index.functions.get('use')?.moduleVarRefs.has('scratch')).toBe(true);
	});

	it('does not capture locals that shadow top-level names', () => {
		const index = idx(`
			const scratch = [0, 0, 0];
			/* @inline */
			function f() {
				const scratch = 1;
				return scratch;
			}
		`);
		// the inner scratch shadows the top-level one
		expect(index.functions.get('f')?.moduleVarRefs.has('scratch')).toBe(false);
	});
});
