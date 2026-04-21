import { parse } from '@babel/parser';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Effects from '../src/plugin/analyses/effects';
import { createFileCache } from '../src/plugin/analyses/fileindex';
import { applyInline } from '../src/plugin/transforms/inline';
import { generate } from '../src/plugin/util/babel';

/**
 * Library inlining has to read from a real `node_modules` on disk — we mock
 * node resolution too deeply to bother with a virtual layer for this. A tmp
 * directory gives us a scoped package layout we control.
 */

let tmpRoot: string;

beforeAll(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-alt-lib-inline-'));
});

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
	const abs = path.join(tmpRoot, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
	return abs;
}

function run(consumerPath: string, consumerCode: string, allowLibrary: boolean): string {
	const ast = parse(consumerCode, { sourceType: 'module', plugins: ['typescript'] });
	applyInline(ast, consumerPath, {
		effects: Effects.init(),
		fileCache: createFileCache(),
		allowLibraryInline: allowLibrary,
	});
	return generate(ast, { retainLines: false, comments: false }).code.trim();
}

describe('plugin-alt/transforms/inline — library imports', () => {
	it('inlines a bare-specifier import when callsite annotated and library allowed', () => {
		write('project/node_modules/mylib/package.json', JSON.stringify({ main: './index.js' }));
		write(
			'project/node_modules/mylib/index.js',
			`export function triple(x) { return x * 3; }`,
		);
		const consumer = write(
			'project/src/main.ts',
			`
				import { triple } from 'mylib';
				const r = /* @cc-inline */ triple(7);
			`,
		);
		const consumerCode = fs.readFileSync(consumer, 'utf-8');
		const out = run(consumer, consumerCode, true);
		expect(out).toContain('7 * 3');
	});

	it('does NOT inline library calls without callsite annotation', () => {
		write('project2/node_modules/mylib/package.json', JSON.stringify({ main: './index.js' }));
		write(
			'project2/node_modules/mylib/index.js',
			`export function triple(x) { return x * 3; }`,
		);
		const consumer = write(
			'project2/src/main.ts',
			`
				import { triple } from 'mylib';
				const r = triple(7);
			`,
		);
		const consumerCode = fs.readFileSync(consumer, 'utf-8');
		const out = run(consumer, consumerCode, true);
		expect(out).toContain('triple(7)');
	});

	it('respects library=false even with callsite annotation', () => {
		write('project3/node_modules/mylib/package.json', JSON.stringify({ main: './index.js' }));
		write(
			'project3/node_modules/mylib/index.js',
			`export function triple(x) { return x * 3; }`,
		);
		const consumer = write(
			'project3/src/main.ts',
			`
				import { triple } from 'mylib';
				const r = /* @cc-inline */ triple(7);
			`,
		);
		const consumerCode = fs.readFileSync(consumer, 'utf-8');
		const out = run(consumer, consumerCode, false);
		expect(out).toContain('triple(7)');
	});

	it('inlines a decl-annotated function in a library automatically', () => {
		write('project4/node_modules/mylib/package.json', JSON.stringify({ main: './index.js' }));
		write(
			'project4/node_modules/mylib/index.js',
			`/* @cc-inline */ export function double(x) { return x * 2; }`,
		);
		const consumer = write(
			'project4/src/main.ts',
			`
				import { double } from 'mylib';
				const r = double(7);
			`,
		);
		const consumerCode = fs.readFileSync(consumer, 'utf-8');
		const out = run(consumer, consumerCode, true);
		expect(out).toContain('7 * 2');
	});
});
