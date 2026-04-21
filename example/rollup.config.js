import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import compilecat from '../dist/rollup.js';

export default {
  input: 'src/index.ts',
  output: {
    file: 'dist/index.js',
    format: 'esm',
    sourcemap: true
  },
  plugins: [
    compilecat({
      debug: true,
    }),
    nodeResolve(),
    typescript({
      emitDeclarationOnly: true,
    }),
  ]
};
