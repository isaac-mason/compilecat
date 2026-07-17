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
    dependency_edges as core_dependency_edges, format as core_format,
    resolution_frontier as core_resolution_frontier, transform, transform_cross_file,
    Dependency as CoreDependency, FrontierKind as CoreFrontierKind, Mode, ModuleCache, SourceType,
    Stats, TransformOptions, TransformOutput,
};
use napi_derive::napi;

/// A dependency module the consumer imports from (already resolved + read by the JS
/// plugin, which owns module resolution and the filesystem/watch).
/// A resolved `… from '<specifier>'` edge of a dependency — lets the core follow a
/// re-export (`export * as vec3 from './vec3'`) to the module at `path`.
#[napi(object)]
pub struct ResolvedEdge {
    pub specifier: String,
    pub path: String,
}

#[napi(object)]
pub struct Dependency {
    pub specifier: String,
    /// The dependency's own resolved path — lets the core rebase the dependency's relative
    /// imports when forwarding them into the consumer, and match it as a
    /// re-export target.
    pub path: String,
    pub code: String,
    /// Resolved re-export/import edges of this dependency (specifier → path).
    pub resolved: Vec<ResolvedEdge>,
}

/// Identity reprint (parse → codegen, no passes). The differential harness runs
/// both pipelines' output through this so only semantic diffs remain.
#[napi]
pub fn format(id: String, code: String) -> String {
    core_format(&code, &id)
}

/// The specifiers the dependency BFS should follow from ONE module — the AST-based
/// replacement for the plugin's brittle dependency-edge regexes. `id` is the dependency's
/// path, used only to pick the source type (so `.d.ts`/`.tsx`/`.js` parse
/// correctly); the return is a dedup'd, order-stable list of import/re-export
/// specifiers `S` the plugin should read as further dependencies (see
/// [`compilecat_core::dependency_edges`]).
#[napi]
pub fn dependency_edges(id: String, code: String) -> Vec<String> {
    let source_type = SourceType::from_path(&id).unwrap_or_default();
    core_dependency_edges(&code, source_type)
}

/// The JS string a core `FrontierKind` marshals to — `"value"` (a runtime `.js`
/// need) or `"type"` (a `.d.ts` need). A plain string keeps the JS contract exactly
/// `kind: "value" | "type"` (a napi `string_enum` would escape the reserved variant
/// name `type` into the value `"r#type"`).
fn kind_str(k: CoreFrontierKind) -> String {
    match k {
        CoreFrontierKind::Value => "value".to_string(),
        CoreFrontierKind::Type => "type".to_string(),
    }
}

/// One module edge the host still needs but that isn't reachable within the
/// dependencies gathered so far — the demand-driven counterpart to a `Dependency`.
/// The plugin resolves `specifier` relative to `from_path` (as a runtime module for
/// `kind: "value"`, a type module for `kind: "type"`), reads it, adds it as a dependency,
/// and calls [`resolution_frontier`] again until the frontier is empty.
#[napi(object)]
pub struct FrontierRequest {
    pub specifier: String,
    pub from_path: String,
    /// `"value"` (runtime `.js`) or `"type"` (`.d.ts`).
    pub kind: String,
}

/// The module edges the host still needs given the dependencies gathered so far — the
/// demand-driven dependency-gather fixpoint's "what's still missing?" query. STATELESS:
/// the plugin calls this with a growing `provided` set until it returns `[]`, then
/// hands the assembled set to `compileFileCross` (the unchanged inliner). A
/// directive-less host needs nothing → `[]`, UNLESS it calls a first-party
/// `@inline`-def name in `inline_def_names` (the build-start index of
/// `/* @inline */ export function NAME` defs) — then that def's module is a value
/// need. `id` is the host's path (picks the source type). See
/// [`compilecat_core::resolution_frontier`].
#[napi]
pub fn resolution_frontier(
    id: String,
    code: String,
    provided: Vec<Dependency>,
    inline_def_names: Vec<String>,
) -> Vec<FrontierRequest> {
    let provided: Vec<CoreDependency> = provided
        .into_iter()
        .map(|d| CoreDependency {
            specifier: d.specifier,
            path: d.path,
            code: d.code,
            resolved: d.resolved.into_iter().map(|r| (r.specifier, r.path)).collect(),
        })
        .collect();
    core_resolution_frontier(
        &id,
        &code,
        &provided,
        &inline_def_names,
        &TransformOptions {
            filename: id.clone(),
            source_type: None,
            mode: Mode::PerFile,
            sourcemap: false,
        },
    )
    .into_iter()
    .map(|(specifier, from_path, kind)| FrontierRequest {
        specifier,
        from_path,
        kind: kind_str(kind),
    })
    .collect()
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
    /// Build-scoped parsed-module cache, amortized across every call (dependencies
    /// parsed once per build). Behind a `RefCell` because napi methods take
    /// `&self` and the bundler drives plugin transforms on one JS thread, so the
    /// `!Send` oxc ASTs it holds are never shared across threads — and napi does
    /// NOT require the `#[napi]` struct to be `Send` (verified: this compiles).
    /// `compile_file_cross` parses every dependency through it once per build.
    cache: RefCell<ModuleCache>,
}

#[napi]
impl Compiler {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Compiler { cache: RefCell::new(ModuleCache::new()) }
    }

    /// Cross-module per-file pass: inline `@inline` dependencies the consumer imports.
    /// The JS plugin resolves + reads the dependency modules and passes them here.
    #[napi]
    pub fn compile_file_cross(
        &self,
        id: String,
        code: String,
        dependencies: Vec<Dependency>,
        options: Option<CompileOptions>,
    ) -> CompileResult {
        let sourcemap = options.as_ref().and_then(|o| o.sourcemap).unwrap_or(true);
        let dependencies: Vec<CoreDependency> = dependencies
            .into_iter()
            .map(|d| CoreDependency {
                specifier: d.specifier,
                path: d.path,
                code: d.code,
                resolved: d.resolved.into_iter().map(|r| (r.specifier, r.path)).collect(),
            })
            .collect();
        let out = transform_cross_file(
            &code,
            &dependencies,
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
