// Single-Program orchestration.
//
// Two modes:
//   - WholeProgram (renderChunk / bundle-mode): operate on a parsed chunk
//     that already contains every reachable callee. No cross-file context.
//   - PerFile (transform-mode): operate on one source file. When passed a
//     consumerPath + fileCache the inliner follows imports into donor
//     modules, splices donor bodies, and hoists the module-vars / imports
//     the spliced body references.
//
// Steps:
//   1. Parse with @babel/parser (TS/JSX-aware).
//   2. Strip TS-only syntax so downstream passes only see JS.
//   3. Normalize (makeDeclaredNamesUnique) — Closure runs Normalize before
//      its optimization pass group; later passes depend on the structural
//      invariants it establishes.
//   4. inlineFunctions across the program (optionally cross-file).
//   5. unrollLoops.
//   6. inlineVariables (pre) — collapse alias temps so SROA sees direct
//      `name[i]` uses.
//   7. applySroa.
//   8. simplifyAll (per-function peephole + DCE fixpoint).
//   9. inlineVariables (post).
//  10. removeUnusedCode.
//  11. stripDirectiveComments.
//  12. Generate code (and optional sourcemap).

import { type ParserOptions, parse } from '@babel/parser';
import type * as t from '@babel/types';

import { generate } from './babel-interop';
import { collectOptIns } from './directives';
import type { FileCache } from './file-index';
import { inlineFunctions } from './inline-functions';
import { inlineVariables } from './inline-variables';
import { unrollLoops } from './loop-unroller';
import { makeDeclaredNamesUnique } from './normalize';
import { removeUnusedCode } from './remove-unused-code';
import type { FileReader } from './resolve';
import { applySroa } from './scalar-replace-aggregates';
import { simplifyAll, type SimplifyTimings } from './simplifier';
import { stripDirectiveComments } from './strip-directive-comments';
import { stripTypeScript } from './strip-typescript';

// Mode signals the unit of optimization. The pipeline's pass set is the same
// in both modes; the difference is whether `inlineFunctions` is given a
// cross-file context (resolver + donor cache + hoister). Pass `Mode.PerFile`
// with a `consumerPath` + `fileCache` to enable cross-file behavior.
export const Mode = {
    PerFile: 0,
    WholeProgram: 1,
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export type TransformOptions = {
    sourceMaps?: boolean;
    /** Filename for sourcemap purposes. In PerFile mode this is also the
     *  consumer path used by the cross-file resolver. */
    filename?: string;
    /** Incoming source map to chain through (e.g. from rollup's chunk). */
    inputSourceMap?: unknown;
    /** Optimization unit being processed. Defaults to WholeProgram. */
    mode?: Mode;
    /** Shared cache for parsed donor files. Required (with PerFile mode) to
     *  enable cross-file inlining. Ignored in WholeProgram mode. */
    fileCache?: FileCache;
    /** File reader; defaults to disk. */
    fileReader?: FileReader;
    /** Permit inlining from `node_modules` when the call site opts in. */
    allowLibraryInline?: boolean;
};

export type TransformResult = {
    code: string;
    // biome-ignore lint/suspicious/noExplicitAny: babel sourcemap shape
    map: any;
    /** Donor files whose bodies were spliced in. Empty unless PerFile mode
     *  with cross-file context. PerFile plugin callers use this to register
     *  watchers (`this.addWatchFile`) so consumers re-transform on donor
     *  changes. */
    donorPaths: Set<string>;
    stats: {
        inlined: number;
        unrolled: number;
        sroad: number;
        folded: number;
        removedDeadCode: number;
        flowInlined: number;
        deadAssigns: number;
        minimized: number;
        inlinedVariables: number;
        removedDeclarators: number;
        removedFunctionDecls: number;
        removedImportSpecifiers: number;
        removedImportDeclarations: number;
    };
    /** Wall-clock ms per phase. Always populated; the cost is a handful of
     *  `performance.now()` calls per transform. */
    timings: Timings;
    /** Per-sub-pass breakdown of the `simplify` phase, summed across every
     *  simplified function and fixpoint iteration. */
    simplifyTimings: SimplifyTimings;
};

export type Timings = {
    parse: number;
    stripTypeScript: number;
    normalize: number;
    inlineFunctions: number;
    unrollLoops: number;
    inlineVariablesPre: number;
    sroa: number;
    simplify: number;
    inlineVariablesPost: number;
    removeUnusedCode: number;
    stripDirectiveComments: number;
    generate: number;
    total: number;
};

export function transform(code: string, options: TransformOptions = {}): TransformResult {
    const mode: Mode = options.mode ?? Mode.WholeProgram;

    const totalStart = performance.now();

    const parseStart = performance.now();
    const ast = parse(code, parserOptions(options.filename));
    const parseEnd = performance.now();

    const stripTypeScriptStart = performance.now();
    stripTypeScript(ast);
    const stripTypeScriptEnd = performance.now();

    const normalizeStart = performance.now();
    makeDeclaredNamesUnique(ast);
    const normalizeEnd = performance.now();

    // Touched-set: every per-function pass below uses this to skip functions
    // that no producing pass (inline / unroll / sroa) modified and that the
    // author didn't opt in via `@optimize`/`@flatten`/`@sroa`/`@unroll`.
    // Grows monotonically through the pipeline.
    const touched = new WeakSet<t.Function>();
    collectOptIns(ast as t.File, touched);

    const inlineFunctionsStart = performance.now();
    const inl = inlineFunctions(
        ast,
        mode === Mode.PerFile
            ? {
                  consumerPath: options.filename,
                  fileCache: options.fileCache,
                  fileReader: options.fileReader,
                  allowLibraryInline: options.allowLibraryInline,
                  touched,
              }
            : { touched },
    );
    const inlineFunctionsEnd = performance.now();

    const unrollLoopsStart = performance.now();
    const unr = unrollLoops(ast, { touched });
    const unrollLoopsEnd = performance.now();

    const inlineVariablesPreStart = performance.now();
    const ivarPre = inlineVariables(ast, { touched });
    const inlineVariablesPreEnd = performance.now();

    const sroaStart = performance.now();
    const sroa = applySroa(ast, { touched });
    const sroaEnd = performance.now();

    const simplifyStart = performance.now();
    const simp = simplifyAll(ast, { touched });
    const simplifyEnd = performance.now();

    const inlineVariablesPostStart = performance.now();
    const ivar = inlineVariables(ast, { touched });
    ivar.inlined += ivarPre.inlined;
    const inlineVariablesPostEnd = performance.now();

    const removeUnusedCodeStart = performance.now();
    const ruc = removeUnusedCode(ast, { touched });
    const removeUnusedCodeEnd = performance.now();

    const stripDirectiveCommentsStart = performance.now();
    stripDirectiveComments(ast);
    const stripDirectiveCommentsEnd = performance.now();

    const generateStart = performance.now();
    const gen = generate as unknown as (n: t.Node, opts?: any) => { code: string; map: any };
    const out = gen(ast, {
        sourceMaps: options.sourceMaps === true,
        sourceFileName: options.filename,
        inputSourceMap: options.inputSourceMap,
    });
    const generateEnd = performance.now();

    const totalEnd = performance.now();

    return {
        code: out.code,
        map: out.map,
        donorPaths: inl.donorPaths,
        stats: {
            inlined: inl.succeeded,
            unrolled: unr.unrolled,
            sroad: sroa.sroad,
            folded: simp.folded,
            removedDeadCode: simp.removed,
            flowInlined: simp.inlined,
            deadAssigns: simp.deadAssigns,
            minimized: simp.minimized,
            inlinedVariables: ivar.inlined,
            removedDeclarators: ruc.removedDeclarators,
            removedFunctionDecls: ruc.removedFunctionDecls,
            removedImportSpecifiers: ruc.removedImportSpecifiers,
            removedImportDeclarations: ruc.removedImportDeclarations,
        },
        simplifyTimings: simp.timings,
        timings: {
            parse: parseEnd - parseStart,
            stripTypeScript: stripTypeScriptEnd - stripTypeScriptStart,
            normalize: normalizeEnd - normalizeStart,
            inlineFunctions: inlineFunctionsEnd - inlineFunctionsStart,
            unrollLoops: unrollLoopsEnd - unrollLoopsStart,
            inlineVariablesPre: inlineVariablesPreEnd - inlineVariablesPreStart,
            sroa: sroaEnd - sroaStart,
            simplify: simplifyEnd - simplifyStart,
            inlineVariablesPost: inlineVariablesPostEnd - inlineVariablesPostStart,
            removeUnusedCode: removeUnusedCodeEnd - removeUnusedCodeStart,
            stripDirectiveComments: stripDirectiveCommentsEnd - stripDirectiveCommentsStart,
            generate: generateEnd - generateStart,
            total: totalEnd - totalStart,
        },
    };
}

function parserOptions(filename?: string): ParserOptions {
    // In bundle-mode the chunk filename is `.js`, but the chunk text may
    // still contain TS (consumers who don't transpile TS before compilecat).
    // The typescript plugin is tolerant of plain JS, so enable unconditionally.
    const isJsx = filename ? /\.[jt]sx$/.test(filename) : false;
    const plugins: ParserOptions['plugins'] = ['typescript'];
    if (isJsx) plugins.push('jsx');
    return {
        sourceType: 'module',
        allowImportExportEverywhere: true,
        allowReturnOutsideFunction: false,
        plugins,
    };
}
