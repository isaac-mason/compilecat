# Deferred from the Babel version — consolidated tracker

Single source of truth for everything the Rust/oxc port does **not yet** do that
the Babel pipeline does. Per-pass sub-features are also noted in each pass's
module doc-comment and in `WORKLOG.md`; this file is the checklist.

Two kinds: **(A) whole pipeline phases not yet ported** (no Rust file exists —
these are NOT visible in per-pass deferral notes) and **(B) per-pass deferred
sub-features**.

## ⚠ STATUS — audited 2026-06-18 (this list was significantly stale)

A source audit + a differential sweep (`tst/parity/crashcat-sweep.parity.ts`)
found many items below marked deferred that are in fact **DONE**. Authoritative
tracker is now **`CUTOVER_PLAN.md`** (§4 disposition table, §5c findings). Specific
corrections:

- **DONE — CFG/dataflow trio.** `flow-sensitive-inline-variables`,
  `live-variables-analysis`, `dead-assignments-elimination` and the `analysis/`
  infra (`cfg`, `data_flow`, `live_vars`, `reaching`, `local_var_table`) are
  implemented and wired into the fixpoint (`passes/mod.rs:97-104`). The `[ ]`
  sub-items under "CFG/dataflow trio" below are obsolete.
- **DONE — normalize α-rename / `MakeDeclaredNamesUnique` + `tryMergeBlock`.**
  Implemented in `passes/block_flatten.rs` (scope-aware `renameForFlatten` on real
  collisions, `$N` suffix; bare-block merge). NOT in `normalize.rs` — that's
  structural-only by design. So the "normalize α-rename — NOT started" item is wrong.
  (Native renames *lazily* — only on real collision — vs Babel's eager `__N`; this
  is an intentional cleaner-output divergence, the source of the harness's
  "naming-only" bucket.)
- **DONE — `@flatten` end-to-end** (`inline_functions.rs` + cross-file) and
  **strip-directives mixed-comment** (`strip_directives.rs:72-102`). The Section C
  `[ ]` for `@flatten` contradicted Section B and is wrong.
- **FIXED 2026-06-18 (correctness, both with cargo regression tests):**
  (1) destructuring alias-inline miscompile in `inline_variables.rs`
  (`const [a,b]=arr` substituted the whole array for each element);
  (2) task-#29 block-inline-in-init-position miscompile — `flow_inline` applied
  two chained inline decisions in one pass, deleting a def whose only use sat in
  another decision's dropped subtree (`const r=_t; return r` + `_t=E` → orphaned
  → `return undefined`). Fix: `analyze_fn` now defers a decision whose use-site is
  a descendant of any drop node; the fixpoint resolves the chain. (DEFERRED.md and
  a stale `.node` had both hidden this — it was NOT actually fixed in code despite
  the §B "task #29 ✅ FIXED" claim, which referred to a fix that wasn't present.)
- **Known-open (reopened):** unroller emits a `{ }` block per iteration that isn't
  merged (`block_flatten` runs before `unroll`). Do NOT fix by *moving*
  `block_flatten` after unroll — that reintroduces task-#29. Add a *second*
  post-unroll `block_flatten` run instead.
- **Real remaining gaps (from the sweep, see CUTOVER_PLAN §5c):** single-use
  member-access inline (path-1 bails on all property reads; Babel inlines when
  safe); minimize-conditions shorter-form (E2); minimize-exit-points
  switch/labeled (E3); dead-code folds (E1); cross-module `@unroll` (D1); `export *`
  without alias (D2); diagnostics (C1); source-map chaining (C2). Unroll
  aggressiveness vs Babel is a divergence pending a keep-or-match decision (not a bug).

The detail below is kept for context but **trust CUTOVER_PLAN.md over the
checkboxes here** until this file is rewritten to match.

## Roadmap (two phases)

- **Phase 1 — absolute JS/Babel parity (current).** Clear this whole list.
  Keep `renderChunk` (whole-program) as the parity forcing function.
- **Phase 2 — TypeScript-first, always-multi-file (later; do not start early).**
  Optimize TS→TS *before* the bundle, hand output to rolldown. Forcing function
  moves off `renderChunk` onto the per-file `transform` hook. Two items below
  invert/relocate in phase 2 — flagged inline:
  - `strip-typescript` (A) — **mode-gate it**, never bake in; phase 2 turns it
    OFF to preserve types.
  - cross-file/PerFile mode (A) — becomes the **centerpiece**, not a deferral.

---

## Intentional divergences (WON'T FIX by design)

These differ from Babel on purpose — fixing them would *regress* intent, not
improve parity. Byte-parity with Babel will therefore never be 100%, and that is
correct. Each is pinned by an `intentional_*` cargo test (or a `preserves_*` /
`module_top_level_*` test) so it can't silently drift.

- **Opt-in gating.** OLD's `transform` optimized everything unconditionally; NEW
  only touches directive-annotated constructs and their subtrees (module
  top-level/un-opted code is left byte-identical). The whole point of the
  per-construct directive model. Pinned: `tests/gating.rs`,
  `pipeline::module_top_level_without_directive_is_left_alone`.
- **TypeScript preserved (no type-strip).** TS→TS optimizer; types on untouched
  code are kept. Pinned: `pipeline::preserves_types_on_passthrough_ts`,
  `tst/parity/ts.parity.ts`.
- **`if/else` not collapsed to ternary** (`minimize-conditions`). Readability
  choice (OLD's own comments disable it; the downstream minifier does size
  collapsing). Pinned: `minimize_conditions::preserves_if_else_*`.
- **Single-use object literal not inlined** (`inline-variables`). Competes with
  SROA, which needs the `const o = {…}` declaration to scalarize the high-value
  path. Pinned: `inline_variables::intentional_keeps_single_use_object_literal`.
- **Bare member-access statement kept** (`dead-code`). Babel's
  `assumeGettersArePure` drops `a.b.c;` as dead; assuming getters are pure is
  UNSOUND, so NEW keeps it (would only change behind an explicit assume-pure
  flag). Pinned: `dead_code::intentional_keeps_member_access_statement`.
- **Object/typed SROA in nested blocks** is a NEW *superset* (Babel has no object
  SROA at all) — not a divergence to "fix", a capability OLD lacked.
- **Module-scratch localization** is a NEW capability with no Babel analogue:
  LLVM-GlobalOpt-style global-localization *fused into SROA* (`sroa.rs`). A
  single-owner module-level scratch buffer
  (`const _s = /*@__PURE__*/ [0,0,0]`) used as per-call temporary storage inside
  one `@optimize` function is scalarized into per-call locals and the module const
  deleted. Gated by a CFG must-reaching-defs analysis (killed-on-entry), a symbol
  gate, and a re-entrancy guard, so it never fires when the buffer's state could be
  observed across calls. Fused so the buffer is never materialized as a per-call
  allocation. Pinned by `sroa::tests` + `tst/real-world.test.ts`.
- **Function purity analysis + `@pure`** is a NEW capability (port of Closure's
  `PureFunctionIdentifier`, `analysis/purity.rs`). A reverse call-graph fixpoint
  proves side-effect-free functions; `stamp_pure_calls` (`passes/mod.rs:74`) marks
  their calls `pure` before inline, so surviving pure calls can be dropped /
  reordered / substituted and codegen emits `/*@__PURE__*/` for the bundler.
  `@pure` and `/*@__PURE__*/` are developer-assertion overrides layered on top.
  Soundness pinned by the effect-trace fuzzer + `purity::tests`.

---

## A. Whole pipeline phases missing

Compare against `src/compiler/pipeline.ts` `PHASE_ORDER`:
`parse · stripTypeScript · normalize · inlineFunctions · unrollLoops ·
inlineVariablesPre · sroa · simplify · inlineVariablesPost · removeUnusedCode ·
stripDirectiveComments · generate`.

- [n/a] **strip-typescript** — **intentionally NOT built (phase-2 anti-goal).**
  We're a TS→TS optimizer, so types are *preserved* (verified: see
  `tst/parity/ts.parity.ts`). This was a "gap" only under the old JS/Babel-parity
  framing. If a JS-output mode is ever wanted, add it **mode-gated** (off by
  default) via oxc's TS transform — never as a baked-in phase.
- [x] **remove-unused-code ✓** (`passes/remove_unused.rs`, 2026-06-15) — the
  `removeUnusedCode` phase. Drops zero-reference (read/write/type) `let|const|var`
  declarators (pure init), `function`/`class` declarations (no side-effecting
  static members), and import specifiers / whole imports, to fixpoint. Detection
  is span-precise via `oxc_semantic` (shadow-safe); removal is a structural
  `VisitMut` that only touches bare decls, so exports are preserved. Keeps
  type-only-used imports (we keep TS). Wired in `run_all` after `simplify`. Full
  Babel parity (removes top-level too) — behavioral parity harnesses updated to
  model exported entries (the entry IS the module API). Validated on three.js:
  722 files compile to valid output, forced-NEW build behaviorally identical.
  NOTE: NEW lacks OLD's per-function `touched`-gating, so it optimizes every
  function in a processed file, not just opted-in ones (see WORKLOG).
  **Confirmed conservative vs Babel (cargo-pinned, SAFE — kept code is correct,
  just not removed):** (1) a recursive function whose only reference is its own
  self-call is NOT removed (the self-call counts as a read → ≥1 reference); Babel
  removed it. (2) an unused **destructuring** declarator (`const { a } = obj;`) is
  NOT removed (the pass only handles bare `BindingIdentifier` declarators). Pinned
  by `remove_unused::tests::conservative_keeps_recursive_function` /
  `conservative_keeps_unused_destructuring_declarator`. Class removal +
  static-field/static-block/superclass side-effect guards ARE implemented and
  cargo-tested.
- [x] **Readability cleanup ✓ — `cleanup-residue.rs`** (the re-scoped CFG/dataflow
  work). Straight-line literal propagation + zero-read dead-def removal of
  compiler-generated residue (`span.start==0` marker). sroa-tuple → `return 5`;
  user code untouched; 4/4 whole-program green. Original notes kept below for
  the deferred generalizations:
- [x] **CFG/dataflow trio — DONE (full branch-aware framework, not just the
  straight-line case).** The original re-scope shipped straight-line readability
  cleanup via `cleanup_residue.rs`; the full per-node CFG + dataflow tier is now
  ported and wired into the fixpoint (`passes/mod.rs:129-133`). Purpose is still to
  clean up the residue *our own* passes create (sroa expands arrays into
  `v_0`/`v_1` scalars + reassignments; BLOCK-mode inline adds temps), keeping the
  **intermediate TS output clean and readable**. Gate = **semantic equivalence +
  clean output**, not byte-parity with Babel.
  - [x] `flow-sensitive-inline-variables` → `passes/flow_inline.rs` (reaching-defs)
  - [x] `live-variables-analysis` → `analysis/live_vars.rs`
  - [x] `dead-assignments-elimination` → `passes/dead_assignments.rs`
  - [x] supporting infra (in the `analysis/` module): `control-flow-graph` →
    `analysis/cfg.rs`, `data-flow-analysis` → `analysis/data_flow.rs`,
    `local-variable-table` → `analysis/local_var_table.rs`;
    `must-be-reaching-variable-def` + `maybe-reaching-variable-use` →
    `analysis/reaching.rs`.
  - **Decision (kept): compilecat's own per-node CFG, NOT `oxc_cfg`** (basic-block,
    impedance mismatch; parity needs the exact GEN/KILL/JOIN). CFG nodes are keyed
    by `Address`/`NodeId`, never `Span` (generated nodes share `SPAN(0,0)`). See WORKLOG.
  - Flipped the last whole-program red (`sroa-tuple`) green.
- [~] **Cross-file / PerFile mode ✓** — `cross_file.rs` + `compileFileCross` +
  `src/native-plugin.ts` (transform-hook, resolve+read donors, `addWatchFile`).
  Cross-module `@inline` inlining works end-to-end (real rollup build).
  **Module-scope decl hoisting ✓ (copy-then-clean):** donor consts/helper
  fns/classes the body needs are copied into the consumer (transitively) and the
  cleanup pipeline folds literal consts / drops dead copies. Shared-mutable
  module state split across consumers is an accepted `@inline` limitation.
  **Imported-dep forwarding ✓:** a needed name bound by the donor's own `import`
  is forwarded into the consumer (one shared binding, bundler-deduped) — bare
  specifiers verbatim, relative ones rebased to the consumer's location
  (`rebase_specifier`; `Donor.path` threaded from the plugin's `resolved.id`).
  **Now also implemented (audit 2026-06-17 — the old "still deferred" list was
  stale):** default + namespace import forwarding ✓; re-exports (`export {x} from`,
  namespace re-export barrels) ✓; donor parse cache ✓; cross-module SROA (imported
  type shapes) ✓; **α-rename on a true name collision** between a copied donor dep
  and a consumer binding ✓ (2026-06-17 — this was a confirmed MISCOMPILE: a colliding
  donor dep was silently skipped, so the inlined body captured the consumer's
  binding — e.g. donor `const SCALE=2` + consumer `const SCALE=100` made `bump(10)`
  return 1001 instead of 21; fix α-renames the colliding dep on the *cloned*
  material — `cross_file.rs` `plan_renames`/`CfRename` — with a sound bail when the
  colliding name comes from a donor import; regression tests in `cross_file.rs`).
  Still deferred (both LOW priority — crashcat uses neither): cross-module **unroll**
  (const-bound resolution across modules); `export *` without an alias.
- [ ] **minimized-condition.ts** — `MinimizedCondition` shorter-form machinery;
  blocks the deferred if→ternary in minimize-conditions (see B).

---

## A′. Cheap high-value gaps (mis-prioritized under "CFG trio")

These block real exported/aggregate code and are small — surfaced by running the
`sroa-tuple` case instead of theorizing:

- [x] **Exported-decl annotation — sroa + unroll** (`util::expand_export_annotations`):
  `@sroa`/`@optimize`/`@unroll` now fire on exported fns. ✓
- [x] **Exported-decl annotation — inline-functions** ✓ (done): `@inline` on an
  exported donor works — `annotated_spans_with_exports` + discovery descends into
  `ExportNamedDeclaration`; the strip loop preserves exported donors. crashcat uses
  this (its constraint-part `export function`s are `@inline`).
- [x] **inline-variables multi-declarator** ✓ — inlines one declarator out of a
  `let a,b,c` group, drops the declaration only when empty. **Surfaced + fixed a
  real bug: span-based node identity COLLIDES on compiler-generated nodes (sroa
  scalars / `v_i` refs all carry `SPAN(0,0)`). Switched inline-variables to
  `node_id` keying (unique, set by semantic) — robust for all generated code.**
  sroa-tuple residue now correctly cascades to `let v_0=1; v_0=5; return v_0;`
  (evals to 5); the readability cleanup will finish it to `return 5`.

## B. Per-pass deferred sub-features

- [ ] **normalize** — the α-rename (`renameForFlatten`, `MakeDeclaredNamesUnique`).
  Scope-aware; the structural part is done. Needed by dead-code's block-flatten
  safety and the flatten/simplify path. **Confirmed conservative (cargo-pinned,
  SAFE):** does NOT hoist `for (var x in y)` → `var x; for (x in y)` (only plain
  `ForStatement` var-inits are hoisted; for-in/for-of left intact). Pinned by
  `normalize::tests::conservative_leaves_for_in_var_unhoisted`. Structural
  normalize is now cargo-tested (`normalize::tests`).
- [x] **fold — bigint + optional-chain ✓** (Phase C, cargo-tested `fold::tests`):
  BigInt `+ - *` + comparisons on literal operands (i128, overflow-bails;
  `/ % **` + bitwise still deferred); optional-chain folding (`null?.x`/`null?.()`
  → `undefined` via oxc `ChainExpression`, non-nullish base left intact).
  *object/array literal operands* remains deferred (OLD never folded these either
  — its own header lists them under "Not covered").
- [x] **fold — type-gated numeric-identity folds ✓** (`fold.rs`): `x+0`, `x*1`,
  `x-0`, `x/1` etc. collapse **only** when compilecat's type inference proves the
  operand is a `number` (a `numeric` symbol set threaded into the fold), never on
  a possibly-string/bigint operand where the identity wouldn't hold. Cargo-tested.
- [ ] **strip-directives** — mixed-comment rewriting (`/* @inline foo */` →
  `/* foo */`); only marker-only comments are removed today (oxc spans are
  immutable, can't repoint at new text).
- [ ] **dead-code** — label folding (lives in `minimize-exit-points` in the port,
  not here); `tryOptimizeConditionalAfterAssign` (the `a=1; if(a)` const-prop folds
  — handled by flow-inline/cleanup, not dead-code); nested block-flatten
  (`tryMergeBlock`). **Confirmed conservative vs Babel (cargo-pinned, SAFE):** does
  NOT drop pure member-access expression statements (`a.b.c;`,
  `Number.POSITIVE_INFINITY;` — Babel's `assumeGettersArePure`) nor pure
  sequence-expression prefixes (`(1, 2, foo())` → `foo()`). Pinned by
  `dead_code::tests::conservative_keeps_*`. The implemented eliminations (literal
  if/while/do, ternary-literal, unreachable-after-return/throw, pure-stmt drop,
  empty-if/else) are cargo-tested in `dead_code::tests`.
- [x] **inline-functions — feature-complete** (verified 2026-06-17 by audit; the
  old "still deferred" list was STALE — all of it is implemented + cargo/behavioral
  tested): exported-`@inline` donor ✓; call-site `/* @inline */ foo()` ✓; `@flatten`
  host ✓; namespace `NS.fn()` ✓; nested (non-top-level) candidates ✓; BLOCK mode in
  void/statement/**expression/init/assign** positions ✓; BLOCK bodies with `return`
  (labeled-block + break) ✓; α-rename when an arg names a param ✓. The accurate
  description is the module doc-comment header. **Only remaining (cosmetic, deferred):**
  alias cleanup for `let out = v` prologues (a `cleanup-residue` broadening, not an
  inline gap).
- [x] ✅ **FIXED (task #29) — `@optimize` + BLOCK-inline in INIT position miscompile.**
  `/* @optimize */ function consumer(x,y){ const r = callee(x,y); return r; }` (callee
  BLOCK-inlined) used to compile to `{ let _compilecat_result_0; return _compilecat_result_0; }`
  — whole body deleted, returned `undefined`. Root cause was in **`flow_inline`**, not
  inline-functions: it applied two *chained, conflicting* edits in one analyze→apply
  pass — inlining `r` (`const r = _t; return r` → `return _t`, dropping `const r`) AND
  inlining `_t` (whose single use sat *inside* `const r = _t`, dropping `_t = …`). The
  second edit's substitution target was deleted by the first, but its def-drop still
  fired → undefined read. Fix: `flow_inline::analyze_fn` now **defers** any decision
  whose use-site is a descendant of another decision's dropped subtree
  (`is_descendant`/`drop_root`); the outer simplify fixpoint resolves the chain one
  link per iteration (OLD's iterate-to-fixpoint model). Regression:
  `behavioral.parity` → `optimize-block-inline-init-position`.
- [x] **unroll — const bounds + negative start + catch-shadow ✓** (Phase C,
  cargo-tested `unroll::tests`): resolves a bound/start/step that references a
  whole-program-unique `const NAME = <numeric literal>`; handles unary-negated
  literals (`-2`); `Subst` no longer substitutes the loop var inside a
  catch-clause that shadows it. Still deferred: multi-pass fixpoint beyond one
  bottom-up sweep.
- [x] **sroa — decls nested in inner blocks** (scope is the enclosing
  function/program): candidates collected recursively into loop/if/switch/try
  bodies, declarations rewritten in place. Matches Babel for array/tuple
  aggregates; object/typed aggregates in nested blocks are a NEW-only superset
  (Babel has no object SROA).
- [x] **sroa — multi-declarator + let-kind ✓** (Phase C, cargo-tested
  `sroa::tests`): each declarator in a `const a = […], b = […]` group is
  classified independently and a partially-scalarized statement splits in source
  order (kept declarators stay in their original kind, scalars become `let`);
  keyed by per-declarator arena `Address`. `let` aggregates scalarize (and a
  whole-binding reassignment correctly bails via escape analysis).
- [x] **inline-variables — alias inline (path 3) ✓** (Phase C, cargo-tested
  `inline_variables::tests`): a multi-use bare-identifier alias of a stable
  local/param (`const b = a; use(b); use(b)` → `use(a)`, drop `b`) now collapses,
  loop-safe. Four soundness guards (each a passing test): RHS must be a bare
  identifier (member inits like `body.linearVelocity` bail); aliased binding never
  reassigned; alias never reassigned; every use site must resolve the aliased name
  to the *same* SymbolId (intervening shadow → bail). Still deferred: inits
  referencing globals; destructuring / multi-declarator decls. *Single-use object
  literal inline* is an INTENTIONAL non-feature (competes with SROA) — see the
  "Intentional divergences" section.
- [x] **minimize-exit-points — implemented & cargo-tested** (`minimize_exit_points::tests`):
  redundant trailing `return`/`continue`/labeled-`break` drop, if-sibling-hoisting
  (`if(c){…return} A;B` → `if(c){…}else{A;B}`), the inliner labeled-break→if/else
  rewrite, and finalizer-skip. Still deferred: switch-case minimization;
  `do…while(false)` break.
- [x] **minimize-conditions — condition-substitution family ✓** (Phase C,
  cargo-tested `minimize_conditions::tests`): on top of the prior `!`-pushdown /
  `!!` cancel / boolean-ternary / HOOK-flip, now does `performConditionSubstitutions`
  in boolean context (`x?true:y→x||y`, `x?y:false→x&&y`), short-circuit constant
  folds (`x||true→true`, `x&&false→false`, `x||false→x`, `x&&true→x`; pure-LHS
  gated, impure → `(x,K)` comma), same-arm fold `c?a:a→a` (pure test + `ContentEq`),
  nested-`if`→`&&`, and `tryJoinForCondition` (`for{if(c)break;…}` → `for(;cond&&!c;)`).
  Intentionally NOT ported: if/else→ternary collapse (readability — see Intentional
  divergences). Still deferred: full `MinimizedCondition` shorter-form selection;
  `tryRemoveRepeatedStatements`.

---

## C. Cross-cutting

- [ ] **Diagnostics** — parser/`ParserReturn::errors` not surfaced; `transform`
  proceeds on a best-effort program (lib.rs TODO). Port the
  `Result<_, CompilerDiagnostic>` shape.
- [ ] **`@flatten` directive** end-to-end (depends on inline-functions call-site +
  flatten support above).
- [ ] **Source maps** — emitted (`map` JSON) but input-map chaining
  (`inputSourceMap`) from a prior tool isn't threaded.
