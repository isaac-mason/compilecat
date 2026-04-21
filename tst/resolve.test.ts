import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	resolveImportSource,
	resolveLibraryImport,
	resolveRelativeImport,
} from '../src/plugin/analyses/resolve';

/**
 * Resolver tests use a tmp-dir fixture — the resolver hits real disk for
 * library resolution (package.json probing), so a tmp tree is the simplest
 * way to get realistic coverage without tying to the project's node_modules.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-alt-resolve-'));
afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
	const abs = path.join(tmpRoot, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
	return abs;
}

describe('plugin-alt/analyses/resolve', () => {
	it('resolves relative import with explicit extension', () => {
		const consumer = write('a/consumer.ts', 'export {}');
		const target = write('a/target.ts', 'export {}');
		expect(resolveRelativeImport(consumer, './target.ts')).toBe(target);
	});

	it('resolves relative import without extension', () => {
		const consumer = write('b/consumer.ts', 'export {}');
		const target = write('b/target.ts', 'export {}');
		expect(resolveRelativeImport(consumer, './target')).toBe(target);
	});

	it('resolves relative import via index file', () => {
		const consumer = write('c/consumer.ts', 'export {}');
		const target = write('c/sub/index.ts', 'export {}');
		expect(resolveRelativeImport(consumer, './sub')).toBe(target);
	});

	it('returns null for bare specifier in relative resolver', () => {
		const consumer = write('d/consumer.ts', 'export {}');
		expect(resolveRelativeImport(consumer, 'lodash')).toBeNull();
	});

	it('resolves library via main field', () => {
		const pkgDir = path.join(tmpRoot, 'e/node_modules/mypkg');
		write('e/node_modules/mypkg/package.json', JSON.stringify({ main: './dist/index.js' }));
		const target = write('e/node_modules/mypkg/dist/index.js', 'export {}');
		const consumer = write('e/src/consumer.ts', 'export {}');
		expect(resolveLibraryImport(consumer, 'mypkg')).toBe(target);
		void pkgDir;
	});

	it('resolves library via module field (preferred over main)', () => {
		write(
			'f/node_modules/mypkg/package.json',
			JSON.stringify({ main: './dist/cjs.js', module: './dist/esm.js' }),
		);
		const target = write('f/node_modules/mypkg/dist/esm.js', 'export {}');
		const consumer = write('f/src/consumer.ts', 'export {}');
		expect(resolveLibraryImport(consumer, 'mypkg')).toBe(target);
	});

	it('resolves library subpath', () => {
		write('g/node_modules/mypkg/package.json', JSON.stringify({ main: './dist/index.js' }));
		const target = write('g/node_modules/mypkg/sub/foo.js', 'export {}');
		const consumer = write('g/src/consumer.ts', 'export {}');
		expect(resolveLibraryImport(consumer, 'mypkg/sub/foo')).toBe(target);
	});

	it('honors exports field with string target', () => {
		write(
			'h/node_modules/mypkg/package.json',
			JSON.stringify({ exports: { '.': './dist/index.js' } }),
		);
		const target = write('h/node_modules/mypkg/dist/index.js', 'export {}');
		const consumer = write('h/src/consumer.ts', 'export {}');
		expect(resolveLibraryImport(consumer, 'mypkg')).toBe(target);
	});

	it('honors exports field with conditions (import preferred)', () => {
		write(
			'i/node_modules/mypkg/package.json',
			JSON.stringify({
				exports: {
					'.': {
						import: './dist/esm.js',
						require: './dist/cjs.js',
					},
				},
			}),
		);
		const target = write('i/node_modules/mypkg/dist/esm.js', 'export {}');
		const consumer = write('i/src/consumer.ts', 'export {}');
		expect(resolveLibraryImport(consumer, 'mypkg')).toBe(target);
	});

	it('resolves scoped package', () => {
		write('j/node_modules/@scope/pkg/package.json', JSON.stringify({ main: './main.js' }));
		const target = write('j/node_modules/@scope/pkg/main.js', 'export {}');
		const consumer = write('j/src/consumer.ts', 'export {}');
		expect(resolveLibraryImport(consumer, '@scope/pkg')).toBe(target);
	});

	it('walks up dir tree to find node_modules', () => {
		write('k/node_modules/mypkg/package.json', JSON.stringify({ main: './m.js' }));
		const target = write('k/node_modules/mypkg/m.js', 'export {}');
		const consumer = write('k/src/deep/nested/consumer.ts', 'export {}');
		expect(resolveLibraryImport(consumer, 'mypkg')).toBe(target);
	});

	it('resolveImportSource does NOT fall through to library when disallowed', () => {
		write('l/node_modules/mypkg/package.json', JSON.stringify({ main: './m.js' }));
		write('l/node_modules/mypkg/m.js', 'export {}');
		const consumer = write('l/src/consumer.ts', 'export {}');
		expect(resolveImportSource(consumer, 'mypkg', false)).toBeNull();
	});

	it('resolveImportSource falls through to library when allowed', () => {
		write('m/node_modules/mypkg/package.json', JSON.stringify({ main: './m.js' }));
		const target = write('m/node_modules/mypkg/m.js', 'export {}');
		const consumer = write('m/src/consumer.ts', 'export {}');
		expect(resolveImportSource(consumer, 'mypkg', true)).toBe(target);
	});
});
