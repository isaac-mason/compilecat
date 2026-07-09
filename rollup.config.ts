import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import filesize from 'rollup-plugin-filesize';

// The napi loader (`dist/core/index.js`) resolves the native
// `@compilecat/core-<platform>` binary at runtime. It MUST ship in the tarball —
// 0.0.7 published without it and every `createCompiler()` threw. Emitting it here,
// as part of the rollup build, means the `rm -rf ./dist` in `build:ts` can never
// separate the loader from the dist it wipes (the old standalone `build:loader`
// step could run before the wipe and vanish). The platform `.node` binaries are
// copied separately (dev-only, gitignored, excluded from the package).
const NAPI = path.resolve(import.meta.dirname, './rust/crates/compilecat_napi');
const emitNapiLoader = () => ({
	name: 'emit-napi-loader',
	writeBundle() {
		mkdirSync('dist/core', { recursive: true });
		copyFileSync(path.join(NAPI, 'index.js'), 'dist/core/index.js');
		copyFileSync(path.join(NAPI, 'index.d.ts'), 'dist/core/index.d.ts');
		writeFileSync('dist/core/package.json', `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
	},
});

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

const entries = ['vite', 'rollup', 'rolldown', 'webpack', 'esbuild', 'rspack', 'rsbuild', 'farm', 'bun', 'plugin', 'wasm'];

export default entries.map((entry, i) => ({
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
		// emit the napi loader exactly once, as part of the build
		...(i === 0 ? [emitNapiLoader()] : []),
	],
}));
