import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The in-browser compiler is the Rust/oxc core compiled to wasm
// (rust/crates/compilecat_wasm). wasm-pack's `--target web` output loads the
// `.wasm` via `new URL(..., import.meta.url)`, a pattern Vite rewrites natively
// — so no wasm plugin is needed, only an alias resolving the out-of-tree pkg.
export default defineConfig({
  base: '/compilecat/',
  plugins: [react()],
  resolve: {
    alias: {
      '@compilecat/wasm': path.resolve(
        import.meta.dirname,
        '../rust/crates/compilecat_wasm/pkg/compilecat_wasm.js',
      ),
    },
  },
  // Don't let the dep-optimizer pre-bundle @rollup/browser — that's what serves
  // its wasm without the `application/wasm` MIME (breaking instantiateStreaming).
  // Excluded, Vite serves it straight from node_modules with the right type.
  optimizeDeps: {
    exclude: ['@rollup/browser'],
  },
});
