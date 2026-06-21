//! Control-flow + dataflow analysis infrastructure, ported from compilecat's
//! own framework (NOT `oxc_cfg` — see `rust/WORKLOG.md` for the decision).
//!
//! Build order:
//!   - `graph`           — index-based directed graph (done)
//!   - `cfg`             — per-statement-node CFG over the AST  (control-flow-analysis.ts)
//!   - `data_flow`       — lattice + forward/backward fixpoint  (data-flow-analysis.ts)
//!   - `local_var_table` — binding-slot index space            (local-variable-table.ts)
//!
//! Consumers (the passes) then layer on: live-variables, dead-assignments,
//! flow-sensitive-inline (+ reaching-defs / reaching-uses).

// CFG/dataflow framework (worklist phase 1). `#[allow(dead_code)]` stays until
// the consumer passes (flow-sensitive-inline, dead-assignments) wire them in —
// the framework lands first, bottom-up, then the passes.
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
pub mod reaching;
#[allow(dead_code)]
pub(crate) mod tri;

pub(crate) mod type_shape;
