# Rust/oxc port — worklog

Running log of **decisions** made porting compilecat's Babel pipeline to the
Rust/oxc core. Newest entries at the bottom of each section. For *how* the loop
works see `README.md`; this file is the *why*. **`DEFERRED.md` is the
consolidated checklist** of everything not yet ported (missing whole phases +
per-pass sub-features) — keep it in sync as deferrals are cleared.

## Architecture decisions

- **napi shell, not a native rolldown plugin.** rolldown's native plugins are a
  closed compile-time enum with no dynamic loading, and the zero-copy
  `transform_ast` hook isn't exposed to JS — so a native plugin can't ship as an
  npm package. We compile the oxc core to a napi `cdylib` and call it from a thin
  JS plugin. One extra parse+print vs. theoretical zero-copy; the distributable
  path. Broad bundler reach later via `unplugin`.
- **Single crate + modules, not the React-port multi-crate split.** compilecat's
  ~12k LOC doesn't need separate `_hir`/`_ssa`/… crates yet. `passes/` holds one
  file per pass; `analysis/` (CFG/dataflow) can become its own crate later if
  compile times bite.
- **`compilecat_core` is napi-free** (pure Rust, unit-testable, reusable);
  `compilecat_napi` is a thin wrapper exposing `Compiler.{compileFile,
  compileChunk,runPass,format}`.
- **Latest crates:** oxc `0.135`, napi `3`. (napi v3 config is `binaryName` +
  `targets`, not v2's `triples`.)
- **Parity baseline = transform-mode, NOT a NEW bundle-mode.** (2026-06-15, the
  goal's "DECIDE FIRST" step, decided off a *measured* gate —
  `tst/parity/optimization-parity.parity.ts`.) The harness pins the gap: on an
  `@optimize` host calling namespace members (`vec3.add`/`vec3.copy`), OLD emits
  **0 residual calls** + full SROA (`out_0/_1/_2`, copy+tmp dead-eliminated);
  NEW emits **4 residual calls**, no SROA. OLD only wins because **bundle-mode
  lets the bundler pre-resolve `vec3.copy` → a plain `copy()`** before OLD's
  same-file flatten runs. Two ways to match it:
  - **(A) Add a NEW renderChunk bundle-mode.** Cheapest Rust (the bundler hands
    us resolved names; existing same-file flatten/SROA just fire). But it is
    *exactly OLD's whole-chunk model* — it discards the committed per-file +
    donor + persistent-cache architecture, kills incremental HMR, and forfeits
    the measured 43× win (NEW transform 136ms vs OLD bundle 5860ms on crashcat),
    which is *because* NEW is per-file. Rejected as the baseline.
  - **(B) Finish cross-file flatten in transform-mode** (worklist #1): resolve
    `import * as ns` member calls across files, reusing `@inline`'s
    `object_export_methods`/`register_namespace`/`resolve_*_reexport` ungated,
    scoped to `@flatten`/`@optimize` host calls; libraries never modified. More
    Rust, but preserves the committed architecture and the speed win. **Chosen.**
  Bundle-mode (A) stays available as a *fallback measurement target* only if (B)
  proves intractable for some call shape — not as the shipping path.
- **(B) implemented + crashcat-verified.** (2026-06-15.) Cross-file `@flatten`/
  `@optimize` now inlines namespace-member calls (`vec3.add`): the driver in
  `transform_cross_file` resolves a host's `ns.member` calls through both a direct
  `import * as ns from M` and the mathcat **barrel** shape (`import { ns } from B`
  where B does `import * as ns from M; export { ns }`) via the new
  `reexported_namespace_source` + existing `resolve_reexport_target`, then
  registers each called member ungated (`find_all_inline_exports(_, false)`). The
  JS plugin's donor BFS was the *other* half of the bug — it only followed
  `export … from` edges, so the impl module behind a sourceless namespace
  re-export was never read; it now also follows `import * as ns from S; export
  { ns }`. `allowLibraryInline` (was a no-op) is required for **bare-specifier**
  libraries like `mathcat` and now functions end-to-end. **Measured on crashcat**
  (full `src/index.ts` build, NEW transform vs OLD bundle): residual mathcat
  member calls 13 = 13; distinct object-SROA scalar names 25 = 25; spot-checked
  `computeClosestPointOnTriangle` byte-identical, `getSleepTestPoints` inlined.
  The remaining raw-count delta (OLD 349 object-scalar *occurrences* vs NEW 85;
  OLD output 1.41 MB vs NEW 1.24 MB) is OLD's bundle-mode duplicating internal
  helper bodies across call sites — whole-program internal-function inlining, the
  deferred whole-graph optimization, NOT a mathcat/SROA gap. Gate:
  `tst/parity/optimization-parity.parity.ts` (both gap assertions promoted to
  live `it`).
  - **Measurement caveat (2026-06-15, corrected):** the crashcat scalar/size
    numbers above came from building OLD then NEW *in one Node process*, which
    lets rolldown's module cache cross-pollinate — they are unreliable. Measured
    in **separate fresh processes** (the trustworthy method), OLD and NEW both
    emit ~0 object-SROA scalars on the `index.ts`-only / `three`-external build
    (most hot paths tree-shake away without the full app), sizes are within 0.6%,
    and residual member calls match (1 = 1). The *controlled* signal — the
    minimal mathcat corpus + 144 core / 146 parity tests — is what actually
    establishes inlining+SROA parity; crashcat aggregates are config-sensitive.
    Always measure OLD and NEW in separate processes.
- **`block_flatten` pass — port of `renameForFlatten` + `tryMergeBlock`.**
  (2026-06-15.) BLOCK inlining (`function-to-block-mutator`) wraps each inlined
  body in a `{ }` to scope its `let p = arg;` prologue, exactly as Babel's
  mutator does — and the port had shipped the mutator but **not** the simplifier
  step that flattens those blocks away, so they survived with their (small, real)
  scope cost. `passes/block_flatten.rs` closes it, per function scope, in OLD's
  two phases: (1) demand-driven α-rename makes every nested `let`/`const` unique
  vs the function (`name$N`, first-seen kept clean), on the *original* nested
  structure so each binding is unambiguous; (2) lift every *bare* block (a
  `BlockStatement` that is a statement-list element, not a control body) into its
  parent. The renamer is scope-accurate: it skips a nested scope that re-binds
  the name (shadow) but follows closures that merely capture it. Wired as
  `simplify()` in `run_all`, right after inlining so downstream passes see
  straight-line code. Result: the scaffolding blocks are gone — on crashcat NEW
  now emits **fewer** bare blocks than OLD (4, all legit source scopes in
  undirected third-party code, vs OLD's 12); the minimal corpus is fully flat;
  SROA still fires through it. 6 unit tests (collision, param clash, nested
  shadow, closure capture, control-flow kept).

- **CFG/dataflow framework port — in progress** (2026-06-16, toward full Babel
  parity). Bottom-up: `analysis/tri.rs` (3-valued logic), `analysis/cfg.rs`
  (per-AST-node CFG over the existing `DiGraph`), `analysis/data_flow.rs` (generic
  forward/backward worklist fixpoint) — **done, 21 tests** ported from OLD's
  `cfg.test.ts` + `dataflow.test.ts`. Key oxc-specific decisions:
  - **CFG nodes keyed by `Span`**, value = borrowed `AstKind<'a>`. The CFG is
    short-lived (build → analyze → apply → drop before mutation), so borrows are
    fine. `AstKind<'a>` is collected via `Visit::enter_node` (which yields the
    *arena* lifetime, unlike `visit_xxx`'s short borrows — the crucial trick).
  - **Callers obtain the root `AstKind<'a>` by allocating the parsed `Program`
    into the arena** (`allocator.alloc(parse_program(..))`) so sub-node refs are
    `'a`; or, in the pipeline, from `semantic.nodes().kind(id)`.
  - **No `branched` dataflow** — no consumer (must-def/maybe-use/live-vars) uses
    per-edge state, so it's omitted (YAGNI).
  - Nested functions are skipped by overriding `visit_function`/`_arrow` to only
    `walk_*` when `span == root_span` (skipping the walk skips `enter_node`, so
    nested-fn internals never become CFG nodes).
  Remaining Phase-1: `local_var_table` (on `oxc_semantic` SymbolIds, not Babel
  scope), `reaching` (must-def + maybe-use), `live_vars`. Then the two passes
  (flow-sensitive-inline, dead-assignments) + `simplify()` wiring.

- **Per-construct opt-in gate — worklist #4, DONE incl. scope-level** (2026-06-16).
  OLD optimizes only opted-in (directive/inline-modified) functions; NEW used to
  optimize *every* function in a processed file. Now matched + generalized:
  - `passes/gate.rs` `Gate` — `enter_fn` (reset: functions are independent units,
    a nested untouched fn inside a touched scope is NOT optimized) + `enter_scope`
    (inherit-or-enter: a touched bare block keeps its whole subtree active). Every
    optimization/cleanup pass (`fold`, `minimize_*`, `inline_variables`,
    `dead_code`, `block_flatten`) gates mutation on `gate.active`;
    `cleanup_residue` is already self-gated (span-0); `normalize`/`strip_directives`
    stay global.
  - `touched_spans` = directive-attached construct spans (`annotated_spans` — for
    `/* @optimize */ { … }` that's the *block* span) ∪ functions containing a
    generated (`span 0`) node (producing-pass-modified). Cross-file `@inline`
    *targets* (directive-free consumers) are added via
    `inline_functions::functions_calling` (recorded before inlining) → passed to
    `run_all_gated`.
  - **Scope-level opt-in works**: `/* @optimize */ { block }` optimizes only the
    block (verified `tst/parity/gating.parity.ts`). This *exceeds* OLD (which is
    function-granular) — a deliberate capability, no parity regression. Producing
    passes (`sroa`/`unroll`/`inline`) honoring *block*-level directives (so a
    block directive drives production, not just cleanup) is the remaining slice.
  - All gates green: 186 core / 181 parity / 294 main / three.js.

## Cross-cutting oxc decisions

- **Parse with `ParseOptions { preserve_parens: false }`** everywhere
  (`parse_program` in lib.rs). oxc keeps `ParenthesizedExpression` nodes by
  default; Babel's AST is paren-free. Matching Babel here keeps the AST shapes
  and the parity comparison honest, and codegen re-inserts precedence parens
  anyway. (Surfaced by fold's `-(-5)` case.)
- **AST moves use `oxc_allocator::TakeIn::take_in(allocator)`**, not the removed
  `AstBuilder::move_*`. Leaves a dummy in place; pairs with rebuilding a
  statement `Vec` via `take_in` + filtered re-push.
- **Comments are span-based** (`program.comments: Vec<Comment>`, text =
  `source_text[span]`, immutable) — the opposite of Babel's mutable node-attached
  comments. Consequence recorded under strip-directives below.
- **Bottom-up peephole pattern:** override `visit_expression` / `visit_statement`,
  call `walk_*` first (children fold first), then fold the current node by
  replacing `*node`. `visit_statements` for block-level cleanup.
- **Differential parity normalizer:** both Babel and native output are run through
  the same oxc identity printer (`format()`) so only *semantic* diffs fail —
  formatting differences between the two codegens are erased.

## Per-pass decisions

### normalize ✓
- Pipeline's normalize phase is **structural only** (arrow→block, blockify
  branches, split multi-declarators, hoist `var` for-init). The α-rename
  (`renameForFlatten`) is scope-aware and runs from `simplify`, so it's NOT part
  of this pass — kept this first port scope-free.
- Hoisted multi-declarator for-init flows through the same `push_decl` splitter
  (pass A feeds pass B), matching Closure ordering. (Caught by the `nested` case.)

### fold ✓
- Full bottom-up constant folder. JS `ToInt32`/`ToUint32` implemented by hand
  (mask shift counts to 5 bits; Rust would panic on `<<` ≥ 32 otherwise).
- **Deferred:** bigint, object/array operands, optional-chain folding
  (`null?.x` → `undefined`) — oxc models optional chains via `ChainExpression`,
  ported separately.

### strip-directives ✓
- **Only marker-only comments are removed** (`/* @inline */`), by filtering
  `program.comments`. Rewriting a *mixed* comment (`/* @inline foo */` →
  `/* foo */`) would mean repointing a span at new text, which the
  single-source-string codegen can't do — **deferred (TODO)**.

### dead-code ✓
- Ported: literal `if`/ternary/`while`/`do-while` folding, empty-branch cleanup +
  condition negation, pure-expr-statement removal, unreachable-after-terminator
  removal (keeping hoisted `var`/function decls), drop empties.
- "Drop" cases replace the node with `EmptyStatement`; `clean_block_body`
  (in `visit_statements`) then removes empties — avoids in-place array deletion
  mid-visit.
- **Deferred:** label folding, `tryOptimizeConditionalAfterAssign`, nested
  block-flatten (`tryMergeBlock` — needs normalize's unique-name invariant).
- Factored shared `is_pure`/`as_boolean` into `passes/util.rs` (used by fold too).

### inline-functions ✓ (DIRECT only)
- Scoped the first cut to **DIRECT mode, whole-program, declaration-annotated**:
  top-level `/* @inline */ function NAME(...) { return <expr>; }`, simple params,
  not async/generator, no `this`/`arguments`. Every `NAME(args)` call → `<expr>`
  with params substituted; declaration removed when no refs remain. This is the
  README headline and made the `inline-simple-call` whole-program case green.
- **`@inline` discovery via comment `attached_to`:** oxc leading comments record
  the start offset of the token they precede; a decl is annotated iff some
  `@inline` comment's `attached_to == fn.span.start`. (Plain `function`; exported
  decls attach to `export` — deferred.)
- **AST cloning via `oxc_allocator::CloneIn::clone_in(allocator)`** — clone the
  return expr once per candidate, then clone each arg per substitution site.
- **`Argument` → `Expression`:** `arg.is_spread()` guard, then
  `arg.to_expression()` (the `inherit_variants!` macro provides it; there is no
  `as_expression`).
- **`BindingPattern` is an enum directly in 0.135** (no `.kind` field) — match
  `BindingPattern::BindingIdentifier(id)`.
- **Side-effect bail:** a param whose arg is impure (`!is_pure`) and used >1× in
  the body bails the DIRECT inline. Babel then falls back to BLOCK (temp var);
  the port has no BLOCK yet, so it just leaves the call. Therefore the
  "impure-arg-reused" scenario is **not** a parity case (it'd need BLOCK) — kept
  as a native-only unit test.
- **Breadcrumbs:** Babel tags each inline site with a `/* @applied-inline … */`
  comment (debug aid). oxc's span-based comments can't be injected at arbitrary
  positions, and they're non-semantic, so the parity harness **strips
  `@applied-inline` comments from both sides** before comparing (documented in
  both `*.parity.ts`).
- **Deferred (TODO):** BLOCK mode (multi-statement bodies, temp hoisting),
  call-site `@inline` + `@flatten`, namespace calls, nested candidates,
  cross-file/PerFile donor splicing, exported-decl annotation.

### unroll ✓
- Directive-driven: a loop unrolls if a `/* @unroll */` comment attaches to its
  span start, or it sits inside an `@optimize` function (tracked via an
  `optimize_depth` counter pushed/popped in `visit_function`).
- **Substitution is simpler than Babel's** — oxc puts non-read identifiers in
  distinct node types (`BindingIdentifier`, `IdentifierName`), so replacing only
  `Expression::Identifier(name == loop_var)` is automatically read-context-
  correct. No `isReadContext` table. Shadowing handled with a `shadow_depth`
  counter incremented when entering a function/block that re-declares the var.
- **Bottom-up single pass handles nesting:** `visit_statements` walks children
  first, so an inner loop is already flat when the outer one expands — no
  fixpoint loop needed (Babel runs up to 16 passes).
- Each iteration wrapped in its own `BlockStatement` (matches Babel; block-scoped
  bindings stay isolated until the simplifier's α-rename flattens them).
- `update.argument` (UpdateExpression) and `assignment.left` use
  `.get_identifier_name()`; `ArrayExpressionElement` → `to_expression()` after
  rejecting `SpreadElement`/`Elision`.
- **`@unroll` markers are removed by this pass** (gone on success since the loop
  is replaced; stripped on soft-fail) so output matches Babel without relying on
  strip-directives running.
- **Deferred (TODO):** non-literal const bounds, negative start, catch-clause
  shadowing, multi-pass fixpoint beyond one bottom-up sweep.

### sroa ✓
- `@sroa const v = [a,b,c]` + constant-index accesses → `let v_0=a, v_1=b, v_2=c`
  with each `v[i]` → `v_i`. Opt-in via `@sroa` on the decl or an enclosing
  function (tracked via `depth` like unroll's optimize). Scope for escape +
  rewrite is the enclosing function/program.
- **Escape analysis** (oxc has no parent pointers): override
  `visit_computed_member_expression` — a valid `v[<lit>]` audits only the index
  and skips the object identifier; `visit_identifier_reference` flags *any*
  other `v` as an escape. Skips nested functions that shadow the name by param.
- **Two rewrite directions:** reads are `Expression::ComputedMemberExpression`
  (→ `expression_identifier`); write targets `v[0] = …` are a *different node
  type*, `SimpleAssignmentTarget::ComputedMemberExpression`
  (→ `simple_assignment_target_assignment_target_identifier`). Both overridden
  in one `AccessRewriter`.
- **Comment preservation:** Babel mutates the decl in place, keeping a leading
  `@sroa` comment; the port builds a fresh `let` node, so it **reuses the
  original decl's `Span`** — the span-keyed comment then re-attaches and matches
  Babel. (General trick for "rewrite a statement but keep its leading comment".)
- Builders: `binding_pattern_binding_identifier`, `variable_declarator(.., NONE,
  init, false)` (the `NONE` const fills the `IntoIn` type-annotation slot);
  dynamic names via `allocator.alloc_str(&format!("{name}_{i}"))`.
- **Deferred (TODO):** multi-declarator decls, decls nested in inner blocks,
  object aggregates, `let`-kind aggregates.

### Recalibration follow-through (TODO 1–3 of the new goal)
- **multi-declarator inline-variables ✓** — inlines one declarator out of a
  `let a,b,c` group; drops the declaration only when empty.
- **node_id keying (bug fix) ✓** — span-based node identity COLLIDES on
  compiler-generated nodes (sroa scalars / `v_i` refs all carry `SPAN(0,0)`).
  inline-variables now keys reads/drops by `node_id` (unique, set by semantic).
  General lesson: **never use span as node identity for generated code — use
  `node_id`.** (Pointer identity is fragile across Vec moves; node_id isn't.)
- **interdependent-inline (bug fix) ✓** — `const a=…; const b=a*…; return b` was
  inlining both in one batch → `return a*…` with `a` undefined (its use-site
  deleted with `const b`). Fix: two-pass collect-then-filter — don't inline a
  candidate whose init references another candidate dropped this sweep; the
  fixpoint loop cascades it next sweep.
- **export annotations ✓** for sroa + unroll (`util::expand_export_annotations`);
  inline-functions export still TODO (needs discovery into `ExportNamedDeclaration`).
- **behavioral-equivalence harness ✓** (`tst/parity/behavioral.parity.ts`) —
  `eval(source) === eval(native output)`, now the PRIMARY correctness gate. It
  immediately caught both bugs above (string-parity didn't). The whole-program
  `sroa-tuple` string-parity red is now a soft signal: behaviorally green, will
  byte-match once the readability cleanup (TODO 4) reduces the residue.

### BLOCK-mode inline ✓ v1 (TODO 5)
Multi-statement `@inline` bodies, **void + statement position** (the `init(out)`
helper pattern). `init(v, 5)` → `{ let out = v; let a = 5; out.x = a; … }` spliced
at the call statement; donor stripped if fully consumed. The `let p = arg`
prologue carries `SPAN(0,0)` so it's generated residue that cleanup/inline-vars
tidy. Behaviorally validated (eval), incl. multi-call-site.
- `classify_block`: simple-void body (no return/this/arguments/nested fn — those
  need the labeled-break machinery, deferred). Bails if an arg references a param
  name (α-rename deferred).
- **Two lifetime gotchas worth remembering:**
  1. **Names must be arena-allocated.** `param.as_str()` borrows from the
     candidate; `Ident<'a>` needs `&'a str`. Use `allocator.alloc_str(p)`.
     (This was the real cause of the "`cand: &'a` required" errors, not the
     clones.)
  2. Pass `&Candidate`/`&CallExpression` to a **free function** (like DIRECT's
     `build_inlined`) rather than looking up through the map inside a method —
     cleaner lifetime inference.
- **Deferred:** expression/init/assign call positions (need result temp +
  hoisting); bodies with returns (labeled-block + `break`); α-rename; and
  **alias cleanup** — BLOCK leaves `let out = v` (identifier alias); cleanup-residue
  only propagates literals today, so broaden it to stable-identifier aliases for
  fully-clean BLOCK output (`{ v.x = 5; … }`).

### cleanup-residue ✓ (TODO 4 — the re-scoped "CFG/dataflow")
Readability cleanup of compiler-generated residue. `/* @sroa */ … return v[0]`
now reduces all the way to `return 5`. **Flipped the last whole-program red
(sroa-tuple) green — now 4/4 — and it byte-matches Babel as a bonus.**
- **Generated-var marker (no plumbing): declarator `span.start == 0`.** Everything
  compilecat synthesizes carries `SPAN(0,0)`; user bindings have real spans
  (>0 inside a function). This cleanly enforces the hard rule "never touch user
  code" — verified: user `let x=1; x=2; return x+p` is left exactly intact.
- **Two phases:** (1) straight-line literal propagation over generated vars
  (reset at control flow; recurse into nested blocks with fresh state),
  substitutions keyed by `node_id`; (2) any generated var now read 0 times → all
  its defs (decls + `g = …` assignments) are dead → removed.
- Conservative v1: literals only, straight-line; bails (leaves intact) on
  anything it can't prove. Gated by the behavioral harness (12 cases incl.
  generated-var-feeds-computation and user-var-across-control-flow), NOT Babel
  byte-parity. Wired into the simplify fixpoint loop.
- TODO when BLOCK-mode inline lands: add the nested-function capture (escape)
  check for its temps; broaden propagation beyond literals if real residue needs.

### inline-variables ✓ (paths 1 + 2)
**First pass on `oxc_semantic`.** Flipped the `fold-constant-arith` whole-program
case green. Paths: (1) single-use pure inline; (2) multi-use primitive-literal
inline. Alias inline (path 3) deferred.

- **The analyze-then-mutate dance** (the crux): `Semantic<'a>` borrows the AST
  immutably, so you can't build it and mutate in the same borrow. Solution:
  build semantic in an inner `{}` scope, collect *owned* edits (init exprs
  `clone_in`'d into the arena — lifetime `'a`, independent of the semantic
  borrow — keyed by read-site `span.start`, plus declarator spans to drop), let
  the scope end (drops `Semantic`, releasing the AST), then apply with a
  span-keyed `VisitMut`. **`build(&*program)` typechecks from a `&mut Program`
  because oxc ASTs are covariant** — the long arena lifetime shortens to the
  borrow. Compiled first try.
- API: `SemanticBuilder::new().build(&*program).semantic`; `scoping()` for
  `symbol_ids()` / `symbol_declaration(sym)` (→ `NodeId`) /
  `get_resolved_references(sym)` (each `Reference` has `is_read`/`is_write`/
  `node_id`); `nodes()` (`AstNodes`) for `kind(id)` / `parent_kind` /
  `parent_id` / `ancestor_ids` — the latter replaces Babel's parent-chain walks
  for the conditional/loop/async safety checks. `Scoping` is **owned** (no
  lifetime), so it survives the drop if you ever need it.
- Reassignment = a write `Reference` (replaces `constantViolations`). Free-var
  stability approximated by a "reassigned local *names*" set (Babel checks the
  exact binding; name-based over-bails only under shadowing — avoided in cases).
- Wired into `run_all` as a **simplify fixpoint loop** `{fold, inline_variables,
  dead_code} × ≤8` so propagation cascades (fold exposes a constant → inline it
  → fold again).
- **Deferred (TODO):** alias inline; inits referencing globals; destructuring.

### minimize-exit-points ✓ (trailing + recursion; hoisting deferred)
- Drops redundant trailing exits (`return;`/`break L;`/`continue;`) and recurses
  into if-branches/nested blocks. Each enclosing structure sets the exit kind its
  body can shed (function→Return, loop→Continue, `L:{}`→Break(L)); only
  argument-less returns and label-matched breaks/continues count.
- `VisitMut` dispatches at structure nodes (walk first = bottom-up), then runs a
  block minimizer (pop trailing matching exit; recurse into the tail's
  if/block).
- **Deferred (TODO):** if-sibling-hoisting (`if(c){A;return} B` →
  `if(c){A}else{B}`) — Babel only hoists when the `if` has siblings *after* it, so
  parity cases use last-child ifs; switch-case minimization; try/labeled
  recursion; `do…while(false)` break. Wired into the simplify fixpoint loop.

### minimize-conditions ✓ (tryMinimizeNot + hook shortcuts; rest deferred)
- Ported: `!!x → x`; `!(a == b) → a != b` (and `===`/`!==` only — relational
  `< <= > >=` are NaN-unsafe, Closure skips them); `c ? true : false → !!c`;
  `c ? false : true → !c`. Bottom-up `visit_expression`.
- **Deferred (TODO):** full `tryMinimizeIf` (if/else → ternary) — needs the
  258-LOC `MinimizedCondition` shorter-form machinery; `performCondition
  Substitutions` (`x||true→true`, `x?y:false→x&&y`, …); `tryRemoveRepeated
  Statements`; `tryJoinForCondition`; `c?x:x→x` (needs `ContentEq`). Parity
  cases use only not/hook forms (Babel does the if→ternary that this defers, so
  no if/else cases). Wired into the simplify fixpoint loop.

### CFG/dataflow trio — DESIGN DECISION: port compilecat's own CFG, NOT oxc_cfg
**Decision (overrides the goal's "add oxc_cfg" hint):** port `control-flow-graph.ts`
(156) + `data-flow-analysis.ts` (225, the lattice/fixpoint framework) +
`local-variable-table.ts` into a new `analysis/` module, rather than use
`oxc_cfg`. Why:
- `oxc_cfg` is a **basic-block** CFG built for lint rules (no-unreachable); it
  isn't even compiled unless `oxc_semantic`'s `cfg` feature is enabled.
- compilecat's dataflow is **per-statement-node** with BitSet GEN/KILL/JOIN
  lattices keyed by binding-slot (`local-variable-table`). Mapping that onto
  basic blocks is an impedance mismatch.
- **Parity** is the goal: porting the exact CfgNode + GEN/KILL/JOIN semantics
  reproduces Babel-version behavior faithfully. The framework is small and
  self-contained.

`analysis/` module (build order):
- [x] `analysis/graph.rs`     — idiomatic index-based `DiGraph<E>` (NodeId, edges
      with `Branch` labels, successors/predecessors). Lattice state lives in a
      parallel `Vec<NodeId→Lattice>`, NOT on the graph (vs the TS object-graph).
      Tested. **Scope reality: the full CFG/dataflow chunk is ~3,640 LOC** —
      `control-flow-analysis.ts` (665) + `data-flow-analysis.ts` (225) +
      `local-variable-table.ts` (200) + reaching def/use (679) + the 3 passes
      (1,453) + graph lib. ~⅓ of the whole compiler; most correctness-critical.
- [ ] `analysis/cfg.rs`           ← `control-flow-analysis.ts` (the builder, 665).
      Key Rust choice: key CFG nodes by AST-node **pointer address**
      (`*const _ as usize`) to replicate JS object-identity for arena nodes.
- [ ] `analysis/data_flow.rs`     ← `data-flow-analysis.ts` (lattice + fixpoint)
- [ ] `analysis/local_var_table.rs` ← `local-variable-table.ts` (binding-slot space).
      **oxc recipe (verified):** per function F (its `Function.scope_id`),
      enumerate `scoping.symbol_ids()`; a symbol is F-local iff walking
      `scope_parent_id` up from `symbol_scope_id(sym)`, the first scope with
      `ScopeFlags::Function` is F's scope. Assign each a slot (order is internal —
      doesn't affect output, so no need to match Babel's param-first numbering).
      `resolve(ref)` = reference→`symbol_id`→slot. `escaped` = a symbol with any
      reference whose scope's nearest function ancestor ≠ F (closure capture);
      plus all params if `arguments` is referenced. Unit-testable in isolation
      (slot counts, resolve, escape) before the CFG rides on it. Note: its
      interface is somewhat coupled to how the dataflow passes share `Semantic`
      (build once, reuse per function) — design alongside the first consumer.
- [ ] passes: `live_variables`, `dead_assignments`, `flow_sensitive_inline`
      (+ `must-be-reaching-variable-def`, `maybe-reaching-variable-use`).

Build infra first, then the three passes. The analyze-then-mutate pattern from
inline-variables applies (build CFG + run analysis over the function body,
collect edits, apply via span-keyed VisitMut). Flips `sroa-tuple` green.

### (superseded) flow-sensitive simplify passes
Only remaining whole-program red is `sroa-tuple`: after sroa + inline-variables
it's `let v_0 = 1; v_0 = 2 + 3; return v_0;` → needs flow-sensitive inline
(propagate the reassigned `v_0`) + dead-assignment elimination (drop `v_0 = 1`).
These are `flow-sensitive-inline-variables.ts`, `live-variables-analysis.ts`,
`dead-assignments-elimination.ts` on a CFG (`SemanticBuilder::with_cfg(true)` →
`oxc_cfg::ControlFlowGraph`) + hand-built dataflow lattices — the largest chunk.
The analyze-then-mutate pattern from inline-variables is the template; the CFG
adds `with_cfg(true)` and `semantic.cfg()`.

## Phase 2 — TypeScript-first, multi-file

### TS-first foundation ✓ (TODO 1) — validated by running it
**TS-preservation works for free.** Ran a battery of real TS through the pipeline:
typed params/returns/vars, interfaces, type aliases, enums, generics, `as`-casts,
typed `@inline`/`@sroa`/BLOCK — **all preserved, none corrupted**, optimizations
fire correctly (`add(x,1): number` → `x + 1` keeping types; `sroa-typed` →
`return 5`; typed BLOCK → `{ v.x = 5 }`). oxc parses TS to a TS AST and codegen
emits it; our passes operate on the JS-shaped nodes and leave TS nodes alone.
- Gate: `tst/parity/ts.parity.ts` — (a) behavioral equivalence via **strip-for-eval**
  (esbuild `loader: 'ts'`, test-only) and (b) "types preserved" assertions
  (output still contains `: number`/`interface`/`enum`/`<T>`/`as`). 11 cases.
- `strip-typescript` stays **intentionally absent** (anti-goal for TS→TS). If a
  JS-output mode is ever wanted, add it mode-gated.

### per-file transform plugin ✓ (TODO 2) — runs in a real bundler
`src/native-plugin.ts` — `compilecatNative()`, a per-file `transform`-hook plugin
backed by the napi core (`createCompiler().compileFile`). Optimizes each source
file BEFORE bundling, keeps TS. Proven end-to-end in an actual **rollup** build
(`tst/parity/plugin.parity.ts`, virtual entry, JS input): `@inline` donor inlined
during transform, `@sroa` optimized per file, directive-free files untouched.
This is the forcing function that replaces `renderChunk` and becomes cross-module
aware in TODO 3. (Directive regex inlined so the native plugin doesn't pull the
Babel modules.)

### cross-file inlining ✓ v1 (TODO 3) — the differentiated value
`import { add } from './math'` + donor `/* @inline */ export function add…` →
`return x + 1` with the import **dropped**. The thing a bundler can't do.
- **Architecture:** JS plugin owns module resolution + fs + watch; it resolves +
  reads donor modules and passes `{specifier, code}[]` to the Rust core
  (`Compiler.compileFileCross` → `transform_cross_file`). Rust does the AST work.
- **Reuse:** factored `inline_functions::{inline_with, classify_direct,
  classify_block}` (pub(crate)); cross-file builds candidate maps keyed by the
  consumer's **local import name**, runs `inline_with`, then `remove_unused_imports`,
  then the normal pipeline (fold/cleanup). No new inliner.
- **Self-containment gate (v1):** a donor fn is inlined only if no free identifier
  in its body resolves to a donor module-level binding (params + globals OK).
  `function scale(v){return v*FACTOR}` with module `FACTOR` is correctly skipped —
  hoisting donor module-vars/imports is the deferred harder half.
- Plugin (`src/native-plugin.ts`): regex-scans relative imports, `this.resolve` +
  `fs.readFileSync` the donors, `this.addWatchFile` for HMR. Proven through a real
  rollup build on disk (`tst/parity/cross-file.parity.ts`) + behavioral eval.
- **TODO 4** (transform primary, renderChunk legacy): the native plugin is
  already transform-based; the renderChunk path is the Babel legacy. Largely done.
- **Deferred:** donor module-var/import hoisting (non-self-contained donors);
  default imports / namespace imports / re-exports; donor parse cache.

### cross-file module-scope hoisting ✓ (copy-then-clean) — replaces the v1 gate
The self-containment gate is gone. Donors that reference module-scope **decls**
(`const FACTOR = 3`, helper fns/classes — transitively) now inline: the needed
decls are **copied** into the consumer and the normal pipeline cleans up.
- **Design call (user, 2026-06-13):** adopt the OG/Babel "bring module-scope
  things across + lean on the cleanup passes" approach over a bespoke
  import-reference/dedup design. Why it works: `inline-variables` + `dead-code`
  already **fold literal consts and drop the dead decl** — so `const FACTOR = 3`
  → `x * 3` with zero new machinery (the "fold tier" is free). Copies land at the
  consumer's **module scope**, not the call site, so no per-call alloc. Copied
  **imports** dedupe at the bundler; only non-literal const *decls* duplicate
  per-consumer (bloat, not a correctness bug).
- **No mutability guard (user call):** shared-mutable module state copied across
  consumers splits — accepted as a **documented `@inline` limitation**, not a
  special case in the code. Keeps it simple; matches the opt-in contract.
- **Mechanism (`cross_file.rs`):** `needed_module_names` walks body free-refs ∩
  donor module bindings, **transitively** (a needed const may pull another
  const/helper); emit those decls in donor source order (preserves dep order),
  `clone_in` into the consumer after the import block; `export` wrappers unwrapped
  so we don't pollute consumer exports; dedup by name (shared dep copied once,
  never clobbers a consumer binding).
- **Still deferred — imported deps:** if a needed name is a donor **import**,
  hoisting it needs the donor's specifier re-resolved relative to the donor's
  path (the core only has `{specifier, code}`, not the donor's abs path). For now
  that donor is left **un-inlined** (correct, just unoptimized).
- Tests: 4 core unit (`cross_file::tests`), 3 parity (fold / non-literal-copy /
  imported-dep-deferred), all behavioral-eval gated. 49 core / 294 main / 114 parity.

### cross-file imported-dep forwarding ✓ — the last hoisting gap
Donors whose `@inline` body needs a name bound by the donor's **own `import`**
now inline: the import is **forwarded** into the consumer (one shared binding,
the bundler dedupes + bundles it — the "import-already-exported dep" tier, no
copying).
- **Bare specifiers** (`import { clamp } from "math-utils"`) are location-
  independent → forwarded verbatim.
- **Relative specifiers** (`./util`) are **rebased** by lexical path math
  (`rebase_specifier`): resolve against the donor's dir, re-express relative to
  the consumer's dir. The bundler re-resolves the rebased path, so extensions /
  index files needn't be known in the core. Needs the donor's own path → added
  `path` to `Donor` / napi `DonorModule` / TS `DonorModule`; the plugin passes
  `resolved.id`.
- **Mechanism:** `forward_import` clones the donor import decl, filters to the
  needed specifiers (deduped against consumer bindings + earlier donors via the
  shared `hoisted`/`bound` set), rewrites `source.value` to the rebased string
  (`raw=None` so codegen prints the new value), prepends it to the consumer's
  import block. Transitive case works: a copied const referencing a forwarded
  import pulls the import in via `needed_module_names`.
- Proven end-to-end: a real rollup build where the donor's sibling `./clamp.js`
  is forwarded and the bundler resolves+bundles it (`Math.max` present, `norm(`
  gone). 52 core / 294 main / 116 parity. clippy-clean.
- **Still deferred:** default/namespace import forwarding (only named specifiers
  today); re-exports (`export { x } from`); α-rename on a true name collision
  between a forwarded/copied dep and a consumer binding.

### library inlining v1 — bare-specifier (node_modules) donors ✓
`import { inc } from "mathcat"` now inlines the package's `@inline` export into
the consumer — the "deeply important" library-inlining goal, first slice.
- **Plugin-only change** (`src/native-plugin.ts`): the import scan generalized
  from relative-only (`RELATIVE_IMPORT`) to any `… from "<spec>"` (`IMPORT_FROM`);
  **bare specifiers are read as donors only when `allowLibraryInline: true`**
  (new `NativeOptions` flag, off by default — when on, every file's package
  imports are resolved + read to scan for directives). Externalized deps
  (`resolved.external`) are still skipped: we only inline what actually bundles.
- **No core change needed:** `collect_named_imports` never cared about specifier
  shape, so all the machinery we already built (decl hoisting, const fold,
  import forwarding) works through a package boundary for free.
- Proven end-to-end through a real rollup build with a node_modules-shaped
  fixture, resolved via an inline `resolveId` plugin (no
  `@rollup/plugin-node-resolve` dep): `inc(x)` → `x + 1` (module const `ONE`
  folded). Gate verified: with `allowLibraryInline` off, `inc(x)` is left alone.
- **Next (blocks real libs):** member/namespace-call inlining (`vec3.add(a,b)`)
  — most libraries expose methods/namespaces, not bare named functions.
- 52 core / 294 main / 118 parity.

### member/namespace-call inlining ✓ (vec3.add) — the real-library blocker
`import * as vec from "mathvec"; vec.add(x, 1)` now inlines to `x + 1`. Most
libraries expose methods/namespaces, not bare named functions, so this is what
makes library inlining actually useful.
- **Inliner change (`inline_functions.rs`):** added `call_key(call)` — a plain
  `fn(...)` keys on `"fn"`, a member call `obj.fn(...)` keys on `"obj.fn"`. Both
  the DIRECT `Inliner` and BLOCK `call_candidate` now match call sites through
  it. **Shape-agnostic:** the inliner doesn't care how `obj` got its binding;
  cross-file just registers the right composite keys.
- **cross_file change:** `collect_namespace_imports` finds `import * as vec`;
  `find_all_inline_exports` returns every `@inline` top-level fn of the donor;
  each is registered under key `vec.<name>` and run through the shared
  `pull_donor_deps` (decl-copy + import-forward, deduped via `hoisted`). The
  named-import path was refactored onto the same helper.
- **Namespace import dropped** only when fully consumed: `vec` is added to
  `inlined_locals` so `remove_unused_imports` drops it iff zero `vec.` refs
  remain. A non-inlinable member (`vec.mul`, no directive) keeps both the call
  and the import — verified.
- Proven end-to-end through a real rollup build with a node_modules-shaped
  namespace package (`import * as vec from "mathvec"` → `x + 1`, EPSILON-style
  const folded). 55 core / 294 main / 119 parity. clippy + biome clean.
- **Deferred (task 3):** named-export *objects* (`import { vec3 }` where the
  donor is `export const vec3 = {add,…}`); re-export following (`export * as vec3
  from './vec3'`, the gl-matrix barrel shape); default-import-as-namespace.

### ESM shape coverage — arrow/expr const exports ✓ (task 3 of the ESM matrix)
`export const add = (a,b) => a+b` (and `= function(a,b){…}`) now inline, via
named import, namespace member-call, or with module deps — same as function
decls.
- **`Callable` abstraction (`cross_file.rs`):** `enum Callable { Func(&Function),
  Arrow(&ArrowFunctionExpression) }` with `param_names` / `body_statements` /
  `classify_direct` / `classify_block`. Discovery (`inline_exports_of`) now yields
  `DonorExport { name, callable }` from a top-level function OR a
  `const NAME = <arrow|function-expr>` (bare or exported); `find_inline_export` /
  `find_all_inline_exports` / `needed_module_names` all route through it. This is
  the unifying seam the rest of the ESM matrix (objects, default, re-exports)
  builds on.
- **Inliner (`inline_functions.rs`):** added `classify_direct_arrow` /
  `classify_block_arrow` — expression-body arrows (`x=>expr`) yield their expr;
  block-body arrows follow the single-`return` rule. `this`/`arguments` still bail.
- 59 core / 294 main / 119 parity. clippy + biome clean.

### ESM shape coverage — export clauses + aliases ✓ (task 4)
`export { add as plus }` and `import { add as plus }` now resolve correctly.
- **Export surface walk:** `find_all_inline_exports` now builds a local-binding→
  callable map (via `inline_exports_of`), then walks the donor's *export surface*
  — `export <decl>` (own name) and `export { local as exported }` clauses
  (renamed, `source: None` only; sourced clauses are re-exports = task 7) —
  emitting a `DonorExport` per consumer-visible name. Bare un-exported helpers are
  no longer surfaced as importable names (they still reach the consumer as copied
  deps). `Callable` is now `Copy` so one callable surfaces under several names.
- **Aliased imports** (`import { add as plus }`) already worked (keyed by local,
  resolved by imported) — locked with a test.
- Renamed exports work through both named imports and namespace member calls.
- 62 core / 294 main / 119 parity. clippy + biome clean.

### ESM shape coverage — named-export objects ✓ (task 5)
`export const vec3 = { /* @inline */ add(a,b){…}, … }` consumed as
`import { vec3 } from 'm'; vec3.add(…)` now inlines.
- **Named-import loop fall-through:** if the imported name isn't a callable
  export, try `object_export_methods` — locate `export const <name> = { … }` via
  the export surface (`export_name_to_local`), extract each `@inline` method /
  function-property as a `(member, Callable)` (object methods, `add: (a,b)=>…`
  arrow props, `add: function…`), and register `local.member` keys for the
  member-call inliner from task 2.
- **Annotation modes:** `@inline` on the whole `export const` annotates every
  member; or per-method (`{ /* @inline */ add(){} }`). Unannotated members stay
  (call + import kept) — verified.
- Module-dep fold works through object members. Import dropped iff fully consumed.
- 65 core / 294 main / 119 parity. clippy + biome clean.

### ESM shape coverage — default export/import ✓ (task 6)
`export default function/arrow/object` + `import vec from 'm'` (and the default
half of `import add, { sub }`) now inline.
- **Consumer:** `collect_named_imports` folds an `ImportDefaultSpecifier` into the
  named list as imported = `"default"`, so the donor side resolves it through the
  same callable/object paths. Default specifier dropped when fully consumed.
- **Donor:** `find_all_inline_exports` handles `ExportDefaultDeclaration` via
  `default_callable` (function decl / function-expr / arrow / `export default x`
  identifier indirection → name `"default"`); `object_export_methods` special-
  cases `"default"` for `export default { … }` object namespaces.
- Mixed `import add, { sub }` inlines both halves.
- 69 core / 294 main / 119 parity. clippy + biome clean.

### ESM shape coverage — re-export barrels ✓ (task 7, gl-matrix shape)
`import { vec3 } from 'mathcat'; vec3.add(…)` where the barrel does
`export * as vec3 from './vec3'` now inlines, plus `export { x as y } from './m'`
named re-exports.
- **Plugin BFS:** donor gathering follows `export … from` edges (re-export
  barrels) breadth-first, deduped by resolved path, capped at MAX_DONORS=200.
  Each donor carries a `resolved` map (specifier → resolved path) so the core
  follows re-exports by exact path, never re-implementing module resolution.
- **Core graph walk:** `resolve_namespace_reexport` / `resolve_named_reexport`
  find `export * as <imported> from S` / `export { n as <imported> } from S` in
  the barrel, resolve S via the donor's `resolved` map to the target donor, parse
  it, and register its exports (namespace members or callable). Refactored the
  per-import logic into a `Registrar` reused for direct donors and re-export
  targets. Source type now derived from `donor.path` (real extension) first.
- **Plugin read cache + reverse map:** build-scoped `donorCache` (read + scan a
  donor once, not per consumer); `consumersByDonor` reverse map + `watchChange`
  eviction — the hooks a Vite HMR adapter needs (inlining removes the import edge,
  so the module graph alone won't invalidate consumers).
- Proven end-to-end through a real rollup build (barrel → submodule namespace).
- 71 core / 294 main / 120 parity. clippy + biome clean (one pre-existing `any`).
**Note:** this is local/syntactic, type-unaware inlining — see the architecture
discussion re: whole-graph TS-aware optimization (a different, heavier model).

### Inlining viability gate — function-to-block-mutator ✓ (gate #1)
Ported `src/compiler/function-to-block-mutator.ts` → `passes/block_mutate.rs`:
`mutate_for_block_inline` turns a callee body (incl. one with `return`s) + args
into a spliceable statement. Returns → `result = X; break LABEL;`; a sole
trailing `return X` falls through as `result = X` (no label/break); fall-off-end
with a needed result appends `result = undefined`; interior returns wrap in a
labeled block. Key oxc move: replace each `return` with a single
`{ result=X; break LABEL; }` block — valid in both statement-list and bare-slot
(`if (c) return x`) positions, so no array-splicing. v1 param handling is
always-temp (`let p = arg`); substitute-simple-args-directly is a follow-up.
5 unit tests green (trailing/early/void/fall-off/multiple-interior). 81 core green.
**Next (gate #2, task 13):** wire it into the inliner — collect-then-splice with
call-site shapes (statement/init/assign/expression) so value-returning
multi-statement calls actually inline. This is the restructure that replaces the
current statement-position-only BlockInliner.

### Inlining viability gate — general BLOCK mode wired ✓ (gate #2, partial)
classify_block now accepts ANY body (was: void-only) — gated by
`block_body_classifiable` (rejects `this`/`arguments`/`try`/`with`/`yield`/
`await`, allows `return`s + nested fns). The BlockInliner routes through
`block_mutate` and handles three call-site shapes via `plan_for`/`make_plan`:
  - `f();`            → block, result discarded (needs_result=false)
  - `x = f();`        → block writes `x`
  - `let x = f();`    → `let x;` + block writing `x`
So multi-statement bodies **with early returns** now inline. Conservative bails
(deferred to gate #14): arg-references-param (α-rename), body-free-ref-to the
reused result var, and the **expression position** (nested call like
`return f(x)+1` — needs a hoisted fresh result temp).
4 inline unit tests + 5 block_mutate tests green. 85 core / 294 main / 120 parity.

### Inlining gate — DIRECT→BLOCK fallback + empty-body DIRECT ✓ (gate #3, #5-partial)
- **Fallback (#3):** single-return functions are now registered in BOTH the
  direct and block maps. DIRECT runs first and inlines every non-bailing call;
  calls it bails (side-effecting arg used >1) are left and the BLOCK pass catches
  them — its `let p = arg` prologue evaluates each arg exactly once. No
  restructure needed. Test: `twice(rand())` → arg evaluated once.
- **Empty-body DIRECT (#5):** `function f(){}` now inlines to `undefined`.
- 8 inline + 5 block_mutate unit tests; 87 core / 294 main / 120 parity green.
**Gate remaining:** #4 α-rename (rename instead of bail when an arg references a
param), #15 BLOCK in expression position (collect-then-splice), nested candidates,
call-site `/* @inline */`, `@flatten`.

### Inlining gate — α-rename ✓ (gate #4)
When an arg references a param name (`scale(v, k)` called inside `f(v, k)`), the
param is renamed `p__<id>` in the cloned body + the prologue instead of bailing —
so the `let p__id = arg` prologue reads the caller's binding soundly. `make_plan`
collects arg identifier names, renames colliding params (sharing the inline's id
suffix), and a `Renamer` VisitMut rewrites the cloned body. 7 inline unit tests.
88 core / 294 main / 120 parity, clippy clean.

**Inlining gate status:** #1 mutator ✓ · #2 BLOCK statement/init/assign ✓ ·
#3 DIRECT→BLOCK fallback ✓ · #4 α-rename ✓ · #5 empty-body DIRECT ✓.
Remaining: #15 BLOCK in expression position (collect-then-splice); nested
(non-top-level) candidates; call-site `/* @inline */`; `@flatten`.

### Inlining gate — behavioral validation ✓
Added 6 behavioral.parity cases (eval source ≡ eval native output through napi):
early-return in init position (both branches), assign-position BLOCK, DIRECT→BLOCK
fallback (impure arg evaluated once), α-rename, multi-interior-return. All pass.
The viability gate's CORE — general BLOCK inlining (any body incl. returns, in
statement/init/assign positions) + fallback + α-rename + empty-body — is done and
behaviorally proven. 88 core / 294 main / 126 parity.
Remaining gate completeness (task 14/15): expression-position BLOCK, nested
candidates, call-site `/* @inline */`, `@flatten`.

### Inlining gate — expression-position BLOCK ✓ (gate #2 complete)
A BLOCK candidate call nested in an arbitrary expression (`return sq(x)+1`,
`[sq(x), sq(x+1)]`) now inlines: `ExprHoister` (VisitMut per non-shape statement,
skipping nested functions) walks expressions post-order so inner calls hoist
first, builds the block via shared `build_block_plan` + `block_mutate` with a
fresh `_compilecat_result_<id>` temp, emits `let _result; <block>` before the
statement, replaces the call with the temp. Updated one stale unit test
(`twice(g())` in return position now inlines via fallback, g() once). 2 behavioral
cases added. 88 core / 294 main / 128 parity, clippy clean.
**Inlining gate now:** #1 ✓ #2 ✓(all positions) #3 ✓ #4 ✓ #5 empty-body ✓.
Remaining: nested (non-top-level) candidates, call-site `/* @inline */`, `@flatten`.

### Inlining gate — @flatten ✓ (gate #6)
`/* @flatten */ function host(){…}` inlines the calls inside the host using ALL
top-level functions as candidates (scoped to the host's body via
`Inliner`/`BlockInliner`.visit_function_body), even callees not annotated
`@inline`. Semantics simplified vs Babel (descends into the host's nested
functions too) — behaviorally equivalent, which is our gate. Spans collected
before the @inline early-return so @flatten works standalone. Strip stays
`@inline`-only (must not strip arbitrary unreferenced functions; @flatten-orphaned
callees are the dead-code pass's job). 2 unit + 1 behavioral test.
90 core / 294 main / 129 parity, clippy clean.
**Inlining gate:** #1 ✓ #2 ✓ #3 ✓ #4 ✓ #5 empty-body ✓ #6 @flatten ✓.
Remaining (minor): call-site `/* @inline */ foo()`, nested (non-top-level)
candidate discovery.

### Inlining gate — call-site @inline + nested/const-arrow discovery ✓ (GATE COMPLETE)
- **Nested + const-arrow discovery:** `CandidateCollector` walks the whole tree
  (replacing the top-level-only loop), discovering `@inline` `function NAME` and
  `const NAME = <arrow|fn-expr>` at ANY scope (outermost name wins). Closes a real
  gap — the local pass didn't even discover const-arrow `@inline` before.
- **Call-site `/* @inline */ foo()`:** an optional `trigger: Option<HashSet<u32>>`
  threads through `Inliner`/`BlockInliner`/`ExprHoister` (None = inline all
  candidates; Some = only calls whose span is annotated). A guarded pass
  (`has_callsite_annotation`) runs over the program with all top-level functions
  as candidates + trigger = the `@inline` spans, inlining only annotated calls to
  any function. The early-return now accounts for call-site-only annotations.
- **VIABILITY GATE COMPLETE:** #1 return-bodies ✓ · #2 all call positions ✓ ·
  #3 DIRECT→BLOCK fallback ✓ · #4 α-rename ✓ · #5 nested + call-site + empty-body
  ✓ · #6 @flatten ✓. 13 inline + 5 mutator unit tests + 24 behavioral eval cases.
  94 core / 294 main / 130 parity, clippy clean.
Next (priority #2): finish ModuleCache integration.

### ModuleCache integration — napi Send de-risked + scaffolded (gate priority #2, partial)
Verified the key unknown: **napi does NOT require the `#[napi] Compiler` struct to
be `Send`** — `RefCell<ModuleCache>` holding `!Send` oxc ASTs compiles + builds the
.node fine. So the "cache on the Compiler" design is viable. Field added (scaffold,
`#[allow(dead_code)]` until wired). 130 parity / 294 main still green.
**Remaining (the cross_file rewiring):** thread `&mut ModuleCache` into
`transform_cross_file`; two-phase (ensure-all-cached via `get_or_parse`, then read
via a new `get(&self)`); replace the per-call `parse_program` of donors + the
re-export resolvers' parses with cache reads; `clone_in` candidates out of cache
arenas into the per-call allocator. Known frictions to handle: (1) cache keys on
`path` — the Rust unit `run` helper uses `path=""`, so give tests unique paths or
fall back to specifier; (2) the re-export resolvers currently return owned
`Program` — switch to returning `&ParsedModule` (cache lifetime). Modest perf win
(re-parse measured cheap), so do it carefully without regressing the cross-file
suite; its real payoff is as the type-layer substrate.

### ModuleCache integration — cross_file rewired ✓ (gate priority #2 COMPLETE)
`transform_cross_file` now takes `&mut ModuleCache`: phase 1 `get_or_parse`s every
donor once (keyed by path); phase 2 reads donors via `cache.get(...).program()`
instead of re-parsing per call; the re-export resolvers read from the cache too.
The napi `Compiler` holds `RefCell<ModuleCache>`, so donors parse once per BUILD
(persisting across `compileFileCross` calls). Lifetimes: the cache borrow outlives
the per-call arena, so its `&Program`s covariantly coerce where `&Program<'a>` is
expected — no pervasive signature decoupling needed; candidate bodies still
`clone_in` out into the per-call allocator at splice. Test paths made unique
(cache keys on path). New test: a donor parsed ONCE across two consumers sharing
the cache. 96 core / 294 main / 130 parity, clippy clean.

### Validation gates ✓ (gate priority #3 COMPLETE)
- **addWatchFile HMR wiring:** a deterministic test invokes the plugin's
  `transform` with a mock context and asserts it calls `addWatchFile(donorPath)` —
  the mechanism that re-transforms a consumer when a donor changes (the import
  edge is gone after inlining, so this is what drives HMR re-inlining).
- **Real rolldown smoke:** added `rolldown` (1.1.1) as a dev dep; a test runs an
  actual `rolldown()` build with the plugin and asserts cross-module inlining
  works end-to-end (`add(x,1)` → `x + 1`). Confirms the rollup-compat assumption
  directly in the real target bundler.
132 parity / 294 main, lint clean.
**Goal priorities: #1 inlining gate ✓ · #2 ModuleCache ✓ · #3 validation ✓.
Remaining: #4 type-resolution layer (the differentiator).**

### Type-resolution layer — type-aware SROA ✓ (priority #4, slice 1 — FIRST type-aware opt)
`@sroa` now fires on a TYPED fixed-tuple aggregate, not just a literal:
`const v: Vec3 = mk()` → `let [v_0, v_1, v_2] = mk()` (+ `v[i]`→`v_i`). The TYPE
supplies the arity the opaque initializer can't; we destructure it (a tuple is
array-iterable, evaluated once). Introduces the **type-shape oracle** —
`build_alias_arities` (pre-resolves top-level `type X = <fixed tuple>` to owned
arities, alias→alias with a cycle guard) + `type_arity`/`tuple_arity` (inline
TSTupleType or alias ref; bails on rest/optional). `SafeCand` split into
`Literal(Vec<Expr>)` | `Destructure(Expr)`; `escape_ok` + `AccessRewriter` reused.
The type annotation lives on the `VariableDeclarator` (`d.type_annotation`).
4 unit tests (inline tuple, local alias, rest-bail, escape-bail) + 1 behavioral
eval case (Vec3 destructure ≡ original). 99 core / 294 main / 133 parity, clippy
+ biome clean.
**Slice 2 next:** cross-module type aliases (resolve `Vec3` imported from a donor
via the ModuleCache) — the type-resolution-over-donors generalization.

### Type-aware SROA — hardened test coverage
After review, closed the gaps: nested-alias resolution (alias→alias→tuple),
recursive-alias cycle-guard (no hang), below-MIN_FIELDS bail (1-element tuple),
and a second behavioral eval case (inline-tuple type with a side-effecting `mk()`
whose call count proves the initializer is evaluated exactly once + arity is
correct). Now 7 type-aware SROA unit tests + 2 behavioral eval cases (alias-tuple
covers mutation+read; inline-tuple covers eval-once). 102 core / 294 main /
134 parity, clippy + biome clean.

### Inliner correctness + output-cleanliness pass (#1/#2/#3)
Triggered by reviewing the three known deltas from the Babel inliner. Testing #3
(instead of asserting) surfaced that it was not a cosmetic gap but a **real
soundness hole**: a donor body's *free variable* gets captured by a consumer-
local binding of the same name (donor reads module `base`; consumer has
`let base` → spliced body now reads the consumer's `base`). Affected BOTH DIRECT
and BLOCK paths and produced silently-wrong output (`return 7` for an expected
`106`).

- **#3 capture guard (correctness):** each `Candidate`/`BlockCandidate` now
  carries its `free` var set (`free_vars_expr` / `free_vars_stmts` — referenced
  idents minus params, minus the body's *top-level* declarations so a real outer
  capture is never missed). `collect_local_names` gathers all NON-module binding
  names of the consumer (function/arrow params + in-function var/let/const/catch;
  module-level and function/class *decl names* excluded — the latter a
  documented, rare soundness boundary). `build_inlined` (DIRECT) and
  `build_block_plan` (BLOCK) bail when `free ∩ local_names ≠ ∅`. Coarse (program-
  wide local set, not call-site-scoped) but sound + cheap; param-only donors have
  an empty `free` set so the common path is unaffected. Shared into the per-
  statement `ExprHoister` via `Rc<HashSet>` (no per-statement clone).
- **#1 substitute simple args:** `build_block_plan` now substitutes simple
  identifier/literal args directly into the body for params that aren't reassigned
  (`modified_params` + `OwnedSubstitutor`), emitting a `let p = arg` temp only for
  reassigned params or non-simple/side-effecting args (eval-once preserved). Kills
  the alias residue the cleanup passes don't remove (`inline-variables` alias-
  inlining is deferred; `cleanup-residue` only propagates literals).
- **#2 nested strip:** the 0-ref `@inline` strip is now a `StripVisitor`
  (VisitMut) that removes dead candidate `FunctionDeclaration`s at ANY scope, not
  just `program.body` — a fully-inlined nested `@inline` fn is the pass's own
  residue. Exported donors (`ExportNamedDeclaration`) still never stripped.

+6 inline unit tests (3 capture: DIRECT bail / BLOCK bail / no-collision inlines;
2 simple-arg: modified-param keeps temp / side-effecting arg eval-once; 1 nested
strip) + the `block-init-unsafe-reuse-demotes` behavioral case. **108 core / 294
main / 135 parity; clippy clean on changed files** (one pre-existing unrelated
`while let` warning in minimize_exit_points; whole-crate rustfmt drift is a
toolchain-version artifact, left untouched).

### Capture guard — closed the nested-function-name boundary
`collect_local_names` now collects *nested* function declaration names (enclosing
`depth > 0`), while still skipping top-level (module-scoped, safe) ones — class
ids were already collected via the default `visit_class` walk. This closes the
last realistic capture case: a donor free var shadowed by a nested `function
name` in the consumer (e.g. donor reads module `helper`; consumer has a nested
`function helper`). The guard is now sound for all non-`with`/non-`eval` code.
+1 unit test (`bails_when_free_var_captured_by_nested_function_decl`). 109 core /
294 main / 135 parity.

### Type layer slice 2 — cross-module type aliases (the type-resolution-over-donors generalization)
Type-aware SROA now fires across module boundaries: `import { Vec3 } from './math'`
+ `const v: Vec3 = mk()` destructures into scalars, with the arity resolved from
`./math`'s AST. Rust-only change — the plugin already gathers the type donor
(`IMPORT_FROM` matches the import, and the consumer's `@sroa` opens the
`compileFileCross` path), so the donor is already in the ModuleCache.

- `transform_cross_file` builds `external_alias_arity: HashMap<local → arity>` via
  `collect_imported_type_arities`: for each named import (reusing
  `collect_named_imports`, which already captures `import {T}`/`import type {T}`),
  find the donor, run the SROA oracle's now-`pub(crate)` `build_alias_arities` over
  the donor program, and map the consumer's local name → arity. Plain arities, no
  borrow into donor programs (same design as the local oracle).
- Threaded through `passes::run_all` → `sroa::run(.., external_aliases)`, which
  overlays imported aliases under same-file ones (a local `type X` shadows an
  imported one). Plain `transform` + the per-pass harness pass an empty map.
- This is the ModuleCache earning its keep beyond inlining: it's now the shared
  home for donor *type* facts too.

Scope: direct type imports + donor-local alias chains (`export type V = Pair`
where `type Pair = [..]`). **Deferred:** a type re-exported through a barrel
(`export type { Vec3 } from …`) — the directly-imported module doesn't declare it,
so its alias map won't carry the name (the inlining side's re-export following
could be mirrored for types later).

+3 core unit tests (imported tuple / donor alias chain / non-tuple no-fire) + 1
behavioral parity case through `compileFileCross` (eval ≡ original). 112 core /
294 main / 136 parity.

### Type layer slice 3 — object-type SROA (records)
SROA now scalarizes records, not just tuples. `@sroa const v = { x, y, z }` (or a
typed `const v: Vec3 = mk()`) with only `v.x` field accesses becomes named
scalars `let v_x = …` (literal) or a destructure `let { x: v_x, … } = mk()`
(typed). Generalizes the whole SROA framework rather than bolting on a parallel
pass.

- **Oracle now returns shapes:** `usize` arity → `Shape { Tuple(usize) |
  Object(Vec<String>) }`. `build_alias_shapes` (was `build_alias_arities`, still
  `pub(crate)`) scans `type` aliases AND `interface` declarations; resolves inline
  tuple types, `TSTypeLiteral` object types, and reference chains (alias→alias,
  alias→interface) with the cycle guard. `object_fields` extracts a plain
  identifier-keyed field set, bailing on optional/computed/string-keyed members,
  methods, index/call/construct signatures. `interface_shape` bails on `extends`
  (inherited fields unresolved — deferred).
- **Escape + rewrite gain static-member arms:** `EscapeChecker` allows `v.field`
  for a known field of an `Object` shape (and still `v[lit]` for `Tuple`),
  bailing on the cross cases (record indexed, tuple property-accessed, dynamic
  key, whole-`v` escape). `AccessRewriter` rewrites `v.field`→`v_field` in both
  read (`StaticMemberExpression`) and write (`SimpleAssignmentTarget::Static…`)
  positions, mirroring the tuple computed-member handling.
- **`scalar_decl`** gains object forms: per-field `let v_x = …` (literal) and the
  object binding pattern `let { x: v_x, … } = expr` (typed destructure).
- **Cross-module for free:** `collect_imported_type_shapes` (was `…_arities`)
  returns `Shape`s from donor ASTs via `build_alias_shapes`, so an imported
  `interface Vec3` / `type Vec3 = {x,y,z}` resolves through slice 2's plumbing
  unchanged. `run_all` / `sroa::run` external param is now `HashMap<String,
  Shape>`.

Same opt-in type contract as the tuple destructure (assumes plain field reads, no
getters); the literal-object form has no caveat. **Deferred:** interface
`extends`, optional fields, computed/string keys, barrel-re-exported types.

+8 core unit tests (object literal / inline object type / interface / alias→
interface / escape / dynamic-key / optional / method bails) + 4 behavioral parity
cases (object literal, typed object, eval-once destructure, cross-module imported
interface ≡ original). 120 core / 294 main / 140 parity, clippy clean on changed
files.

### Type layer — generalized the oracle into a real resolver (`TSType → ResolvedType | bail`)
Replaced the bespoke `Shape`-only oracle with a small, principled, demand-driven
type resolver. It models the *structure of written annotations* (not inference),
sound-bails on everything unmodeled, and `Shape` is now a projection
(`shape_of`), so SROA and every existing test are byte-for-byte unchanged.

- **`ResolvedType`** IR: primitives, literal types (`NumberLit`/`StringLit`/
  `BoolLit`), `Tuple`, `Object(Vec<(name, ResolvedType)>)`, `Union`, `Unknown`
  (= typed-but-no-structure, distinct from `None` = not-modeled). Owned, no
  borrow into the program (resolved before SROA mutates). Literal/union payloads
  are produced now, consumed later (const-enum / narrowing) — `allow(dead_code)`
  with that intent documented.
- **One structural resolver, two name sources** (`NameSrc`): `Decls` (declaration
  phase — follows alias/interface bodies in the AST, read-only) and `Resolved`
  (use-site phase — looks names up in the borrow-free resolved map, during
  mutation). Shared arms; only reference resolution differs. Cycle-guarded.
- **New coverage the old oracle bailed on** (all preserving sound-bail):
  intersection `A & B` and interface `extends` (both via `merge_objects` — union
  of record field sets; bail if any part isn't a record), parenthesized types,
  and generic *record* aliases (`Box<number>` resolves its field-name shape; type
  args ignored, member types → `Unknown` — all SROA needs). Use-site intersection
  (`const v: A & B`) works too.
- **Cross-module unchanged**: `build_alias_shapes` is now a thin projection over
  the resolver's declaration phase, so imported `interface Vec extends Base`
  resolves across modules with no cross_file changes.

**Still deferred** (sound bails): optional fields, computed/string keys,
member-accurate generic *instantiation*, `EnumMember` (awaits const-enum),
barrel-re-exported types, and anything inference/narrowing/type-level-computation
(conditional/mapped/keyof/utility types) — that's the typescript-go-backend line.

+13 tests (intersection alias + use-site, interface extends local + cross-module,
generic record shape, intersection-with-primitive + union bails, plus 2
behavioral parity eval cases). 130 core / 294 main / 143 parity, clippy clean on
changed files. The resolver is now the seam a deeper backend (typescript-go)
could slot behind without touching any pass.

### Directive stripping — proper token removal + a `changed`-flag bug (found via crashcat)
Building crashcat (99-file physics engine) with the native pipeline surfaced 20
leftover `@optimize`/`@inline` directive comments in the output (OLD stripped all).
Two distinct causes, both fixed:

1. **Strip only deleted marker-only comments.** oxc comments are span-based
   (printed text = `source_text[span]`, not editable), so the pass could only drop
   whole `/* @inline */` comments — directives embedded in JSDoc (alongside
   `@param`/`@returns`) survived. Fix: rebuild `source_text` as `original +
   cleaned-texts` and repoint each rewritten comment's span into the appended
   region (the original stays an exact prefix → all other spans valid). Now matches
   the Babel pass: `/* @inline foo */` → `/* foo */`, JSDoc keeps its docs and drops
   the directive line, marker-only comments are deleted.
2. **`changed` didn't count stripping.** `run_all` discarded
   `strip_directives::run`'s return, so a file whose *only* edit was removing a
   directive (e.g. `@optimize` on a function with no unrollable loop) reported
   `changed=false` → the native plugin returned `null` → rolldown kept the
   ORIGINAL source, directive intact. This is why 3 stubbornly survived after fix
   #1. Added `Stats::stripped`, included it in `changed()`, and accumulated it in
   `run_all`/`run_one`.

Result on crashcat: 20 → 0 leftover directives; output still valid ESM, identical
185-export surface. +2 strip unit tests (mixed comment, JSDoc). 132 core / 294
main / 143 parity, clippy clean on changed files.

**Real-world validation (crashcat):** the native pipeline builds the whole engine
+ the `mathcat` library, ~35× faster than the Babel build (160ms vs 5.7s),
produces valid ESM with the exact same public API, SROA + inlining fire
extensively (24 tuple + 83 record scalars). The old-vs-new size delta (−15%) is
not a clean A/B (old = bundle-mode renderChunk, new = per-file transform). Next
real-world step: behavioral validation (run crashcat's own tests/benchmarks
against a native build). Deferred: `@applied-inline` breadcrumbs (awkward in oxc's
position-gated, span-based comment model — see below).

### `@applied-inline` breadcrumbs — built, then reverted (rolldown strips them)
Attempted the Babel-style `@applied-inline <call>` breadcrumb. Built it end-to-end
(core emits a leading comment on the enclosing statement via an appended-source
buffer; unit-tested green) — but **verifying on the crashcat build showed 0
breadcrumbs vs OLD's 88.** Root cause is architectural, not a code bug:

- oxc only prints leading comments at *statement* boundaries (confirmed: only
  statement Gen impls call `print_comments_at`), so breadcrumbs attach to the
  enclosing statement — fine.
- **But rolldown re-codegens the bundle and drops ALL leading comments** (`/* */`,
  `//`, and `/** */`, under default *and* `comments: true` — tested directly). NEW
  is transform-mode, so rolldown always bundles after us and strips them. OLD
  keeps its 88 only because it's bundle-mode (`renderChunk` = the last codegen).

So breadcrumbs are invisible in the real transform-mode + rolldown build —
reverted the whole feature (kept the directive-strip fix, which is independent and
verified). Lesson (again): validate end-to-end through the bundler, not just our
own codegen. Observability that survives a re-codegen would be a structured
debug/stats report, not comments — deferred. 132 core / 294 main / 143 parity.

### `@optimize` combo-directive fix + the GJK inlining gap (found via crashcat sanity check)
Manually diffing OLD vs NEW output for a GJK function (`computeClosestPointOnLine`,
`@optimize`) showed NEW inlines far less: OLD inlines `computeBarycentricCoordinates2d`
+ the vec3 ops; NEW keeps them as calls. Two causes:

1. **`@optimize` wasn't a combo directive in Rust** (clear bug, fixed). `directives.ts`
   defines `@optimize` ⇒ `@flatten` + `@sroa` + `@unroll`; the Rust port only wired
   it to unroll. Fix: `inline_functions` adds `@optimize` to `flatten_spans`, `sroa`
   adds it to `sroa_spans` (unroll already handled it). +2 unit tests
   (`optimize_implies_flatten`, `sroa_optimize_implies_sroa`). 134 core / 294 main /
   143 parity green.

2. **The bigger gap is transform-mode vs bundle-mode scope** (not a bug — architectural).
   Even with #1, crashcat output barely changed (SROA 24+83 unchanged, +1.8KB). The
   GJK `@optimize` functions call *cross-file* helpers (`computeBarycentricCoordinates2d`
   in closest-points.ts — NOT `@inline`) and mathcat vec3 ops. OLD runs bundle-mode
   (`renderChunk` = one program), so `@flatten` inlines the whole chunk including
   cross-file callees. NEW runs transform-mode (per-file), so `@flatten`/`@optimize`
   only inlines *same-file* top-level functions; non-`@inline` cross-file callees stay
   as calls. Output is correct (same computation) but less inlined.

   **To close it: cross-file flatten** — when an `@optimize`/`@flatten` host calls an
   *imported* function, inline it across the module boundary (like `@inline` donors,
   but for all callees of a flatten host). That's what GJK's hot path actually needs
   in transform-mode; the single host annotation is the whole point. Deferred —
   next hot-path feature.

### Cross-file `@flatten`/`@optimize` — closed the GJK gap (no duplicated logic)
The real parity hole behind the GJK sanity check: a `@flatten`/`@optimize` host
only inlined *same-file* callees (OLD, being bundle-mode, inlines the whole chunk).
Now a host inlines its *imported* callees too — the cross-module analogue.

Built it reusing, not duplicating:
- **Resolution**: `cross_file`'s `register_export` + `pull_donor_deps` are already
  gate-agnostic; the `@inline` check lived only in the finder. Added a
  `require_inline` flag threaded through `inline_exports_of` /
  `find_all_inline_exports` / new `find_export` — `false` resolves *any* callable
  export (flatten), `true` keeps `@inline`-only. No parallel resolver.
- **Application**: extracted `flatten_into_hosts` + `gather_all_callables` +
  `collect_flatten_spans` from the same-file `@flatten` block; the local pass and
  the cross-file driver both call them. One application path. (`@inline` stays
  whole-program via `inline_with`; flatten stays host-scoped via
  `flatten_into_hosts` — the one intentional fork, a scope arg, not copied code.)
- **Driver**: `transform_cross_file` detects hosts (`collect_flatten_spans`),
  collects the call keys used in host bodies (`call_names_in_hosts`), resolves the
  imported non-`@inline` callees through the shared `register_export`, then
  `flatten_into_hosts` (host-scoped) + dep forwarding + unused-import removal.

**Verified on crashcat**: `computeClosestPointOnLine` (`@optimize`) now inlines the
imported `computeBarycentricCoordinates2d` (barycentric math spliced into the host,
labeled-block for early returns) — matches OLD. +4 tests (cross-file flatten
inlines / leaves non-host callers; `optimize_implies_flatten`/`_sroa`). 136 core /
294 main / 143 parity; valid ESM; 0 leftover directives. (mathcat vec3 ops still
calls — that's the separate `allowLibraryInline` knob, off in this harness.)

**Honest correction to earlier "inlining parity complete":** that claim was wrong —
`@inline` cross-file was done, but `@flatten`/`@optimize` cross-file was not, and I
asserted parity from isolated unit tests without an end-to-end check. The crashcat
diff is what caught it. Parity now actually covers the flatten/optimize cross-file
path too.
