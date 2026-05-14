import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/compilecat/',
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.BABEL_TYPES_8_BREAKING': 'false',
    'process.env.BABEL_8_BREAKING': 'false',
    'process.env': '{}',
  },
  optimizeDeps: {
    include: [
      '@babel/parser',
      '@babel/traverse',
      '@babel/types',
      '@babel/generator',
    ],
  },
});
