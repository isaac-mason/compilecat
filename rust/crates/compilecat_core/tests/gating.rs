//! Opt-in gating — the Rust home for the old `tst/parity/gating.parity.ts`.
//! The optimization/cleanup tier only touches directive-annotated constructs and
//! their subtrees (including bare `/* @optimize */ { … }` blocks) and leaves
//! everything else byte-identical.

use compilecat_core::{transform, Mode, TransformOptions};

fn compile(code: &str) -> String {
    transform(
        code,
        &TransformOptions {
            filename: "gating.ts".to_string(),
            source_type: None,
            mode: Mode::WholeProgram,
            sourcemap: false,
        },
    )
    .code
}

#[test]
fn leaves_an_un_opted_in_function_untouched() {
    // `hot` opts in (@optimize → sroa); `cold` has no directive, so its `1 + 2`
    // must NOT be folded.
    let out = compile(
        "/* @optimize */ export function hot() { const a = [1, 2, 3]; a[0] = a[1] + a[2]; return a[0]; }\n\
         export function cold(x) { return x + (1 + 2); }",
    );
    assert!(out.contains("1 + 2"), "cold untouched:\n{out}");
    assert!(!out.contains("[1, 2, 3]"), "hot was SROA'd:\n{out}");
}

#[test]
fn scope_opt_in_optimizes_only_the_annotated_block() {
    // The block is opted in; `4 + 5` outside it is not.
    let out = compile(
        "export function f(x) { /* @optimize */ { let a = 1 + 2; sink(a); } return x + (4 + 5); }",
    );
    assert!(!out.contains("1 + 2"), "inside the block: folded:\n{out}");
    assert!(out.contains("4 + 5"), "outside the block: untouched:\n{out}");
}

#[test]
fn does_not_touch_a_nested_function_inside_an_opted_in_one() {
    // `outer` is opted in; the nested `inner` is an independent unit and keeps
    // its `7 + 8` unfolded.
    let out = compile(
        "/* @optimize */ export function outer() { const v = [1, 2]; v[0] = v[1]; function inner() { return 7 + 8; } return v[0] + inner(); }",
    );
    assert!(out.contains("7 + 8"), "nested fn untouched:\n{out}");
}
