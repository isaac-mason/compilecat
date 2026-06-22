import initWasm, { Compiler, format as format$1 } from '@compilecat/wasm';

// Browser/edge wasm backend for the compilecat core — the in-browser twin of
// `compiler.ts` (the napi addon). Same `Compiler` surface, but it loads the
// wasm-bindgen build (`@compilecat/wasm`, from `rust/crates/compilecat_wasm`) and
// is **async**: `wasm-pack --target web` needs `init()` before the first call.
//
// Consumers (e.g. the website playground, or an edge runtime where the Node
// addon can't load) import this via `compilecat/wasm` instead of the Node-only
// `compilecat`.
let ready;
/** Initialize the wasm module (idempotent). `createCompiler`/`format` call this
 *  internally, so you rarely need it directly — but it lets a host preload the
 *  ~MB wasm before the first compile. */
function init() {
    if (!ready)
        ready = initWasm().then(() => undefined);
    return ready;
}
/** Async twin of `compiler.ts`'s `createCompiler()` (wasm must `init()` first).
 *  Returns a real `compilecat_wasm.Compiler`; its module cache amortizes across
 *  calls, so keep one instance per session/build. */
async function createCompiler() {
    await init();
    return new Compiler();
}
/** Identity reprint (parse → codegen, no passes) — the wasm twin of
 *  `compiler.ts`'s `format`. */
async function format(id, code) {
    await init();
    return format$1(id, code);
}

export { createCompiler, format, init };
//# sourceMappingURL=wasm.js.map
