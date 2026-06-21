import type { Compiler } from './compiler';
export type { CompileOptions, CompileResult, CompileStats, DonorModule, Compiler, ResolvedEdge, } from './compiler';
/** Initialize the wasm module (idempotent). `createCompiler`/`format` call this
 *  internally, so you rarely need it directly — but it lets a host preload the
 *  ~MB wasm before the first compile. */
export declare function init(): Promise<void>;
/** Async twin of `compiler.ts`'s `createCompiler()` (wasm must `init()` first).
 *  Returns a real `compilecat_wasm.Compiler`; its module cache amortizes across
 *  calls, so keep one instance per session/build. */
export declare function createCompiler(): Promise<Compiler>;
/** Identity reprint (parse → codegen, no passes) — the wasm twin of
 *  `compiler.ts`'s `format`. */
export declare function format(id: string, code: string): Promise<string>;
