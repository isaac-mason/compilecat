# compilecat — Rust/oxc core

The fast core. Pure Rust, built on [oxc](https://github.com/oxc-project/oxc)
(parser, AST, codegen, semantic). The TypeScript plugin in `../src` loads the
compiled napi addon and calls into it; all AST work happens here.

This is a **scaffold** — the parse → codegen loop is real and tested, but every
optimization pass is a no-op stub. Porting the passes from `../src/compiler/*.ts`
is the remaining work.

## Layout

```
rust/
  Cargo.toml                       workspace (pinned oxc 0.114, napi 2.16)
  crates/
    compilecat_core/               pure Rust, no napi — the optimizer
      src/lib.rs                   transform(): parse → passes → codegen
      src/options.rs               Mode, TransformOptions, Stats, output
      src/passes/mod.rs            pass stubs, 1:1 with src/compiler/*.ts
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

## Porting the passes

Port in pipeline order, snapshot-testing each against the existing `tst/`
fixtures before moving on. The mapping:

| TS pass (`src/compiler/`)            | Rust (`compilecat_core::passes`) | Needs |
|--------------------------------------|----------------------------------|-------|
| `normalize.ts`                       | `normalize`                      | `VisitMut`, scopes |
| `inline-functions.ts` (+ `resolve`)  | `inline_functions`               | `VisitMut`, semantic |
| `loop-unroller.ts`                   | `unroll_loops`                   | `VisitMut` |
| `scalar-replace-aggregates.ts`       | `scalar_replace_aggregates`      | semantic |
| `simplifier.ts` + sub-passes         | `simplify`                       | `oxc_cfg` CFG + dataflow |
| `inline-variables.ts`, `*flow*`      | (under `simplify`)               | `oxc_cfg`, lattices |

`oxc_semantic` gives scopes/symbols/references; `oxc_semantic` with
`SemanticBuilder::with_cfg(true)` gives `oxc_cfg::ControlFlowGraph` (basic-block
CFG, petgraph). The dataflow-lattice passes (live-vars, reaching-defs,
flow-sensitive inline) are hand-built on top of that CFG — the largest single
chunk of the port. Add `oxc_ast_visit` (and `oxc_cfg`) to `core/Cargo.toml` when
you start the first real pass.
```
