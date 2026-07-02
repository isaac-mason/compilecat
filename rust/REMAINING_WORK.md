# compilecat native port — remaining work (authoritative plan)

> Supersedes the byte-parity framing in `CUTOVER_PLAN.md` / `DEFERRED.md`. Start
> here. Written 2026-06-18 after the acceptance bar was corrected.

---

## 0. Acceptance bar (READ FIRST — this is the whole point)

The goal is **NOT** byte-for-byte equivalence with the Babel pipeline. It is:

1. **Correctness** — absolute, non-negotiable. Output must compute identical results.
2. **Clean, readable output that preserves the original's intent & structure** —
   *except* for the applied perf enhancements. Named constants stay named.
   No noise (dead loops, redundant blocks). Authored structure survives.
3. **Performance** — the applied optimizations are real wins.

**Design reference = Google Closure Compiler source**, now on disk at
`/Users/isaacmason/Development/crashcat/llm/closure-compiler/src/com/google/javascript/jscomp/`
(+ `test/.../*Test.java` for exact behavior). Use it to learn how an optimization
*should* work. The Babel port (`~/Development/compilecat/src/compiler/*.ts`, which
cites `jscomp/X.java`) is a secondary reference, NOT the spec.

**Implication:** some earlier "divergences" are non-issues (native output equally
readable/correct → ignore). Others I had wrongly *ratified* as "native does more"
are actually **quality regressions to FIX** (const-propagation destroys named-const
intent; over-unrolling emits dead loops). See P0.

---

## 1. References (paths)

- **Closure source (DESIGN SPEC):** `crashcat/llm/closure-compiler/src/com/google/javascript/jscomp/`
  — key files: `Normalize.java`, `Denormalize.java`, `PeepholeRemoveDeadCode.java`,
  `PeepholeMinimizeConditions.java`, `MinimizedCondition.java`, `MinimizeExitPoints.java`,
  `InlineVariables.java`, `FlowSensitiveInlineVariables.java`, `PeepholeFoldConstants.java`,
  `NodeUtil.java`. Tests in the sibling `test/` tree show exact expected behavior.
- **Babel port (secondary):** `compilecat/src/compiler/*.ts`.
- **Analyses:** `compilecat/llm/function-inlining-analysis.md`, `compilecat/llm/scalar-replacement-plan.md`.
- **Native code under work:** `compilecat/rust/crates/compilecat_core/src/passes/` (+ `analysis/`).
- **Pipeline order:** `compilecat/rust/crates/compilecat_core/src/passes/mod.rs` (`run_all_gated`).

---

## 2. Working discipline (we got burned ignoring this)

- **Correctness gate (must ALWAYS stay green):** `compilecat/tst/parity/threejs.parity.ts`
  (behavioral: runs optimized three.js math, asserts identical results) + the
  cargo suite. This is the real-world fuzz that catches miscompiles the crashcat
  sweep misses. It caught 3 unsound transform attempts this session.
- **Divergence finder (NOT a byte-gate):** `compilecat/tst/parity/crashcat-sweep.parity.ts`
  → `_sweep-report.md`. For each divergence triage by pillar: correctness bug →
  fix; native *less readable* than Babel → fix; native equal-or-cleaner → ignore.
- **ALWAYS `pnpm build:native` before trusting any JS parity test.** A stale
  `.node` masked a regression twice this session. Rebuild, then test.
- **On any behavioral (three.js) break: BISECT.** Find the exact miscompiling
  function, read its before/after, understand the unsound precondition — THEN fix.
  Blind retries cost 3 reverts (De Morgan, member-access ×2, consecutive-if-merge ×2).
- **Commit the uncommitted WIP first.** ~15 rust files are modified vs HEAD
  (`aa6d063`); commit before large changes so reverts are clean. (Do NOT
  `git checkout` individual files in a dirty tree — it reverts to old HEAD.)

---

## 3. Current state (confirm on fresh start)

Run: `cd compilecat && pnpm build:native && pnpm vitest run --config vitest.parity.config.ts`
Expect **187/187 parity (incl. three.js behavioral)** and `cargo test -p compilecat_core` **~364 green**.

**Landed & verified this session:**
- D3: α-rename / `MakeDeclaredNamesUnique` + `tryMergeBlock` (in `block_flatten.rs`).
- E2 De Morgan: faithful `MinimizedCondition` cost-model port (`minimized_condition.rs`),
  applied at all condition slots. −23 structural, three.js green.
- 2 miscompile fixes (+ regression tests): destructuring alias-inline (`inline_variables.rs`),
  task-#29 block-inline-in-init `undefined` (`flow_inline.rs` chained-decision deferral).
- Additive `block_flatten` after unroll (`mod.rs`).

---

## 4. Work items — prioritized

### P0 — Readability defects (the core of the bar)

**R1 — Eliminate ALL unnecessary `{ }` blocks. [TOP PRIORITY]**
- Gap: native emits bare `{ }` blocks (block-inline scaffolding, per-iteration unroll
  blocks, nested bare blocks). Unnecessary blocks are a serious readability defect.
- Closure design: **Normalize adds** structure for safe optimization; **`Denormalize.java`
  removes** it for clean output. `PeepholeRemoveDeadCode.java` also folds empty/bare
  blocks (`tryFoldBlock`/block merging). Native has `block_flatten.rs` (tryMergeBlock)
  but it doesn't catch everything (runs pre-unroll + one additive post; not in the fixpoint).
- Approach: audit every bare-block source against a forced-`@optimize` sweep; make a
  denormalize-style bare-block lift run to fixpoint over the whole tree (mirror
  `Denormalize` + `PeepholeRemoveDeadCode` block handling). A "bare block" = a
  `BlockStatement` that is an element of a statement list and declares no
  block-scoped bindings that would collide (α-rename already guarantees uniqueness).
- Verify: zero bare-block divergences in the sweep; three.js green; eyeball `dist`.

**R2 — Loop unroller: make our own strong decision (it's OURS, no Closure analogue).**
- Gap: native unrolls inner loops with dynamic bounds → emits dead `for (j = 0; j < 0; j++)`;
  unrolls large static counts (128) → bloat. Both are noise.
- Decision (design it, document it in `unroll.rs`): `@unroll` only unrolls when
  (a) bound/start/step are static-resolvable, (b) trip count ≤ a budget, (c)
  trip-count × body-size ≤ a budget. Otherwise leave the loop intact. And DCE any
  dead-loop residue (`for(;false;)` / `j<0`) — see `PeepholeRemoveDeadCode.java`.
- Files: `unroll.rs` (bail conditions), `dead_code.rs` (dead-loop removal).
- Verify: no dead/degenerate loops in output; no oversized expansion; three.js green.

**R3 — Preserve named module constants (stop value-propagation).**
- Gap: native emits `4294967295` for `EMPTY_SUB_SHAPE_ID`, `32` for `MAX_SUB_SHAPE_ID_BITS`
  — destroys authored intent. (The exported `const` decl is kept, but uses are folded.)
- Approach: find the offending pass (likely `fold.rs` const-propagation, or
  `inline_variables.rs` path-2 multi-use-literal applied to module-scope consts).
  Restrict value-propagation to anonymous/compiler-generated temps — never named
  module-level / exported consts. Closure's `InlineVariables.java` does not inline
  named consts wholesale; mirror its constraints.
- Verify: named consts survive in output; sweep const divergences drop.

**R4 — Un-hide R2/R3 in the sweep harness.**
- `crashcat-sweep.parity.ts` currently normalizes const-propagation
  (`collectConstLiterals`) — that HIDES R3. Remove that normalization so const-prop
  shows as a gap. KEEP the cosmetic-name normalizations (result-temp `_RES`,
  inline-label `_LBL`, rename-suffix) — those are genuinely equal-readability.

### P1 — Correctness on the real target

**V1 — crashcat green on native build.** Link local compilecat into crashcat
(`crashcat/package.json` installs it from github; need an fs link or local build+install),
build via `crashcat/rolldown.config.mjs` (uses `compilecatNative`), run `pnpm test`
+ `pnpm test-tree-shaking`.
**V2 — behavioral + perf/size vs Babel build.** Build crashcat twice (native vs
`crashcat/rolldown.compilecat-test.mjs` Babel); run physics/determinism; compare
results + `dist` size.

### P2 — Infrastructure / cutover mechanics

**I1 — C1 diagnostics.** Surface `ParserReturn::errors` as a typed `CompilerDiagnostic`
through `lib.rs` (`transform`, see the `lib.rs:47` TODO) → napi/wasm → native plugin,
so malformed input fails loudly instead of silently. Confirm the error shape with the user.
**I2 — C2 source maps.** Thread `inputSourceMap` through the core codegen; fix
`crashcat/rolldown.config.mjs`'s `stripDebug` plugin (returns `map: null`, breaking
the chain).
**I3 — B4 retire Babel.** After V1/V2: drop crashcat's Babel-pipeline reliance; keep
Babel adapters as the differential oracle (recommended) or remove.

### P3 — Optional optimization completeness (ONLY if it makes output cleaner or
faster, and NEVER at correctness risk — bisect any three.js break before retry)

- **O1 — dead-code folds + `MinimizeExitPoints` completeness** (else-after-exit form,
  switch/labeled). Ref `PeepholeRemoveDeadCode.java`, `MinimizeExitPoints.java`.
  Note: native's exit-point canonical form differs from Babel's; pick the *readable*
  one (Closure's) and make passes consistent (avoid the sibling-hoist↔else-removal
  oscillation found this session).
- **O2 — consecutive-if-merge** (`if(c1)return X; if(c2)return X` → `if(c1||c2)return X`).
  Ref `PeepholeMinimizeConditions.java` `tryReplaceIfBlock`. Reverted twice (broke
  three.js behavioral even with an exact `areNodesEqual` port → the unsoundness is in
  the transform preconditions, NOT equality). **MUST bisect the three.js failure first.**
- **O3 — member-access inline** (`let t = obj.prop; …t…` → inline). Entangled with
  SROA pass-ordering (2 reverts: broke SROA parity + ↑divergence). Needs replicating
  Closure's `FlowSensitiveInlineVariables` ↔ inlining/SROA order. LOW (perf nicety;
  JIT handles temps). Ref `FlowSensitiveInlineVariables.java`, `InlineVariables.java`.
- **O4 — cross-module `@unroll`, `export *` without alias.** Capability gaps crashcat
  doesn't currently exercise. LOW.

---

## 5. Landmines / lessons (don't repeat)

- **Stale `.node`** masked regressions twice → always rebuild before JS parity tests.
- **Rushing transforms ships miscompiles** — 3 reverts this session; each broke three.js
  behavioral. The faithful `MinimizedCondition` port (E2) is the template: port the
  exact Closure algorithm, verify against the oracle. Approximations fail.
- **`DEFERRED.md` was wrong** (claimed task-#29 fixed when no guard existed) — trust
  source + the oracle, not the tracker.
- **oxc `content_eq` ≠ Closure `areNodesEqual`** — for any equality-gated transform,
  port `NodeUtil`'s comparison conservatively (whitelist).

---

## 6. Suggested sequence for the fresh session

1. Confirm green (§3). Commit the WIP.
2. **R4** (un-hide gaps in sweep) — instant, makes R2/R3 visible.
3. **R1 (blocks)** — top priority; study `Denormalize.java` + `PeepholeRemoveDeadCode.java`,
   make block-lift comprehensive + in-fixpoint.
4. **R2 (unroller)** — design bail conditions + dead-loop DCE.
5. **R3 (named consts)** — restrict const-propagation.
6. **V1/V2** — verify crashcat on native (the real correctness proof).
7. **I1/I2** (diagnostics, sourcemaps), then **I3** (retire Babel).
8. P3 only as cleanliness/perf demands, each oracle-verified, bisect-on-break.
