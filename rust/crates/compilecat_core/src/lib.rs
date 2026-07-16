//! compilecat's optimization core, on oxc.
//!
//! Pure Rust, no bundler or napi dependency — this is the piece every host
//! (the napi addon, a CLI, a test harness) calls. The public surface is one
//! function: [`transform`], mirroring `transform()` in `src/compiler/pipeline.ts`.

mod analysis;
mod cross_file;
mod module_cache;
mod options;
mod passes;

pub use cross_file::{donor_edges, transform_cross_file, Donor};
pub use module_cache::ModuleCache;

pub use options::{Mode, Stats, TransformOptions, TransformOutput};

/// Re-exported so hosts (napi/wasm) can derive a donor's source type from its path
/// (`SourceType::from_path`) before calling [`donor_edges`], without depending on
/// `oxc_span` directly.
pub use oxc_span::SourceType;

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;
use oxc_codegen::{Codegen, CodegenOptions, CodegenReturn};
use oxc_parser::{ParseOptions, Parser};

/// Parse with `preserve_parens: false` so the oxc AST has no
/// `ParenthesizedExpression` nodes — the passes assume a paren-free AST.
/// Codegen re-inserts any parens that precedence actually requires.
fn parse_program<'a>(
    allocator: &'a Allocator,
    source: &'a str,
    source_type: SourceType,
) -> Program<'a> {
    Parser::new(allocator, source, source_type)
        .with_options(ParseOptions { preserve_parens: false, ..ParseOptions::default() })
        .parse()
        .program
}

/// Quick "is there anything to do?" check — the Rust twin of
/// `ANY_DIRECTIVE_IN_SOURCE` in `src/compiler/directives.ts`. Hosts call this
/// before `transform` to skip files/chunks with no compilecat directives, so
/// the parse never happens on the (overwhelmingly common) directive-free input.
pub fn has_directive(source: &str) -> bool {
    passes::directives::any_in_source(source)
}

/// Parse `source`, run the optimization pipeline, and print the result back to
/// source + (optionally) a JSON source map.
///
/// oxc's parser is error-tolerant: it returns a best-effort `Program` even on
/// syntax errors. The scaffold proceeds with that program and does not yet
/// surface diagnostics — wiring `ParserReturn::errors` into a typed error is a
/// TODO (see `rust-port-architecture` notes from the React port for the
/// `Result<_, CompilerDiagnostic>` shape to copy).
pub fn transform(source: &str, options: &TransformOptions) -> TransformOutput {
    let allocator = Allocator::default();
    let source_type = options.source_type();

    let mut program = parse_program(&allocator, source, source_type);

    let mut stats = Stats::default();
    // No donors in the per-file path → no cross-module type aliases.
    passes::run_all(
        &allocator,
        &mut program,
        options.mode,
        &mut stats,
        &std::collections::HashMap::new(),
    );

    let codegen_options = CodegenOptions {
        source_map_path: options.sourcemap.then(|| std::path::PathBuf::from(&options.filename)),
        ..CodegenOptions::default()
    };

    let CodegenReturn { code, map, .. } =
        Codegen::new().with_options(codegen_options).build(&program);

    TransformOutput { code, map: map.map(|m| m.to_json_string()), stats }
}

/// Run a single named pass (per-pass differential harness). Returns `None` for
/// an unknown pass name.
pub fn run_pass(name: &str, source: &str, options: &TransformOptions) -> Option<TransformOutput> {
    let allocator = Allocator::default();
    let source_type = options.source_type();
    let mut program = parse_program(&allocator, source, source_type);

    let mut stats = Stats::default();
    if !passes::run_one(name, &allocator, &mut program, &mut stats) {
        return None;
    }

    let codegen_options = CodegenOptions {
        source_map_path: options.sourcemap.then(|| std::path::PathBuf::from(&options.filename)),
        ..CodegenOptions::default()
    };
    let CodegenReturn { code, map, .. } =
        Codegen::new().with_options(codegen_options).build(&program);

    Some(TransformOutput { code, map: map.map(|m| m.to_json_string()), stats })
}

/// Identity reprint: parse `source` and codegen it straight back, running no
/// passes. Normalizes away cosmetic formatting differences — useful for
/// comparing outputs up to formatting.
pub fn format(source: &str, filename: &str) -> String {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(filename).unwrap_or_default();
    let program = parse_program(&allocator, source, source_type);
    Codegen::new().build(&program).code
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(filename: &str) -> TransformOptions {
        TransformOptions {
            filename: filename.to_string(),
            source_type: None,
            mode: Mode::WholeProgram,
            sourcemap: false,
        }
    }

    #[test]
    fn roundtrips_js() {
        // Non-foldable input → pipeline is a no-op reprint.
        let out = transform("const x = foo(y);\n", &opts("chunk.js"));
        assert!(out.code.contains("const x"));
        assert!(!out.stats.changed());
    }

    fn fold(src: &str) -> String {
        run_pass("fold", src, &opts("f.js")).unwrap().code
    }

    #[test]
    fn fold_numeric_and_bitwise() {
        assert!(fold("var x = 1 + 2 * 3;").contains("var x = 7"));
        assert!(fold("var x = 5 & 3;").contains("var x = 1"));
        assert!(fold("var x = 1 << 3;").contains("var x = 8"));
        assert!(fold("var x = -1 >>> 0;").contains("4294967295"));
        assert!(fold("var x = ~5;").contains("var x = -6"));
    }

    #[test]
    fn fold_strings_and_logical() {
        assert!(fold(r#"var s = "ab" + "cd";"#).contains(r#""abcd""#));
        assert!(fold(r#"var s = "n=" + 5;"#).contains(r#""n=5""#));
        assert!(fold("var x = true && y;").contains("var x = y"));
        assert!(fold("var x = null ?? y;").contains("var x = y"));
    }

    #[test]
    fn fold_identities_and_purity() {
        assert!(fold("function f(p) { return p + 0; }").contains("return p"));
        // impure left side is NOT dropped
        assert!(fold("var x = call() + 0;").contains("call()"));
    }

    #[test]
    fn fold_guards_div_by_zero() {
        assert!(fold("var x = 1 / 0;").contains("1 / 0"));
    }

    fn strip(src: &str) -> String {
        run_pass("strip-directives", src, &opts("s.js")).unwrap().code
    }

    #[test]
    fn strip_removes_marker_only_comment() {
        let out = strip("/* @inline */\nfunction f() {}\n");
        assert!(!out.contains("@inline"), "got: {out}");
        assert!(out.contains("function f"));
    }

    #[test]
    fn strip_keeps_non_directive_comment() {
        let out = strip("/* keep me */\nfunction f() {}\n");
        assert!(out.contains("keep me"), "got: {out}");
    }

    #[test]
    fn strip_removes_directive_token_from_mixed_comment() {
        // `/* @inline foo */` → `/* foo */` (token gone, other content kept).
        let out = strip("/* @inline foo */\nfunction f() {}\n");
        assert!(!out.contains("@inline"), "directive token removed: {out}");
        assert!(out.contains("foo"), "other content kept: {out}");
    }

    #[test]
    fn strip_removes_directive_line_from_jsdoc() {
        // A JSDoc keeps its docs but drops the directive-only line.
        let out = strip(
            "/**\n * Does a thing.\n * @returns the thing\n * @optimize\n */\nfunction f() {}\n",
        );
        assert!(!out.contains("@optimize"), "directive removed from JSDoc: {out}");
        assert!(out.contains("@returns the thing"), "doc content kept: {out}");
        assert!(out.contains("Does a thing"), "doc content kept: {out}");
    }

    fn dce(src: &str) -> String {
        run_pass("dead-code", src, &opts("d.js")).unwrap().code
    }

    #[test]
    fn dce_literal_if() {
        assert!(dce("function f() { if (true) return 1; else return 2; }").contains("return 1"));
        let f = dce("function f() { if (false) return 1; else return 2; }");
        assert!(f.contains("return 2") && !f.contains("return 1"), "got: {f}");
    }

    #[test]
    fn dce_unreachable_after_return() {
        let out = dce("function f() { return 1; g(); }");
        assert!(!out.contains("g()"), "got: {out}");
    }

    #[test]
    fn dce_while_false_and_pure_stmt() {
        assert!(!dce("function f() { while (false) g(); }").contains("while"));
        assert!(!dce("function f() { 1 + 2; return 3; }").contains("1 + 2"));
    }

    #[test]
    fn dce_ternary_literal() {
        assert!(dce("var x = true ? a : b;").contains("var x = a"));
    }

    fn inline(src: &str) -> String {
        run_pass("inline-functions", src, &opts("i.js")).unwrap().code
    }

    #[test]
    fn inline_direct_substitutes_args() {
        let out = inline(
            "/* @inline */ function add(a, b) { return a + b; }\nexport function step(x) { return add(x, 1); }\n",
        );
        assert!(out.contains("return x + 1"), "got: {out}");
        // declaration removed once fully inlined
        assert!(!out.contains("function add"), "got: {out}");
    }

    #[test]
    fn inline_fires_on_exported_donor() {
        let out = inline(
            "/* @inline */ export function add(a, b) { return a + b; }\nexport function s(x) { return add(x, 1); }",
        );
        assert!(out.contains("return x + 1"), "got: {out}");
        // exported donor is kept (other modules may import it)
        assert!(out.contains("export function add"), "got: {out}");
    }

    #[test]
    fn inline_block_void_helper() {
        let out = inline("/* @inline */ function init(o, a) { o.x = a; o.y = a; }\nfunction s(v) { init(v, 5); }");
        assert!(!out.contains("init("), "call should be spliced: {out}");
        assert!(!out.contains("function init"), "donor should be stripped: {out}");
        assert!(out.contains(".x ="), "body should be spliced: {out}");
    }

    #[test]
    fn inline_only_with_directive() {
        // no @inline → untouched
        let out = inline(
            "function add(a, b) { return a + b; }\nexport function s(x) { return add(x, 1); }\n",
        );
        assert!(out.contains("function add"), "got: {out}");
        assert!(out.contains("add(x, 1)"), "got: {out}");
    }

    #[test]
    fn inline_duplicated_side_effect_arg_binds_as_const() {
        // `g()` (impure) used twice → the DIRECT path binds it to an init-position
        // `const _inl_arg_N` from the `return` (expression) position, evaluating
        // `g()` exactly once.
        let out = inline(
            "/* @inline */ function twice(a) { return a + a; }\nexport function s() { return twice(g()); }\n",
        );
        assert!(!out.contains("twice(g())"), "inlined: {out}");
        assert_eq!(out.matches("g()").count(), 1, "side effect evaluated once: {out}");
        assert!(out.contains("_inl_arg"), "arg bound to an init-position const: {out}");
    }

    fn unroll(src: &str) -> String {
        run_pass("unroll", src, &opts("u.js")).unwrap().code
    }

    #[test]
    fn unroll_fixed_for() {
        let out = unroll("function f() { /* @unroll */ for (let i = 0; i < 3; i++) { use(i); } }");
        assert!(
            out.contains("use(0)") && out.contains("use(1)") && out.contains("use(2)"),
            "got: {out}"
        );
        assert!(!out.contains("for ("), "got: {out}");
        assert!(!out.contains("@unroll"), "got: {out}");
    }

    #[test]
    fn unroll_for_of_literal_array() {
        let out = unroll("function f() { /* @unroll */ for (const x of [10, 20]) { use(x); } }");
        assert!(out.contains("use(10)") && out.contains("use(20)"), "got: {out}");
    }

    #[test]
    fn unroll_softfails_dynamic_bound() {
        let out = unroll("function f(n) { /* @unroll */ for (let i = 0; i < n; i++) { use(i); } }");
        assert!(out.contains("for ("), "got: {out}");
    }

    fn sroa(src: &str) -> String {
        run_pass("sroa", src, &opts("s.js")).unwrap().code
    }

    #[test]
    fn sroa_replaces_tuple() {
        let out = sroa(
            "/* @sroa */ function f() { const v = [1, 2, 3]; v[0] = v[1] + v[2]; return v[0]; }",
        );
        assert!(out.contains("v_0") && out.contains("v_1") && out.contains("v_2"), "got: {out}");
        assert!(!out.contains("[1, 2, 3]") && !out.contains("v["), "got: {out}");
    }

    #[test]
    fn sroa_optimize_implies_sroa() {
        // `@optimize` is a combo directive that implies `@sroa`.
        let out = sroa(
            "/* @optimize */ function f() { const v = [1, 2, 3]; return v[0] + v[1] + v[2]; }",
        );
        assert!(
            out.contains("v_0") && out.contains("v_1") && out.contains("v_2"),
            "@optimize → SROA: {out}"
        );
        assert!(!out.contains("[1, 2, 3]"), "{out}");
    }

    #[test]
    fn sroa_bails_on_escape() {
        // `v` passed whole → escapes → not replaced
        let out = sroa("/* @sroa */ function f() { const v = [1, 2]; use(v); return v[0]; }");
        assert!(out.contains("[1, 2]"), "got: {out}");
    }

    #[test]
    fn sroa_needs_directive() {
        let out = sroa("function f() { const v = [1, 2]; return v[0] + v[1]; }");
        assert!(out.contains("[1, 2]"), "got: {out}");
    }

    fn sroa_ts(src: &str) -> String {
        run_pass("sroa", src, &opts("s.ts")).unwrap().code
    }

    #[test]
    fn sroa_type_aware_inline_tuple() {
        // Type gives the arity (2) even though the init isn't a literal array →
        // destructure the opaque initializer.
        let out = sroa_ts(
            "/* @sroa */ function f(p: number) { const v: [number, number] = mk(p); v[0] = v[1]; return v[0]; }",
        );
        assert!(out.contains("v_0") && out.contains("v_1"), "scalarized: {out}");
        assert!(!out.contains("v["), "accesses rewritten: {out}");
        assert!(out.contains("mk(p)"), "initializer preserved (destructured): {out}");
    }

    #[test]
    fn sroa_type_aware_local_alias() {
        let out = sroa_ts(
            "type Vec3 = [number, number, number];\n/* @sroa */ function f() { const v: Vec3 = make(); return v[0] + v[1] + v[2]; }",
        );
        assert!(out.contains("v_0") && out.contains("v_1") && out.contains("v_2"), "got: {out}");
        assert!(!out.contains("v["), "accesses rewritten: {out}");
        assert!(out.contains("make()"), "initializer preserved: {out}");
    }

    #[test]
    fn sroa_type_aware_bails_on_rest_tuple() {
        // `[number, ...number[]]` isn't fixed-arity → not scalarized.
        let out = sroa_ts(
            "/* @sroa */ function f() { const v: [number, ...number[]] = make(); return v[0]; }",
        );
        assert!(out.contains("make()") && out.contains("v[0]"), "left intact: {out}");
    }

    #[test]
    fn sroa_type_aware_bails_on_escape() {
        let out = sroa_ts(
            "/* @sroa */ function f() { const v: [number, number] = make(); use(v); return v[0]; }",
        );
        assert!(out.contains("use(v)"), "escape → left intact: {out}");
    }

    #[test]
    fn sroa_type_aware_nested_alias() {
        // alias → alias → tuple: the oracle resolves the chain to arity 3.
        let out = sroa_ts(
            "type Vec3 = [number, number, number];\ntype V3 = Vec3;\n/* @sroa */ function f() { const v: V3 = make(); return v[0] + v[1] + v[2]; }",
        );
        assert!(out.contains("v_0") && out.contains("v_1") && out.contains("v_2"), "got: {out}");
        assert!(!out.contains("v["), "got: {out}");
    }

    #[test]
    fn sroa_type_aware_bails_below_min_fields() {
        // 1-element tuple is below MIN_FIELDS → not scalarized.
        let out = sroa_ts("/* @sroa */ function f() { const v: [number] = make(); return v[0]; }");
        assert!(out.contains("make()") && out.contains("v[0]"), "left intact: {out}");
    }

    #[test]
    fn sroa_type_aware_recursive_alias_does_not_hang() {
        // self-referential alias must not loop (cycle guard); just no SROA.
        let out = sroa_ts(
            "type Bad = Bad;\n/* @sroa */ function f() { const v: Bad = make(); return v[0]; }",
        );
        assert!(out.contains("v[0]"), "no scalarization, no hang: {out}");
    }

    // ── object-type SROA (records) ───────────────────────────────────────────

    #[test]
    fn sroa_replaces_object_literal() {
        // `{ x, y }` literal → per-field scalars; `.x` accesses rewritten.
        let out = sroa(
            "/* @sroa */ function f() { const v = { x: 1, y: 2 }; v.x = v.y + 1; return v.x; }",
        );
        assert!(out.contains("v_x") && out.contains("v_y"), "scalarized: {out}");
        assert!(!out.contains("v.x") && !out.contains("{ x:"), "no object left: {out}");
    }

    #[test]
    fn sroa_object_bails_on_escape() {
        // whole `v` used → escapes → object left intact.
        let out =
            sroa("/* @sroa */ function f() { const v = { x: 1, y: 2 }; use(v); return v.x; }");
        assert!(out.contains("use(v)") && out.contains("x: 1"), "left intact: {out}");
    }

    #[test]
    fn sroa_object_bails_on_dynamic_key() {
        // computed access `v[k]` on a record → can't map to a field → bail.
        let out = sroa("/* @sroa */ function f(k) { const v = { x: 1, y: 2 }; return v[k]; }");
        assert!(out.contains("x: 1"), "dynamic key → left intact: {out}");
    }

    #[test]
    fn sroa_type_aware_inline_object_type() {
        // inline object type gives the field set → destructure the opaque init.
        let out = sroa_ts(
            "/* @sroa */ function f() { const v: { x: number; y: number } = mk(); v.x = v.y; return v.x; }",
        );
        assert!(out.contains("v_x") && out.contains("v_y"), "scalarized: {out}");
        assert!(out.contains("mk()"), "initializer destructured (preserved): {out}");
        assert!(!out.contains("v.x"), "accesses rewritten: {out}");
    }

    #[test]
    fn sroa_type_aware_interface() {
        // an `interface` resolves to a record shape (field set).
        let out = sroa_ts(
            "interface Vec3 { x: number; y: number; z: number }\n/* @sroa */ function f() { const v: Vec3 = mk(); return v.x + v.y + v.z; }",
        );
        assert!(out.contains("v_x") && out.contains("v_y") && out.contains("v_z"), "got: {out}");
        assert!(!out.contains("v.x"), "accesses rewritten: {out}");
    }

    #[test]
    fn sroa_type_aware_object_alias_to_interface() {
        // alias → interface chain resolves to the record shape.
        let out = sroa_ts(
            "interface Pt { x: number; y: number }\ntype P = Pt;\n/* @sroa */ function f() { const v: P = mk(); return v.x + v.y; }",
        );
        assert!(out.contains("v_x") && out.contains("v_y"), "got: {out}");
    }

    #[test]
    fn sroa_type_aware_object_type_alias() {
        // `type X = { … }` object-type alias (not an interface) resolves to the
        // record shape — exercises TSTypeAliasDeclaration → TSTypeLiteral.
        let out = sroa_ts(
            "type Vec3 = { x: number; y: number; z: number };\n/* @sroa */ function f() { const v: Vec3 = mk(); v.x = v.y + v.z; return v.x; }",
        );
        assert!(out.contains("v_x") && out.contains("v_y") && out.contains("v_z"), "got: {out}");
        assert!(!out.contains("v.x"), "accesses rewritten: {out}");
        assert!(out.contains("mk()"), "initializer destructured (preserved): {out}");
    }

    #[test]
    fn sroa_type_aware_object_type_alias_chain() {
        // alias → object-type alias chain (`type A = B`, `type B = { … }`).
        let out = sroa_ts(
            "type Inner = { x: number; y: number };\ntype Outer = Inner;\n/* @sroa */ function f() { const v: Outer = mk(); return v.x + v.y; }",
        );
        assert!(out.contains("v_x") && out.contains("v_y"), "got: {out}");
        assert!(!out.contains("v.x"), "accesses rewritten: {out}");
    }

    #[test]
    fn sroa_object_bails_on_optional_field() {
        // an optional field can't be safely scalarized (presence unknown) → bail.
        let out = sroa_ts(
            "interface Maybe { x: number; y?: number }\n/* @sroa */ function f() { const v: Maybe = mk(); return v.x; }",
        );
        assert!(out.contains("mk()") && out.contains("v.x"), "optional field → left intact: {out}");
    }

    #[test]
    fn sroa_object_bails_on_method_member() {
        // a method signature isn't a scalarizable field → bail the whole type.
        let out = sroa_ts(
            "interface Obj { x: number; go(): void }\n/* @sroa */ function f() { const v: Obj = mk(); return v.x; }",
        );
        assert!(out.contains("v.x"), "method member → left intact: {out}");
    }

    // ── type resolver: composition (extends / intersection / generics) ───────

    #[test]
    fn sroa_resolves_intersection_alias() {
        // `type C = A & B` merges the two record field sets.
        let out = sroa_ts(
            "type A = { x: number; y: number };\ntype B = { z: number };\ntype C = A & B;\n/* @sroa */ function f() { const v: C = mk(); v.x = v.y + v.z; return v.x; }",
        );
        assert!(
            out.contains("v_x") && out.contains("v_y") && out.contains("v_z"),
            "intersection merged: {out}"
        );
        assert!(!out.contains("v.x"), "rewritten: {out}");
    }

    #[test]
    fn sroa_resolves_use_site_intersection() {
        // intersection written at the use site, not as a named alias.
        let out = sroa_ts(
            "type A = { x: number; y: number };\ntype B = { z: number };\n/* @sroa */ function f() { const v: A & B = mk(); return v.x + v.y + v.z; }",
        );
        assert!(out.contains("v_x") && out.contains("v_y") && out.contains("v_z"), "got: {out}");
    }

    #[test]
    fn sroa_resolves_interface_extends() {
        // `interface C extends A, B { own }` → own + inherited fields merged.
        let out = sroa_ts(
            "interface A { x: number }\ninterface B { y: number }\ninterface C extends A, B { z: number }\n/* @sroa */ function f() { const v: C = mk(); v.x = v.y + v.z; return v.x; }",
        );
        assert!(
            out.contains("v_x") && out.contains("v_y") && out.contains("v_z"),
            "extends merged: {out}"
        );
    }

    #[test]
    fn sroa_resolves_generic_record_alias_shape() {
        // a generic record alias resolves its field-name shape (type arg ignored,
        // member types → Unknown, which is all SROA needs).
        let out = sroa_ts(
            "type Box<T> = { value: T; tag: T };\n/* @sroa */ function f() { const v: Box<number> = mk(); v.value = v.tag; return v.value; }",
        );
        assert!(out.contains("v_value") && out.contains("v_tag"), "generic shape resolved: {out}");
    }

    #[test]
    fn sroa_bails_on_intersection_with_primitive() {
        // `A & string` isn't an all-record intersection → no shape → bail.
        let out = sroa_ts(
            "type A = { x: number; y: number };\n/* @sroa */ function f() { const v: A & string = mk(); return v.x; }",
        );
        assert!(out.contains("mk()") && out.contains("v.x"), "left intact: {out}");
    }

    #[test]
    fn sroa_bails_on_union_type() {
        // a union isn't a fixed shape → bail.
        let out = sroa_ts(
            "type A = { x: number; y: number };\ntype B = { x: number; y: number };\n/* @sroa */ function f() { const v: A | B = mk(); return v.x; }",
        );
        assert!(out.contains("v.x"), "union → left intact: {out}");
    }

    fn ivars(src: &str) -> String {
        run_pass("inline-variables", src, &opts("v.js")).unwrap().code
    }

    #[test]
    fn ivars_single_use_pure() {
        let out = ivars("function f() { const a = 1 + 2; return a * 3; }");
        assert!(
            out.contains("return (1 + 2) * 3")
                || out.contains("return 1 + 2 * 3")
                || out.contains("1 + 2"),
            "got: {out}"
        );
        assert!(!out.contains("const a"), "got: {out}");
    }

    #[test]
    fn ivars_multi_use_literal() {
        let out = ivars("function f() { const K = 42; return K + K; }");
        assert!(out.contains("42 + 42"), "got: {out}");
        assert!(!out.contains("const K"), "got: {out}");
    }

    #[test]
    fn ivars_keeps_reassigned() {
        let out = ivars("function f() { let x = 1; x = 2; return x; }");
        assert!(out.contains("let x = 1") && out.contains("x = 2"), "got: {out}");
    }

    #[test]
    fn ivars_keeps_impure_single_use() {
        let out = ivars("function f() { const a = g(); return a; }");
        assert!(out.contains("const a = g()"), "got: {out}");
    }

    #[test]
    fn ivars_multi_declarator_inlines_one_keeps_rest() {
        // b inlines out of the group; a (reassigned) stays.
        let out = ivars("function f() { let a = 1, b = 2; a = a + 1; return a + b; }");
        assert!(out.contains("return a + 2") || out.contains("return a + 2;"), "got: {out}");
        assert!(out.contains("a = 1") && !out.contains("b = 2"), "got: {out}");
    }

    fn mxp(src: &str) -> String {
        run_pass("minimize-exit-points", src, &opts("m.js")).unwrap().code
    }

    #[test]
    fn mxp_drops_trailing_return() {
        let out = mxp("function f() { g(); return; }");
        assert!(!out.contains("return"), "got: {out}");
        assert!(out.contains("g()"), "got: {out}");
    }

    #[test]
    fn mxp_recurses_into_if_branch() {
        let out = mxp("function f() { if (c) { g(); return; } return; }");
        // both bare returns gone
        assert!(!out.contains("return"), "got: {out}");
        assert!(out.contains("g()"), "got: {out}");
    }

    #[test]
    fn mxp_keeps_value_return() {
        let out = mxp("function f() { g(); return 1; }");
        assert!(out.contains("return 1"), "got: {out}");
    }

    #[test]
    fn mxp_drops_trailing_continue() {
        let out = mxp("function f() { for (;;) { g(); continue; } }");
        assert!(!out.contains("continue"), "got: {out}");
    }

    fn mcond(src: &str) -> String {
        run_pass("minimize-conditions", src, &opts("c.js")).unwrap().code
    }

    #[test]
    fn mcond_double_not() {
        // `!!x` (unknown x) is ToBoolean — kept in a value context; a boolean-valued
        // inner (`a < c`) cancels.
        assert!(mcond("var b = !!x;").contains("!!x"), "value kept: {}", mcond("var b = !!x;"));
        let out = mcond("var b = !!(a < c);");
        assert!(out.contains("a < c") && !out.contains("!!"), "boolean-valued cancels: {out}");
    }

    #[test]
    fn mcond_negate_equality() {
        assert!(
            mcond("var b = !(a === c);").contains("a !== c"),
            "got: {}",
            mcond("var b = !(a === c);")
        );
        assert!(mcond("var b = !(a == c);").contains("a != c"));
    }

    #[test]
    fn mcond_keeps_relational_negation() {
        // `!(a < b)` is NaN-unsafe — leave it
        assert!(
            mcond("var b = !(a < c);").contains("!(a < c)"),
            "got: {}",
            mcond("var b = !(a < c);")
        );
    }

    // cleanup-residue only fires on compiler-generated nodes (span 0), so test
    // it through the full pipeline rather than on user source.
    #[test]
    fn cleanup_reduces_sroa_residue_to_constant() {
        let out = transform(
            "/* @sroa */ export function f() { const v = [1, 2, 3]; v[0] = v[1] + v[2]; return v[0]; }",
            &opts("f.js"),
        )
        .code;
        assert!(out.contains("return 5"), "got: {out}");
        assert!(!out.contains("v_0") && !out.contains("[1, 2, 3]"), "got: {out}");
    }

    #[test]
    fn cleanup_never_touches_user_code() {
        // User `let x` reassigned + read — must be left exactly as written.
        let out =
            transform("export function g(p) { let x = 1; x = 2; return x + p; }", &opts("g.js"))
                .code;
        assert!(out.contains("let x = 1"), "got: {out}");
        assert!(out.contains("x = 2"), "got: {out}");
        assert!(out.contains("return x + p"), "got: {out}");
    }

    #[test]
    fn mcond_hook_bool_literals() {
        assert!(
            mcond("var b = c ? true : false;").contains("!!c"),
            "got: {}",
            mcond("var b = c ? true : false;")
        );
        assert!(mcond("var b = c ? false : true;").contains("!c"));
    }

    #[test]
    fn strips_types_via_codegen_on_ts_input() {
        // Sanity that TS parses; type-stripping itself is a pass to port.
        let out = transform("export const x: number = 1;\n", &opts("mod.ts"));
        assert!(out.code.contains('x'));
    }

    #[test]
    fn directive_prefilter() {
        assert!(has_directive("/* @inline */ function f(){}"));
        assert!(!has_directive("const x = 1;"));
    }

    fn normalize(src: &str) -> String {
        run_pass("normalize", src, &opts("n.js")).unwrap().code
    }

    #[test]
    fn normalize_arrow_to_block() {
        let out = normalize("const f = (x) => x + 1;\n");
        assert!(out.contains("return x + 1"));
    }

    #[test]
    fn normalize_splits_multi_declarators() {
        let out = normalize("var a = 1, b = 2, c = 3;\n");
        assert_eq!(out.matches("var ").count(), 3, "got: {out}");
    }

    #[test]
    fn normalize_hoists_var_for_init() {
        let out = normalize("for (var i = 0; i < 3; i++) { f(i); }\n");
        // `var i = 0;` is hoisted above the loop, so the for-header has no init.
        assert!(out.contains("var i = 0"), "got: {out}");
        assert!(out.contains("for (; i < 3"), "got: {out}");
    }

    #[test]
    fn normalize_blockifies_if_branch() {
        let out = normalize("if (x) f(); else g();\n");
        assert!(out.contains('{'), "got: {out}");
    }

    #[test]
    fn normalize_leaves_let_for_init() {
        let out = normalize("for (let i = 0; i < 3; i++) { f(i); }\n");
        assert!(out.contains("for (let i = 0"), "got: {out}");
    }
}
