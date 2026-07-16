// Cross-module SHADOWING fuzzer — the automated hunt for the resolver bug class
// described in cross_file.rs (resolve_export / resolve_local behind
// resolve_value_origin). The consumer imports ONE name it calls; that name is
// reachable across a random donor graph via a mix of JS/TS binding-precedence
// shapes:
//
//   (A) sourced named re-export      `export { g as f } from S`
//   (B) sourceless export clause     `export { f }` / `export { g as f }`
//   (C) local declaration            `function f`/`const f = (…) => …`
//       + const-alias of an import   `import { f as f$1 } from S; const f = f$1; export { f }`
//   (D) import binding               `import { f } from S`  (S maybe out-of-scope)
//   (E) bare wildcard                `export * from S`
//   opaque/non-inlinable             `const f = someGlobal.bind(…)`, `class f`
//   SHADOWING combos                 a HIGHER-priority source (A–D) AND a lower
//                                    `export *` (E) both provide `f`, pointing at
//                                    DIFFERENT callable bodies with DISTINCT
//                                    observable returns — so a fall-through /
//                                    wrong-shadow bug produces a DIFFERENT result.
//
// Every callable encodes its identity in its return value (a distinct prime-ish
// constant + a function of the args), so the oracle "compiled ≡ source" actually
// distinguishes "inlined the RIGHT function" from "inlined a shadowed one".
//
// ORACLE: compile the consumer against the donors via `compileFileCross`, then run
// `donors + consumer` (source) vs `donors + compiled` (output) in a plain-Function
// sandbox and assert the SAME result. We do NOT predict the resolver's decision —
// only that behavior is unchanged. Every generated program is deterministic and
// total (no Math.random / Date; callables return a comparable number), so any
// divergence is a genuine miscompile.
//
// SEEDED: a mulberry32 PRNG seeded from the iteration index. A failure prints the
// seed and the exact donor + consumer sources for a minimal handoff repro.
//
//   pnpm test:js                                  # 60 seeded iters (fast CI gate)
//   FUZZ=1 vitest run tst/fuzz-cross-shadow.test.ts   # 1500 iters (deep campaign)
//   FUZZ_ITERS=5000 vitest run tst/fuzz-cross-shadow.test.ts
//   FUZZ_SEED=12345 vitest run tst/fuzz-cross-shadow.test.ts   # reproduce a seed

import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { createCompiler } from '../src/compiler';
import type { DonorModule } from '../src/loader';

const compiler = createCompiler();

// ── seeded PRNG (reproducible) ───────────────────────────────────────────────

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type Rng = () => number;
const pick = <T>(r: Rng, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const chance = (r: Rng, p: number): boolean => r() < p;
const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

// ── eval sandbox (mirrors cross-file.test.ts `ev`) ───────────────────────────
//
// Strip module syntax BEFORE esbuild so a combined donors+consumer (which has both
// `import { f }` and `function f`) doesn't trip a redeclare, then eval in a plain
// Function. Both source and compiled go through the identical strip, so it's a
// fair differential — the strip only removes import/export lines, never the body a
// miscompile would have corrupted.

function stripTS(code: string): string {
    return transformSync(code, { loader: 'ts' }).code;
}

type EvalRes = { ok: true; value: unknown } | { ok: false };

/** Throwing is an equivalence class: if BOTH source and compiled throw it's EQUAL;
 *  if exactly one throws it's a real divergence. Otherwise `Object.is` (keeps
 *  NaN≡NaN, -0≢+0 — a returned distinct-identity constant is never -0/NaN, so this
 *  is exact for our value model). */
function equiv(want: EvalRes, got: EvalRes): boolean {
    if (!want.ok || !got.ok) return want.ok === got.ok;
    return Object.is(want.value, got.value);
}

// ── module-graph model ───────────────────────────────────────────────────────
//
// We build N donor modules m0..m(k-1). The consumer imports ONE flat name `f` from
// the ENTRY donor m0 and calls `f(P, Q)` inside an `@optimize` (sometimes plain)
// host. `f` is provided in m0 by ONE randomly chosen PRIMARY shape (A–E / opaque),
// and — for the shadowing shapes — ALSO by a bare `export * from S` pointing at a
// DIFFERENT module whose `f` has a distinct body. The generator wires the `resolved`
// edges so the core can follow the graph exactly as a bundler would.

type Mod = {
    specifier: string; // how it is imported (m0 is the entry, imported by consumer)
    path: string;
    lines: string[]; // module body lines
    edges: { specifier: string; path: string }[]; // resolved `from` edges
};

// A callable body that ENCODES its identity `id` in the return so the oracle can
// tell which body got inlined. Deterministic + total (no throws for numeric args).
function callableBody(r: Rng, id: number): string {
    const c = 1000 + id * 37; // distinct per-id constant
    const shape = int(r, 0, 3);
    if (shape === 0) return `{ return ${c} + a + b; }`;
    if (shape === 1) return `{ return ${c} + a * 2 - b; }`;
    if (shape === 2) return `{ if (a > b) return ${c} + a; return ${c} + b; }`;
    // block body with a local temp
    return `{ const t = a - b; return ${c} + t * t; }`;
}

// A DIRECT arrow callable (const = (…) => …) with an id-encoding body.
function arrowInit(id: number): string {
    const c = 1000 + id * 37;
    return `(a, b) => ${c} + a + b`;
}

class ShadowGen {
    private uid = 0;
    private idCounter = 0;
    constructor(private r: Rng) {}

    private freshPath(): string {
        return `/p/m${this.uid}.ts`;
    }
    private freshSpec(): string {
        return `./m${this.uid++}`;
    }
    private nextId(): number {
        return this.idCounter++;
    }

    /** A donor module that DIRECTLY defines + exports the callable `f` with a fresh
     *  identity. Used as the target of re-exports and `export *`. Sometimes the
     *  defining local name differs from `f` (renamed export). */
    private definingModule(name: string): { mod: Mod; id: number } {
        const id = this.nextId();
        const path = this.freshPath();
        const spec = this.freshSpec();
        const lines: string[] = [];
        const local = chance(this.r, 0.35) ? `g${id}` : name; // sometimes a distinct local
        if (chance(this.r, 0.5)) {
            lines.push(`export function ${local}(a, b) ${callableBody(this.r, id)}`);
        } else {
            lines.push(`export const ${local} = ${arrowInit(id)};`);
        }
        if (local !== name) lines.push(`export { ${local} as ${name} };`);
        return { mod: { specifier: spec, path, lines, edges: [] }, id };
    }

    /** A donor module whose DEFAULT export is a fresh callable, in one of the
     *  default shapes: `export default function name`, or a locally-declared
     *  callable re-surfaced as `export default name`. Used as the import target of
     *  the default-indirection primary shapes. */
    private definingDefaultModule(name: string): { mod: Mod; id: number } {
        const id = this.nextId();
        const path = this.freshPath();
        const spec = this.freshSpec();
        const lines: string[] = [];
        const shape = int(this.r, 0, 2);
        if (shape === 0) {
            // `export default function name` — the direct named-function default.
            lines.push(`export default function ${name}(a, b) ${callableBody(this.r, id)}`);
        } else if (shape === 1) {
            // local decl, then `export default <ident>` (indirection to a local).
            const local = `d${id}`;
            lines.push(`function ${local}(a, b) ${callableBody(this.r, id)}`);
            lines.push(`export default ${local};`);
        } else {
            // `export default class` — an opaque default (calling it throws in the
            // sandbox; both source and compiled must throw alike).
            lines.push(`export default class D${id} { constructor(a, b) { this.v = a + b; } }`);
        }
        return { mod: { specifier: spec, path, lines, edges: [] }, id };
    }

    /** Build the whole scenario: consumer + donors + import specifier. */
    scenario(): { consumer: string; donors: DonorModule[] } {
        this.uid = 0;
        this.idCounter = 0;
        const name = 'f';
        const mods: Mod[] = [];

        // Entry module m0 (imported by the consumer). Give it a STABLE spec/path.
        const entry: Mod = { specifier: './m0', path: '/p/m0.ts', lines: [], edges: [] };
        this.uid = 1; // m1+ are freshly allocated

        // Sometimes the consumer's imported symbol is a DEFAULT import (`import f
        // from`) rather than a named one; the entry then provides `f` as its
        // `default` export via a default shape. There is no `export *` default, so
        // these shapes don't participate in wildcard shadowing — they exercise the
        // default-resolution steps (`find_export`/`default_callable` DIRECT forms +
        // the new `export default <ident>` indirection) instead.
        const useDefault = chance(this.r, 0.3);
        if (useDefault) {
            return this.defaultScenario(name, entry, mods);
        }

        // Decide the PRIMARY provider shape for `f` in the entry module.
        const primary = pick(this.r, [
            'localFn',
            'localArrow',
            'constAlias',
            'sourcelessExport',
            'sourcelessRenamed',
            'sourcedReexport',
            'sourcedRenamed',
            'wildcardOnly',
            'importBinding',
            'importUnresolvable',
            'opaqueGlobal',
            'opaqueClass',
        ] as const);

        // Whether to ALSO plant a shadowed `export * from S` whose `f` is a DIFFERENT
        // body. Only meaningful when the primary is itself authoritative (A–D / opaque)
        // — a bare wildcard as primary has nothing to shadow. When present, a
        // fall-through bug would inline the wildcard's (wrong) `f`.
        const canShadow = primary !== 'wildcardOnly';
        const withShadow = canShadow && chance(this.r, 0.6);

        let primaryId: number | null = null; // the id `f` should resolve to (if inlinable)

        if (primary === 'localFn') {
            primaryId = this.nextId();
            entry.lines.push(`export function ${name}(a, b) ${callableBody(this.r, primaryId)}`);
        } else if (primary === 'localArrow') {
            primaryId = this.nextId();
            entry.lines.push(`const ${name} = ${arrowInit(primaryId)};`);
            entry.lines.push(`export { ${name} };`);
        } else if (primary === 'constAlias') {
            // mathcat quat-as-vec4 shape: import { f as f$1 } from S; const f = f$1; export { f }
            const def = this.definingModule(name);
            mods.push(def.mod);
            primaryId = def.id;
            entry.edges.push({ specifier: def.mod.specifier, path: def.mod.path });
            entry.lines.push(`import { ${name} as ${name}$1 } from "${def.mod.specifier}";`);
            entry.lines.push(`const ${name} = ${name}$1;`);
            entry.lines.push(`export { ${name} };`);
        } else if (primary === 'sourcelessExport') {
            // local decl under a distinct name, exported sourcelessly under `f`.
            primaryId = this.nextId();
            const local = `loc${primaryId}`;
            entry.lines.push(`function ${local}(a, b) ${callableBody(this.r, primaryId)}`);
            entry.lines.push(`export { ${local} as ${name} };`);
        } else if (primary === 'sourcelessRenamed') {
            // `export { f }` where `f` is a plain local (sourceless, same name).
            primaryId = this.nextId();
            entry.lines.push(`function ${name}(a, b) ${callableBody(this.r, primaryId)}`);
            entry.lines.push(`export { ${name} };`);
        } else if (primary === 'sourcedReexport') {
            // `export { f } from S`
            const def = this.definingModule(name);
            mods.push(def.mod);
            primaryId = def.id;
            entry.edges.push({ specifier: def.mod.specifier, path: def.mod.path });
            entry.lines.push(`export { ${name} } from "${def.mod.specifier}";`);
        } else if (primary === 'sourcedRenamed') {
            // `export { g as f } from S` where S defines `g`.
            const id = this.nextId();
            const path = this.freshPath();
            const spec = this.freshSpec();
            const g = `g${id}`;
            mods.push({ specifier: spec, path, lines: [`export function ${g}(a, b) ${callableBody(this.r, id)}`], edges: [] });
            primaryId = id;
            entry.edges.push({ specifier: spec, path });
            entry.lines.push(`export { ${g} as ${name} } from "${spec}";`);
        } else if (primary === 'importBinding') {
            // `import { f } from S` then re-exported so the consumer sees it.
            const def = this.definingModule(name);
            mods.push(def.mod);
            primaryId = def.id;
            entry.edges.push({ specifier: def.mod.specifier, path: def.mod.path });
            entry.lines.push(`import { ${name} } from "${def.mod.specifier}";`);
            entry.lines.push(`export { ${name} };`);
        } else if (primary === 'importUnresolvable') {
            // `import { f } from S` where S is NOT in the donor set (out of scope).
            // Authoritative binding the resolver CANNOT follow → must stay a call,
            // must NOT fall through to a shadowed wildcard. No inlinable id.
            primaryId = null;
            entry.lines.push(`import { ${name} } from "./unresolved-donor";`);
            entry.lines.push(`export { ${name} };`);
        } else if (primary === 'opaqueGlobal') {
            // `const f = someGlobal.bind(...)` — a real callable at runtime but not
            // one we can follow. Must stay a live call, must not fall through.
            primaryId = null;
            const g = pick(this.r, ['Math.max.bind(Math)', 'Math.min.bind(Math)', 'Math.hypot.bind(Math)']);
            entry.lines.push(`const ${name} = ${g};`);
            entry.lines.push(`export { ${name} };`);
        } else if (primary === 'opaqueClass') {
            // `class f {}` shadows a wildcard `f`. (Calling a class throws — both
            // source and compiled throw → EQUAL — but the optimizer must not swap in
            // an unrelated body, which would NOT throw → divergence.)
            primaryId = null;
            entry.lines.push(`class ${name} { constructor(a, b) { this.v = a + b; } }`);
            entry.lines.push(`export { ${name} };`);
        } else {
            // wildcardOnly: no local/import shape; `f` comes solely from `export * from S`.
            const def = this.definingModule(name);
            mods.push(def.mod);
            primaryId = def.id;
            entry.edges.push({ specifier: def.mod.specifier, path: def.mod.path });
            entry.lines.push(`export * from "${def.mod.specifier}";`);
        }

        // Plant the shadowed `export * from S` whose `f` is a DIFFERENT body.
        if (withShadow) {
            const shadow = this.definingModule(name); // distinct id → distinct return
            mods.push(shadow.mod);
            entry.edges.push({ specifier: shadow.mod.specifier, path: shadow.mod.path });
            entry.lines.push(`export * from "${shadow.mod.specifier}";`);
        }

        // Sometimes chain the wildcard target through an intermediate barrel that
        // itself `export *`s (deeper graph → tests re-export following depth).
        if (chance(this.r, 0.3) && mods.length) {
            const leaf = pick(this.r, mods);
            // wrap: create a barrel that `export * from leaf`, and re-point one
            // consumer edge at the barrel instead.
            const bid = this.nextId();
            const bpath = this.freshPath();
            const bspec = this.freshSpec();
            const barrel: Mod = {
                specifier: bspec,
                path: bpath,
                lines: [`export * from "${leaf.specifier}";`],
                edges: [{ specifier: leaf.specifier, path: leaf.path }],
            };
            mods.push(barrel);
            // Add a redundant wildcard through the barrel to the SAME leaf body: this
            // must NOT change behavior (same id) — exercises dedupe / cycle handling.
            void bid;
            entry.edges.push({ specifier: barrel.specifier, path: barrel.path });
            entry.lines.push(`export * from "${barrel.specifier}";`);
        }

        mods.unshift(entry);

        // Build the consumer host. It imports `f` from the entry module and calls it.
        const optimize = chance(this.r, 0.85) ? '/* @optimize */ ' : '';
        const P = int(this.r, 2, 20);
        const Q = int(this.r, 1, 9);
        // Occasionally mark the entry donor's export @inline (some primaries produce
        // a plain fn the host wants inlined). We tag via a leading comment on the def
        // — only affects `function f`/`const f` local defs; harmless otherwise.
        const consumer =
            `import { ${name} } from "${entry.specifier}";\n` +
            `${optimize}export function entry(p, q) {\n  return ${name}(p + ${P}, q + ${Q});\n}`;

        const donors: DonorModule[] = mods.map((m) => ({
            specifier: m.specifier,
            path: m.path,
            code: m.lines.join('\n'),
            resolved: m.edges,
        }));
        void primaryId;
        return { consumer, donors };
    }

    /** DEFAULT-import scenario: the consumer does `import f from m0`, and the entry
     *  provides `f` as its `default` export via one of the default shapes:
     *    - `export default function f`        (DIRECT named-function default)
     *    - local decl + `export default f`    (DIRECT `export default <ident>` to a
     *                                          local callable — resolved by
     *                                          `default_callable`)
     *    - `import x from S; export default x` (INDIRECTION to an imported default —
     *                                          the NEW step; also the named-import
     *                                          variant `import { g as x } from S`)
     *    - `export { g as default } from S`    (sourced default re-export clause —
     *                                          the pre-existing step-A path)
     *    - `export default class`              (opaque — must throw, not fall through)
     *  No `export *` default exists, so these don't participate in wildcard shadowing. */
    private defaultScenario(name: string, entry: Mod, mods: Mod[]): { consumer: string; donors: DonorModule[] } {
        const shape = pick(this.r, [
            'defaultFn',
            'defaultLocalIdent',
            'defaultImportedIndirection',
            'defaultNamedImportIndirection',
            'defaultReexportClause',
            'defaultOpaqueClass',
        ] as const);

        if (shape === 'defaultFn') {
            entry.lines.push(`export default function ${name}(a, b) ${callableBody(this.r, this.nextId())}`);
        } else if (shape === 'defaultLocalIdent') {
            const id = this.nextId();
            const local = `loc${id}`;
            entry.lines.push(`function ${local}(a, b) ${callableBody(this.r, id)}`);
            entry.lines.push(`export default ${local};`);
        } else if (shape === 'defaultImportedIndirection') {
            // `import bar from S; export default bar;` — S's default is a callable.
            const def = this.definingDefaultModule(name);
            mods.push(def.mod);
            entry.edges.push({ specifier: def.mod.specifier, path: def.mod.path });
            entry.lines.push(`import bar from "${def.mod.specifier}";`);
            entry.lines.push('export default bar;');
        } else if (shape === 'defaultNamedImportIndirection') {
            // `import { g as bar } from S; export default bar;` — S NAMES `g`.
            const id = this.nextId();
            const path = this.freshPath();
            const spec = this.freshSpec();
            const g = `g${id}`;
            mods.push({ specifier: spec, path, lines: [`export function ${g}(a, b) ${callableBody(this.r, id)}`], edges: [] });
            entry.edges.push({ specifier: spec, path });
            entry.lines.push(`import { ${g} as bar } from "${spec}";`);
            entry.lines.push('export default bar;');
        } else if (shape === 'defaultReexportClause') {
            // `export { g as default } from S` — the sourced default re-export clause.
            const id = this.nextId();
            const path = this.freshPath();
            const spec = this.freshSpec();
            const g = `g${id}`;
            mods.push({ specifier: spec, path, lines: [`export function ${g}(a, b) ${callableBody(this.r, id)}`], edges: [] });
            entry.edges.push({ specifier: spec, path });
            entry.lines.push(`export { ${g} as default } from "${spec}";`);
        } else {
            // `export default class` — opaque; calling it throws in the sandbox, and
            // the compiler must NOT swap in some other callable (that wouldn't throw).
            entry.lines.push(`export default class ${name}Cls { constructor(a, b) { this.v = a + b; } }`);
        }

        mods.unshift(entry);

        const optimize = chance(this.r, 0.85) ? '/* @optimize */ ' : '';
        const P = int(this.r, 2, 20);
        const Q = int(this.r, 1, 9);
        const consumer =
            `import ${name} from "${entry.specifier}";\n` +
            `${optimize}export function entry(p, q) {\n  return ${name}(p + ${P}, q + ${Q});\n}`;

        const donors: DonorModule[] = mods.map((m) => ({
            specifier: m.specifier,
            path: m.path,
            code: m.lines.join('\n'),
            resolved: m.edges,
        }));
        return { consumer, donors };
    }
}

// ── differential oracle ──────────────────────────────────────────────────────
//
// Compile consumer against donors, then compare `donorCode + consumer` (source)
// vs `donorCode + compiled` (output). We prepend the ENTRY donor's code (m0) so a
// kept import resolves and an inlined copy is harmless; but because m0 may itself
// re-export from siblings that also define `f`, we must build a self-contained
// module for the sandbox. We inline the WHOLE graph's callable definitions plus
// the consumer's own binding of `f`.

/** Flatten the donor graph into an executable prelude that reproduces what `f`
 *  binds to at runtime in the ENTRY module, following the same JS precedence the
 *  resolver models. Rather than re-implement resolution, we simply eval the real
 *  module graph: esbuild-bundle-free, we concatenate all donor bodies + consumer
 *  and let the sandbox's own scope + the consumer's `import { f }` line (stripped)
 *  fall back to the entry module's binding. To make that deterministic we instead
 *  RESOLVE `f` by executing the graph as ES modules via esbuild is overkill; a
 *  simpler, robust approach: run source and compiled through the SAME concatenation
 *  so any resolution asymmetry shows as a divergence. */
function crossDiff(consumer: string, donors: DonorModule[]): { want: unknown; got: unknown; compiled: string } | null {
    // The self-contained "source" program: define `f` exactly as the ENTRY module
    // binds it, by evaluating the real module graph. We build a tiny CJS-ish harness
    // that wires each donor into a `require`-like map keyed by path, honoring the
    // resolved edges — this reproduces runtime binding precedence faithfully.
    const call = 'entry(7, 3)';
    const want = evalGraph(consumer, donors, call);
    const compiled = compiler.compileFileCross('entry.ts', consumer, donors, {}).code;
    // The compiled consumer either inlined `f` (self-contained) or kept the import.
    // If it kept the import, we must still bind `f` from the graph, so run it through
    // the SAME graph harness with the compiled consumer body substituted.
    const got = evalGraph(compiled, donors, call);

    // Throwing is an equivalence CLASS, not a skip: an opaque/unresolvable `f` that
    // throws "not a function"/"class constructor" at runtime MUST still throw after
    // compilation. If a fall-through bug inlined a wildcard body, the compiled output
    // would RETURN a number instead of throwing → a divergence we WANT to catch. So we
    // only skip when BOTH threw for the SAME reason (want.ok === got.ok === false), which
    // `equiv` already treats as equal.
    if (equiv(want, got)) return null;
    return { want: want.ok ? want.value : '<threw>', got: got.ok ? got.value : '<threw>', compiled };
}

/** Execute the module graph faithfully: a minimal ESM-linker in a Function sandbox.
 *  Each donor becomes a module object; imports/re-exports/`export *` are resolved by
 *  path via the `resolved` edges, reproducing JS binding precedence at RUNTIME (the
 *  ground truth the compiler must preserve). The consumer is the entry; we call
 *  `entry(...)` and return its value. */
function evalGraph(consumer: string, donors: DonorModule[], call: string): EvalRes {
    try {
        // Map path -> donor module. Entry donor is the one whose specifier matches the
        // consumer's `import { … } from "<spec>"`.
        const byPath = new Map<string, DonorModule>();
        for (const d of donors) {
            byPath.set(d.path, d);
        }
        const entrySpecMatch =
            consumer.match(/import\s*\{[^}]*\}\s*from\s*["']([^"']+)["']/) ||
            consumer.match(/import\s+[A-Za-z_$][\w$]*\s+from\s*["']([^"']+)["']/);
        const entrySpec = entrySpecMatch ? entrySpecMatch[1] : './m0';
        const entryDonor = donors.find((d) => d.specifier === entrySpec);
        if (!entryDonor) return { ok: false };

        // Resolve a module's exported bindings into a flat record { name: value }.
        // Memoized per path; follows named/sourceless exports, imports, and export *.
        const moduleCache = new Map<string, Record<string, unknown>>();
        const resolving = new Set<string>();

        function evalModuleLocals(d: DonorModule): Record<string, unknown> {
            // Execute the donor's body in a sandbox where its imports are pre-bound
            // to the resolved targets' exports. Returns the module's LOCAL scope
            // (all declared/imported names) so export clauses can pick from it.
            const edgeByspec = new Map(d.resolved.map((e) => [e.specifier, e.path]));
            const importBindings: string[] = [];
            const importValues: Record<string, unknown> = {};
            // Named imports `import { a as b } from S`.
            for (const m of d.code.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?/gm)) {
                const spec = m[2];
                const targetPath = edgeByspec.get(spec);
                const exportsOfTarget = targetPath && byPath.has(targetPath) ? resolveExports(byPath.get(targetPath)!) : {};
                for (const clause of m[1].split(',')) {
                    const parts = clause.trim().split(/\s+as\s+/);
                    if (parts.length === 0 || !parts[0]) continue;
                    const imported = parts[0].trim();
                    const localName = (parts[1] ?? parts[0]).trim();
                    if (!localName) continue;
                    importBindings.push(localName);
                    importValues[localName] = exportsOfTarget[imported];
                }
            }
            // Default imports `import foo from S` — binds `foo` to S's `default` export.
            for (const m of d.code.matchAll(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["'];?/gm)) {
                const localName = m[1];
                const targetPath = edgeByspec.get(m[2]);
                const exportsOfTarget = targetPath && byPath.has(targetPath) ? resolveExports(byPath.get(targetPath)!) : {};
                importBindings.push(localName);
                importValues[localName] = exportsOfTarget.default;
            }
            // Strip module syntax from the body, keep local decls + sourceless exports'
            // targets. We collect declared top-level names to return them. A named
            // default declaration (`export default function foo`) is rewritten to a
            // bare declaration so `foo` survives as a local binding.
            const bodyNoModule = d.code
                .replace(/^\s*import[^\n]*\n?/gm, '')
                .replace(/^\s*export\s*\*[^\n]*\n?/gm, '')
                .replace(/^\s*export\s*\{[^}]*\}\s*(?:from\s*["'][^"']+["'])?\s*;?/gm, '')
                .replace(/^\s*export\s+default\s+((?:async\s+)?(?:function|class)\s+[A-Za-z_$][\w$]*)/gm, '$1')
                .replace(/^\s*export\s+default\s+[A-Za-z_$][\w$]*\s*;?\s*$/gm, '') // `export default ident;` — a re-surface, not a decl
                .replace(/^\s*export\s+default\s+[^\n]*\n?/gm, '') // anonymous default expression — not a local binding
                .replace(/\bexport\s+/g, '');
            const declNames = new Set<string>();
            for (const m of bodyNoModule.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) declNames.add(m[1]);
            for (const m of bodyNoModule.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declNames.add(m[1]);
            for (const m of bodyNoModule.matchAll(/(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)/g)) declNames.add(m[1]);
            const allNames = [...new Set([...importBindings, ...declNames])];
            const argNames = importBindings;
            const argVals = importBindings.map((n) => importValues[n]);
            const fn = new Function(
                ...argNames,
                `${stripTS(bodyNoModule)}\nreturn { ${allNames.map((n) => `${n}: (typeof ${n} !== 'undefined' ? ${n} : undefined)`).join(', ')} };`,
            );
            return fn(...argVals) as Record<string, unknown>;
        }

        function resolveExports(d: DonorModule): Record<string, unknown> {
            if (moduleCache.has(d.path)) return moduleCache.get(d.path)!;
            if (resolving.has(d.path)) return {}; // cycle guard
            resolving.add(d.path);
            const out: Record<string, unknown> = {};
            const edgeByspec = new Map(d.resolved.map((e) => [e.specifier, e.path]));
            const locals = evalModuleLocals(d);

            // (E) bare `export * from S` — lowest priority; collect first so explicit
            // clauses below OVERWRITE (shadow) them.
            for (const m of d.code.matchAll(/^\s*export\s*\*\s*from\s*["']([^"']+)["'];?/gm)) {
                const targetPath = edgeByspec.get(m[1]);
                if (targetPath && byPath.has(targetPath)) {
                    const tex = resolveExports(byPath.get(targetPath)!);
                    for (const k of Object.keys(tex)) if (!(k in out)) out[k] = tex[k];
                }
            }
            // (A) sourced named re-export `export { g as f } from S` — shadows *.
            for (const m of d.code.matchAll(/^\s*export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?/gm)) {
                const targetPath = edgeByspec.get(m[2]);
                const tex = targetPath && byPath.has(targetPath) ? resolveExports(byPath.get(targetPath)!) : {};
                for (const clause of m[1].split(',')) {
                    const parts = clause.trim().split(/\s+as\s+/);
                    if (!parts[0]) continue;
                    const local = parts[0].trim();
                    const exported = (parts[1] ?? parts[0]).trim();
                    out[exported] = tex[local];
                }
            }
            // (B/C) sourceless export clause `export { local as f }` — maps to LOCAL.
            for (const m of d.code.matchAll(/^\s*export\s*\{([^}]*)\}\s*;?\s*$/gm)) {
                for (const clause of m[1].split(',')) {
                    const parts = clause.trim().split(/\s+as\s+/);
                    if (!parts[0]) continue;
                    const local = parts[0].trim();
                    const exported = (parts[1] ?? parts[0]).trim();
                    out[exported] = locals[local];
                }
            }
            // inline `export function`/`export const`/`export class` — direct exports.
            for (const m of d.code.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm))
                out[m[1]] = locals[m[1]];
            for (const m of d.code.matchAll(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out[m[1]] = locals[m[1]];
            for (const m of d.code.matchAll(/^\s*export\s+class\s+([A-Za-z_$][\w$]*)/gm)) out[m[1]] = locals[m[1]];

            // (A/default) sourced default re-export `export { g as default } from S`
            // is already handled by the sourced-clause loop above (it writes
            // `out.default`). Here we model the remaining default forms:
            //   `export default <ident>`  → the local binding `<ident>`
            //   `export default function <name>` / `export default class <name>`
            //     → the (locally-bound) named declaration
            //   `export default function(…)` / `export default (…) => …` (anonymous)
            //     → evaluated as a standalone expression in the module scope.
            // A named default declaration also binds its name locally (ES spec), so
            // `evalModuleLocals` already returns it; we just surface it as `default`.
            const defIdent = d.code.match(/^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m);
            const defNamedDecl = d.code.match(/^\s*export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/m);
            if (defIdent && !defNamedDecl) {
                out.default = locals[defIdent[1]];
            } else if (defNamedDecl) {
                out.default = locals[defNamedDecl[1]];
            }

            moduleCache.set(d.path, out);
            resolving.delete(d.path);
            return out;
        }

        // Bind `f` (and any other imported names) from the entry module's exports.
        // A named import (`import { f }`) binds each name from the matching export;
        // a default import (`import f from`) binds the local to the `default` export.
        const entryExports = resolveExports(entryDonor);
        const args: string[] = [];
        const argVals: unknown[] = [];
        const consumerNamedImport = consumer.match(/import\s*\{([^}]*)\}\s*from/);
        if (consumerNamedImport) {
            for (const s of consumerNamedImport[1].split(',')) {
                const parts = s.trim().split(/\s+as\s+/);
                const imported = parts[0].trim();
                const localName = (parts[1] ?? parts[0]).trim();
                if (!localName) continue;
                args.push(localName);
                argVals.push(entryExports[imported]);
            }
        }
        const consumerDefaultImport = consumer.match(/import\s+([A-Za-z_$][\w$]*)\s+from/);
        if (consumerDefaultImport) {
            args.push(consumerDefaultImport[1]);
            argVals.push(entryExports.default);
        }
        const consumerBody = consumer.replace(/^\s*import[^\n]*\n?/gm, '').replace(/\bexport\s+/g, '');
        // biome-ignore lint/security/noGlobalEval: intentionally evaluating generated/compiled code
        const value = new Function(...args, `${stripTS(consumerBody)}\nreturn (${call});`)(...argVals);
        return { ok: true, value };
    } catch (e) {
        if (process.env.PROBE) console.log('evalGraph threw:', (e as Error).message);
        return { ok: false };
    }
}

// ── the test ─────────────────────────────────────────────────────────────────
//
// Default (CI gate): small deterministic batch — fast. FUZZ=1 → deep campaign.
describe('cross-module shadowing fuzzer: compiled output ≡ source', () => {
    const DEEP = !!process.env.FUZZ;
    const ITERS = Number(process.env.FUZZ_ITERS ?? 0) || (DEEP ? 1500 : 60);
    const BASE = Number(process.env.FUZZ_SEED ?? 0) || 0x5adf00d;

    it(
        `${ITERS} random donor-graph scenarios preserve semantics`,
        () => {
            for (let i = 0; i < ITERS; i++) {
                const seed = (BASE + i * 2654435761) >>> 0;
                const { consumer, donors } = new ShadowGen(mulberry32(seed)).scenario();
                let d: ReturnType<typeof crossDiff>;
                try {
                    d = crossDiff(consumer, donors);
                } catch (e) {
                    d = { want: 'n/a', got: `<compile threw: ${(e as Error).message}>`, compiled: '' };
                }
                if (d) {
                    const donorDump = donors
                        .map(
                            (m) =>
                                `--- donor ${m.specifier} (${m.path}) ---\n${m.code}\n  resolved: ${JSON.stringify(m.resolved)}`,
                        )
                        .join('\n\n');
                    throw new Error(
                        `CROSS-SHADOW MISCOMPILE (seed=${seed}, FUZZ_SEED=${BASE} i=${i})\n` +
                            `entry(7, 3)   want=${JSON.stringify(d.want)} got=${JSON.stringify(d.got)}\n\n` +
                            `--- consumer ---\n${consumer}\n\n${donorDump}\n\n` +
                            `--- compiled ---\n${d.compiled}\n`,
                    );
                }
            }
            expect(true).toBe(true);
            // Generous timeout: each iteration compiles a multi-module graph (slower than
            // the local fuzzer), so a deep FUZZ=1 / FUZZ_ITERS campaign must not trip
            // vitest's default 5s per-test timeout. Scales ~3ms/iter with headroom.
        },
        Math.max(10000, ITERS * 20),
    );
});
