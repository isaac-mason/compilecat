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
	'@rollup/pluginutils',
	'rollup',
	// wasm core: resolved by the consumer (the website aliases it to the
	// wasm-pack `pkg/`); never bundled into the package.
	'compilecat-wasm',
];

const entries = ['index', 'vite', 'rollup', 'rolldown', 'plugin', 'wasm'];

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
