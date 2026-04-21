import * as t from '@babel/types';
import * as Effects from '../analyses/effects';
import * as Zones from '../analyses/zones';
import { type FileCache } from '../analyses/fileindex';
import { type FileReader } from '../analyses/resolve';
/**
 * Alt-native inliner.
 *
 * Layers (bottom → top):
 *   1. Single-file decl-annotated `@cc-inline` — bodies pre-inlined bottom-up
 *      within the file, then substituted at four canonical callsite forms.
 *      Non-simple args hoisted once to `_arg_<param>_<suffix>` temps.
 *   2. Callsite-annotated calls (`/* @cc-inline *​/ foo()`) — opt-in inlining of
 *      a non-decl-annotated callee; applies to local functions and imports.
 *   3. Cross-file imports — relative imports resolve through FileCache +
 *      FileReader; imported function bodies are cloned and substituted just
 *      like local ones. Donor-file module vars and imports are hoisted into
 *      the consumer as needed.
 *   4. Library inlining — bare specifiers (`lodash`, `@scope/pkg`) walk up
 *      `node_modules`, honoring package.json exports / main / module. Only
 *      permitted with a callsite `@cc-inline` annotation, to keep library reach
 *      explicit at the call site.
 */
export type Options = {
    effects: Effects.State;
    /**
     * Zone cache shared with the simplifier. When omitted, a fresh state is
     * created — sharing is only a performance win, not a correctness need.
     */
    zones?: Zones.State;
    /** Cross-file file cache. When omitted, cross-file inlining is off. */
    fileCache?: FileCache;
    /** File reader for cross-file inlining. Defaults to `defaultFileReader`. */
    fileReader?: FileReader;
    /** Permit `node_modules` inlining via callsite `@cc-inline`. Default false. */
    allowLibraryInline?: boolean;
};
export declare function applyInline(ast: t.File, absolutePath: string, options: Options): boolean;
