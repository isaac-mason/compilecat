// Browser/edge wasm backend for the compilecat core — the in-browser twin of
// `compiler.ts` (the napi addon). Same `Compiler` surface, but it loads the
// wasm-bindgen build (`@compilecat/wasm`, from `rust/crates/compilecat_wasm`) and
// is **async**: `wasm-pack --target web` needs `init()` before the first call.
//
// Consumers (e.g. the website playground, or an edge runtime where the Node
// addon can't load) import this via `compilecat/wasm` instead of the Node-only
// `compilecat`.

import initWasm, { Compiler as WasmCompiler, donorEdges as wasmDonorEdges, format as wasmFormat } from '@compilecat/wasm';
import type { Compiler } from './compiler';

export type {
    CompileOptions,
    CompileResult,
    CompileStats,
    DonorModule,
    Compiler,
    ResolvedEdge,
} from './compiler';

let ready: Promise<void> | undefined;

/** Initialize the wasm module (idempotent). `createCompiler`/`format` call this
 *  internally, so you rarely need it directly — but it lets a host preload the
 *  ~MB wasm before the first compile. */
export function init(): Promise<void> {
    if (!ready) ready = initWasm().then(() => undefined);
    return ready;
}

/** Async twin of `compiler.ts`'s `createCompiler()` (wasm must `init()` first).
 *  Returns a real `compilecat_wasm.Compiler`; its module cache amortizes across
 *  calls, so keep one instance per session/build. */
export async function createCompiler(): Promise<Compiler> {
    await init();
    return new WasmCompiler() as unknown as Compiler;
}

/** Identity reprint (parse → codegen, no passes) — the wasm twin of
 *  `compiler.ts`'s `format`. */
export async function format(id: string, code: string): Promise<string> {
    await init();
    return wasmFormat(id, code);
}

/** The specifiers the donor BFS should follow from ONE module — the wasm twin of
 *  `compiler.ts`'s `donorEdges` (async: wasm must `init()` first). */
export async function donorEdges(id: string, code: string): Promise<string[]> {
    await init();
    return wasmDonorEdges(id, code);
}
