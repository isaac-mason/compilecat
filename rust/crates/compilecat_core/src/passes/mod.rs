//! Optimization passes.
//!
//! Each pass is the Rust counterpart of one in the TS pipeline
//! (`src/compiler/*.ts`). Ported passes live in their own module
//! (`normalize.rs`, …); not-yet-ported ones are no-op stubs below and graduate
//! to a file when ported.
//!
//! Port in pipeline order, snapshot-testing each against `tst/` via the
//! differential parity harness (`pnpm test:parity`).

mod block_flatten;
mod block_mutate;
mod cleanup_residue;
mod dead_assignments;
mod dead_code;
pub(crate) mod directives;
mod flow_inline;
mod fold;
mod gate;
pub(crate) mod inline_functions;
mod inline_variables;
mod minimize_conditions;
mod minimize_exit_points;
mod minimized_condition;
mod normalize;
mod remove_unused;
mod sroa;
mod strip_directives;
mod unroll;
mod util;

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;

use crate::options::{Mode, Stats};

/// Run the full pipeline over `program`, accumulating into `stats`. Order
/// matches `transform()` in `src/compiler/pipeline.ts`.
pub fn run_all<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    mode: Mode,
    stats: &mut Stats,
    sroa_external_shapes: &HashMap<String, crate::analysis::type_shape::Shape>,
) {
    run_all_gated(allocator, program, mode, stats, sroa_external_shapes, &HashSet::new(), 0);
}

/// As [`run_all`], but with `extra_touched` function span-starts opted into the
/// cleanup gate — used by the cross-file path to mark `@inline` *target*
/// functions (which carry no directive of their own) so their inlined residue
/// gets cleaned. `uid_base` continues the cross-file driver's inline-temp counter
/// so generated names stay unique across the donor-inline → local-pipeline
/// boundary (single-file callers pass 0).
pub fn run_all_gated<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    mode: Mode,
    stats: &mut Stats,
    sroa_external_shapes: &HashMap<String, crate::analysis::type_shape::Shape>,
    extra_touched: &std::collections::HashSet<u32>,
    uid_base: u32,
) {
    normalize::run(allocator, program);
    let _ = mode; // inline cross-file (PerFile) path not yet ported

    // Closure-aligned purity: stamp `CallExpression.pure` on calls to functions the
    // analysis proves side-effect-free, BEFORE inline — so `is_side_effect_free`
    // (which honors `c.pure`) lets the drop/reorder/substitute passes optimize the
    // pure calls that survive inlining (recursive / un-inlined helpers), and codegen
    // emits `/*@__PURE__*/` for downstream. Verified sound by the effect-trace fuzzer.
    crate::analysis::purity::stamp_pure_calls(program);

    // Inline first (self-gated on directives); it returns the directive-free
    // consumers it inlined into so their residue can join the cleanup gate.
    let mut uid = uid_base;
    let (inlined, inline_targets) = inline_functions::run(allocator, program, &mut uid);
    stats.inlined += inlined;

    // Per-function/scope opt-in gate (worklist #4): only constructs carrying a
    // directive (and their subtrees), PLUS the `@inline` consumers above, are
    // optimized/cleaned; everything else is left byte-identical. Built after
    // inlining so those consumer spans are known (the surviving directive
    // comments are still present — inline only strips fully-inlined donors).
    // `gate()` mints a fresh gate per pass.
    let mut touched_set = directives::touched_spans(program);
    touched_set.extend(extra_touched.iter().copied());
    touched_set.extend(inline_targets);
    let touched = std::rc::Rc::new(touched_set);
    let gate = || gate::Gate::gated(touched.clone());

    // Flatten the scaffolding blocks inlining emits, before downstream passes so
    // they see straight-line code.
    stats.folded += block_flatten::run_with(allocator, program, gate());
    stats.unrolled += unroll::run(allocator, program);
    stats.sroa += sroa::run(allocator, program, sroa_external_shapes);
    // Second flatten pass: the unroller wraps each iteration body in a `{ }`
    // block; run block_flatten again here (additively — the pre-unroll run still
    // handles inline scaffolding) so unrolled blocks are lifted before the fixpoint.
    stats.folded += block_flatten::run_with(allocator, program, gate());
    // Simplify to fixpoint: folding can expose a single-use constant, inlining
    // it can expose more folding, etc. Mirrors the simplifier's pass loop. Each
    // cleanup pass is gated to opted-in constructs; `cleanup_residue` is already
    // self-gated (it only touches compiler-generated `span 0` nodes).
    for _ in 0..8 {
        // Each pass attributes to its own counter (so the playground can show a
        // per-pass breakdown); `changed` is the per-iteration total that drives
        // the fixpoint. Call order is preserved exactly (fold → minimize-exit →
        // minimize-cond → inline-vars → cleanup → dead-code → flow → dead-store).
        let folded = fold::run_with(allocator, program, gate());
        let minimized = minimize_exit_points::run_with(allocator, program, gate())
            + minimize_conditions::run_with(allocator, program, gate());
        let inlined_vars = inline_variables::run_with(allocator, program, gate());
        let cleaned = cleanup_residue::run(allocator, program);
        let dead = dead_code::run_with(allocator, program, gate());
        // R1: lift bare `{ }` blocks *exposed during* simplification — a
        // constant-arg block-inline collapsing to one (`if (edge1===0) {…}` with
        // edge1≡0 → a bare block), or dead_code folding `if (true) {…}` to a bare
        // block. The pre-/post-unroll runs above only catch scaffolding present
        // before the fixpoint; bare blocks born inside it would otherwise ossify.
        // Safe to re-run each pass: `pick_fresh` strips existing suffixes before
        // minting, so the renamer is idempotent (no `x$1$1…` growth).
        let flattened = block_flatten::run_with(allocator, program, gate());
        // CFG-tier passes (per opted-in function):
        // flow-sensitive variable inlining, then dead-store elimination. Skipped
        // when nothing is opted in (avoids rebuilding semantic for no-op work).
        let (flow_inlined, dead_assigns) = if !touched.is_empty() {
            (
                flow_inline::run(allocator, program, &touched),
                dead_assignments::run(allocator, program, &touched),
            )
        } else {
            (0, 0)
        };
        stats.folded += folded + flattened;
        stats.minimized += minimized;
        stats.inlined_variables += inlined_vars;
        stats.removed_dead_code += cleaned + dead;
        stats.flow_inlined += flow_inlined;
        stats.dead_assigns += dead_assigns;
        let changed = folded
            + flattened
            + minimized
            + inlined_vars
            + cleaned
            + dead
            + flow_inlined
            + dead_assigns;
        if changed == 0 {
            break;
        }
    }
    // Drop bindings/imports left unused after inlining.
    stats.removed_dead_code += remove_unused::run(allocator, program);
    // Strip authored directive markers last — every consumer has run. Counts
    // toward `changed` so a file whose only edit is removing a directive still
    // emits its cleaned output.
    stats.stripped += strip_directives::run(allocator, program);
}

/// Run a single pass by name. Returns false for an unknown name.
pub fn run_one<'a>(
    name: &str,
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    stats: &mut Stats,
) -> bool {
    match name {
        "normalize" => {
            normalize::run(allocator, program);
            true
        }
        "fold" => {
            stats.folded += fold::run(allocator, program);
            true
        }
        "strip-directives" => {
            stats.stripped += strip_directives::run(allocator, program);
            true
        }
        "dead-code" => {
            stats.removed_dead_code += dead_code::run(allocator, program);
            true
        }
        "inline-functions" => {
            let mut uid = 0u32;
            stats.inlined += inline_functions::run(allocator, program, &mut uid).0;
            true
        }
        "inline-variables" => {
            stats.inlined_variables += inline_variables::run(allocator, program);
            true
        }
        "cleanup-residue" => {
            stats.removed_dead_code += cleanup_residue::run(allocator, program);
            true
        }
        "minimize-exit-points" => {
            stats.minimized += minimize_exit_points::run(allocator, program);
            true
        }
        "minimize-conditions" => {
            stats.minimized += minimize_conditions::run(allocator, program);
            true
        }
        "unroll" => {
            stats.unrolled += unroll::run(allocator, program);
            true
        }
        "sroa" => {
            stats.sroa += sroa::run(allocator, program, &HashMap::new());
            true
        }
        // graduate cases here as passes land
        _ => false,
    }
}
