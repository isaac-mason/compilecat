import path from 'node:path';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import filesize from 'rollup-plugin-filesize';

const external = [
	'node:fs',
	'node:crypto',
	'node:path',
	'node:module',
	'tty',
	'util',
	'os',
	'rollup',
	'unplugin',
	// wasm core: the published `@compilecat/wasm` binary package (an optional dep
	// of `compilecat`); never bundled into the wrapper. In-repo dev resolves it
	// via the website's vite alias to the local wasm-pack `pkg/`.
	'@compilecat/wasm',
];

const entries = ['index', 'vite', 'rollup', 'rolldown', 'webpack', 'esbuild', 'rspack', 'rsbuild', 'farm', 'bun', 'plugin', 'wasm'];

export default entries.map((entry) => ({
	input: `./src/${entry}.ts`,
	external,
	output: [
		{
			file: `dist/${entry}.js`,
			format: 'es' as const,
			sourcemap: true,
			exports: 'named' as const,
		},
	],
	plugins: [
		nodeResolve(),
		typescript({
			tsconfig: path.resolve(import.meta.dirname, './tsconfig.json'),
			declaration: true,
			declarationDir: 'dist',
			outDir: 'dist',
			rootDir: 'src',
		}),
		filesize(),
	],
}));
