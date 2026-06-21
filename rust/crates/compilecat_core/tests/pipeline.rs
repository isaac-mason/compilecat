//! Whole-pipeline integration tests — the Rust home for the old Babel
//! `tst/pipeline.test.ts` + the single-file slice of `tst/per-file.test.ts`.
//! Exercises the public `transform()` API end-to-end (parse → all passes →
//! codegen), as opposed to the per-pass unit tests inside each pass module.

use compilecat_core::{transform, Mode, TransformOptions};

fn opts(filename: &str) -> TransformOptions {
    TransformOptions {
        filename: filename.to_string(),
        source_type: None,
        mode: Mode::WholeProgram,
        sourcemap: false,
    }
}

/// Collapse whitespace so assertions are formatting-insensitive.
fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn optimize_fn_inlines_and_folds_in_one_go() {
    // The realistic opt-in shape: an `@optimize` host whose body inlines an
    // `@inline` callee, then folds + inline-vars collapse the result. (NEW gates
    // fold/inline-vars to opted-in scopes — see `module_top_level_*` below.)
    let out = transform(
        "/** @inline */ function add(a, b) { return a + b; }\n\
         /* @optimize */ export function f() { const x = add(1, 2); return x; }",
        &opts("test.ts"),
    );
    assert!(norm(&out.code).contains("return 3"), "{}", out.code);
    assert_eq!(out.stats.inlined, 1, "one call inlined");
    assert!(out.stats.folded > 0, "constant folded");
}

#[test]
fn module_top_level_without_directive_is_left_alone() {
    // DIVERGENCE from OLD Babel (intentional — the opt-in gating model): OLD's
    // `transform` folded/inlined everything unconditionally; NEW only optimizes
    // directive-annotated constructs. An `@inline` callee still inlines (its
    // directive is on the callee), but the resulting `1 + 2` at the un-opted
    // module top level is NOT folded.
    let out = transform(
        "/** @inline */ function add(a, b) { return a + b; }\nexport const x = add(1, 2);",
        &opts("test.ts"),
    );
    assert_eq!(out.stats.inlined, 1, "the @inline callee still inlines");
    assert!(out.code.contains("1 + 2"), "module-level fold gated off:\n{}", out.code);
}

#[test]
fn supports_typescript_syntax_in_optimized_fn() {
    let out = transform(
        "/** @inline */ function id<T>(x: T): T { return x; }\n\
         /* @optimize */ export function f(): number { const v: number = id(42); return v; }",
        &opts("test.ts"),
    );
    assert!(norm(&out.code).contains("return 42"), "{}", out.code);
}

#[test]
fn preserves_types_on_passthrough_ts() {
    // TS→TS: type annotations on untouched code are preserved (NEW never strips
    // types — that's the design, see ts.parity.ts).
    let out = transform("export function f(x: number): number { return x; }", &opts("test.ts"));
    assert!(out.code.contains(": number"), "types preserved:\n{}", out.code);
}

#[test]
fn emits_a_sourcemap_when_requested() {
    let out = transform(
        "/** @inline */ function add(a, b) { return a + b; }\n\
         /* @optimize */ export function f() { return add(1, 2); }",
        &TransformOptions { sourcemap: true, ..opts("test.ts") },
    );
    assert!(out.map.is_some(), "source map emitted when requested");
}

#[test]
fn does_not_rename_declared_function_parameters() {
    // Regression: normalization must not inline-style-rename function params
    // (no `rA__1` etc.) across functions that share param names.
    let out = transform(
        "export function f(rA: number, rB: number, rC: number): number { return rA + rB + rC; }\n\
         export function g(rA: number, rB: number): number { return rA - rB; }\n\
         export function h(rA: number): number { return rA * 2; }",
        &opts("test.ts"),
    );
    assert!(!out.code.contains("rA__"), "no param suffix:\n{}", out.code);
    assert!(!out.code.contains("rB__"), "no param suffix:\n{}", out.code);
    assert!(!out.code.contains("rC__"), "no param suffix:\n{}", out.code);
}

// ── single-file slice of the old per-file.test.ts (cross-file donor cases stay
//    in tst/parity/cross-file.parity.ts — they need the plugin's resolver) ──

#[test]
fn perfile_mode_leaves_undirected_code_alone() {
    // PerFile mode with no directives anywhere: a no-op (no donors, nothing
    // opted in). The shape is preserved.
    let out = transform(
        "export function f(x) { return x + 1; }",
        &TransformOptions { mode: Mode::PerFile, ..opts("test.ts") },
    );
    assert!(out.code.contains("x + 1"), "untouched:\n{}", out.code);
    assert!(!out.stats.changed(), "no-op in PerFile with no directives");
}
