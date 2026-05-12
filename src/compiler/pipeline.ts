// Per-file orchestration. Mirrors src/plugin/transform.ts but driven by the
// gcc-tree analyses + transforms.
//
// Steps:
//   1. ANY_DIRECTIVE_IN_SOURCE pre-check (caller's responsibility usually).
//   2. Parse with @babel/parser.
//   3. Run InlineFunctions across the file.
//   4. Run simplifyAll across the file.
//   5. Generate code (and optional sourcemap).

import { parse, type ParserOptions } from '@babel/parser';
import * as t from '@babel/types';

import { generate } from './babel-interop';
import type { FileCache } from './file-index';
import { inlineFunctions } from './inline-functions';
import { inlineVariables } from './inline-variables';
import { unrollLoops } from './loop-unroller';
import { makeDeclaredNamesUnique } from './normalize';
import { removeUnusedCode } from './remove-unused-code';
import type { FileReader } from './resolve';
import { applySroa } from './scalar-replace-aggregates';
import { simplifyAll } from './simplifier';

export type TransformOptions = {
    sourceMaps?: boolean;
    /** Filename for sourcemap purposes. */
    filename?: string;
    /** Shared cache for cross-file inlining. When omitted, cross-file is off. */
    fileCache?: FileCache;
    /** Custom file reader (defaults to disk). */
    fileReader?: FileReader;
    /** Permit `node_modules` inlining when the call site opts in. */
    allowLibraryInline?: boolean;
};

export type TransformResult = {
    code: string;
    // biome-ignore lint/suspicious/noExplicitAny: babel sourcemap shape
    map: any;
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
};

export function transform(code: string, options: TransformOptions = {}): TransformResult {
    const ast = parse(code, parserOptions(options.filename));

    const inl = inlineFunctions(ast, {
        consumerPath: options.filename,
        fileCache: options.fileCache,
        fileReader: options.fileReader,
        allowLibraryInline: options.allowLibraryInline,
    });
    const unr = unrollLoops(ast);
    // Collapse `let aliasName = arg` temps emitted by FunctionArgumentInjector
    // before SROA so its escape analysis sees only direct `name[i]` uses.
    // Without this, a cascade-induced alias of an SROA candidate poisons the
    // candidate's escape check (`init` of a VariableDeclarator is rejected).
    const ivarPre = inlineVariables(ast);
    const sroa = applySroa(ast);
    // Normalize before the simplifier fixpoint. Closure runs Normalize before
    // its optimization pass group; passes downstream (block flatten, let→var
    // lowering) check `isASTNormalized()` to relax safety conditions.
    makeDeclaredNamesUnique(ast);
    const simp = simplifyAll(ast);
    const ivar = inlineVariables(ast);
    ivar.inlined += ivarPre.inlined;
    const ruc = removeUnusedCode(ast);

    const gen = generate as unknown as (n: t.Node, opts?: any) => { code: string; map: any };
    const out = gen(ast, {
        sourceMaps: options.sourceMaps === true,
        sourceFileName: options.filename,
    });

    return {
        code: out.code,
        map: out.map,
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
    };
}

function parserOptions(filename?: string): ParserOptions {
    const isTs = filename ? /\.tsx?$/.test(filename) : false;
    const isJsx = filename ? /\.[jt]sx$/.test(filename) : false;
    const plugins: ParserOptions['plugins'] = [];
    if (isTs) plugins.push('typescript');
    if (isJsx) plugins.push('jsx');
    return {
        sourceType: 'module',
        allowImportExportEverywhere: true,
        allowReturnOutsideFunction: false,
        plugins,
    };
}
