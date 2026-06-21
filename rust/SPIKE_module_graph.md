# Spike: persistent module graph + opt-dependency edges + mode-gated passes

Scoped 2026-06-13. De-risks the core architecture for **whole-graph, dev-HMR-correct
TS→TS optimization** — minimally. This is a *spike*: prove the structure and the
riskiest unknowns, not ship the full feature.

## What it must prove

1. **Persistence** — modules can be parsed *once* and held alive in the Rust core
   across calls (the arena/self-reference risk).
2. **Drop-in** — cross-file resolution can be served *from the graph* instead of
   re-parsing donors per call, with no behavior change.
3. **HMR correctness is structural** — optimization-dependency edges drive exact
   invalidation: a changed donor returns the consumers that must re-transform,
   even though inlining erased the import edge.

## Non-goals (explicitly deferred — do NOT pull these in)

- Types / the type-resolution layer (separate, later).
- `oxc_resolver` whole-project crawl (the build-mode driver — later).
- Global passes (whole-program DCE, all-usages reasoning) — build-only, later.
- Memory eviction / LRU, perf tuning.
- **Persisting the consumer AST** — see the insight below; only donors persist.

## The insight that shrinks the spike

For **dev HMR, only donor modules need to persist.** They are the things
re-parsed N times across consumers (and the re-export graph). The consumer's AST
does *not* need to persist: when a donor changes, Vite re-invokes
`transform(consumer)` with fresh source and we re-optimize against the updated
graph. So `self_cell` only the **donor** modules; the consumer flow stays
per-call exactly as today. That cuts the riskiest arena work to the minimum while
still killing the re-parse waste and proving the edges.

## Pass locality (the design constraint that makes dev HMR safe)

Every optimization is classified:

- **Local** — depends only on a *bounded neighborhood* (consumer + direct donors
  + their signatures). Inlining, const-fold, callee-signature specialization.
  Precisely invalidatable → **runs in Dev and Build.**
- **Global** — depends on "all modules / all usages" (whole-program DCE,
  cross-module devirtualization). Not incremental-safe → **Build only.**

Dev doesn't want the global ones anyway (DCE/tree-shaking/minify are build
concerns), so the split is natural. `Mode::{Dev, Build}` gates the pass set.

## Phases (each has a single de-risk + a clear exit test)

**Phase 0 — Arena foundation.**
`ModuleCell` via `self_cell` (or `ouroboros`) holding `(source: String,
allocator: Allocator, program: Program<'a>)`. `ModuleGraph` held on the napi
`Compiler` instance: `HashMap<ModuleId /* resolved path */, Module>`.
`get_or_parse(id, code)` — parse once, content-hash dedupe, reparse on hash
change. *Exit:* a test parses a donor, holds it across two calls, second is a hit
(no reparse).

**Phase 1 — Index + reroute.**
On insert, compute the resolved `exports` table (the export surface incl
re-export edges as `ModuleId` refs) and `imports`. Reroute `cross_file.rs`
resolution (`find_inline_export`, namespace, object methods, re-export walk) to
query the graph instead of parsing donors inline. *Exit:* all existing
`cross_file` tests pass, now served from the graph; a shared donor is parsed once
across multiple consumers.

**Phase 2 — Opt-dependency edges + mode.**
`Module.opt_deps`/a `consumer_id -> {donor ModuleIds}` map recorded during
inlining. `Mode::{Dev, Build}` plumbed; the inliner declares `Local`.
`invalidate(changed_id) -> Vec<ModuleId>` walks reverse edges transitively.
*Exit:* inline A←B, `invalidate(B)` returns `[A]`; A←B←C returns `[A]` for a
change to C.

**Phase 3 — Vite adapter + validation.**
Plugin routes `transform` through the graph; `handleHotUpdate(file)` calls
`invalidate` and `server.moduleGraph.invalidateModule`s the result.
`optimizeDeps.exclude` for inlinable packages via the `config` hook (the dev
wrinkle for `allowLibraryInline`). *Exit:* a donor change flags the inlining
consumer for re-transform (simulated invalidation test at minimum; real
vite-dev-server integration is a follow-on).

## napi surface (sketch)

- `compileFileCross(id, code, donors, opts)` — additionally upserts donors into
  the graph and records opt-dep edges keyed by `id`. `opts.mode`.
- `invalidate(changedPath) -> string[]` — consumers to re-transform (for
  `handleHotUpdate`). The graph lives on the `Compiler` (one instance per build/
  dev session — already the case via `createCompiler()`).

## Risks to watch

- `self_cell` ergonomics against oxc lifetimes (`Program<'a>` borrows both the
  `Allocator` and the source `&'a str`).
- Transitive edge walking (A←B←C) — invalidation must close over the full chain.
- `optimizeDeps` pre-bundling still strips directives from node_modules donors in
  dev — orthogonal to the graph; handled by `optimizeDeps.exclude`.

## Done = ready to graduate

When Phase 2 proves the edges and Phase 3 proves the Vite hook consumes them.
Then decide independently whether to graduate to: the build-mode crawl
(`oxc_resolver`), the type-resolution layer over preserved annotations, and the
global passes.
