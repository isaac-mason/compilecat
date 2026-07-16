//! WebAssembly bindings for `compilecat_core`.
//!
//! The browser/edge twin of `compilecat_napi`: the same `compilecat_core`
//! surface, exposed through `wasm-bindgen` instead of napi so the optimizer runs
//! in the browser (the playground / website) and in edge runtimes where native
//! addons can't load. All AST work lives in `compilecat_core`; this crate is
//! only the boundary — keep it a thin shell, exactly like the napi crate.
//!
//! Build (from `rust/`):
//!   rustup target add wasm32-unknown-unknown   # once
//!   wasm-pack build crates/compilecat_wasm --target web --release
//!
//! Inputs/outputs cross the JS↔wasm boundary as plain objects via
//! `serde-wasm-bindgen`, mirroring the `#[napi(object)]` DTO shapes so the two
//! bindings stay interchangeable from the host's point of view.

#![deny(clippy::all)]

use std::cell::RefCell;

use compilecat_core::{
    donor_edges as core_donor_edges, format as core_format, run_pass as core_run_pass, transform,
    transform_cross_file, Donor, Mode, ModuleCache, SourceType, Stats, TransformOptions,
    TransformOutput,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Route Rust panics to `console.error` with a readable message — invaluable
/// when debugging the optimizer in a browser. Runs once on module init.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// A resolved `… from '<specifier>'` edge of a donor (specifier → path) — lets
/// the core follow a re-export to the module at `path`.
#[derive(Deserialize)]
pub struct ResolvedEdge {
    pub specifier: String,
    pub path: String,
}

/// A donor module the consumer imports from. In the browser the *host* supplies
/// these (a virtual FS / module map) exactly as the JS plugin does in Node — the
/// core never touches a filesystem.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DonorModule {
    pub specifier: String,
    /// The donor's own resolved path — lets the core rebase the donor's relative
    /// imports when forwarding them, and match it as a re-export target.
    pub path: String,
    pub code: String,
    /// Resolved re-export/import edges of this donor (specifier → path).
    #[serde(default)]
    pub resolved: Vec<ResolvedEdge>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompileOptions {
    pub sourcemap: Option<bool>,
    pub allow_library_inline: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub code: String,
    /// JSON source map string, when source maps are enabled.
    pub map: Option<String>,
    /// Whether any pass actually rewrote the input. The host returns a no-op when
    /// false, instead of handing back an identical reprint.
    pub changed: bool,
    /// Per-pass counts of what the pipeline did (powers the playground panel).
    pub stats: CompileStats,
}

/// Per-pass optimization counts — mirrors `compilecat_core::Stats`, serialized to
/// a camelCase JS object (`removedDeadCode`, `flowInlined`, …).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
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

/// Serialize a core `TransformOutput` to the JS `CompileResult` object — the one
/// place stats + `changed` are derived, shared by every `compile*` method.
fn result_value(out: TransformOutput) -> Result<JsValue, JsValue> {
    Ok(serde_wasm_bindgen::to_value(&CompileResult {
        changed: out.stats.changed(),
        stats: (&out.stats).into(),
        code: out.code,
        map: out.map,
    })?)
}

/// Identity reprint (parse → codegen, no passes). Mirrors `format` in the napi
/// crate — the differential harness / playground use it to normalize formatting.
#[wasm_bindgen]
pub fn format(id: String, code: String) -> String {
    core_format(&code, &id)
}

/// The specifiers the donor BFS should follow from ONE module — the AST-based
/// replacement for the plugin's donor-edge regexes. Mirrors `donorEdges` in the
/// napi crate: `id` (the donor's path) picks the source type, and the return is a
/// dedup'd, order-stable list of specifiers to read as further donors (see
/// [`compilecat_core::donor_edges`]).
#[wasm_bindgen(js_name = donorEdges)]
pub fn donor_edges(id: String, code: String) -> Vec<String> {
    let source_type = SourceType::from_path(&id).unwrap_or_default();
    core_donor_edges(&code, source_type)
}

/// Run a single named pass in isolation (per-pass differential harness). Returns
/// `null` (a JS `null`) for an unknown pass name, matching the napi `Option`.
#[wasm_bindgen(js_name = runPass)]
pub fn run_pass(name: String, id: String, code: String) -> Result<JsValue, JsValue> {
    let out = core_run_pass(
        &name,
        &code,
        &TransformOptions { filename: id, source_type: None, mode: Mode::WholeProgram, sourcemap: false },
    );
    match out {
        Some(out) => result_value(out),
        None => Ok(JsValue::NULL),
    }
}

#[wasm_bindgen]
pub struct Compiler {
    /// Build-scoped parsed-module cache, amortized across calls (donors parsed
    /// once). `RefCell` for interior mutability behind `&self`; wasm is
    /// single-threaded so the `!Send` oxc ASTs it holds are never shared.
    cache: RefCell<ModuleCache>,
}

#[wasm_bindgen]
impl Compiler {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Compiler { cache: RefCell::new(ModuleCache::new()) }
    }

    /// Cross-module per-file pass: inline `@inline` donors the consumer imports.
    /// `donors` is an array of `DonorModule`; `options` may be omitted/undefined.
    #[wasm_bindgen(js_name = compileFileCross)]
    pub fn compile_file_cross(
        &self,
        id: String,
        code: String,
        donors: JsValue,
        options: JsValue,
    ) -> Result<JsValue, JsValue> {
        let donors: Vec<DonorModule> = serde_wasm_bindgen::from_value(donors)?;
        let options = parse_options(options)?;
        let sourcemap = options.sourcemap.unwrap_or(true);

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
        result_value(out)
    }

    /// Per-file pass — universal (every bundler has a `transform` hook).
    #[wasm_bindgen(js_name = compileFile)]
    pub fn compile_file(&self, id: String, code: String, options: JsValue) -> Result<JsValue, JsValue> {
        self.run(id, code, Mode::PerFile, options)
    }

    /// Whole-program pass — rollup-family `renderChunk` only.
    #[wasm_bindgen(js_name = compileChunk)]
    pub fn compile_chunk(&self, id: String, code: String, options: JsValue) -> Result<JsValue, JsValue> {
        self.run(id, code, Mode::WholeProgram, options)
    }

    fn run(&self, id: String, code: String, mode: Mode, options: JsValue) -> Result<JsValue, JsValue> {
        let sourcemap = parse_options(options)?.sourcemap.unwrap_or(true);
        let out = transform(&code, &TransformOptions { filename: id, source_type: None, mode, sourcemap });
        result_value(out)
    }
}

/// Decode an optional `CompileOptions` arg, treating JS `undefined`/`null` as
/// defaults so callers can omit the trailing argument.
fn parse_options(options: JsValue) -> Result<CompileOptions, JsValue> {
    if options.is_undefined() || options.is_null() {
        Ok(CompileOptions::default())
    } else {
        Ok(serde_wasm_bindgen::from_value(options)?)
    }
}
