import type { StringOrRegExp } from 'rollup';
export type FilterPattern = StringOrRegExp | StringOrRegExp[];
export interface Options {
    /** Module ids compilecat operates on — its **scope** (picomatch globs and/or
     *  RegExps). Required; there is no implicit default. Both the files that get
     *  transformed *and* the donor modules that may be read+inlined are limited
     *  to this scope, so `node_modules` is never trawled unless a package is
     *  explicitly listed (e.g. `['**​/src/**', '**​/node_modules/mathcat/**']`).
     *  Wired through Rollup 4's hook-filter API, so rolldown skips out-of-scope
     *  files in Rust without ever calling into JS. */
    include: FilterPattern;
    /** Ids to exclude on top of `include`. */
    exclude?: FilterPattern;
    /** Emit source maps. @default true */
    sourcemap?: boolean;
    /** Print a per-build timing/counter breakdown at `closeBundle` (how many
     *  files were seen vs optimized, and where wall time went: donor resolve, fs
     *  read, native compile). @default false */
    debug?: boolean;
}
type Ctx = any;
export declare function compilecat(options: Options): {
    name: string;
    watchChange(this: Ctx, changedId: string): void;
    closeBundle(): void;
    transform: {
        filter: {
            id: {
                include: StringOrRegExp[];
                exclude?: StringOrRegExp[];
            };
        };
        handler: (this: Ctx, code: string, id: string) => Promise<{
            code: string;
            map: any;
        } | null>;
    };
};
export default compilecat;
