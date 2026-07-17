use oxc_span::SourceType;

/// The optimization unit being processed. Mirrors `Mode` in the TS pipeline
/// (`src/compiler/pipeline.ts`): the pass set is the same in both, the
/// difference is whether cross-file inlining (resolver + dependency splicing) is in
/// play. Whole-program runs on a tree-shaken chunk where every `@inline` target
/// is already in scope, so no resolver is needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Per source file (`transform` hook). Cross-file resolution applies.
    PerFile,
    /// Whole tree-shaken chunk (`renderChunk` hook). No resolver.
    WholeProgram,
}

#[derive(Debug, Clone)]
pub struct TransformOptions {
    /// Used to derive `SourceType` (ts/tsx/jsx) and to label the source map.
    pub filename: String,
    /// Override the parsed source type. When `None`, derived from `filename`.
    /// Note: bundle chunks are named `.js` even when the text is TS — callers
    /// in whole-program mode may want to force `SourceType::ts()` here, exactly
    /// as `parserOptions()` does in the TS pipeline.
    pub source_type: Option<SourceType>,
    pub mode: Mode,
    pub sourcemap: bool,
}

impl TransformOptions {
    pub fn source_type(&self) -> SourceType {
        self.source_type
            .unwrap_or_else(|| SourceType::from_path(&self.filename).unwrap_or_default())
    }
}

/// Counts of what each pass did — mirrors `TransformResult.stats` in TS. The
/// host uses `changed()` to decide whether to hand back a rewritten file or a
/// no-op (`null`), avoiding a pointless reprint of identical source.
#[derive(Debug, Default, Clone)]
pub struct Stats {
    /// Functions inlined at call sites (`inline_functions`, incl. cross-file).
    pub inlined: u32,
    /// Loops unrolled (`unroll`).
    pub unrolled: u32,
    /// Aggregates scalar-replaced (`sroa`).
    pub sroa: u32,
    /// Constant-folds / block flattens (`fold`, `block_flatten`).
    pub folded: u32,
    /// Dead code removed (`dead_code`, `cleanup_residue`, `remove_unused`).
    pub removed_dead_code: u32,
    /// Flow-sensitive variable inlines (`flow_inline`, CFG tier).
    pub flow_inlined: u32,
    /// Dead stores eliminated (`dead_assignments`, CFG tier).
    pub dead_assigns: u32,
    /// Conditions/exit-points minimized (`minimize_conditions`,
    /// `minimize_exit_points`).
    pub minimized: u32,
    /// Local variables inlined (`inline_variables`).
    pub inlined_variables: u32,
    /// Directive comments removed/rewritten. Counts as a change: a file whose
    /// only edit is stripping an `@optimize`/`@inline` marker must still emit its
    /// cleaned output (otherwise the host keeps the original, directives intact).
    pub stripped: u32,
}

impl Stats {
    pub fn changed(&self) -> bool {
        self.inlined
            + self.unrolled
            + self.sroa
            + self.folded
            + self.removed_dead_code
            + self.flow_inlined
            + self.dead_assigns
            + self.minimized
            + self.inlined_variables
            + self.stripped
            > 0
    }
}

#[derive(Debug)]
pub struct TransformOutput {
    pub code: String,
    /// JSON source map, when `options.sourcemap` is set.
    pub map: Option<String>,
    pub stats: Stats,
}
