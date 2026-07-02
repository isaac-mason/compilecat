//! Control-flow + dataflow analysis infrastructure, ported from compilecat's
//! own framework (NOT `oxc_cfg` — see `rust/WORKLOG.md` for the decision).
//!
//! Substrate (bottom-up):
//!   - `graph`           — index-based directed graph
//!   - `cfg`             — per-AST-node CFG over the AST        (control-flow-analysis.ts)
//!   - `data_flow`       — lattice + forward/backward fixpoint  (data-flow-analysis.ts)
//!   - `local_var_table` — binding-slot index space            (local-variable-table.ts)
//!   - `reaching`        — must-reaching-defs / maybe-reaching-uses
//!   - `live_vars`       — backward liveness (GEN/KILL bitsets)
//!   - `purity`          — Closure `PureFunctionIdentifier` port (side-effect summaries)
//!   - `type_shape`      — inferred tuple/record shapes for type-directed SROA
//!   - `tri`             — three-valued logic
//!
//! Consumers wired into the simplify fixpoint (`passes/mod.rs`):
//! flow-sensitive-inline-variables and dead-assignments-elimination (over
//! reaching/live-vars); `sroa` uses `reaching`/`cfg` for module-scratch
//! killed-on-entry; `stamp_pure_calls` uses `purity`.

// `#[allow(dead_code)]` is belt-and-suspenders: the consumer passes are wired in,
// but not every analysis helper is exercised on every build config, so the tier
// keeps the allow rather than churning it per-helper.
#[allow(dead_code)]
pub mod cfg;
#[allow(dead_code)]
pub mod data_flow;
#[allow(dead_code)]
pub mod graph;
#[allow(dead_code)]
pub mod live_vars;
#[allow(dead_code)]
pub mod local_var_table;
#[allow(dead_code)]
pub mod purity;
#[allow(dead_code)]
pub mod reaching;
#[allow(dead_code)]
pub(crate) mod tri;

pub(crate) mod type_shape;
