# Follow-ups: LLVM-aligned use-def SROA

## Status

- **DONE — inliner expression-inline** (`inline_functions.rs`): the DIRECT path
  binds complex args to **init-position** `const _inl_arg_N = arg;` instead of
  bailing to the BLOCK result-temp. Single-`return E` callees (add/sub/scale/…)
  now flatten to scalars via SROA's existing init-position collection →
  `integrateNode` is zero-alloc.
- **DONE — SROA `collapse_result_temps` pre-phase** (`sroa.rs`): collapses the
  inliner's **single-use** result temp `let _r; … _r = E; const x = _r;` →
  `const x = E;` (forward-substitute the one read, drop the let+assign), making it
  init-position so existing collection scalarizes it. This covers the BLOCK path's
  output for multi-*statement* callees (e.g. `normalize`, which has a `const l =…`
  before its `return`). It's a copy-prop enabler, deliberately scoped to the
  single-assignment/single-use shape the inliner actually emits (no CFG,
  read-rewriter untouched).
- **DONE — second DIRECT pass per host** (`inline_functions.rs`,
  `flatten_into_hosts`): a BLOCK inline can splice a single-return helper call
  (`normalize`'s body calls `len(a)`); the prior DIRECT-then-BLOCK ordering left
  it un-inlined, so an aggregate passed whole to it (`len(delta)`) escaped and
  stayed allocated. One extra DIRECT pass after BLOCK resolves the BLOCK→DIRECT
  nesting (bounded — can't expand recursion) → `solveLink`'s `delta` scalarizes,
  and the whole cloth is now zero-alloc.
- **DONE — Stage 1 deferred-init, via `merge_deferred_init`** (`sroa.rs`): the
  multi-field-read deferred aggregate (`let v; … v = {lit};` read field-wise,
  no single-use alias) that the collapse can't reach. Implemented as a SROA
  pre-phase that **canonicalizes the deferred store into init position** (drop the
  `let v;`, turn the single `v = {lit};` store into `let v = {lit};` in place) when
  there's exactly one store and no read of `v` before it (which makes relocating
  the declaration unobservable). The existing collection/escape/rewrite then
  scalarize the init-position aggregate — **identical output to the store-agnostic
  rewrite, reusing the tested machinery with no escape/collect/rewrite changes.**
  Covered by `deferred_aggregate_multi_field_read_scalarizes` + equivalence cases
  (merge + conditional-skip conservatism).

## Why the rest is still wanted

`collapse_result_temps` only fires when the deferred temp is read **exactly once**
(the inliner's alias). It does NOT help a deferred aggregate read **field-wise
multiple times** without an alias (`let v; v = {…}; … v.x … v.y …`), or one
assigned in **branches** (`if (c) v = {…} else v = {…}`). Those don't arise from
today's inliner, but a future inliner shape, hand-written code, or a different
producer could emit them. The robust, general fix is to make SROA itself
**use-def-driven** (store-position agnostic), the way LLVM's SROA works: scalarize
a local aggregate by analyzing its complete def/use set, not by pattern-matching
the declaration shape or relying on the copy-prop pre-phase.

## The LLVM model

LLVM's SROA operates on `alloca` slots and is agnostic to *how* a value entered
the slot: it walks every load/store, and if the access pattern is splittable
(field-wise only, no escaping pointer) it splits the aggregate into per-field
slots and rewrites all loads/stores. An init store, a deferred store, a store in a
branch — all identical: "a store to the slot." It also splits aggregate **copies**
(`memcpy`) field-wise, which is how it handles `const vel = _r` (a whole-object
copy) without bailing.

Our SROA is **shape-driven** instead: it only recognizes `const v = {literal}`
(init position). The work below moves it toward the use-def model.

## Current code (as of this writing)

`rust/crates/compilecat_core/src/passes/sroa.rs`:

- **Collect** — `collect_safe`→`collect_in` (~L409–480) walks statements; the only
  candidate source is `Statement::VariableDeclaration`→`candidate_of` (~L504–571),
  which reads only `d.init`. A `let v;` (no init) returns `None`. **Standalone
  `v = {…}` `ExpressionStatement`s are never inspected.**
- **Escape** — `escape_ok`→`EscapeChecker` (~L602–656): a valid `v.field`/`v[i]`
  read short-circuits as accounted-for; **any other bare `v` reference sets
  `bad = true`.** The LHS of `v = {…}` walks to an `IdentifierReference` → treated
  as a (escaping) read. Documented at the header (~L29–31): "reassigning the whole
  binding escapes."
- **Rewrite** — `process_scope` (~L142–163): phase 1 `AccessRewriter` rewrites
  `v.x` reads (`visit_expression`) and `v.x = …` field-write targets
  (`visit_simple_assignment_target`); phase 2 `rewrite_decls`/`split_decl`/
  `scalar_decl`/`reinit_from_live` split the *declaration*. **Nothing splits a
  whole `v = {a,b};` assignment statement.**
- **Keying** — `SafeCand { name, shape, decl_addr: Address, decl_span, init }`
  (~L109–135); `declarator_addr` keys the declarator by arena `Address` (NOT span —
  inline temps share `SPAN(0,0)`). `reinit_from_live` rebuilds scalars from the
  live (already access-rewritten) declarator — the single-source fix.

## The change (three touch-points)

### Stage 1 — DONE (via `merge_deferred_init`, not the store-agnostic rewrite)

The single-unconditional-store deferred aggregate is handled by canonicalizing it
to init position (see Status above), so the three touch-points below were **not
needed** for Stage 1 — the existing init-position collection does the work. The
store-agnostic rewrite they describe is only required for **Stage 3** (a `v`
stored in *multiple* places / branches, which can't be merged into one init).
Keep them as the Stage 3 design.

1. **Escape — add a store exemption.** In `EscapeChecker`, when `v` is the
   *assignment target* of `v = <object/array literal matching the candidate
   shape>`, count it as a **def, not an escape**. Reuse the existing field-read
   accept logic untouched. Update the header policy comment (~L29–31).
2. **Collect — admit the deferred var.** In `collect_in`/`candidate_of`, recognize
   a `let v;` whose single dominating assignment is a shape-consistent literal. The
   per-field initializer expressions come from the **assignment's RHS**, not the
   declarator — so give `SroaInit`/`reinit_from_live` a sibling path that rebuilds
   from the live assignment RHS (same single-source spirit as the existing fix).
   Key the assignment statement by candidate **name** (statement-level walk) since
   it has no pre-collected `Address` like the declarator does.
3. **Rewrite — split the assignment + the decl.** Alongside `rewrite_decls`, add
   statement-level machinery to turn `let v;` → `let v_x, v_y;` (uninitialized
   scalars) and `v = {a, b};` → `v_x = a; v_y = b;`. The `AccessRewriter` (reads +
   field-write targets) is **unchanged**.

### Stage 2 — aggregate copies (the alias)

`const vel = _r;` (whole-object copy) currently makes `_r` escape. LLVM splits it
into field copies. Implement: when `v` is read as a whole *only* as the RHS of
`const u = v;` (and `u` is itself a scalarizable aggregate of the same shape),
rewrite the copy to `u_x = v_x; u_y = v_y;` (field-wise) so neither escapes, then
let copy-propagation/inline-vars collapse `u_x ← v_x`. With Stage 1 + inliner
fix this is rarely hit, so it's lower priority.

### Stage 3 — conditional / multiple assignments (defer; needs care)

`if (c) v = {…}; else v = {…};` requires a "defined-before-read on every path"
guarantee → real dominance/CFG (the pass has `oxc_cfg` available via the
`flow_inline`/`dead_assignments` tier). There's also a semantic edge: reading an
*unassigned* aggregate field throws in the original (`undefined.x`) but yields
`undefined` after scalarization — fine for compiler-generated temps, unsound as a
general rule. Gate this behind dominance + restrict to compiler-generated
(`SPAN(0,0)`) temps, or skip it.

## Tests

- The single-read `normalize`/`solveLink` case is already covered by
  `collapse_result_temps` (see the green test
  `deferred_result_temp_from_multistatement_callee_scalarizes`).
- **Anchor for the remaining Stage 1 (write first, expect red) — a deferred temp
  read field-wise more than once, so the copy-prop pre-phase can't collapse it:**
  ```ts
  /* @optimize */ function f(c: boolean, p: { x: number; y: number }) {
    let v: { x: number; y: number };
    v = { x: p.x + 1, y: p.y + 1 };   // deferred whole-literal assignment
    return v.x * v.y;                 // two field reads, no single-use alias
  }
  ```
  `collapse_result_temps` skips this (two reads); use-def Stage 1 scalarizes it →
  zero surviving object literals. A multi-*return* callee
  (`if (c) return {x:a}; return {x:b};`) is the Stage 3 variant.
- **Must stay green:** `inline_generated_object_decls_scalarize_independently`
  (Address keying), `candidate_init_reading_another_candidates_field_stays_consistent`
  (`reinit_from_live`), `scalarizes_tuple_at_function_top_level` + the literal/typed
  cases. Grep for any test asserting `let v; v = […]` is *not* scalarized — it
  encodes the old "reassign escapes" policy and will flip; update it + the header.

## Suggested order

Stage 1 only is enough to make SROA independent of the inliner for the common
deferred-temp case, with no CFG and the read-rewriter untouched. Ship it as one
reviewable change behind the anchor test. Stages 2–3 are separate, opt-in
follow-ups.
