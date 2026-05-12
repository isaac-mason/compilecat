import path from 'node:path';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import filesize from 'rollup-plugin-filesize';

const external = [
	'node:fs',
	'node:crypto',
	'node:path',
	'tty',
	'util',
	'os',
	'@babel/generator',
	'@babel/parser',
	'@babel/traverse',
	'@babel/types',
	'rollup',
];

const entries = ['index', 'vite', 'rollup', 'rolldown'];

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
