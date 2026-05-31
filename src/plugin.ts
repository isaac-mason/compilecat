// Two plugin shapes:
//
//   - compilecat()         — bundle-mode. Operates on whole chunks via
//                            `renderChunk`, after rollup/rolldown has
//                            tree-shaken and concatenated modules. By the
//                            time we run, the chunk is a single Program —
//                            every `@inline` function in scope is directly
//                            reachable, no cross-file resolution needed.
//   - compilecatPerFile()  — transform-mode. Operates per source file via
//                            `transform`, with a cross-file resolver +
//                            donor-body hoister that brings in module-vars,
//                            enums, and imports the spliced bodies need.
//                            Required for Vite dev (no bundle phase).
//
// Compatible with rollup, vite, and rolldown (vite/rolldown share rollup's
// plugin shape). esbuild + webpack are not supported.

import type { Plugin, StringOrRegExp } from 'rollup';

import { ANY_DIRECTIVE_IN_SOURCE } from './compiler/directives';
import { createFileCache } from './compiler/file-index';
import { Mode, type Timings, transform } from './compiler/pipeline';
import type { SimplifyTimings } from './compiler/simplifier';

export type FilterPattern = StringOrRegExp | StringOrRegExp[];

export type Options = {
    /**
     * Enable debug logging.
     * @default false
     */
    debug?: boolean;
};

export type PerFileOptions = Options & {
    /**
     * Permit inlining from `node_modules` when the call site opts in via
     * `/* @inline *​/`. Off by default — library reach must be explicit.
     * @default false
     */
    allowLibraryInline?: boolean;
    /**
     * Restrict transforms to module ids matching these patterns (picomatch
     * glob strings and/or RegExps). Required — there is no project-wide
     * default. Wired through Rollup 4's hook-filter API, so rolldown skips
     * non-matching files in Rust without ever calling into JS.
     */
    include: FilterPattern;
    /**
     * Additional ids to skip on top of `include`.
     */
    exclude?: FilterPattern;
};

// Source files we accept. Anything else (.css, .json, virtual ids, etc.) is
// passed through untouched.
const TRANSFORMABLE = /\.(?:js|ts|jsx|tsx|mjs|cjs)$/;

function toArray<T>(v: T | T[] | undefined): T[] {
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
}

type PhaseKey = keyof Timings;
const PHASE_ORDER: PhaseKey[] = [
    'parse',
    'stripTypeScript',
    'normalize',
    'inlineFunctions',
    'unrollLoops',
    'inlineVariablesPre',
    'sroa',
    'simplify',
    'inlineVariablesPost',
    'removeUnusedCode',
    'stripDirectiveComments',
    'generate',
    'total',
];

const SIMPLIFY_SUBPASS_ORDER: (keyof SimplifyTimings)[] = [
    'renameForFlatten',
    'foldConstants',
    'minimizeExitPoints',
    'minimizeConditions',
    'removeDeadCode',
    'cfgBuild',
    'localVarTable',
    'flowInline',
    'liveVars',
    'deadAssigns',
];

function emptySimplifyTimings(): SimplifyTimings {
    return {
        renameForFlatten: 0,
        foldConstants: 0,
        minimizeExitPoints: 0,
        minimizeConditions: 0,
        removeDeadCode: 0,
        cfgBuild: 0,
        localVarTable: 0,
        flowInline: 0,
        liveVars: 0,
        deadAssigns: 0,
    };
}

function createAggregator() {
    const totals: Record<string, number> = {};
    const simplifyTotals = emptySimplifyTimings();
    let calls = 0;
    let totalBytesIn = 0;
    return {
        add(t: Timings, s: SimplifyTimings, byteLen: number) {
            calls++;
            totalBytesIn += byteLen;
            for (const k of PHASE_ORDER) totals[k] = (totals[k] ?? 0) + t[k];
            for (const k of SIMPLIFY_SUBPASS_ORDER) simplifyTotals[k] += s[k];
        },
        report(label: string) {
            if (calls === 0) return;
            const total = totals.total ?? 0;
            const rows = PHASE_ORDER.filter((k) => k !== 'total').map((k) => {
                const ms = totals[k] ?? 0;
                const pct = total > 0 ? (ms / total) * 100 : 0;
                return `  ${k.padEnd(24)} ${ms.toFixed(1).padStart(9)}ms  ${pct.toFixed(1).padStart(5)}%`;
            });
            const simplifyTotal = totals.simplify ?? 0;
            const simplifyRows = SIMPLIFY_SUBPASS_ORDER.map((k) => {
                const ms = simplifyTotals[k];
                const pct = simplifyTotal > 0 ? (ms / simplifyTotal) * 100 : 0;
                return `    ${k.padEnd(22)} ${ms.toFixed(1).padStart(9)}ms  ${pct.toFixed(1).padStart(5)}%`;
            });
            console.log(
                `[compilecat] ${label} aggregate over ${calls} call(s), ${(totalBytesIn / 1024).toFixed(1)} KiB in:\n` +
                    `${rows.join('\n')}\n  ${'TOTAL'.padEnd(24)} ${total.toFixed(1).padStart(9)}ms\n` +
                    `  simplify breakdown (of ${simplifyTotal.toFixed(1)}ms):\n${simplifyRows.join('\n')}`,
            );
        },
    };
}

function formatTimings(t: Timings): string {
    const parts = PHASE_ORDER.filter((k) => k !== 'total' && t[k] >= 0.5).map(
        (k) => `${k}=${t[k].toFixed(1)}ms`,
    );
    return `total=${t.total.toFixed(1)}ms [${parts.join(' ')}]`;
}

export function compilecat(options: Options = {}): Plugin {
    const debug = options.debug === true;
    const agg = debug ? createAggregator() : null;
    return {
        name: 'compilecat',
        renderChunk(code, chunk) {
            if (!ANY_DIRECTIVE_IN_SOURCE.test(code)) return null;

            const id = chunk.fileName;
            if (debug) console.log(`[compilecat] transforming chunk ${id}`);

            try {
                const r = transform(code, {
                    sourceMaps: true,
                    filename: id,
                    mode: Mode.WholeProgram,
                });
                if (debug) {
                    agg?.add(r.timings, r.simplifyTimings, code.length);
                    console.log(
                        `[compilecat] ${id}: inlined=${r.stats.inlined} folded=${r.stats.folded} dead=${r.stats.removedDeadCode}\n[compilecat] ${id}: ${formatTimings(r.timings)}`,
                    );
                }
                return { code: r.code, map: r.map };
            } catch (err) {
                console.error(`[compilecat] failed to transform chunk ${id}:`, err);
                return null;
            }
        },
        closeBundle() {
            agg?.report('bundle-mode');
        },
    };
}

export function compilecatPerFile(options: PerFileOptions): Plugin {
    const debug = options.debug === true;
    const agg = debug ? createAggregator() : null;
    // One FileCache per plugin instance amortizes parse + index across every
    // transform call in the build. Donors only get parsed/indexed once.
    const fileCache = createFileCache();

    // Hook-filter declaration. Rollup 4 / rolldown invoke the handler only
    // for ids matching this filter — in rolldown's case, the test happens in
    // Rust without bouncing into JS at all. Big win because the typical
    // project has far more directive-less files than annotated ones.
    //
    //   id.include — caller-supplied allowlist (required; no implicit default)
    //   id.exclude — additional skips on top of include
    //   code       — fast-path skip for files without any compilecat directive
    const idFilter: { include: StringOrRegExp[]; exclude?: StringOrRegExp[] } = {
        include: toArray(options.include),
    };
    const userExclude = toArray(options.exclude);
    if (userExclude.length > 0) idFilter.exclude = userExclude;

    return {
        name: 'compilecat:per-file',
        transform: {
            filter: {
                id: idFilter,
                code: ANY_DIRECTIVE_IN_SOURCE,
            },
            handler(code, id) {
                // Belt-and-braces extension check — the hook filter handles
                // include/exclude and the directive content sniff, but the
                // pipeline still expects a JS/TS source.
                if (!TRANSFORMABLE.test(id)) return null;

                if (debug) console.log(`[compilecat] transforming ${id}`);

                try {
                    const r = transform(code, {
                        sourceMaps: true,
                        filename: id,
                        mode: Mode.PerFile,
                        fileCache,
                        allowLibraryInline: options.allowLibraryInline === true,
                    });

                    // Register each donor so rollup/vite re-runs this transform
                    // when a donor changes. Without this, `removeUnusedCode`
                    // strips the donor's import from our output and the module
                    // graph loses the consumer→donor edge — HMR goes stale.
                    for (const donor of r.donorPaths) this.addWatchFile(donor);

                    if (debug) {
                        agg?.add(r.timings, r.simplifyTimings, code.length);
                        console.log(
                            `[compilecat] ${id}: inlined=${r.stats.inlined} folded=${r.stats.folded} dead=${r.stats.removedDeadCode} donors=${r.donorPaths.size}\n[compilecat] ${id}: ${formatTimings(r.timings)}`,
                        );
                    }
                    return { code: r.code, map: r.map };
                } catch (err) {
                    console.error(`[compilecat] failed to transform ${id}:`, err);
                    return null;
                }
            },
        },
        closeBundle() {
            agg?.report('per-file');
        },
    };
}

export default compilecat;
