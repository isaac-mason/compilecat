//! Port of `src/compiler/inline-functions.ts` + `function-injector.ts` +
//! `function-to-block-mutator.ts`.
//!
//! A candidate is a top-level (bare or exported) `function`/`const`-arrow
//! carrying a leading `/* @inline */`, with simple identifier params, not
//! async/generator, no `this`/`arguments`. Each call is replaced by the body:
//!   - **DIRECT** — body is a single `return <expr>;` (or an expression arrow):
//!     params are substituted into `<expr>` and the call expression is replaced.
//!   - **BLOCK** — any other body, *including one with `return`s*: the body is
//!     turned into a statement via `block_mutate` (returns → `result = X; break
//!     LABEL;`) and spliced at the call-site shape (`f();` / `x = f();` /
//!     `let x = f();`). See `block_mutate.rs`.
//!
//! The declaration is removed once no references remain. Member calls
//! (`NS.fn(...)`) are matched via `call_key` for cross-file namespace/object
//! donors.
//!
//! Side-effect safety: a param whose arg may have side effects and is used more
//! than once in a DIRECT body bails that call — and falls back to BLOCK (whose
//! temp prologue evaluates each arg once). Single-return bodies are registered
//! in both maps so the fallback is automatic.
//!
//! α-rename: when an arg references a param name, the param is renamed to
//! `p__<id>` in the body + prologue (not bailed).
//!
//! Candidates are discovered at any scope (top-level or nested). Triggers:
//! decl `@inline`, call-site `/* @inline */ foo()` (inlines a single call to any
//! top-level function), and `@flatten` (a host function whose interior calls all
//! inline, even non-`@inline` callees).

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::ast::*;
use oxc_ast::AstBuilder;
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_span::GetSpan;

use super::block_mutate::{mutate_for_block_inline, BlockMutateInput};
use super::util::is_pure;

pub(crate) struct Candidate<'a> {
    params: Vec<String>,
    /// The return expression (or `undefined`), cloned out of the declaration.
    value: Expression<'a>,
    /// Free variable names in `value` (referenced, not a param). An inline is
    /// bailed when one would be captured by a consumer-local binding of the
    /// same name (see `collect_local_names`).
    free: HashSet<String>,
}

/// Returns `(inlines, targets)` where `targets` is the span-starts of functions
/// that call an `@inline` donor — the (possibly directive-free) consumers whose
/// inlined residue must be opted into the cleanup gate. The cross-file path
/// computes the same set itself (`inline_targets`); the same-file caller folds
/// this into the gate so `@inline` output is flattened like `@optimize`'s.
pub fn run<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    uid: &mut u32,
) -> (u32, HashSet<u32>) {
    // Spans that carry a leading `@inline` comment (comment attaches to the
    // start of the following token = the declaration's span start).
    let inline_spans = super::directives::annotated_spans_with_exports(program, &["@inline"]);
    // `@flatten`/`@optimize` hosts (the latter a combo directive, per directives.ts).
    let flatten_spans = collect_flatten_spans(program);
    if inline_spans.is_empty() && flatten_spans.is_empty() {
        return (0, HashSet::new());
    }

    // Discover top-level candidates — DIRECT (single-return) or BLOCK (void
    // multi-statement). Exported donors are never stripped below (the strip
    // loop only removes bare FunctionDeclarations).
    // Discover `@inline` candidates at ANY scope — `function NAME` and
    // `const NAME = <arrow|function-expr>`, top-level or nested. Each is
    // registered in BOTH maps where applicable: DIRECT is tried first at a call;
    // the BLOCK form is the fallback when DIRECT bails (side-effecting arg used
    // >1) — its temp prologue evaluates each arg once. Outermost name wins.
    let (candidates, block_candidates) = {
        let mut c = CandidateCollector {
            allocator,
            inline_spans: &inline_spans,
            direct: HashMap::new(),
            block: HashMap::new(),
        };
        c.visit_program(program);
        (c.direct, c.block)
    };
    let callsite = has_callsite_annotation(program, &inline_spans);
    if candidates.is_empty() && block_candidates.is_empty() && flatten_spans.is_empty() && !callsite
    {
        return (0, HashSet::new());
    }

    // Functions that call an `@inline` donor — captured BEFORE inlining, while the
    // calls still exist. These are the consumers whose residue must be cleaned
    // even when they carry no directive (see this fn's doc).
    let donor_keys: HashSet<String> =
        candidates.keys().chain(block_candidates.keys()).cloned().collect();
    let targets = functions_calling(program, &donor_keys);

    // ONE program-global counter (`uid`, threaded in by `&mut`) for every
    // inline-generated name across ALL phases (declaration inlining,
    // @optimize/@flatten, call-site) — and, via the caller, across the cross-file
    // donor-inline that precedes this. Each generated `_inl_arg_<n>` /
    // `_compilecat_inline_label_<n>` / `_…__result_<n>` / `p__<n>` is unique by
    // construction, preventing the illegal same-scope redeclaration that
    // `oxc_semantic` conflates (which defeats the block_flatten renamer and yields
    // self-referential consts or cross-slot substitutions). Replaces the old
    // per-phase bases (0 / 1M·k / 2M / 3M).
    let mut count = inline_with(allocator, program, &candidates, &block_candidates, uid);

    // @flatten/@optimize: inline calls *inside* each annotated host, using every
    // top-level function as a candidate (scoped to the host subtree). More
    // aggressive (it descends into nested functions) — fine, our gate is
    // semantic. Cross-file flatten (imported callees) is driven from `cross_file`
    // via the same `gather_all_callables` + `flatten_into_hosts` helpers.
    if !flatten_spans.is_empty() {
        // Process hosts in source order, re-gathering candidates from the *live*
        // program before each one. So when an inner host (e.g. tetrahedron) has
        // already had its own callees inlined, an outer host (simplex, then
        // gjkClosestPoints) clones that fully-inlined definition — resolving a
        // chain of nested calls in a single pass — injecting in source order
        // from live candidate defs (no fixpoint loop;
        // recursion still only ever inlines one level, since the freshly spliced
        // self-call isn't a pre-collected site).
        let host_spans: Vec<u32> = program
            .body
            .iter()
            .filter_map(|s| top_level_function(s).map(|_| s.span().start))
            .filter(|st| flatten_spans.contains(st))
            .collect();
        for span in host_spans {
            let (all_direct, all_block) = gather_all_callables(allocator, program);
            let single: HashSet<u32> = std::iter::once(span).collect();
            count +=
                flatten_into_hosts(allocator, program, &single, &all_direct, &all_block, uid);
        }
    }

    // Call-site `/* @inline */ foo()`: inline calls explicitly annotated at the
    // call site (using all top-level functions as candidates), even callees not
    // declared `@inline`. Guarded so the common no-call-site case pays nothing.
    if callsite {
        let (all_direct, all_block) = gather_all_callables(allocator, program);
        let local_names = Rc::new(collect_local_names(program));
        if !all_direct.is_empty() {
            let mut di = Inliner {
                allocator,
                candidates: &all_direct,
                count: 0,
                next_id: *uid,
                hoists: Vec::new(),
                trigger: Some(inline_spans.clone()),
                local_names: local_names.clone(),
                no_hoist: false,
            };
            di.visit_program(program);
            count += di.count;
            *uid = di.next_id;
        }
        if !all_block.is_empty() {
            let mut bi = BlockInliner {
                allocator,
                candidates: &all_block,
                count: 0,
                next_id: *uid,
                trigger: Some(inline_spans.clone()),
                local_names: local_names.clone(),
            };
            bi.visit_program(program);
            count += bi.count;
            *uid = bi.next_id;
        }
    }

    // Strip declarations that have no remaining references. Only `@inline`
    // candidates (the user opted in); `@flatten`-orphaned callees are left for
    // the dead-code / remove-unused pass — the inline pass must not strip
    // arbitrary unreferenced functions.
    if count > 0 {
        let names: HashSet<String> =
            candidates.keys().chain(block_candidates.keys()).cloned().collect();
        let mut counter = RefCounter { names: names.clone(), counts: HashMap::new() };
        counter.visit_program(program);
        let strip: HashSet<String> = names
            .into_iter()
            .filter(|n| counter.counts.get(n).copied().unwrap_or(0) == 0)
            .collect();
        if !strip.is_empty() {
            // Remove 0-ref candidate FunctionDeclarations at ANY scope — a
            // fully-inlined *nested* `@inline` function is the inline pass's own
            // residue (same reason we strip top-level ones). Only bare
            // FunctionDeclarations match, so exported donors are never stripped.
            let mut sv = StripVisitor { allocator, strip: &strip };
            sv.visit_program(program);
        }
    }

    (count, targets)
}

/// `@flatten`/`@optimize` host spans (each comment's `attached_to`), with
/// exported-decl annotations propagated to the inner function. `@optimize` is a
/// combo directive that implies `@flatten` (per `directives.ts`). `pub(crate)` so
/// the cross-file driver detects the same hosts.
pub(crate) fn collect_flatten_spans(program: &Program) -> HashSet<u32> {
    super::directives::annotated_spans_with_exports(program, &["@flatten", "@optimize"])
}

/// Classify every top-level callable — `function` declarations *and*
/// `const NAME = (…) => …` / `const NAME = function(…){…}` — as both a DIRECT
/// and BLOCK candidate. The candidate set for `@flatten`/`@optimize` and
/// call-site inlining, where *any* callee is eligible (not just `@inline`-marked
/// ones).
pub(crate) fn gather_all_callables<'a>(
    allocator: &'a Allocator,
    program: &Program<'a>,
) -> (HashMap<String, Candidate<'a>>, HashMap<String, BlockCandidate<'a>>) {
    let mut direct = HashMap::new();
    let mut block = HashMap::new();
    for stmt in &program.body {
        // `function NAME(…) {…}` (bare or exported).
        if let Some(f) = top_level_function(stmt) {
            if let Some(id) = &f.id {
                let n = id.name.to_string();
                if let Some(c) = classify_direct(f, allocator) {
                    direct.insert(n.clone(), c);
                }
                if let Some(c) = classify_block(f, allocator) {
                    block.insert(n, c);
                }
            }
            continue;
        }
        // `const NAME = (…) => …` / `const NAME = function(…){…}` (bare or exported).
        if let Some(vd) = var_decl_of(stmt) {
            for d in &vd.declarations {
                let BindingPattern::BindingIdentifier(id) = &d.id else { continue };
                let n = id.name.to_string();
                match &d.init {
                    Some(Expression::ArrowFunctionExpression(a)) => {
                        if let Some(c) = classify_direct_arrow(a, allocator) {
                            direct.insert(n.clone(), c);
                        }
                        if let Some(c) = classify_block_arrow(a, allocator) {
                            block.insert(n, c);
                        }
                    }
                    Some(Expression::FunctionExpression(f)) => {
                        if let Some(c) = classify_direct(f, allocator) {
                            direct.insert(n.clone(), c);
                        }
                        if let Some(c) = classify_block(f, allocator) {
                            block.insert(n, c);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    (direct, block)
}

/// Inline `direct`/`block` candidates into the body of each `@flatten`/`@optimize`
/// host — scoped to the host subtree (unlike `@inline`, which inlines everywhere).
/// Shared by the same-file pass and the cross-file driver; `next_id_base` keeps
/// generated labels disjoint across the two invocations. Returns the inline count.
pub(crate) fn flatten_into_hosts<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    flatten_spans: &HashSet<u32>,
    direct: &HashMap<String, Candidate<'a>>,
    block: &HashMap<String, BlockCandidate<'a>>,
    uid: &mut u32,
) -> u32 {
    if flatten_spans.is_empty() || (direct.is_empty() && block.is_empty()) {
        return 0;
    }
    let mut count = 0;
    for stmt in program.body.iter_mut() {
        if !flatten_spans.contains(&stmt.span().start) {
            continue;
        }
        // Capture guard is scoped to THIS host's own bindings, not the whole
        // program: a donor free var is only at risk of capture if the consumer
        // we splice into binds that name. A program-wide set spuriously bails an
        // inline whenever any unrelated function (or donor module) happens to use
        // the same name as a param/local.
        let local_names = match top_level_function(stmt) {
            Some(f) => Rc::new(host_bound_names(f)),
            None => continue,
        };
        let body = match stmt {
            Statement::FunctionDeclaration(f) => f.body.as_deref_mut(),
            Statement::ExportNamedDeclaration(e) => match &mut e.declaration {
                Some(Declaration::FunctionDeclaration(f)) => f.body.as_deref_mut(),
                _ => None,
            },
            _ => None,
        };
        let Some(body) = body else { continue };
        // All generated temps (DIRECT `_inl_arg_<n>` and BLOCK label/result/param
        // temps) draw from ONE program-global counter `uid`, threaded through every
        // inliner in every phase. This makes every generated name unique BY
        // CONSTRUCTION across phases/functions, so no two same-named temps can ever
        // land in one scope — the only thing that would make `oxc_semantic` conflate
        // them (an illegal redeclaration the block_flatten renamer can't recover,
        // producing self-referential consts / cross-slot substitutions). The
        // counters are advanced sequentially: DIRECT, BLOCK, DIRECT.
        if !direct.is_empty() {
            let mut di = Inliner {
                allocator,
                candidates: direct,
                count: 0,
                next_id: *uid,
                hoists: Vec::new(),
                trigger: None,
                local_names: local_names.clone(),
                no_hoist: false,
            };
            di.visit_function_body(body);
            count += di.count;
            *uid = di.next_id;
        }
        if !block.is_empty() {
            let mut bi = BlockInliner {
                allocator,
                candidates: block,
                count: 0,
                next_id: *uid,
                trigger: None,
                local_names: local_names.clone(),
            };
            bi.visit_function_body(body);
            count += bi.count;
            *uid = bi.next_id;
            // Second DIRECT pass: inline single-return helpers (e.g. `len`) that
            // the BLOCK pass just spliced in from a multi-statement callee's body
            // (`normalize`). A single DIRECT-then-BLOCK ordering leaves those
            // un-inlined, keeping any aggregate they read-whole alive past SROA.
            // One extra pass resolves one level of BLOCK→DIRECT nesting; it can't
            // expand a recursive callee (DIRECT recursion still inlines one level
            // per pass). `uid` continues so arg-binding temps stay unique.
            if !direct.is_empty() {
                let mut di = Inliner {
                    allocator,
                    candidates: direct,
                    count: 0,
                    next_id: *uid,
                    hoists: Vec::new(),
                    trigger: None,
                    local_names: local_names.clone(),
                    no_hoist: false,
                };
                di.visit_function_body(body);
                count += di.count;
                *uid = di.next_id;
            }
        }
    }
    count
}

/// The `Function` of a top-level declaration, whether bare or `export`ed.
pub(crate) fn top_level_function<'b, 'a>(stmt: &'b Statement<'a>) -> Option<&'b Function<'a>> {
    match stmt {
        Statement::FunctionDeclaration(f) => Some(f),
        Statement::ExportNamedDeclaration(e) => match &e.declaration {
            Some(Declaration::FunctionDeclaration(f)) => Some(f),
            _ => None,
        },
        _ => None,
    }
}

/// True if any call expression's span carries a leading annotation (i.e. a
/// call-site `/* @inline */ foo()` exists). Cheap guard before the call-site pass.
fn has_callsite_annotation(program: &Program, spans: &HashSet<u32>) -> bool {
    struct V<'s> {
        spans: &'s HashSet<u32>,
        found: bool,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
            if self.spans.contains(&call.span.start) {
                self.found = true;
            }
            walk::walk_call_expression(self, call);
        }
    }
    let mut v = V { spans, found: false };
    v.visit_program(program);
    v.found
}

/// The `VariableDeclaration` of a statement, whether bare or `export`ed.
fn var_decl_of<'b, 'a>(stmt: &'b Statement<'a>) -> Option<&'b VariableDeclaration<'a>> {
    match stmt {
        Statement::VariableDeclaration(v) => Some(v),
        Statement::ExportNamedDeclaration(e) => match &e.declaration {
            Some(Declaration::VariableDeclaration(v)) => Some(v),
            _ => None,
        },
        _ => None,
    }
}

/// Walks the whole tree collecting `@inline` candidates at any scope —
/// `function NAME` and `const NAME = <arrow|function-expr>`. Outermost name wins
/// (parent statements are considered before descending).
struct CandidateCollector<'a, 'i> {
    allocator: &'a Allocator,
    inline_spans: &'i HashSet<u32>,
    direct: HashMap<String, Candidate<'a>>,
    block: HashMap<String, BlockCandidate<'a>>,
}

impl<'a> Visit<'a> for CandidateCollector<'a, '_> {
    fn visit_statement(&mut self, stmt: &Statement<'a>) {
        self.consider(stmt);
        walk::walk_statement(self, stmt);
    }
}

impl<'a> CandidateCollector<'a, '_> {
    fn consider(&mut self, stmt: &Statement<'a>) {
        if let Some(f) = top_level_function(stmt) {
            if self.inline_spans.contains(&f.span.start) {
                if let Some(id) = &f.id {
                    let name = id.name.to_string();
                    if let Some(c) = classify_direct(f, self.allocator) {
                        self.direct.entry(name.clone()).or_insert(c);
                    }
                    if let Some(c) = classify_block(f, self.allocator) {
                        self.block.entry(name).or_insert(c);
                    }
                }
            }
            return;
        }
        if let Some(v) = var_decl_of(stmt) {
            if !self.inline_spans.contains(&v.span.start) {
                return;
            }
            for d in &v.declarations {
                let BindingPattern::BindingIdentifier(id) = &d.id else { continue };
                let Some(init) = &d.init else { continue };
                let name = id.name.to_string();
                match init {
                    Expression::ArrowFunctionExpression(a) => {
                        if let Some(c) = classify_direct_arrow(a, self.allocator) {
                            self.direct.entry(name.clone()).or_insert(c);
                        }
                        if let Some(c) = classify_block_arrow(a, self.allocator) {
                            self.block.entry(name).or_insert(c);
                        }
                    }
                    Expression::FunctionExpression(f) => {
                        if let Some(c) = classify_direct(f, self.allocator) {
                            self.direct.entry(name.clone()).or_insert(c);
                        }
                        if let Some(c) = classify_block(f, self.allocator) {
                            self.block.entry(name).or_insert(c);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Run the DIRECT + BLOCK inliners with pre-built candidate maps (keyed by the
/// call name). Returns the number of calls inlined. Used by both the local pass
/// (comment-discovered candidates) and cross-file inlining (donor candidates
/// keyed by the consumer's local import name). Does NOT strip declarations —
/// the caller removes local decls / unused imports as appropriate.
pub(crate) fn inline_with<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    direct: &HashMap<String, Candidate<'a>>,
    block: &HashMap<String, BlockCandidate<'a>>,
    uid: &mut u32,
) -> u32 {
    let local_names = Rc::new(collect_local_names(program));
    let mut count = 0;
    if !direct.is_empty() {
        let mut inliner = Inliner {
            allocator,
            candidates: direct,
            count: 0,
            next_id: *uid,
            hoists: Vec::new(),
            trigger: None,
            local_names: local_names.clone(),
            no_hoist: false,
        };
        inliner.visit_program(program);
        count += inliner.count;
        *uid = inliner.next_id;
    }
    if !block.is_empty() {
        let mut bi = BlockInliner {
            allocator,
            candidates: block,
            count: 0,
            next_id: *uid,
            trigger: None,
            local_names: local_names.clone(),
        };
        bi.visit_program(program);
        count += bi.count;
        *uid = bi.next_id;
    }
    count
}

/// DIRECT iff: not async/generator, simple identifier params, body is a single
/// `return <expr>;` (or empty → `undefined`), and the value reads no
/// `this`/`arguments`. Returns the candidate with the value cloned out.
pub(crate) fn classify_direct<'a>(
    f: &Function<'a>,
    allocator: &'a Allocator,
) -> Option<Candidate<'a>> {
    if f.r#async || f.generator {
        return None;
    }
    let mut params = Vec::with_capacity(f.params.items.len());
    for p in &f.params.items {
        let BindingPattern::BindingIdentifier(id) = &p.pattern else {
            return None;
        };
        params.push(id.name.to_string());
    }
    let body = f.body.as_ref()?;
    let value: Expression<'a> = match body.statements.len() {
        0 => AstBuilder::new(allocator).expression_identifier(oxc_span::SPAN, "undefined"),
        1 => {
            let Statement::ReturnStatement(ret) = &body.statements[0] else {
                return None; // multi-effect single statement → BLOCK (deferred)
            };
            let arg = ret.argument.as_ref()?;
            arg.clone_in(allocator)
        }
        _ => return None, // BLOCK mode deferred
    };
    if reads_this_or_arguments(&value) {
        return None;
    }
    let free = free_vars_expr(&value, &params);
    Some(Candidate { params, value, free })
}

// ── BLOCK mode (any body, incl. returns; statement/init/assign positions) ────

pub(crate) struct BlockCandidate<'a> {
    params: Vec<String>,
    /// Cloned body statements (any body — may contain `return`s; `block_mutate`
    /// rewrites them at splice time). Spliced with a `let p = arg` prologue.
    body: Vec<Statement<'a>>,
    /// Free variable names in `body` (referenced, not a param or body-local).
    /// See `Candidate::free`.
    free: HashSet<String>,
}

/// BLOCK iff: not async/generator, simple identifier params, and a body that is
/// `block_body_classifiable` — any statements (incl. `return`s, handled by the
/// mutator) except `this`/`arguments`/`try`/`with`/`yield`/`await`.
pub(crate) fn classify_block<'a>(
    f: &Function<'a>,
    allocator: &'a Allocator,
) -> Option<BlockCandidate<'a>> {
    if f.r#async || f.generator {
        return None;
    }
    let mut params = Vec::with_capacity(f.params.items.len());
    for p in &f.params.items {
        let BindingPattern::BindingIdentifier(id) = &p.pattern else { return None };
        params.push(id.name.to_string());
    }
    let body = f.body.as_ref()?;
    if body.statements.is_empty() || !block_body_classifiable(&body.statements) {
        return None;
    }
    let cloned: Vec<Statement<'a>> =
        body.statements.iter().map(|s| s.clone_in(allocator)).collect();
    let free = free_vars_stmts(&cloned, &params);
    Some(BlockCandidate { params, body: cloned, free })
}

/// DIRECT classification for an arrow / function-expression const initializer
/// (`export const add = (a,b) => a+b`). Expression-body arrows yield their
/// expression directly; block-body arrows follow the single-`return` rule.
pub(crate) fn classify_direct_arrow<'a>(
    arrow: &ArrowFunctionExpression<'a>,
    allocator: &'a Allocator,
) -> Option<Candidate<'a>> {
    if arrow.r#async {
        return None;
    }
    let mut params = Vec::with_capacity(arrow.params.items.len());
    for p in &arrow.params.items {
        let BindingPattern::BindingIdentifier(id) = &p.pattern else { return None };
        params.push(id.name.to_string());
    }
    let body = &arrow.body;
    let value: Expression<'a> = if arrow.expression {
        // `x => expr` is stored as a body with one ExpressionStatement.
        match body.statements.first() {
            Some(Statement::ExpressionStatement(es)) => es.expression.clone_in(allocator),
            _ => return None,
        }
    } else {
        match body.statements.len() {
            1 => {
                let Statement::ReturnStatement(ret) = &body.statements[0] else { return None };
                ret.argument.as_ref()?.clone_in(allocator)
            }
            _ => return None,
        }
    };
    if reads_this_or_arguments(&value) {
        return None;
    }
    let free = free_vars_expr(&value, &params);
    Some(Candidate { params, value, free })
}

/// BLOCK classification for a block-body arrow const initializer (void,
/// multi-statement). Expression-body arrows are DIRECT-only.
pub(crate) fn classify_block_arrow<'a>(
    arrow: &ArrowFunctionExpression<'a>,
    allocator: &'a Allocator,
) -> Option<BlockCandidate<'a>> {
    if arrow.r#async || arrow.expression {
        return None;
    }
    let mut params = Vec::with_capacity(arrow.params.items.len());
    for p in &arrow.params.items {
        let BindingPattern::BindingIdentifier(id) = &p.pattern else { return None };
        params.push(id.name.to_string());
    }
    let body = &arrow.body;
    if body.statements.is_empty() || !block_body_classifiable(&body.statements) {
        return None;
    }
    let cloned: Vec<Statement<'a>> =
        body.statements.iter().map(|s| s.clone_in(allocator)).collect();
    let free = free_vars_stmts(&cloned, &params);
    Some(BlockCandidate { params, body: cloned, free })
}

/// A body is BLOCK-classifiable (with the function-to-block-mutator handling
/// `return`s) unless it reads `this`/`arguments` or contains a construct the
/// mutator can't safely relabel (`try`/`with`/`yield`/`await`). Returns and
/// nested functions are fine — the mutator skips nested functions, and the
/// return-rewriter handles `return` at the top level.
fn block_body_classifiable(stmts: &[Statement]) -> bool {
    !reads_this_or_arguments_stmts(stmts) && !has_unsupported_construct(stmts)
}

/// `this`/`arguments` reads outside a nested non-arrow function (arrows capture
/// the donor's `this`/`arguments`, so we descend into them).
fn reads_this_or_arguments_stmts(stmts: &[Statement]) -> bool {
    struct V {
        found: bool,
    }
    impl<'a> Visit<'a> for V {
        fn visit_this_expression(&mut self, _: &ThisExpression) {
            self.found = true;
        }
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            if id.name == "arguments" {
                self.found = true;
            }
        }
        // Non-arrow functions get their own `this`/`arguments` — don't descend.
        fn visit_function(&mut self, _: &Function<'a>, _: oxc_semantic::ScopeFlags) {}
    }
    let mut v = V { found: false };
    for s in stmts {
        v.visit_statement(s);
    }
    v.found
}

/// `try`/`with`/`yield`/`await` at the donor body's top level (skipping all
/// nested functions, whose control flow comes along verbatim).
fn has_unsupported_construct(stmts: &[Statement]) -> bool {
    struct V {
        found: bool,
    }
    impl<'a> Visit<'a> for V {
        fn visit_try_statement(&mut self, _: &TryStatement<'a>) {
            self.found = true;
        }
        fn visit_with_statement(&mut self, _: &WithStatement<'a>) {
            self.found = true;
        }
        fn visit_yield_expression(&mut self, _: &YieldExpression<'a>) {
            self.found = true;
        }
        fn visit_await_expression(&mut self, _: &AwaitExpression<'a>) {
            self.found = true;
        }
        fn visit_function(&mut self, _: &Function<'a>, _: oxc_semantic::ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _: &ArrowFunctionExpression<'a>) {}
    }
    let mut v = V { found: false };
    for s in stmts {
        v.visit_statement(s);
    }
    v.found
}

struct BlockInliner<'a, 'c> {
    allocator: &'a Allocator,
    candidates: &'c HashMap<String, BlockCandidate<'a>>,
    count: u32,
    /// Fresh id source for generated labels / result temps.
    next_id: u32,
    /// Call-site `/* @inline */` trigger (see `Inliner::trigger`).
    trigger: Option<HashSet<u32>>,
    /// Consumer non-module binding names — a candidate whose free vars collide
    /// with one would be captured after splicing, so it's bailed.
    local_names: Rc<HashSet<String>>,
}

impl<'a> VisitMut<'a> for BlockInliner<'a, '_> {
    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts);

        let ast = AstBuilder::new(self.allocator);
        let taken = std::mem::replace(stmts, ast.vec());
        let mut out = ast.vec_with_capacity(taken.len());
        for stmt in taken {
            match self.try_block_inline(stmt) {
                Ok(replacement) => {
                    for s in replacement {
                        out.push(s);
                    }
                    self.count += 1;
                }
                Err(mut stmt) => {
                    // Not a top-level shape — inline any BLOCK candidate calls
                    // nested in this statement's expressions by hoisting a fresh
                    // result temp + block before the statement.
                    let hoists = self.hoist_expr_calls(&mut stmt);
                    if !hoists.is_empty() {
                        self.count += 1;
                        for h in hoists {
                            out.push(h);
                        }
                    }
                    out.push(stmt);
                }
            }
        }
        *stmts = out;
    }
}

/// What an inlinable statement-position call expands to.
struct BlockPlan<'a> {
    params: Vec<String>,
    body_stmts: Vec<Statement<'a>>,
    args: Vec<Expression<'a>>,
    /// Reused result variable (init/assign shapes); `None` for a discarded
    /// statement-position call.
    result_name: Option<String>,
    /// For `let x = f()` — emit `let x;` before the block.
    emit_let: Option<String>,
}

impl<'a> BlockInliner<'a, '_> {
    /// Inline a BLOCK candidate call at one of the recognized statement shapes
    /// (`f();` / `x = f();` / `let x = f();`). Returns the replacement
    /// statement(s), or the original statement back if it isn't such a call.
    fn try_block_inline(
        &mut self,
        stmt: Statement<'a>,
    ) -> Result<Vec<Statement<'a>>, Statement<'a>> {
        // Allocate the id up front so α-renamed params share the inline's suffix;
        // only consume it (bump) when we actually inline.
        let id = self.next_id;
        let Some(plan) = self.plan_for(&stmt, id) else { return Err(stmt) };
        self.next_id += 1;
        let needs_result = plan.result_name.is_some();
        let out = mutate_for_block_inline(
            self.allocator,
            BlockMutateInput {
                body_stmts: plan.body_stmts,
                params: plan.params,
                args: plan.args,
                label: format!("_compilecat_inline_label_{id}"),
                result_name: plan.result_name.unwrap_or_default(),
                needs_result,
            },
        );

        let ast = AstBuilder::new(self.allocator);
        let mut result = Vec::with_capacity(2);
        if let Some(name) = &plan.emit_let {
            let nm: &'a str = self.allocator.alloc_str(name);
            let bid = ast.binding_pattern_binding_identifier(oxc_span::SPAN, nm);
            let declr = ast.variable_declarator(
                oxc_span::SPAN,
                VariableDeclarationKind::Let,
                bid,
                oxc_ast::NONE,
                None,
                false,
            );
            result.push(Statement::VariableDeclaration(ast.alloc(ast.variable_declaration(
                oxc_span::SPAN,
                VariableDeclarationKind::Let,
                ast.vec1(declr),
                false,
            ))));
        }
        result.push(out.block);
        Ok(result)
    }

    /// Recognize the call-site shape and build an owned plan (no borrow of the
    /// statement survives) — `f();` (discard), `x = f();`, `let x = f();`.
    fn plan_for(&self, stmt: &Statement<'a>, id: u32) -> Option<BlockPlan<'a>> {
        match stmt {
            Statement::ExpressionStatement(es) => match &es.expression {
                Expression::CallExpression(call) => {
                    let cand = self.candidates.get(call_key(call)?.as_str())?;
                    self.make_plan(call, cand, None, None, id)
                }
                Expression::AssignmentExpression(asn)
                    if asn.operator == AssignmentOperator::Assign =>
                {
                    let AssignmentTarget::AssignmentTargetIdentifier(target) = &asn.left else {
                        return None;
                    };
                    let Expression::CallExpression(call) = &asn.right else { return None };
                    let cand = self.candidates.get(call_key(call)?.as_str())?;
                    self.make_plan(call, cand, Some(target.name.to_string()), None, id)
                }
                _ => None,
            },
            Statement::VariableDeclaration(vd) => {
                if vd.declarations.len() != 1 {
                    return None;
                }
                if !matches!(vd.kind, VariableDeclarationKind::Let | VariableDeclarationKind::Var) {
                    return None;
                }
                let d = &vd.declarations[0];
                let BindingPattern::BindingIdentifier(bid) = &d.id else { return None };
                let Some(Expression::CallExpression(call)) = &d.init else { return None };
                let cand = self.candidates.get(call_key(call)?.as_str())?;
                let name = bid.name.to_string();
                self.make_plan(call, cand, Some(name.clone()), Some(name), id)
            }
            _ => None,
        }
    }

    fn make_plan(
        &self,
        call: &CallExpression<'a>,
        cand: &BlockCandidate<'a>,
        result_name: Option<String>,
        emit_let: Option<String>,
        id: u32,
    ) -> Option<BlockPlan<'a>> {
        if !triggered(&self.trigger, call) {
            return None;
        }
        build_block_plan(self.allocator, call, cand, result_name, emit_let, &self.local_names, id)
    }

    /// Inline BLOCK candidate calls nested in `stmt`'s expressions, returning the
    /// `let _result; <block>` statements to hoist before `stmt` (in evaluation
    /// order). Each such call is replaced in place by its result temp.
    fn hoist_expr_calls(&mut self, stmt: &mut Statement<'a>) -> Vec<Statement<'a>> {
        let mut h = ExprHoister {
            allocator: self.allocator,
            candidates: self.candidates,
            next_id: self.next_id,
            trigger: self.trigger.clone(),
            local_names: self.local_names.clone(),
            hoists: Vec::new(),
            no_hoist: false,
        };
        // Only this statement's own once-evaluated expressions — NOT nested
        // statement bodies. A nested body (block / loop body / if branch / case)
        // is its own statement list that the BlockInliner recurses into; hoisting
        // a call out of it would lift it past the bindings in scope there (e.g.
        // a helper call inside `for(){ let e = …; helper(e) }` must not move
        // above the loop, out of `e`'s scope).
        h.hoist_in_statement(stmt);
        self.next_id = h.next_id;
        h.hoists
    }
}

/// Hoists BLOCK candidate calls in arbitrary expression position
/// (`return f(x) + 1`, `g(f(x))`): each becomes `let _result_n; <block>` emitted
/// before the enclosing statement, with the call replaced by `_result_n`.
struct ExprHoister<'a, 'c> {
    allocator: &'a Allocator,
    candidates: &'c HashMap<String, BlockCandidate<'a>>,
    next_id: u32,
    trigger: Option<HashSet<u32>>,
    local_names: Rc<HashSet<String>>,
    hoists: Vec<Statement<'a>>,
    /// Set inside a conditionally-evaluated sub-expression (a `?:` branch, or the
    /// short-circuit RHS of `&&`/`||`/`??`). A BLOCK inline hoists the call's body
    /// to a statement BEFORE the enclosing statement — i.e. UNCONDITIONALLY — so
    /// hoisting a call that the source only evaluates conditionally changes
    /// behavior (runs side effects that shouldn't fire; diverges for a recursive
    /// helper the branch never reaches). While set, leave such calls un-inlined.
    no_hoist: bool,
}

impl<'a> ExprHoister<'a, '_> {
    /// Hoist block-candidate calls from a statement's **own** expressions only —
    /// positions that execute exactly once in the statement's normal flow. Loop
    /// headers (per-iteration) and all nested statement bodies are intentionally
    /// excluded: the former would change evaluation count, the latter belong to
    /// their own statement list (handled by the BlockInliner's recursion).
    fn hoist_in_statement(&mut self, stmt: &mut Statement<'a>) {
        match stmt {
            Statement::ExpressionStatement(es) => self.visit_expression(&mut es.expression),
            Statement::ReturnStatement(r) => {
                if let Some(a) = r.argument.as_mut() {
                    self.visit_expression(a);
                }
            }
            Statement::ThrowStatement(t) => self.visit_expression(&mut t.argument),
            Statement::VariableDeclaration(vd) => {
                for d in vd.declarations.iter_mut() {
                    if let Some(init) = d.init.as_mut() {
                        self.visit_expression(init);
                    }
                }
            }
            Statement::IfStatement(s) => self.visit_expression(&mut s.test),
            Statement::SwitchStatement(s) => self.visit_expression(&mut s.discriminant),
            Statement::ForInStatement(s) => self.visit_expression(&mut s.right),
            Statement::ForOfStatement(s) => self.visit_expression(&mut s.right),
            _ => {}
        }
    }
}

impl<'a> VisitMut<'a> for ExprHoister<'a, '_> {
    // Nested functions/arrows own their statement scope — their calls are hoisted
    // by the BlockInliner's own visit_statements when it recurses into them.
    fn visit_function(&mut self, _: &mut Function<'a>, _: oxc_semantic::ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _: &mut ArrowFunctionExpression<'a>) {}

    // A `?:` evaluates the test unconditionally, but each branch only when chosen.
    fn visit_conditional_expression(&mut self, c: &mut ConditionalExpression<'a>) {
        self.visit_expression(&mut c.test);
        let saved = self.no_hoist;
        self.no_hoist = true;
        self.visit_expression(&mut c.consequent);
        self.visit_expression(&mut c.alternate);
        self.no_hoist = saved;
    }

    // `&&`/`||`/`??` evaluate the left unconditionally, the right only on the
    // non-short-circuit path.
    fn visit_logical_expression(&mut self, l: &mut LogicalExpression<'a>) {
        self.visit_expression(&mut l.left);
        let saved = self.no_hoist;
        self.no_hoist = true;
        self.visit_expression(&mut l.right);
        self.no_hoist = saved;
    }

    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expr); // inner calls hoist first (eval order)

        // Inside a conditionally-evaluated position: leave the call un-inlined
        // (hoisting it would run the block UNconditionally — unsound).
        if self.no_hoist {
            return;
        }

        let id = self.next_id;
        // Result-temp name: `_<callee>__result_<id>` reads as "the value of
        // <callee>" (anon callee → `_result_<id>`), instead of an opaque
        // `_compilecat_result_<id>`.
        let result = match &*expr {
            Expression::CallExpression(call) => match callee_simple_name(call) {
                Some(n) => format!("_{n}__result_{id}"),
                None => format!("_result_{id}"),
            },
            _ => format!("_result_{id}"),
        };
        let plan = match &*expr {
            Expression::CallExpression(call) if triggered(&self.trigger, call) => {
                call_key(call).and_then(|k| self.candidates.get(k.as_str())).and_then(|cand| {
                    build_block_plan(
                        self.allocator,
                        call,
                        cand,
                        Some(result.clone()),
                        None,
                        &self.local_names,
                        id,
                    )
                })
            }
            _ => None,
        };
        let Some(plan) = plan else { return };
        self.next_id += 1;

        let out = mutate_for_block_inline(
            self.allocator,
            BlockMutateInput {
                body_stmts: plan.body_stmts,
                params: plan.params,
                args: plan.args,
                label: format!("_compilecat_inline_label_{id}"),
                result_name: result.clone(),
                needs_result: true,
            },
        );

        let ast = AstBuilder::new(self.allocator);
        let rn: &'a str = self.allocator.alloc_str(&result);
        let bid = ast.binding_pattern_binding_identifier(oxc_span::SPAN, rn);
        let declr = ast.variable_declarator(
            oxc_span::SPAN,
            VariableDeclarationKind::Let,
            bid,
            oxc_ast::NONE,
            None,
            false,
        );
        self.hoists.push(Statement::VariableDeclaration(ast.alloc(ast.variable_declaration(
            oxc_span::SPAN,
            VariableDeclarationKind::Let,
            ast.vec1(declr),
            false,
        ))));
        self.hoists.push(out.block);
        *expr = ast.expression_identifier(oxc_span::SPAN, rn);
    }
}

/// Build the splice plan for a BLOCK candidate call: arg clones (padded with
/// `undefined`), α-rename of params an arg references, the cloned (renamed) body,
/// and the chosen result name. Shared by statement-shape inlining and the
/// expression-position hoister.
fn build_block_plan<'a>(
    allocator: &'a Allocator,
    call: &CallExpression<'a>,
    cand: &BlockCandidate<'a>,
    result_name: Option<String>,
    emit_let: Option<String>,
    local_names: &HashSet<String>,
    id: u32,
) -> Option<BlockPlan<'a>> {
    if call.arguments.iter().any(Argument::is_spread) {
        return None;
    }
    if call.arguments.len() > cand.params.len() {
        return None;
    }
    // Capture guard: a donor free var that collides with a consumer-local
    // binding would be captured after splicing (e.g. donor reads module `base`,
    // consumer has `let base`) — bail rather than miscompile.
    if !cand.free.is_disjoint(local_names) {
        return None;
    }
    // Shadow guard: the α-rename below is not shadow-aware, so bail if the body
    // re-declares a param name in a nested scope (see `stmts_shadow_params`).
    {
        let pset: HashSet<&str> = cand.params.iter().map(String::as_str).collect();
        if stmts_shadow_params(&cand.body, &pset) {
            return None;
        }
    }
    // α-rename EVERY param to a per-expansion-unique `p__<id>` (the same `id` that
    // suffixes the result-temp/label). Two reasons, both correctness:
    //   1. Two inlines of the SAME helper would otherwise both bind the raw param
    //      name (`let b = …`). Once minimize-exit-points unwraps the inline
    //      label-blocks into the parent scope, those become duplicate same-scope
    //      `let b`s, which `oxc_semantic` conflates into ONE symbol — corrupting
    //      every symbol-keyed pass (inline-variables substituted one call's value
    //      into both). The `id` suffix makes each expansion's bindings distinct.
    //   2. It subsumes the old TDZ guard: when an arg references the param name
    //      (`h(b)` into param `b` → `let b = b`), `let b__id = b` reads the
    //      consumer's `b`, no self-capture.
    // Single-use temps still fold away in inline-variables; the suffix only
    // survives on genuinely multi-use params (rare), consistent with the
    // result-temp/label naming already in the output.
    let mut params = cand.params.clone();
    let mut renames: HashMap<String, String> = HashMap::new();
    for p in params.iter_mut() {
        let fresh = format!("{p}__{id}");
        renames.insert(p.clone(), fresh.clone());
        *p = fresh;
    }
    // Reusing an existing var as the result temp is unsafe if the body has a free
    // read of that name — bail (only relevant for init/assign shapes).
    if let Some(rn) = &result_name {
        if body_references_name(&cand.body, rn) {
            return None;
        }
    }

    let ast = AstBuilder::new(allocator);
    let mut args = Vec::with_capacity(cand.params.len());
    for i in 0..cand.params.len() {
        let e = match call.arguments.get(i) {
            Some(a) => a.to_expression().clone_in(allocator),
            None => ast.expression_identifier(oxc_span::SPAN, "undefined"),
        };
        args.push(e);
    }
    let mut body_stmts: Vec<Statement<'a>> =
        cand.body.iter().map(|s| s.clone_in(allocator)).collect();
    if !renames.is_empty() {
        let mut r = Renamer { allocator, map: &renames };
        for s in body_stmts.iter_mut() {
            r.visit_statement(s);
        }
    }

    // #1 — substitute simple (identifier/literal) args directly for params that
    // aren't reassigned in the body, instead of emitting a `let p = arg` alias
    // the cleanup passes don't remove. Modified params and non-simple/side-
    // effecting args keep the temp prologue (eval-once + reassignment safety).
    let modified = modified_params(&body_stmts, &params);
    let mut subs: HashMap<String, Expression<'a>> = HashMap::new();
    let mut temp_params = Vec::with_capacity(params.len());
    let mut temp_args = Vec::with_capacity(params.len());
    for (p, arg) in params.into_iter().zip(args.into_iter()) {
        if is_simple_arg(&arg) && !modified.contains(&p) {
            subs.insert(p, arg);
        } else {
            temp_params.push(p);
            temp_args.push(arg);
        }
    }
    if !subs.is_empty() {
        let mut s = OwnedSubstitutor { allocator, subs: &subs };
        for st in body_stmts.iter_mut() {
            s.visit_statement(st);
        }
    }

    Some(BlockPlan { params: temp_params, body_stmts, args: temp_args, result_name, emit_let })
}

/// An arg cheap + side-effect-free enough to substitute directly (vs a temp):
/// bare identifiers and primitive literals. Re-reading them N times is safe.
fn is_simple_arg(e: &Expression) -> bool {
    matches!(
        e,
        Expression::Identifier(_)
            | Expression::NumericLiteral(_)
            | Expression::StringLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::BigIntLiteral(_)
    )
}

/// An arg safe to *duplicate* into N use sites: `is_pure`, plus static/computed/
/// private member *reads* and pure combinations of them. Excludes anything with
/// a side effect (call/`new`/assign) or fresh identity (array/object/regex/
/// class literal), so the only thing being re-evaluated is a property read —
/// sound to duplicate when the surrounding body is side-effect-free (see the
/// DIRECT arg check). Member-read purity assumes getters are side-effect-free,
/// (getters are assumed side-effect-free).
fn is_pure_with_member_reads(e: &Expression) -> bool {
    if is_pure(e) {
        return true;
    }
    match e {
        Expression::StaticMemberExpression(m) => is_pure_with_member_reads(&m.object),
        Expression::PrivateFieldExpression(m) => is_pure_with_member_reads(&m.object),
        Expression::ComputedMemberExpression(m) => {
            is_pure_with_member_reads(&m.object) && is_pure_with_member_reads(&m.expression)
        }
        Expression::UnaryExpression(u) => {
            !matches!(u.operator, UnaryOperator::Delete) && is_pure_with_member_reads(&u.argument)
        }
        Expression::BinaryExpression(b) => {
            !matches!(b.operator, BinaryOperator::In | BinaryOperator::Instanceof)
                && is_pure_with_member_reads(&b.left)
                && is_pure_with_member_reads(&b.right)
        }
        Expression::LogicalExpression(l) => {
            is_pure_with_member_reads(&l.left) && is_pure_with_member_reads(&l.right)
        }
        Expression::ConditionalExpression(c) => {
            is_pure_with_member_reads(&c.test)
                && is_pure_with_member_reads(&c.consequent)
                && is_pure_with_member_reads(&c.alternate)
        }
        Expression::SequenceExpression(s) => s.expressions.iter().all(is_pure_with_member_reads),
        _ => false,
    }
}

/// True if evaluating `e` produces no observable side effect: no call, `new`,
/// assignment, update (`++`), `delete`, `await`, `yield`, tagged template, or
/// dynamic `import`. Member reads ARE allowed (getter assumed pure). Nested
/// function/arrow bodies don't execute on evaluation, so they're skipped. Used
/// to decide whether re-evaluating a duplicated member-read arg N times across
/// the body is equivalent to evaluating it once.
fn is_side_effect_free(e: &Expression) -> bool {
    struct V {
        ok: bool,
    }
    impl<'a> Visit<'a> for V {
        fn visit_function(&mut self, _: &Function<'a>, _: oxc_semantic::ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _: &ArrowFunctionExpression<'a>) {}
        fn visit_expression(&mut self, e: &Expression<'a>) {
            if !self.ok {
                return;
            }
            match e {
                Expression::CallExpression(_)
                | Expression::NewExpression(_)
                | Expression::AwaitExpression(_)
                | Expression::YieldExpression(_)
                | Expression::AssignmentExpression(_)
                | Expression::UpdateExpression(_)
                | Expression::TaggedTemplateExpression(_)
                | Expression::ImportExpression(_) => {
                    self.ok = false;
                    return;
                }
                Expression::UnaryExpression(u) if u.operator == UnaryOperator::Delete => {
                    self.ok = false;
                    return;
                }
                _ => {}
            }
            walk::walk_expression(self, e);
        }
    }
    let mut v = V { ok: true };
    v.visit_expression(e);
    v.ok
}

/// Param names reassigned (`p = …`, `p++`) anywhere in the body — these need a
/// temp (substituting a literal/identifier and then reassigning it would be
/// invalid or would clobber the consumer's variable).
fn modified_params(stmts: &[Statement], params: &[String]) -> HashSet<String> {
    struct V<'p> {
        params: &'p [String],
        modified: HashSet<String>,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_assignment_target(&mut self, t: &AssignmentTarget<'a>) {
            if let AssignmentTarget::AssignmentTargetIdentifier(id) = t {
                if self.params.iter().any(|p| p == id.name.as_str()) {
                    self.modified.insert(id.name.to_string());
                }
            }
            walk::walk_assignment_target(self, t);
        }
        fn visit_update_expression(&mut self, u: &UpdateExpression<'a>) {
            if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = &u.argument {
                if self.params.iter().any(|p| p == id.name.as_str()) {
                    self.modified.insert(id.name.to_string());
                }
            }
            walk::walk_update_expression(self, u);
        }
    }
    let mut v = V { params, modified: HashSet::new() };
    for s in stmts {
        v.visit_statement(s);
    }
    v.modified
}

/// Substitutes `name → owned expression` (cloned per use). Used by #1 to inline
/// simple args directly into a BLOCK body.
struct OwnedSubstitutor<'a, 's> {
    allocator: &'a Allocator,
    subs: &'s HashMap<String, Expression<'a>>,
}

impl<'a> VisitMut<'a> for OwnedSubstitutor<'a, '_> {
    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        if let Expression::Identifier(id) = &*expr {
            if let Some(rep) = self.subs.get(id.name.as_str()) {
                *expr = rep.clone_in(self.allocator);
                return;
            }
        }
        walk_mut::walk_expression(self, expr);
    }
}

/// Renames identifier references per `map` (α-rename of collided params). Matches
/// the codebase's existing substitution approximation — does not descend-skip a
/// nested scope that shadows the name; fine because renamed targets are fresh
/// `p__<id>` names that real code won't shadow.
struct Renamer<'a, 'r> {
    allocator: &'a Allocator,
    map: &'r HashMap<String, String>,
}

impl<'a> VisitMut<'a> for Renamer<'a, '_> {
    fn visit_identifier_reference(&mut self, id: &mut IdentifierReference<'a>) {
        if let Some(fresh) = self.map.get(id.name.as_str()) {
            let nm: &'a str = self.allocator.alloc_str(fresh);
            id.name = nm.into();
        }
    }
}

/// True if any `params` name is RE-DECLARED by a binding inside the visited
/// subtree (a nested `let`/`const`/`var`, a nested function/arrow param, a
/// function/class name, a catch param, …). The α-rename (`Renamer`/
/// `OwnedSubstitutor`) rewrites identifier references by NAME and is NOT
/// shadow-aware, so renaming/substituting a param whose name is shadowed inside
/// the body would corrupt the inner binding's references (e.g.
/// `function h(b){ let r; { let b = 5; r = b; } return r + b; }` — the inner
/// `r = b` must keep reading the inner `b`, not the renamed param). Callers bail
/// the inline in that case: correct, and the shadow-helper pattern is rare.
/// `visit_binding_identifier` fires for every binding form, and callers visit
/// only the body/value (never the param list), so any hit is a nested re-decl.
struct ShadowDetector<'p> {
    params: &'p HashSet<&'p str>,
    found: bool,
}
impl<'a> Visit<'a> for ShadowDetector<'_> {
    fn visit_binding_identifier(&mut self, id: &oxc_ast::ast::BindingIdentifier<'a>) {
        if self.params.contains(id.name.as_str()) {
            self.found = true;
        }
    }
}

fn stmts_shadow_params(stmts: &[Statement], params: &HashSet<&str>) -> bool {
    if params.is_empty() {
        return false;
    }
    let mut d = ShadowDetector { params, found: false };
    for s in stmts {
        d.visit_statement(s);
    }
    d.found
}

fn expr_shadows_params(e: &Expression, params: &HashSet<&str>) -> bool {
    if params.is_empty() {
        return false;
    }
    let mut d = ShadowDetector { params, found: false };
    d.visit_expression(e);
    d.found
}

/// Any free read of `name` in `stmts` (conservative — ignores shadowing, so a
/// false positive only causes a safe bail).
fn body_references_name(stmts: &[Statement], name: &str) -> bool {
    struct V<'n> {
        name: &'n str,
        found: bool,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            if id.name == self.name {
                self.found = true;
            }
        }
    }
    let mut v = V { name, found: false };
    for s in stmts {
        v.visit_statement(s);
    }
    v.found
}

/// The lookup key for a call site: a plain `fn(...)` keys on `"fn"`; a member
/// call `obj.fn(...)` keys on `"obj.fn"` (how cross-file registers namespace /
/// object donors, e.g. `vec3.add`). Other callee shapes don't inline.
fn call_key(call: &CallExpression) -> Option<String> {
    match &call.callee {
        Expression::Identifier(id) => Some(id.name.to_string()),
        Expression::StaticMemberExpression(m) => match &m.object {
            Expression::Identifier(obj) => Some(format!("{}.{}", obj.name, m.property.name)),
            _ => None,
        },
        _ => None,
    }
}

/// The callee's simple function name for a result-temp name (`f()` → `f`,
/// `vec3.copy()` → `copy` — the inlined function). `None` for anything else.
fn callee_simple_name<'c>(call: &'c CallExpression) -> Option<&'c str> {
    match &call.callee {
        Expression::Identifier(id) => Some(id.name.as_str()),
        Expression::StaticMemberExpression(m) => Some(m.property.name.as_str()),
        _ => None,
    }
}

/// Span-starts of the innermost functions whose body contains a call whose
/// `call_key` is in `keys` — the inline *targets*, recorded BEFORE inlining (the
/// calls vanish after). Lets the cross-file `@inline` path mark an otherwise
/// undirected consumer function `touched` so its inlined residue gets cleaned.
pub(crate) fn functions_calling(program: &Program, keys: &HashSet<String>) -> HashSet<u32> {
    use oxc_ast_visit::{walk as iwalk, Visit};
    struct V<'k> {
        keys: &'k HashSet<String>,
        stack: Vec<u32>,
        hit: HashSet<u32>,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_function(&mut self, f: &Function<'a>, flags: oxc_semantic::ScopeFlags) {
            self.stack.push(f.span.start);
            iwalk::walk_function(self, f, flags);
            self.stack.pop();
        }
        fn visit_arrow_function_expression(&mut self, a: &ArrowFunctionExpression<'a>) {
            self.stack.push(a.span.start);
            iwalk::walk_arrow_function_expression(self, a);
            self.stack.pop();
        }
        fn visit_call_expression(&mut self, c: &CallExpression<'a>) {
            if let Some(k) = call_key(c) {
                if self.keys.contains(&k) {
                    if let Some(&s) = self.stack.last() {
                        self.hit.insert(s);
                    }
                }
            }
            iwalk::walk_call_expression(self, c);
        }
    }
    let mut v = V { keys, stack: Vec::new(), hit: HashSet::new() };
    v.visit_program(program);
    v.hit
}

fn collect_names(e: &Expression, out: &mut HashSet<String>) {
    struct V<'o> {
        out: &'o mut HashSet<String>,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            self.out.insert(id.name.to_string());
        }
    }
    let mut v = V { out };
    v.visit_expression(e);
}

/// Free variable names of a DIRECT value: identifier references minus params.
/// (Nested-arrow params are over-counted as free — a rare, safe over-bail.)
fn free_vars_expr(value: &Expression, params: &[String]) -> HashSet<String> {
    let mut names = HashSet::new();
    collect_names(value, &mut names);
    for p in params {
        names.remove(p);
    }
    names
}

/// Free variable names of a BLOCK body: identifier references minus params and
/// the body's *top-level* declarations. Names declared only in a nested block
/// stay "free" (a safe over-bail), so a real outer capture is never missed.
fn free_vars_stmts(stmts: &[Statement], params: &[String]) -> HashSet<String> {
    let mut fc = FreeCollector { free: HashSet::new(), scopes: Vec::new() };
    // Function scope of the candidate: params + hoisted `var`s + the body's own
    // block-scoped (`let`/`const`/`class`/function) declarations.
    let mut fs: HashSet<String> = params.iter().cloned().collect();
    hoist_vars(stmts, &mut fs);
    block_scoped_names(stmts, &mut fs);
    fc.scopes.push(fs);
    for s in stmts {
        fc.visit_statement(s);
    }
    fc.free
}

/// A reference is free iff no enclosing scope (function, block, loop header,
/// catch) within the candidate binds it. Mirrors lexical scoping so a donor's
/// own block-scoped locals (`let x` inside an `if`) are NOT mistaken for free
/// vars — which would otherwise spuriously collide with a host local of the
/// same name and bail the inline.
struct FreeCollector {
    free: HashSet<String>,
    scopes: Vec<HashSet<String>>,
}

impl FreeCollector {
    fn bound(&self, name: &str) -> bool {
        self.scopes.iter().any(|s| s.contains(name))
    }
    fn params_scope(params: &FormalParameters) -> HashSet<String> {
        let mut s = HashSet::new();
        for p in &params.items {
            collect_binding_names(&p.pattern, &mut s);
        }
        // A `...rest` param is left out (rare); at worst it over-counts a free
        // var named like the rest binding — conservative, never a miscompile.
        s
    }
}

impl<'a> Visit<'a> for FreeCollector {
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if !self.bound(id.name.as_str()) {
            self.free.insert(id.name.to_string());
        }
    }
    fn visit_block_statement(&mut self, b: &BlockStatement<'a>) {
        let mut s = HashSet::new();
        block_scoped_names(&b.body, &mut s);
        self.scopes.push(s);
        walk::walk_block_statement(self, b);
        self.scopes.pop();
    }
    fn visit_function_body(&mut self, b: &FunctionBody<'a>) {
        let mut s = HashSet::new();
        hoist_vars(&b.statements, &mut s);
        block_scoped_names(&b.statements, &mut s);
        self.scopes.push(s);
        walk::walk_function_body(self, b);
        self.scopes.pop();
    }
    fn visit_function(&mut self, f: &Function<'a>, flags: oxc_semantic::ScopeFlags) {
        let s = Self::params_scope(&f.params);
        self.scopes.push(s);
        walk::walk_function(self, f, flags);
        self.scopes.pop();
    }
    fn visit_arrow_function_expression(&mut self, a: &ArrowFunctionExpression<'a>) {
        let s = Self::params_scope(&a.params);
        self.scopes.push(s);
        walk::walk_arrow_function_expression(self, a);
        self.scopes.pop();
    }
    fn visit_for_statement(&mut self, f: &ForStatement<'a>) {
        let mut s = HashSet::new();
        if let Some(ForStatementInit::VariableDeclaration(vd)) = &f.init {
            for d in &vd.declarations {
                collect_binding_names(&d.id, &mut s);
            }
        }
        self.scopes.push(s);
        walk::walk_for_statement(self, f);
        self.scopes.pop();
    }
    fn visit_for_in_statement(&mut self, f: &ForInStatement<'a>) {
        let mut s = HashSet::new();
        if let ForStatementLeft::VariableDeclaration(vd) = &f.left {
            for d in &vd.declarations {
                collect_binding_names(&d.id, &mut s);
            }
        }
        self.scopes.push(s);
        walk::walk_for_in_statement(self, f);
        self.scopes.pop();
    }
    fn visit_for_of_statement(&mut self, f: &ForOfStatement<'a>) {
        let mut s = HashSet::new();
        if let ForStatementLeft::VariableDeclaration(vd) = &f.left {
            for d in &vd.declarations {
                collect_binding_names(&d.id, &mut s);
            }
        }
        self.scopes.push(s);
        walk::walk_for_of_statement(self, f);
        self.scopes.pop();
    }
    fn visit_catch_clause(&mut self, c: &CatchClause<'a>) {
        let mut s = HashSet::new();
        if let Some(param) = &c.param {
            collect_binding_names(&param.pattern, &mut s);
        }
        self.scopes.push(s);
        walk::walk_catch_clause(self, c);
        self.scopes.pop();
    }
}

/// `var` names declared anywhere in `stmts` except inside nested functions
/// (function-scoped, hoisted to the enclosing function).
fn hoist_vars(stmts: &[Statement], out: &mut HashSet<String>) {
    struct V<'o> {
        out: &'o mut HashSet<String>,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_variable_declaration(&mut self, vd: &VariableDeclaration<'a>) {
            if vd.kind == VariableDeclarationKind::Var {
                for d in &vd.declarations {
                    collect_binding_names(&d.id, self.out);
                }
            }
        }
        fn visit_function(&mut self, _f: &Function<'a>, _: oxc_semantic::ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {}
    }
    let mut v = V { out };
    for s in stmts {
        v.visit_statement(s);
    }
}

/// `let`/`const`/`class`/function-declaration names declared directly in this
/// statement list (one block level, not nested blocks).
fn block_scoped_names(stmts: &[Statement], out: &mut HashSet<String>) {
    for s in stmts {
        match s {
            Statement::VariableDeclaration(v) if v.kind != VariableDeclarationKind::Var => {
                for d in &v.declarations {
                    collect_binding_names(&d.id, out);
                }
            }
            Statement::FunctionDeclaration(f) => {
                if let Some(id) = &f.id {
                    out.insert(id.name.to_string());
                }
            }
            Statement::ClassDeclaration(c) => {
                if let Some(id) = &c.id {
                    out.insert(id.name.to_string());
                }
            }
            _ => {}
        }
    }
}

/// All binding identifiers in a pattern (handles destructuring).
fn collect_binding_names(pattern: &BindingPattern, out: &mut HashSet<String>) {
    struct V<'o> {
        out: &'o mut HashSet<String>,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_binding_identifier(&mut self, id: &BindingIdentifier<'a>) {
            self.out.insert(id.name.to_string());
        }
    }
    let mut v = V { out };
    v.visit_binding_pattern(pattern);
}

/// Names bound in any NON-module scope of `program` — function/arrow params, and
/// `var`/`let`/`const`/catch bindings inside functions, at any nesting. A donor
/// free var colliding with one of these would be captured by the consumer
/// binding after splicing, so such an inline is bailed.
///
/// A *top-level* function/class declaration name is module-scoped and safe for a
/// donor to reference (no capture), so those are not collected. A *nested*
/// declaration name, however, is a real local that can capture — those ARE
/// collected (class ids via the default `visit_class` walk; function ids
/// explicitly below, since `visit_function` controls its own descent).
/// Names bound *within* a single host function — its params plus every
/// binding (local, nested param, nested function/class name) inside its body.
/// This is the capture set for inlining into that host: a donor free var can
/// only be captured if the host itself binds the same name. Scoped per-host so
/// unrelated functions (and donor modules in the per-file build) don't trigger
/// spurious bails. Conservatively includes nested-scope bindings (a safe
/// over-approximation — never a miscompile).
fn host_bound_names(f: &Function) -> HashSet<String> {
    struct V {
        names: HashSet<String>,
    }
    impl<'a> Visit<'a> for V {
        fn visit_binding_identifier(&mut self, id: &BindingIdentifier<'a>) {
            self.names.insert(id.name.to_string());
        }
    }
    let mut v = V { names: HashSet::new() };
    walk::walk_formal_parameters(&mut v, &f.params);
    if let Some(body) = &f.body {
        v.visit_function_body(body);
    }
    v.names
}

fn collect_local_names(program: &Program) -> HashSet<String> {
    struct V {
        depth: u32,
        names: HashSet<String>,
    }
    impl<'a> Visit<'a> for V {
        fn visit_function(&mut self, f: &Function<'a>, _flags: oxc_semantic::ScopeFlags) {
            // A nested `function name` (enclosing scope already a function) binds
            // a local that can capture a donor free var — collect it. Top-level
            // names (depth 0) are module-scoped and safe, so they're skipped.
            // (Harmlessly over-guards named function *expressions* too — a rare
            // extra bail, never a miss.)
            if self.depth > 0 {
                if let Some(id) = &f.id {
                    self.names.insert(id.name.to_string());
                }
            }
            self.depth += 1;
            walk::walk_formal_parameters(self, &f.params);
            if let Some(body) = &f.body {
                self.visit_function_body(body);
            }
            self.depth -= 1;
        }
        fn visit_arrow_function_expression(&mut self, a: &ArrowFunctionExpression<'a>) {
            self.depth += 1;
            walk::walk_formal_parameters(self, &a.params);
            self.visit_function_body(&a.body);
            self.depth -= 1;
        }
        fn visit_binding_identifier(&mut self, id: &BindingIdentifier<'a>) {
            if self.depth > 0 {
                self.names.insert(id.name.to_string());
            }
        }
    }
    let mut v = V { depth: 0, names: HashSet::new() };
    v.visit_program(program);
    v.names
}

// ── call-site replacement ───────────────────────────────────────────────────

struct Inliner<'a, 'c> {
    allocator: &'a Allocator,
    candidates: &'c HashMap<String, Candidate<'a>>,
    count: u32,
    /// Fresh-id counter for arg-binding temps (`_inl_arg_<id>`) — monotonic per
    /// pass so the names are unique within it. The `_inl_arg_` prefix never
    /// collides with BLOCK temps; any cross-pass collision (only possible with a
    /// program mixing @optimize/@flatten/call-site @inline) is uniquified by the
    /// block_flatten renamer, like all other inline-generated bindings.
    next_id: u32,
    /// Arg-binding `const _inl_arg_<id> = <arg>;` statements to splice before the
    /// statement currently being walked (drained in `visit_statements`).
    hoists: Vec<Statement<'a>>,
    /// When `Some`, inline only calls whose span start is in the set (call-site
    /// `/* @inline */` mode). `None` = inline every candidate call.
    trigger: Option<HashSet<u32>>,
    /// Consumer non-module binding names (capture guard); see `BlockInliner`.
    local_names: Rc<HashSet<String>>,
    /// Set inside a conditionally-evaluated sub-expression (a `?:` branch or the
    /// short-circuit RHS of `&&`/`||`/`??`). An inline that needs an eval-once
    /// `const _inl_arg_N = arg;` hoist would splice that BEFORE the enclosing
    /// statement — i.e. UNCONDITIONALLY — so the arg (its calls / side effects)
    /// runs even when the source never evaluates the branch. While set, such
    /// inlines bail (the call is left in place). Substitution-only inlines (no
    /// hoist) stay in place and remain safe.
    no_hoist: bool,
}

impl<'a> Inliner<'a, '_> {
    /// Visit a conditionally-executed branch/body. A BlockStatement is its own
    /// statement list, so `visit_statements` scopes any hoists inside it (correct).
    /// A BARE statement has no such list — a hoist from it would escape to the
    /// enclosing list, becoming unconditional — so visit it with `no_hoist` set.
    fn visit_branch(&mut self, stmt: &mut Statement<'a>) {
        if matches!(stmt, Statement::BlockStatement(_)) {
            self.visit_statement(stmt);
        } else {
            let saved = self.no_hoist;
            self.no_hoist = true;
            self.visit_statement(stmt);
            self.no_hoist = saved;
        }
    }
}

impl<'a> VisitMut<'a> for Inliner<'a, '_> {
    // A `?:` evaluates the test unconditionally; each branch only when chosen.
    fn visit_conditional_expression(&mut self, c: &mut ConditionalExpression<'a>) {
        self.visit_expression(&mut c.test);
        let saved = self.no_hoist;
        self.no_hoist = true;
        self.visit_expression(&mut c.consequent);
        self.visit_expression(&mut c.alternate);
        self.no_hoist = saved;
    }

    // `&&`/`||`/`??` evaluate the left unconditionally, the right on the
    // non-short-circuit path only.
    fn visit_logical_expression(&mut self, l: &mut LogicalExpression<'a>) {
        self.visit_expression(&mut l.left);
        let saved = self.no_hoist;
        self.no_hoist = true;
        self.visit_expression(&mut l.right);
        self.no_hoist = saved;
    }

    // Conditionally/repeatedly-executed STATEMENT positions: a hoist from a BARE
    // (non-block) branch/body escapes to the enclosing statement list (spliced
    // before the if/loop) — i.e. unconditionally / once. A BLOCK branch is its own
    // statement list, so `visit_statements` scopes its hoists correctly; only bare
    // ones need `no_hoist`. (Single-file is normalized to all-blocks before
    // inlining; the cross-file path inlines pre-normalize, so it hits bare ones —
    // and `run_all_gated`'s later normalize+inline re-inlines them safely.)
    fn visit_if_statement(&mut self, s: &mut IfStatement<'a>) {
        self.visit_expression(&mut s.test); // unconditional
        self.visit_branch(&mut s.consequent);
        if let Some(alt) = s.alternate.as_mut() {
            self.visit_branch(alt);
        }
    }
    fn visit_while_statement(&mut self, s: &mut WhileStatement<'a>) {
        let saved = self.no_hoist;
        self.no_hoist = true; // test repeats
        self.visit_expression(&mut s.test);
        self.no_hoist = saved;
        self.visit_branch(&mut s.body);
    }
    fn visit_do_while_statement(&mut self, s: &mut DoWhileStatement<'a>) {
        self.visit_branch(&mut s.body);
        let saved = self.no_hoist;
        self.no_hoist = true;
        self.visit_expression(&mut s.test);
        self.no_hoist = saved;
    }
    fn visit_for_statement(&mut self, s: &mut ForStatement<'a>) {
        // test/update run per-iteration → never hoist them out. (init runs once,
        // but over-suppressing it is harmless — the later pass re-inlines.)
        let saved = self.no_hoist;
        self.no_hoist = true;
        if let Some(init) = s.init.as_mut() {
            walk_mut::walk_for_statement_init(self, init);
        }
        if let Some(test) = s.test.as_mut() {
            self.visit_expression(test);
        }
        if let Some(update) = s.update.as_mut() {
            self.visit_expression(update);
        }
        self.no_hoist = saved;
        self.visit_branch(&mut s.body);
    }
    fn visit_for_in_statement(&mut self, s: &mut ForInStatement<'a>) {
        let saved = self.no_hoist;
        self.no_hoist = true;
        self.visit_expression(&mut s.right);
        self.no_hoist = saved;
        self.visit_branch(&mut s.body);
    }
    fn visit_for_of_statement(&mut self, s: &mut ForOfStatement<'a>) {
        let saved = self.no_hoist;
        self.no_hoist = true;
        self.visit_expression(&mut s.right);
        self.no_hoist = saved;
        self.visit_branch(&mut s.body);
    }

    /// Walk each statement, then splice in any arg-binding hoists its calls
    /// produced (in front of it, in evaluation order). `take`/`replace` around the
    /// walk scopes the buffer so a nested block's hoists go into the nested block,
    /// not this list.
    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        let ast = AstBuilder::new(self.allocator);
        let taken = std::mem::replace(stmts, ast.vec());
        let mut out = ast.vec_with_capacity(taken.len());
        for mut stmt in taken {
            let saved = std::mem::take(&mut self.hoists);
            walk_mut::walk_statement(self, &mut stmt);
            let mine = std::mem::replace(&mut self.hoists, saved);
            for h in mine {
                out.push(h);
            }
            out.push(stmt);
        }
        *stmts = out;
    }

    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        walk_mut::walk_expression(self, expr); // inner calls inline first (eval order)

        let Expression::CallExpression(call) = &*expr else { return };
        if !triggered(&self.trigger, call) {
            return;
        }
        let Some(key) = call_key(call) else { return };
        let Some(cand) = self.candidates.get(key.as_str()) else { return };
        // Disjoint field borrows: `cand` ← self.candidates, `&mut self.next_id`,
        // `&mut self.hoists`, `&self.local_names`, `self.allocator`.
        let replacement = build_inlined(
            self.allocator,
            cand,
            call,
            &self.local_names,
            &mut self.next_id,
            &mut self.hoists,
            self.no_hoist,
        );
        if let Some(v) = replacement {
            *expr = v;
            self.count += 1;
        }
    }
}

/// `true` if `call` should inline given an optional call-site trigger set.
fn triggered(trigger: &Option<HashSet<u32>>, call: &CallExpression) -> bool {
    trigger.as_ref().is_none_or(|t| t.contains(&call.span.start))
}

/// Inline a DIRECT (single-`return E`) candidate at `call`, AS AN EXPRESSION.
/// Simple args substitute straight into `E`; an arg that's used more than once
/// and isn't safe to duplicate is bound to an init-position `const _inl_arg_N =
/// arg;` (pushed to `hoists`) and substituted by that identifier — evaluated
/// once, AND kept SROA-visible (the old behavior bailed to the BLOCK path's
/// `let _r; _r = …` result temp, which SROA can't reach). Returns the
/// substituted return expression to replace the call with.
fn build_inlined<'a>(
    allocator: &'a Allocator,
    cand: &Candidate<'a>,
    call: &CallExpression<'a>,
    local_names: &HashSet<String>,
    next_id: &mut u32,
    hoists: &mut Vec<Statement<'a>>,
    bail_on_hoist: bool,
) -> Option<Expression<'a>> {
    if call.arguments.iter().any(Argument::is_spread) {
        return None;
    }
    if call.arguments.len() > cand.params.len() {
        return None; // ignore extras for v1
    }
    // Capture guard (see `build_block_plan`): a donor free var colliding with a
    // consumer-local binding would be captured after splicing.
    if !cand.free.is_disjoint(local_names) {
        return None;
    }
    // Shadow guard: `OwnedSubstitutor` (below) substitutes a param's identifier
    // by NAME and is not shadow-aware; bail if the value re-declares a param name
    // in a nested scope (e.g. `return [1].map(b => b)` with param `b`).
    {
        let pset: HashSet<&str> = cand.params.iter().map(String::as_str).collect();
        if expr_shadows_params(&cand.value, &pset) {
            return None;
        }
    }

    let ast = AstBuilder::new(allocator);
    // An arg used more than once is substituted into each site → re-evaluated N
    // times. Sound only when eval-N ≡ eval-once: a pure arg, or a member-read arg
    // (`shape.halfExtents`) when the body is side-effect-free. Otherwise (a
    // call/`new`/array/object arg, or a side-effecting body) the arg must be
    // evaluated once — bind it to an init-position const here (vs the BLOCK
    // path's `let _r; _r = …` temp) so it stays SROA-visible.
    let uses = count_uses(&cand.value, &cand.params);
    let body_side_effect_free = is_side_effect_free(&cand.value);
    let mut subs: HashMap<String, Expression<'a>> = HashMap::new();
    for (i, p) in cand.params.iter().enumerate() {
        let Some(arg) = call.arguments.get(i).map(Argument::to_expression) else {
            subs.insert(p.clone(), ast.expression_identifier(oxc_span::SPAN, "undefined"));
            continue;
        };
        let multi_use = uses.get(p.as_str()).copied().unwrap_or(0) > 1;
        let dup_safe = is_pure(arg) || (body_side_effect_free && is_pure_with_member_reads(arg));
        if multi_use && !dup_safe {
            // This arg needs an eval-once `const _inl_arg_N` hoist. In a
            // conditionally-evaluated position that hoist would run
            // unconditionally (before the enclosing statement) — bail the inline.
            if bail_on_hoist {
                return None;
            }
            let name: &'a str = allocator.alloc_str(&format!("_inl_arg_{}", *next_id));
            *next_id += 1;
            let declr = ast.variable_declarator(
                oxc_span::SPAN,
                VariableDeclarationKind::Const,
                ast.binding_pattern_binding_identifier(oxc_span::SPAN, name),
                oxc_ast::NONE,
                Some(arg.clone_in(allocator)),
                false,
            );
            hoists.push(Statement::VariableDeclaration(ast.alloc(ast.variable_declaration(
                oxc_span::SPAN,
                VariableDeclarationKind::Const,
                ast.vec1(declr),
                false,
            ))));
            subs.insert(p.clone(), ast.expression_identifier(oxc_span::SPAN, name));
        } else {
            subs.insert(p.clone(), arg.clone_in(allocator));
        }
    }

    let mut value = cand.value.clone_in(allocator);
    let mut subst = OwnedSubstitutor { allocator, subs: &subs };
    subst.visit_expression(&mut value);
    Some(value)
}

// ── analysis helpers ────────────────────────────────────────────────────────

fn reads_this_or_arguments(e: &Expression) -> bool {
    let mut v = ThisArgChecker { found: false };
    v.visit_expression(e);
    v.found
}

struct ThisArgChecker {
    found: bool,
}

impl<'a> Visit<'a> for ThisArgChecker {
    fn visit_this_expression(&mut self, _: &ThisExpression) {
        self.found = true;
    }
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if id.name == "arguments" {
            self.found = true;
        }
    }
    // Non-arrow functions get their own `this`/`arguments` — don't descend.
    fn visit_function(&mut self, _: &Function<'a>, _: oxc_semantic::ScopeFlags) {}
}

fn count_uses(e: &Expression, params: &[String]) -> HashMap<String, u32> {
    let mut v = UseCounter { params, counts: HashMap::new() };
    v.visit_expression(e);
    v.counts
}

struct UseCounter<'p> {
    params: &'p [String],
    counts: HashMap<String, u32>,
}

impl<'a> Visit<'a> for UseCounter<'_> {
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if self.params.iter().any(|p| p == id.name.as_str()) {
            *self.counts.entry(id.name.to_string()).or_insert(0) += 1;
        }
    }
}

struct RefCounter {
    names: std::collections::HashSet<String>,
    counts: HashMap<String, u32>,
}

impl<'a> Visit<'a> for RefCounter {
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if self.names.contains(id.name.as_str()) {
            *self.counts.entry(id.name.to_string()).or_insert(0) += 1;
        }
        walk::walk_identifier_reference(self, id);
    }
}

/// Removes 0-ref candidate `FunctionDeclaration`s at any scope (top-level and
/// nested). Recurses first so nested declarations in a stripped block are also
/// handled. Only bare `FunctionDeclaration`s are removed — `export`ed donors
/// (an `ExportNamedDeclaration`) are left intact.
struct StripVisitor<'a, 's> {
    allocator: &'a Allocator,
    strip: &'s HashSet<String>,
}

impl<'a> VisitMut<'a> for StripVisitor<'a, '_> {
    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts);
        let strip_this = |s: &Statement| {
            matches!(s, Statement::FunctionDeclaration(f)
                if f.id.as_ref().is_some_and(|id| self.strip.contains(id.name.as_str())))
        };
        if stmts.iter().any(strip_this) {
            let taken = std::mem::replace(stmts, AstBuilder::new(self.allocator).vec());
            let mut kept = AstBuilder::new(self.allocator).vec_with_capacity(taken.len());
            for s in taken {
                if !strip_this(&s) {
                    kept.push(s);
                }
            }
            *stmts = kept;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;

    /// Run the inline pass on `src` and return the codegen.
    fn inline(src: &str) -> String {
        let allocator = Allocator::default();
        let mut program = crate::parse_program(&allocator, src, SourceType::ts());
        let mut uid = 0u32;
        run(&allocator, &mut program, &mut uid);
        Codegen::new().build(&program).code
    }

    #[test]
    fn block_with_return_inlines_in_init_position() {
        // multi-statement body WITH an early return, called as `let v = pick(x)`.
        let out = inline(
            "/* @inline */ function pick(a) { if (a > 0) return a; return -a; }\nexport function f(x) { let v = pick(x); return v; }",
        );
        assert!(!out.contains("pick(x)"), "call inlined:\n{out}");
        assert!(out.contains("break"), "early return uses break:\n{out}");
        assert!(!out.contains("function pick"), "donor stripped:\n{out}");
    }

    #[test]
    fn block_with_return_inlines_in_statement_position_discarding() {
        let out = inline(
            "/* @inline */ function note(a) { if (!a) return; sink(a); }\nexport function f(x) { note(x); }",
        );
        assert!(!out.contains("note(x)"), "call inlined:\n{out}");
        assert!(out.contains("sink(a)") || out.contains("sink("), "body spliced:\n{out}");
        assert!(out.contains("break"), "bare early return → break:\n{out}");
    }

    #[test]
    fn block_inlines_in_assign_position() {
        let out = inline(
            "/* @inline */ function dbl(a) { const t = a * 2; return t; }\nexport function f(x) { let v = 0; v = dbl(x); return v; }",
        );
        assert!(!out.contains("dbl(x)"), "call inlined:\n{out}");
        // #1: the simple identifier arg `x` is substituted directly (no `let a = x`).
        assert!(out.contains("x * 2"), "body spliced w/ arg substituted:\n{out}");
        assert!(!out.contains("let a ="), "no always-temp prologue for a simple arg:\n{out}");
    }

    #[test]
    fn direct_binds_side_effecting_multi_use_arg_as_const() {
        // `a` used twice + impure arg → the DIRECT path binds the arg to an
        // init-position `const _inl_arg_N` (evaluated once, and SROA-visible) and
        // substitutes it, instead of bailing to the BLOCK result-temp prologue.
        let out = inline(
            "/* @inline */ function twice(a) { return a + a; }\nexport function f() { let v = twice(rand()); return v; }",
        );
        assert!(!out.contains("twice("), "call inlined:\n{out}");
        assert_eq!(out.matches("rand()").count(), 1, "arg evaluated once:\n{out}");
        assert!(out.contains("_inl_arg"), "arg bound to an init-position const:\n{out}");
        assert!(!out.contains("__result"), "no BLOCK result temp:\n{out}");
    }

    #[test]
    fn empty_body_direct_inlines_to_undefined() {
        let out = inline(
            "/* @inline */ function noop() {}\nexport function f() { let v = noop(); return v; }",
        );
        assert!(!out.contains("noop("), "call inlined:\n{out}");
        assert!(out.contains("undefined"), "empty body → undefined:\n{out}");
    }

    #[test]
    fn alpha_renames_param_when_arg_references_it() {
        // BLOCK body, args reference the param names (`v`, `k`). `v` is
        // *reassigned* so it can't be substituted — it gets a temp, which is
        // α-renamed to a per-expansion-unique `v__<id>` (the same scheme that
        // keeps two inlines of one helper from colliding), avoiding the
        // `let v = v` TDZ self-capture.
        let out = inline(
            "/* @inline */ function scale(v, k) { v = v * k; return v; }\nexport function f(v, k) { let r = scale(v, k); return r; }",
        );
        assert!(!out.contains("scale("), "inlined via α-rename instead of bailing:\n{out}");
        assert!(out.contains("v__"), "reassigned param renamed per-expansion (v__<id>):\n{out}");
        assert!(!out.contains("let v = v"), "no TDZ self-capture:\n{out}");
    }

    #[test]
    fn flatten_inlines_non_annotated_callees_within_host() {
        // `add` is NOT @inline, but `host` is @flatten → its calls inline.
        let out = inline(
            "function add(a, b) { return a + b; }\n/* @flatten */ export function host(x) { return add(x, 1); }",
        );
        assert!(!out.contains("add(x, 1)"), "flatten inlined the call:\n{out}");
        assert!(out.contains("x + 1"), "body spliced:\n{out}");
    }

    #[test]
    fn optimize_implies_flatten() {
        // `@optimize` is a combo directive: it implies `@flatten`, so the host's
        // calls inline even though the callee isn't `@inline`.
        let out = inline(
            "function add(a, b) { return a + b; }\n/* @optimize */ export function host(x) { return add(x, 1); }",
        );
        assert!(!out.contains("add(x, 1)"), "@optimize inlined the call (flatten):\n{out}");
        assert!(out.contains("x + 1"), "body spliced:\n{out}");
    }

    #[test]
    fn nested_call_in_loop_body_not_hoisted_out_of_scope() {
        // Regression: inlining `integrate` (an `@optimize` host's callee) into a
        // loop body must keep the inlined body — and the helper calls it makes —
        // INSIDE the loop, after the loop-local binding `e = arr[i]`. A bug in
        // `hoist_expr_calls` descended into nested statement bodies and lifted
        // statement-position calls to the host top, hoisting `e`'s uses above its
        // `let` binding → invalid JS (`e` referenced out of scope).
        let out = inline(
            "function limitV(e, m) { if (e.vx > m) e.vx = m; }\n\
             function integrate(e, m) { e.px = e.vx; limitV(e, m); }\n\
             /* @optimize */ export function step(arr) { for (let i = 0; i < arr.length; i++) { integrate(arr[i], 1.6); } }",
        );
        let step = out.split("function step").nth(1).expect("step in output");
        let bind = step.find("arr[i]").expect("loop binding present");
        let call = step.find("limitV(").expect("helper call survives inside loop");
        assert!(bind < call, "loop binding must precede the helper call (not hoisted out):\n{out}");
        // Nothing referencing the loop-local var may appear before the `for`.
        let pre_for = &step[..step.find("for ").expect("for loop present")];
        assert!(
            !pre_for.contains(".vx") && !pre_for.contains("limitV"),
            "no inlined/hoisted helper body before the loop:\n{out}"
        );
    }

    #[test]
    fn flatten_does_not_inline_outside_the_host() {
        // the same callee called outside any @flatten host stays a call.
        let out = inline(
            "function add(a, b) { return a + b; }\n/* @flatten */ function host(x) { return add(x, 1); }\nexport function other(y) { return add(y, 2); }",
        );
        assert!(out.contains("add(y, 2)"), "call outside host untouched:\n{out}");
    }

    #[test]
    fn discovers_const_arrow_candidate_locally() {
        let out = inline(
            "/* @inline */ const add = (a, b) => a + b;\nexport function f(x) { return add(x, 1); }",
        );
        assert!(!out.contains("add(x, 1)"), "const-arrow @inline inlined locally:\n{out}");
        assert!(out.contains("x + 1"), "{out}");
    }

    #[test]
    fn discovers_nested_candidate() {
        let out = inline(
            "export function outer(x) { /* @inline */ function helper(a) { return a * 2; } return helper(x); }",
        );
        assert!(!out.contains("helper(x)"), "nested @inline call inlined:\n{out}");
        assert!(out.contains("x * 2"), "{out}");
    }

    #[test]
    fn callsite_inline_direct_non_annotated_callee() {
        // `dbl` is NOT @inline; the CALL is annotated → inline just that call.
        let out = inline(
            "function dbl(a) { return a * 2; }\nexport function f(x) { return /* @inline */ dbl(x); }",
        );
        assert!(!out.contains("dbl(x)"), "call-site annotation inlined the call:\n{out}");
        assert!(out.contains("x * 2"), "{out}");
    }

    #[test]
    fn callsite_inline_only_the_annotated_call() {
        // two calls to `dbl`; only the annotated one inlines.
        let out = inline(
            "function dbl(a) { return a * 2; }\nexport function f(x) { return /* @inline */ dbl(x) + dbl(x); }",
        );
        assert!(out.contains("dbl(x)"), "the un-annotated call stays:\n{out}");
        assert!(out.contains("x * 2"), "the annotated call inlined:\n{out}");
    }

    #[test]
    fn multi_statement_void_still_inlines() {
        // regression: the old void/statement-position case still works.
        let out = inline(
            "/* @inline */ function setup(a) { const x = a + 1; sink(x); }\nexport function f(p) { setup(p); }",
        );
        assert!(!out.contains("setup(p)"), "call inlined:\n{out}");
        // #1: simple arg `p` substituted (was `let a = p; const x = a + 1`).
        assert!(out.contains("p + 1"), "body spliced w/ arg substituted:\n{out}");
    }

    // ── #3: free-variable capture guard ──────────────────────────────────────

    #[test]
    fn direct_bails_when_free_var_captured_by_consumer_local() {
        // `calc` (DIRECT) free-reads module `base`; the consumer has a local
        // `base` that would capture it after splicing → must NOT inline.
        let out = inline(
            "const base = 100;\n/* @inline */ function calc(a) { return a + base; }\nexport function f() { let base = 1; return calc(5) + base; }",
        );
        assert!(out.contains("calc(5)"), "capture-unsafe call left intact:\n{out}");
        assert!(out.contains("function calc"), "donor kept (still referenced):\n{out}");
    }

    #[test]
    fn block_bails_when_free_var_captured_by_consumer_local() {
        // Same hazard via a BLOCK body at an init-position call.
        let out = inline(
            "const base = 100;\n/* @inline */ function calc(a) { const t = a + base; return t; }\nexport function f() { let base = calc(5); return base; }",
        );
        assert!(out.contains("calc(5)"), "capture-unsafe call left intact:\n{out}");
    }

    #[test]
    fn bails_when_free_var_captured_by_nested_function_decl() {
        // `calc` free-reads module `helper`; the consumer has a NESTED function
        // declaration `helper` that would capture it after splicing → must bail.
        let out = inline(
            "const helper = 100;\n/* @inline */ function calc(a) { return a + helper; }\nexport function f() { function helper(x) { return x; } return calc(5); }",
        );
        assert!(out.contains("calc(5)"), "capture-unsafe call left intact:\n{out}");
    }

    #[test]
    fn inlines_free_var_when_no_consumer_collision() {
        // A donor free var that the consumer does NOT shadow inlines normally.
        let out = inline(
            "const base = 100;\n/* @inline */ function calc(a) { return a + base; }\nexport function f() { let n = 1; return calc(5) + n; }",
        );
        assert!(!out.contains("calc(5)"), "no collision → inlined:\n{out}");
        assert!(out.contains("5 + base"), "free var still binds module `base`:\n{out}");
    }

    // ── #1: simple-arg substitution vs always-temp ───────────────────────────

    #[test]
    fn modified_param_keeps_temp_prologue() {
        // `a` is reassigned in the body → can't be substituted; keep the temp
        // (now α-renamed per-expansion to `a__<id>`).
        let out = inline(
            "/* @inline */ function f(a) { a = a + 1; return a; }\nexport function g(x) { let v = f(x); return v; }",
        );
        assert!(out.contains("a__") && out.contains("= x"), "reassigned param keeps its (renamed) temp:\n{out}");
    }

    #[test]
    fn side_effecting_arg_keeps_temp_for_eval_once() {
        // A non-simple (call) arg must be temped so it evaluates exactly once,
        // even though the param isn't reassigned.
        let out = inline(
            "/* @inline */ function f(a) { return a + a; }\nexport function g() { let v = f(rand()); return v; }",
        );
        assert_eq!(out.matches("rand()").count(), 1, "arg evaluated once via temp:\n{out}");
    }

    #[test]
    fn result_temp_uses_callee_name() {
        // Multi-exit callee inlined at expression position → result temp named
        // `_<callee>__result_<id>`, not the opaque `_compilecat_result_<id>`.
        let out = inline(
            "/* @inline */ function classify(s) { if (s > 0) return 1; return 0; }\nexport function host(s) { return classify(s) + 1; }",
        );
        assert!(out.contains("_classify__result_"), "callee-named result temp:\n{out}");
        assert!(!out.contains("_compilecat_result"), "no opaque name:\n{out}");
    }

    #[test]
    fn duplicates_pure_member_arg_when_body_pure() {
        // A member-read arg used >1 in a side-effect-free body inlines via the
        // DIRECT path — substituted (duplicated) into each site, no result temp.
        let out = inline(
            "/* @inline */ function vol(h) { return 8 * h[0] * h[1] * h[2]; }\nexport function g(s) { s.v = vol(s.he); }",
        );
        assert_eq!(out.matches("s.he").count(), 3, "member arg duplicated into 3 sites:\n{out}");
        assert!(!out.contains("_compilecat_result"), "no result temp:\n{out}");
    }

    #[test]
    fn member_arg_kept_temped_when_body_has_side_effect() {
        // The body has a call between/around the member-arg uses, so the value
        // could change — it must NOT be duplicated; bail to BLOCK's eval-once
        // temp (the member read appears once, in the prologue).
        let out = inline(
            "/* @inline */ function f(h) { sink(h[0]); return h[1]; }\nexport function g(s) { s.v = f(s.he); }",
        );
        assert_eq!(out.matches("s.he").count(), 1, "member arg temped (eval once):\n{out}");
    }

    // ── #2: nested dead @inline stripping ────────────────────────────────────

    #[test]
    fn strips_nested_fully_inlined_function() {
        let out = inline(
            "export function outer(x) { /* @inline */ function helper(a) { return a * 2; } return helper(x); }",
        );
        assert!(!out.contains("helper(x)"), "nested call inlined:\n{out}");
        assert!(!out.contains("function helper"), "dead nested @inline stripped:\n{out}");
        assert!(out.contains("x * 2"), "{out}");
    }

    // ── edge cases: the pass must REJECT inlining ───────────────────────────

    #[test]
    fn rejects_async_callee() {
        // An `async` donor can't be inlined into a sync body — the call stays.
        let out = inline(
            "/* @inline */ async function fetchOnce() { return 1; }\nexport function g() { return fetchOnce(); }",
        );
        assert!(out.contains("fetchOnce()"), "async call NOT inlined:\n{out}");
        assert!(out.contains("async function fetchOnce"), "async donor preserved:\n{out}");
    }

    #[test]
    fn rejects_generator_callee() {
        // A generator donor can't be inlined — the call stays.
        let out = inline(
            "/* @inline */ function* gen() { yield 1; }\nexport function g() { return gen(); }",
        );
        assert!(out.contains("gen()"), "generator call NOT inlined:\n{out}");
        assert!(out.contains("function* gen"), "generator donor preserved:\n{out}");
    }

    #[test]
    fn rejects_this_using_callee() {
        // A donor referencing `this` would change meaning if spliced — rejected.
        let out = inline(
            "/* @inline */ function getProp() { return this.p; }\nexport function g() { return getProp(); }",
        );
        assert!(out.contains("getProp()"), "`this`-using call NOT inlined:\n{out}");
    }

    #[test]
    fn rejects_arguments_using_callee() {
        // `arguments` is bound to the callee's own frame — inlining would rebind
        // it, so the call is left intact.
        let out = inline(
            "/* @inline */ function variadic() { return arguments[0]; }\nexport function g() { return variadic(1); }",
        );
        assert!(out.contains("variadic(1)"), "`arguments`-using call NOT inlined:\n{out}");
    }

    #[test]
    fn direct_does_not_substitute_param_into_member_property_name() {
        // `k(p)` inlines to `p.x`: the param `p` substitutes as the member OBJECT,
        // but the non-computed property name `.x` must be preserved verbatim — a
        // param must never overwrite a `.prop` identifier.
        let out = inline(
            "/* @inline */ function k(o) { return o.x; }\nexport function g(p) { return k(p); }",
        );
        assert!(!out.contains("k(p)"), "call inlined:\n{out}");
        assert!(out.contains("p.x"), "object substituted, property name preserved:\n{out}");
    }
}
