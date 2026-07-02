# compilecat — Rust/oxc core

The fast core. Pure Rust, built on [oxc](https://github.com/oxc-project/oxc)
(parser, AST, codegen, semantic). The TypeScript plugin in `../src` loads the
compiled napi addon and calls into it; all AST work happens here.

The full optimizer lives here — the passes are ported and tested (the parse →
passes → codegen loop is the real pipeline, not a scaffold). It reached parity
with the original Babel pipeline and has since grown a superset of passes
(purity-driven pure-call elimination, module-scratch scalar replacement, a
CFG/dataflow analysis tier). See `WORKLOG.md` / `ARCHITECTURE.md` for the "why".

## Layout

```
rust/
  Cargo.toml                       workspace (pinned oxc 0.135, napi 3)
  crates/
    compilecat_core/               pure Rust, no napi — the optimizer
      src/lib.rs                   transform(): parse → passes → codegen
      src/options.rs               Mode, TransformOptions, Stats, output
      src/passes/                  the optimization passes (one module each)
      src/analysis/                CFG / dataflow / purity / type-shape infra
      examples/transform.rs        run on a file from disk
    compilecat_napi/               cdylib → the .node addon
      src/lib.rs                   Compiler { compileFile, compileChunk }
      package.json                 @napi-rs/cli build config
```

`core` has no bundler/napi dependency so it stays unit-testable and reusable
(CLI, tests, a future native rolldown builtin). `napi` is a thin wrapper.

## Build

`compilecat_core` is an `rlib` **dependency** of both bindings, not a separate
artifact — cargo compiles it first, automatically, when you build napi or wasm.
So a full build is just "build both bindings, then the TS plugin". The root
`package.json` orchestrates this:

```bash
pnpm build           # build:rust (napi + wasm) → build:ts (rollup → dist/)
pnpm build:rust      # both bindings (core built transitively)
pnpm build:native    # napi .node addon the TS plugin loads (release)
pnpm build:wasm      # wasm pkg for the browser/edge → crates/compilecat_wasm/pkg
pnpm build:ts        # TS plugin only (fast iteration, skips Rust)
```

Debug variants: `build:native:debug`, `build:wasm:debug`. Prerequisites: the
napi crate vendors `@napi-rs/cli` locally; the wasm build needs `wasm-pack` on
PATH and `rustup target add wasm32-unknown-unknown`.

```bash
# core only (fast iteration + tests)
pnpm test:rust                                                 # cargo test -p compilecat_core
cd rust && cargo run -p compilecat_core --example transform -- ../tst/<fixture>.ts
```

Versions are pinned to a known-good set (see `Cargo.toml`); run `cargo update`
to move forward once it compiles in your environment. A few API spots are
version-sensitive and flagged with `TODO` in the source (parser diagnostics,
sourcemap serialization).

## Testing

```bash
pnpm test:rust    # Rust unit tests (cargo) — the per-pass coverage
pnpm test:js      # JS behavioral/integration gates (tst/*.test.ts)
pnpm test         # both
```

`tst/` holds the real-compiler gates: behavioral equivalence
(`equivalence.test.ts`), TS-in→TS-out (`ts.test.ts`), and the rollup plugin
integration (`plugin.test.ts`, `cross-file.test.ts`). They normalize away
formatting via the shared oxc identity printer (`format()` / `Compiler.format`),
so only *semantic* differences fail.

## Passes & analysis

The passes run in pipeline order out of `passes/mod.rs::run_all_gated`
(normalize → stamp-pure-calls → inline → block-flatten → unroll → SROA →
block-flatten → simplify fixpoint → remove-unused → strip-directives). Each pass
is one module under `src/passes/`; the simplify fixpoint runs fold,
minimize-conditions/exit-points, inline-variables, cleanup-residue, dead-code,
block-flatten, and the two CFG-based passes (flow-sensitive-inline-variables,
dead-assignments-elimination) to convergence.

The control-flow / dataflow substrate lives under `src/analysis/` and is
compilecat's **own** framework, *not* `oxc_cfg`: a per-AST-node CFG (`cfg.rs`)
over an index-based `graph.rs`, a generic lattice worklist (`data_flow.rs`),
`local_var_table.rs`, reaching-defs / reaching-uses (`reaching.rs`), live
variables (`live_vars.rs`), and function purity (`purity.rs`). oxc_cfg is
basic-block granularity; the passes need exact per-node GEN/KILL/JOIN, hence the
custom tier (see `WORKLOG.md` for the decision). `oxc_semantic` supplies
scopes/symbols/references throughout.
```
