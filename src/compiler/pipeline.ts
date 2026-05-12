// Single-Program orchestration. Operates on a parsed AST representing one
// program — in bundle-mode this is the entire chunk after rollup has
// resolved imports.
//
// Steps:
//   1. Parse with @babel/parser (TS/JSX-aware).
//   2. Strip TS-only syntax so downstream passes only see JS.
//   3. Run InlineFunctions across the program.
//   4. Run simplifyAll across the program.
//   5. Generate code (and optional sourcemap).

import { parse, type ParserOptions } from '@babel/parser';
import * as t from '@babel/types';

import { generate } from './babel-interop';
import { inlineFunctions } from './inline-functions';
import { inlineVariables } from './inline-variables';
import { unrollLoops } from './loop-unroller';
import { makeDeclaredNamesUnique } from './normalize';
import { removeUnusedCode } from './remove-unused-code';
import { applySroa } from './scalar-replace-aggregates';
import { simplifyAll } from './simplifier';
import { stripTypeScript } from './strip-typescript';

export type TransformOptions = {
    sourceMaps?: boolean;
    /** Filename for sourcemap purposes. */
    filename?: string;
    /** Incoming source map to chain through (e.g. from rollup's chunk). */
    inputSourceMap?: unknown;
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

    stripTypeScript(ast);

    const inl = inlineFunctions(ast);
    const unr = unrollLoops(ast);
    // Collapse `let aliasName = arg` temps emitted by FunctionArgumentInjector
    // before SROA so its escape analysis sees only direct `name[i]` uses.
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
        inputSourceMap: options.inputSourceMap,
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
