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

#[test]
fn inline_result_object_used_in_conditional_keeps_binding() {
    // Regression: an inlined-result object (`corr`) used only INSIDE a
    // conditional block, as an arg to another inlined helper, had its `const
    // corr` definition dropped while the `corr.x`/`corr.y` uses survived — a
    // reference to an undeclared variable (ReferenceError at runtime).
    let out = transform(
        "type V = { x: number; y: number };\n\
         function sub(a: V, b: V): V { return { x: a.x - b.x, y: a.y - b.y }; }\n\
         function scale(a: V, s: number): V { return { x: a.x * s, y: a.y * s }; }\n\
         /* @optimize */ export function f(a: V, s: number, p: boolean): V {\n\
           const corr = scale(a, s);\n\
           if (p) { const na = sub(a, corr); a.x = na.x; a.y = na.y; }\n\
           return a;\n\
         }",
        &opts("test.ts"),
    );
    // A correct compile either scalarizes `corr` away (no `corr.` member access)
    // or keeps it declared; the bug leaves `corr.x`/`.y` reads with no binding.
    let reads_corr_member = out.code.contains("corr.");
    let declares_corr = out.code.contains("corr =");
    assert!(
        !reads_corr_member || declares_corr,
        "dropped `corr` binding — reads corr.x/.y but never declares corr:\n{}",
        out.code
    );
}

#[test]
fn pure_expression_callees_inline_without_surviving_aggregates() {
    // The functional vector style: helpers are single `return {…}` expressions
    // called with nested-call and object-literal args. The inliner must inline
    // them AS EXPRESSIONS (binding complex args as init-position `const a$N =
    // arg`), never the `let _r; _r = {…}` result-temp shape — so every temporary
    // stays init-position and SROA scalarizes it. End state: zero result temps,
    // zero surviving value object literals.
    let out = transform(
        "type V = { x: number; y: number };\n\
         function add(a: V, b: V): V { return { x: a.x + b.x, y: a.y + b.y }; }\n\
         function sub(a: V, b: V): V { return { x: a.x - b.x, y: a.y - b.y }; }\n\
         function scale(a: V, s: number): V { return { x: a.x * s, y: a.y * s }; }\n\
         /* @optimize */ export function f(n: { x: number; y: number; px: number; py: number }, wind: number): void {\n\
           const pos = { x: n.x, y: n.y };\n\
           const prev = { x: n.px, y: n.py };\n\
           const vel = scale(sub(pos, prev), 0.99);\n\
           const force = add({ x: wind, y: 0.45 }, vel);\n\
           const next = add(pos, force);\n\
           n.x = next.x;\n\
           n.y = next.y;\n\
         }",
        &opts("test.ts"),
    );
    assert!(
        !out.code.contains("__result"),
        "inliner emitted a result temp instead of inlining as an expression:\n{}",
        out.code
    );
    let code = norm(&out.code);
    // `{ x: number` is the only legitimate `{ x:` (the type alias + param type);
    // any other is a surviving value object allocation.
    let value_objs = code.matches("{ x:").count() - code.matches("{ x: number").count();
    assert_eq!(value_objs, 0, "expected zero surviving value object literals:\n{}", out.code);
}

#[test]
fn deferred_result_temp_from_multistatement_callee_scalarizes() {
    // `normalize` has a statement before its `return`, so it inlines via the
    // BLOCK path as a deferred result temp: `let _r; _r = { x: …, y: … };
    // const dir = _r;`. SROA (use-def, Stage 1) must scalarize that deferred
    // aggregate — zero surviving object literals, zero result temps.
    let out = transform(
        "type V = { x: number; y: number };\n\
         function len(a: V): number { return Math.sqrt(a.x * a.x + a.y * a.y); }\n\
         function normalize(a: V): V { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; }\n\
         /* @optimize */ export function f(d: V): number { const dir = normalize(d); return dir.x + dir.y; }",
        &opts("test.ts"),
    );
    assert!(!out.code.contains("__result"), "deferred result temp survives:\n{}", out.code);
    let code = norm(&out.code);
    let value_objs = code.matches("{ x:").count() - code.matches("{ x: number").count();
    assert_eq!(value_objs, 0, "surviving value object literals:\n{}", out.code);
}

#[test]
fn aggregate_through_nested_spliced_helper_scalarizes() {
    // `delta` is an aggregate passed WHOLE to `normalize`, whose body calls
    // `len(a)` — so after `normalize` inlines, `len(delta)` (a whole-object use)
    // would keep `delta` alive unless that spliced single-return helper is also
    // inlined. The per-host inliner must resolve BLOCK→DIRECT nesting → zero
    // surviving object literals, no residual `len(` call.
    let out = transform(
        "type V = { x: number; y: number };\n\
         function len(a: V): number { return Math.sqrt(a.x * a.x + a.y * a.y); }\n\
         function normalize(a: V): V { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; }\n\
         /* @optimize */ export function f(p: number, q: number): number {\n\
           const delta = { x: p - q, y: p + q };\n\
           const dir = normalize(delta);\n\
           return dir.x + dir.y + delta.x;\n\
         }",
        &opts("test.ts"),
    );
    assert!(!out.code.contains("len("), "nested helper left un-inlined:\n{}", out.code);
    let code = norm(&out.code);
    let value_objs = code.matches("{ x:").count() - code.matches("{ x: number").count();
    assert_eq!(value_objs, 0, "surviving value object literals:\n{}", out.code);
}

#[test]
fn deferred_aggregate_multi_field_read_scalarizes() {
    // A deferred aggregate read field-wise more than once, with no single-use
    // alias: `collapse_result_temps` can't touch it (two reads), so use-def SROA
    // Stage 1 must scalarize the deferred `let v; v = {lit};` directly →
    // `let v_x = …, v_y = …;`. Zero surviving object literals.
    let out = transform(
        "/* @optimize */ export function f(p: { x: number; y: number }): number {\n\
           let v: { x: number; y: number };\n\
           v = { x: p.x + 1, y: p.y + 1 };\n\
           return v.x * v.y;\n\
         }",
        &opts("test.ts"),
    );
    let code = norm(&out.code);
    let value_objs = code.matches("{ x:").count() - code.matches("{ x: number").count();
    assert_eq!(value_objs, 0, "deferred aggregate not scalarized:\n{}", out.code);
}

#[test]
fn deferred_tuple_init_scalarizes() {
    // Array (tuple) variant of the deferred merge — the `is_literal_assign_to`
    // ArrayExpression path, scalarized by the existing tuple collection.
    let out = transform(
        "/* @optimize */ export function f(a: number, b: number): number {\n\
           let v: [number, number];\n\
           v = [a + 1, b + 1];\n\
           return v[0] * v[1];\n\
         }",
        &opts("test.ts"),
    );
    // The array allocation must be gone (scalarized, then the single-use scalars
    // fold into the return — identical to the init-position `const v = […]` form).
    assert!(!out.code.contains('['), "array literal survived (not scalarized):\n{}", out.code);
}

#[test]
fn deferred_init_in_nested_block_scalarizes() {
    // The merge recurses into nested blocks: a `let v;` + its single store both
    // inside an `if` body must scalarize there.
    let out = transform(
        "/* @optimize */ export function f(c: boolean, n: number): number {\n\
           let out = 0;\n\
           if (c) { let v: { x: number; y: number }; v = { x: n, y: n + 1 }; out = v.x + v.y; }\n\
           return out;\n\
         }",
        &opts("test.ts"),
    );
    let code = norm(&out.code);
    let objs = code.matches("{ x:").count() - code.matches("{ x: number").count();
    assert_eq!(objs, 0, "deferred aggregate in nested block not scalarized:\n{}", out.code);
}

#[test]
fn deferred_var_aggregate_not_merged() {
    // Conservative skip: the merge only relocates `let` declarations (`var` is
    // function-scoped/hoisted — different relocation semantics), so a `var v;`
    // deferred aggregate must NOT be merged/scalarized. Pins the kind==Let guard.
    let out = transform(
        "/* @optimize */ export function f(n: number): number {\n\
           var v: { x: number; y: number };\n\
           v = { x: n, y: n + 1 };\n\
           return v.x + v.y;\n\
         }",
        &opts("test.ts"),
    );
    let code = norm(&out.code);
    let value_objs = code.matches("{ x:").count() - code.matches("{ x: number").count();
    assert!(value_objs >= 1, "var aggregate unexpectedly scalarized (merge must skip var):\n{}", out.code);
}
