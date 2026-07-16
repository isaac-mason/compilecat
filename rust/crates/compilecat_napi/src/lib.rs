//! napi bindings for `compilecat_core`.
//!
//! Exposes a `Compiler` class whose `compileFile` / `compileChunk` methods
//! return `{ code, map, changed }`. This is the boundary the TS plugin
//! (`src/`) calls — the JS side stays a thin shell, all AST work happens here
//! in Rust. The shape mirrors `oxc-transform`'s napi surface and the
//! `createCompiler()` seam used by the unplugin adapter.

#![deny(clippy::all)]

use std::cell::RefCell;

use compilecat_core::{
    donor_edges as core_donor_edges, format as core_format, transform, transform_cross_file, Donor,
    Mode, ModuleCache, SourceType, Stats, TransformOptions, TransformOutput,
};
use napi_derive::napi;

/// A donor module the consumer imports from (already resolved + read by the JS
/// plugin, which owns module resolution and the filesystem/watch).
/// A resolved `… from '<specifier>'` edge of a donor — lets the core follow a
/// re-export (`export * as vec3 from './vec3'`) to the module at `path`.
#[napi(object)]
pub struct ResolvedEdge {
    pub specifier: String,
    pub path: String,
}

#[napi(object)]
pub struct DonorModule {
    pub specifier: String,
    /// The donor's own resolved path — lets the core rebase the donor's relative
    /// imports when forwarding them into the consumer, and match it as a
    /// re-export target.
    pub path: String,
    pub code: String,
    /// Resolved re-export/import edges of this donor (specifier → path).
    pub resolved: Vec<ResolvedEdge>,
}

/// Identity reprint (parse → codegen, no passes). The differential harness runs
/// both pipelines' output through this so only semantic diffs remain.
#[napi]
pub fn format(id: String, code: String) -> String {
    core_format(&code, &id)
}

/// The specifiers the donor BFS should follow from ONE module — the AST-based
/// replacement for the plugin's brittle donor-edge regexes. `id` is the donor's
/// path, used only to pick the source type (so `.d.ts`/`.tsx`/`.js` parse
/// correctly); the return is a dedup'd, order-stable list of import/re-export
/// specifiers `S` the plugin should read as further donors (see
/// [`compilecat_core::donor_edges`]).
#[napi]
pub fn donor_edges(id: String, code: String) -> Vec<String> {
    let source_type = SourceType::from_path(&id).unwrap_or_default();
    core_donor_edges(&code, source_type)
}

#[napi(object)]
pub struct CompileResult {
    pub code: String,
    /// JSON source map string, when source maps are enabled.
    pub map: Option<String>,
    /// Whether any pass actually rewrote the input. The host returns a no-op
    /// when false, instead of handing back an identical reprint.
    pub changed: bool,
    /// Per-pass counts of what the pipeline did (powers the playground panel).
    pub stats: CompileStats,
}

/// Per-pass optimization counts — mirrors `compilecat_core::Stats`. napi maps the
/// snake_case fields to camelCase on the JS side (`removedDeadCode`, …).
#[napi(object)]
pub struct CompileStats {
    pub inlined: u32,
    pub unrolled: u32,
    pub sroa: u32,
    pub folded: u32,
    pub removed_dead_code: u32,
    pub flow_inlined: u32,
    pub dead_assigns: u32,
    pub minimized: u32,
    pub inlined_variables: u32,
    pub stripped: u32,
}

impl From<&Stats> for CompileStats {
    fn from(s: &Stats) -> Self {
        CompileStats {
            inlined: s.inlined,
            unrolled: s.unrolled,
            sroa: s.sroa,
            folded: s.folded,
            removed_dead_code: s.removed_dead_code,
            flow_inlined: s.flow_inlined,
            dead_assigns: s.dead_assigns,
            minimized: s.minimized,
            inlined_variables: s.inlined_variables,
            stripped: s.stripped,
        }
    }
}

/// Build the napi result from a core `TransformOutput` (the one place stats +
/// `changed` are derived, shared by every `compile*` method).
fn result_of(out: TransformOutput) -> CompileResult {
    CompileResult {
        changed: out.stats.changed(),
        stats: (&out.stats).into(),
        code: out.code,
        map: out.map,
    }
}

#[napi(object)]
pub struct CompileOptions {
    pub sourcemap: Option<bool>,
    pub allow_library_inline: Option<bool>,
}

#[napi]
pub struct Compiler {
    /// Build-scoped parsed-module cache, amortized across every call (donors
    /// parsed once per build). Behind a `RefCell` because napi methods take
    /// `&self` and the bundler drives plugin transforms on one JS thread, so the
    /// `!Send` oxc ASTs it holds are never shared across threads — and napi does
    /// NOT require the `#[napi]` struct to be `Send` (verified: this compiles).
    /// `compile_file_cross` parses every donor through it once per build.
    cache: RefCell<ModuleCache>,
}

#[napi]
impl Compiler {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Compiler { cache: RefCell::new(ModuleCache::new()) }
    }

    /// Cross-module per-file pass: inline `@inline` donors the consumer imports.
    /// The JS plugin resolves + reads the donor modules and passes them here.
    #[napi]
    pub fn compile_file_cross(
        &self,
        id: String,
        code: String,
        donors: Vec<DonorModule>,
        options: Option<CompileOptions>,
    ) -> CompileResult {
        let sourcemap = options.as_ref().and_then(|o| o.sourcemap).unwrap_or(true);
        let donors: Vec<Donor> = donors
            .into_iter()
            .map(|d| Donor {
                specifier: d.specifier,
                path: d.path,
                code: d.code,
                resolved: d.resolved.into_iter().map(|r| (r.specifier, r.path)).collect(),
            })
            .collect();
        let out = transform_cross_file(
            &code,
            &donors,
            &TransformOptions { filename: id, source_type: None, mode: Mode::PerFile, sourcemap },
            &mut self.cache.borrow_mut(),
        );
        result_of(out)
    }

    /// Per-file pass — universal (every bundler has a `transform` hook).
    #[napi]
    pub fn compile_file(
        &self,
        id: String,
        code: String,
        options: Option<CompileOptions>,
    ) -> CompileResult {
        self.run(id, code, Mode::PerFile, options)
    }

    /// Whole-program pass — rollup-family `renderChunk` only.
    #[napi]
    pub fn compile_chunk(
        &self,
        id: String,
        code: String,
        options: Option<CompileOptions>,
    ) -> CompileResult {
        self.run(id, code, Mode::WholeProgram, options)
    }

    /// Run a single named pass in isolation. Returns null for an unknown
    /// pass name.
    #[napi]
    pub fn run_pass(&self, name: String, id: String, code: String) -> Option<CompileResult> {
        compilecat_core::run_pass(
            &name,
            &code,
            &TransformOptions {
                filename: id,
                source_type: None,
                mode: Mode::WholeProgram,
                sourcemap: false,
            },
        )
        .map(result_of)
    }

    fn run(
        &self,
        id: String,
        code: String,
        mode: Mode,
        options: Option<CompileOptions>,
    ) -> CompileResult {
        let sourcemap = options.as_ref().and_then(|o| o.sourcemap).unwrap_or(true);

        let out = transform(
            &code,
            &TransformOptions { filename: id, source_type: None, mode, sourcemap },
        );

        result_of(out)
    }
}
