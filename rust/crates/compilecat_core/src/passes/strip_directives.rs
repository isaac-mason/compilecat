//! Port of `src/compiler/strip-directive-comments.ts`. Removes authored
//! `@inline`/`@flatten`/`@sroa`/`@unroll`/`@optimize` markers once every pass
//! has consumed them. Runs at the end of the pipeline.
//!
//! Policy: remove just the directive *token*. A
//! marker-only comment (`/* @inline */`, or a JSDoc line that's only the
//! directive) is dropped; a comment with other content keeps that content with
//! the marker removed (`/* @inline foo */` → `/* foo */`; a JSDoc keeps its
//! `@param`/`@returns`, drops the `@optimize` line).
//!
//! Representation note: oxc stores comments span-based — printed text is
//! `source_text[span]`, not an editable field. So to *rewrite* a comment we
//! rebuild `source_text` as `original + cleaned-texts` and repoint the rewritten
//! comment's span into the appended region. The original is an exact prefix, so
//! every other comment/node span stays valid; only rewritten comments read the
//! tail.

use oxc_allocator::{Allocator, TakeIn};
use oxc_ast::ast::Program;
use oxc_ast::AstBuilder;
use oxc_span::Span;

use super::directives::DIRECTIVES;

/// Returns the number of comments removed or rewritten.
pub fn run<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> u32 {
    let src = program.source_text;
    let ast = AstBuilder::new(allocator);

    let taken = program.comments.take_in(allocator);
    let mut kept = ast.vec_with_capacity(taken.len());
    let mut appended = String::new();
    let base = src.len() as u32;
    let mut touched = 0u32;

    for mut c in taken {
        let text = &src[c.span.start as usize..c.span.end as usize];
        if !DIRECTIVES.iter().any(|d| text.contains(d)) {
            kept.push(c);
            continue;
        }
        match clean_comment(text) {
            // Marker-only → drop the comment entirely.
            None => {
                touched += 1;
            }
            Some(cleaned) => {
                // Repoint the span at the cleaned text in the appended region.
                let off = base + appended.len() as u32;
                appended.push_str(&cleaned);
                c.span = Span::new(off, off + cleaned.len() as u32);
                kept.push(c);
                touched += 1;
            }
        }
    }

    program.comments = kept;
    if !appended.is_empty() {
        let mut buf = String::with_capacity(src.len() + appended.len());
        buf.push_str(src);
        buf.push_str(&appended);
        program.source_text = allocator.alloc_str(&buf);
    }
    touched
}

/// Clean a full comment (delimiters included). Returns the rewritten comment
/// text, or `None` if nothing but the marker(s) remained (→ drop the comment).
/// Operates line-by-line: a line that is *only* a directive (plus `*`/space
/// filler) is dropped; a directive removed mid-line collapses the gap it left.
fn clean_comment(full: &str) -> Option<String> {
    let is_block = full.starts_with("/*");
    if !is_block && !full.starts_with("//") {
        return Some(full.to_string());
    }
    let inner = if is_block { &full[2..full.len().saturating_sub(2)] } else { &full[2..] };

    let mut out_lines: Vec<String> = Vec::new();
    for line in inner.split('\n') {
        let had_directive = DIRECTIVES.iter().any(|d| line.contains(d));
        if !had_directive {
            out_lines.push(line.to_string());
            continue;
        }
        let mut l = line.to_string();
        for d in DIRECTIVES {
            l = l.replace(d, "");
        }
        // If the directive line is now only whitespace / `*` filler, drop it.
        if l.chars().all(|ch| ch.is_whitespace() || ch == '*') {
            continue;
        }
        // Otherwise collapse the runs of spaces the removal opened up.
        out_lines.push(collapse_spaces(&l));
    }

    let new_inner = out_lines.join("\n");
    if new_inner.chars().all(|ch| ch.is_whitespace() || ch == '*') {
        return None;
    }
    Some(if is_block { format!("/*{new_inner}*/") } else { format!("//{new_inner}") })
}

/// Collapse runs of spaces/tabs to a single space (leaves newlines alone).
fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for ch in s.chars() {
        let is_space = ch == ' ' || ch == '\t';
        if is_space {
            if !prev_space {
                out.push(' ');
            }
        } else {
            out.push(ch);
        }
        prev_space = is_space;
    }
    out
}
