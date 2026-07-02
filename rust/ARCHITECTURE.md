# compilecat architecture (committed 2026-06-14)

The TS→optimized-TS→bundler optimizer. This doc is the committed design; it
supersedes the exploratory `SPIKE_module_graph.md`. Decisions here are grounded
in measurement and in how rolldown/Vite actually work, not assumption.

## Shape: lazy, memoized, per-file + donor — an unplugin plugin

```
unplugin transform hook  (rolldown / vite / rollup / webpack / esbuild)
  • resolve + read donors (build-scoped read cache) + re-export BFS
  • addWatchFile(donor) → bundler re-runs the consumer transform on change (HMR)
  • → core.compileFileCross(consumerCode, donors[{path, code, hash, resolvedEdges}], {mode})
        │
        ├─ CORE: persistent DONOR cache   (keyed by path + content-hash)
        │     per donor, computed ONCE per build, reused by every consumer:
        │       - parsed oxc Program (per-donor arena via self_cell)
        │       - export table (incl. re-export resolution)
        │       - classified @inline candidates (DIRECT / BLOCK)
        │       - dependency sets (module consts/imports to hoist/forward)
        │       - [next] type facts from written TS annotations
        │     invalidated when content-hash changes (HMR / watch)
        │
        ├─ CORE: per-consumer optimization  (NOT cached — consumer changes per edit)
        │     parse consumer · query donor cache · clone_in candidate bodies +
        │     substitute args · hoist/forward deps · run LOCAL passes · codegen → TS
        │
        └─ pass locality + Mode::{Dev, Build}
```

## Grounding (the "not lazy" part)

- **oxc parse cost, measured** (`bench_parse_cost`, release): ~130 MB/s — small
  util ~9µs, ~375-line module ~76µs, ~100KB barrel ~771µs (×500 consumers ≈
  385ms). So raw re-parse is cheap for small/medium donors; only big barrels
  re-parsed widely are costly.
- **The real redundancy is donor-intrinsic *semantic* work**, not parse:
  export-surface resolution, re-export following, candidate classification,
  dependency analysis, and (next) type-fact extraction all depend ONLY on the
  donor source — yet are redone per consumer today. That's what the donor cache
  eliminates. Parse-once is a bonus, not the main motive.
- **Rolldown owns the project module graph + incremental + `addWatchFile`** (re-
  runs the consumer transform when a watched donor changes). So HMR's
  erased-import-edge problem is handled by the bundler — no parallel
  invalidation graph needed. We can't share rolldown's oxc ASTs (separate addon
  heap; it exposes only ESTree/post-transform to plugins), so we parse ourselves
  — once, via the cache.

## The persistent MODULE cache (the speed + type-layer substrate)

Naming boundary: the cache holds parsed **modules** and is **role-agnostic** — a
module is a *donor* in cross-file inlining, a *type source* for the type layer, a
*consumer* elsewhere. The role lives at the **use site** (`cross_file.rs` treats
a cached module as a donor), not in the cache types. So the cache is named after
what it holds (modules), not how one caller uses it. Not `*Cell` (that's the
`self_cell` mechanism, and Rust `Cell` connotes interior mutability — this is
immutable); not `*Graph` (this is a lazy cache, not a whole-program graph).

- **`ParsedModule`** — the `self_cell` owning `(source: String, Allocator,
  Program)` for one module (immutable, self-referential).
- **`ModuleCache`** — `path → (content-hash, ParsedModule)`, held on the napi
  `Compiler` so it persists across `transform` calls; re-parses only on a
  content-hash change. `get_or_parse` / `invalidate` / `parse_count`.

Keyed by `(resolved path, content-hash)`. `clone_in` copies nodes *out* into each
consumer's arena at use → consumer arenas stay independent. Per-module arenas →
drop+re-derive exactly one module on change. Derived facts (export table,
classified candidates, type facts) layer on top as the next increment.

**Status:** ✅ built + wired. `ParsedModule`/`ModuleCache` (`module_cache.rs`):
`self_cell` holds the parse (oxc `Program` is covariant), cloned nodes survive the
source module being dropped, parse-once verified, hash + explicit invalidation.
`transform_cross_file` takes `&mut ModuleCache` (phase-1 `get_or_parse` all donors,
phase-2 read); the napi `Compiler` holds `RefCell<ModuleCache>` (napi needs no
`Send`), so donors parse once per build across `compileFileCross` calls.
- Memory bounded to `@inline`-touched donors (NOT the whole project); LRU cap if
  ever needed. This is **not** a whole-graph — it's lazy, on-demand, donor-only.
- `self_cell` (one small dep) is the only real engineering risk; bounded.

## Pass locality (makes dev HMR correct by construction)

- **Local** — bounded neighborhood (consumer + direct donors + their types):
  inlining, const-fold, SROA, unroll, callee-signature type specialization.
  Precisely invalidatable → **Dev + Build.**
- **Global** — all-usages reasoning (whole-program DCE, monomorphization):
  not incremental-safe, and DCE is rolldown's job anyway. Out of scope.

## Explicitly NOT built (grounded decisions)

- All-usages / whole-program passes — high-value opts are neighborhood-scoped;
  global ones are unproven payoff and DCE is rolldown's job. Out of scope.
- Parallel project graph — rolldown already has one; we cache only our own donor
  analysis.
- Borrowing rolldown's AST — ESTree/post-transform/cross-boundary; we oxc-parse
  once and cache.

## Next-value roadmap (on this architecture, in order)

1. ✅ **Donor-fact cache** (`self_cell` + content-hash) — parse once per donor.
2. ✅ **`addWatchFile` HMR validation** + real **rolldown** smoke build.
3. **Type-resolution layer** — read preserved annotations + resolve type refs
   (the thing rolldown can't give us). Slice 1 ✅: **type-aware SROA** — `@sroa`
   fires on a typed fixed-tuple aggregate (`const v: Vec3 = mk()` →
   `let [v_0,v_1,v_2] = mk()`), via the type-shape oracle (`build_alias_arities`
   /`type_arity`, local aliases + inline tuples). Slice 2 ✅: cross-module aliases
   (resolve an imported `Vec3` via the ModuleCache). Slice 3 ✅: **object/record
   SROA** (non-escaping `{x,y,z}` locals → named scalars).
4. **Local optimizer superset (on this substrate, all neighborhood-scoped):**
   - ✅ **Module-scratch scalar replacement** — an LLVM-GlobalOpt-style
     localization of a module-level scratch buffer, fused into SROA and proven
     safe by a CFG must-reaching-definitions (killed-on-entry) analysis.
   - ✅ **Function purity + `@pure`** — a Closure `PureFunctionIdentifier` port
     (`analysis/purity.rs`) stamps side-effect-free calls so the simplify tier can
     drop/reorder/CSE them and codegen emits `/*@__PURE__*/`.
   - ✅ **CFG/dataflow tier** (`analysis/{cfg,data_flow,reaching,live_vars}.rs`)
     driving flow-sensitive-inline-variables + dead-assignments-elimination.
