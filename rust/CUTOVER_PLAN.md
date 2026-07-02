# Cutover Plan — Babel-parity, then retire the Babel pipeline

**Goal:** the native (Rust/oxc) compilecat reaches **full parity with the Babel
pipeline**, becomes the sole optimization path for crashcat (and compilecat
generally), and the Babel pipeline is retired.

**Acceptance criterion: PARITY.** If the Babel pipeline performs a transform, the
port performs it too. "crashcat doesn't use it" is **not** a reason to defer —
crashcat's current corpus is a coverage accident, not the spec. The only
permitted divergences are the explicitly-ratified ones in WS-F (each with a
principled reason, e.g. soundness), and even those are subject to your override.

**Status as of 2026-06-18:** the port is already crashcat's default build and
passes its own test suites, but it is **not yet at parity** — several Babel
transforms are unported (WS-D/WS-E). This doc is the authoritative checklist;
`DEFERRED.md` is stale and is itself the first thing to fix (WS-A).

---

## 0. Current reality

Verified 2026-06-18 by source audit + running both test suites:

- **crashcat already runs the native port in its main build** (`rolldown.config.mjs`
  → `compilecatNative`, per-file `transform`, cross-module, sourcemaps on, scoped
  to `src/` + `node_modules/mathcat`). Babel survives only in `rolldown.compilecat-test.mjs`.
- **Rust core:** 359 unit + 3 gating + 7 pipeline tests green.
- **JS parity suite:** 186/186 green — incl. `threejs.parity` real-world
  correctness and the `sroa-tuple` whole-program case `DEFERRED.md` calls "last red".
- `analysis/` infra + `flow_inline.rs`, `dead_assignments.rs`, `normalize.rs`,
  `block_flatten.rs` exist and are wired into `run_all` (`passes/mod.rs:62-122`).

Green test suites prove parity *on the corpus tested*. They do **not** prove
parity — the differential harness (WS-B0) is what does, and it currently has known
holes (the unported transforms below).

---

## 1. Definition of done (the cutover gate)

All must hold:

1. **Differential harness shows zero unexplained divergence.** Port output ≡ Babel
   output across the full corpus (compiler's own cases + crashcat + three.js +
   property/fuzz inputs), modulo the ratified WS-F divergences. *This is the real
   parity proof; everything else is a means to it.* (WS-B0)
2. **Every unported Babel transform is ported.** WS-D (capability gaps) and WS-E
   (optimization-completeness gaps) fully landed, each with cargo + differential
   tests. No item is "optional."
3. **Tracker is truthful** — `DEFERRED.md` matches source; every item disposed. (WS-A)
4. **crashcat green on the native build** — `pnpm test` + `test-tree-shaking`. (WS-B1)
5. **No behavioral regression vs Babel** on crashcat physics/determinism. (WS-B2)
6. **No perf/size regression** — step benchmarks + bundle size within tolerance. (WS-B3)
7. **Fails loud** — parser/compile errors surface as diagnostics. (WS-C1)
8. **Source maps trustworthy** end-to-end. (WS-C2)
9. **WS-F divergences ratified** by you (keep-as-divergence vs flip-to-parity). (WS-F)
10. **Babel path retired** — crashcat no longer depends on it; Babel adapters
    kept (if at all) only as the differential oracle. (WS-B4)

---

## 2. Workstreams

### WS-A — Truth-up the tracker (do first; ~half a day)

`DEFERRED.md` is misleading enough to be a liability. Reconcile against the audit.

- **A1. Close 3 done-but-unchecked items** (verify cited tests, mark `[x]`):
  - **CFG/dataflow trio** — DONE, wired `mod.rs:97-104` (`analysis/{cfg,data_flow,live_vars,reaching,local_var_table}.rs` + `flow_inline.rs` + `dead_assignments.rs`).
  - **`@flatten` end-to-end** — DONE (`inline_functions.rs:94-117`, `directives.rs`, `cross_file.rs:154`; 3 tests). Resolve the B-vs-C contradiction.
  - **strip-directives mixed-comment** — DONE (`strip_directives.rs:72-102`; test `strip_removes_directive_token_from_mixed_comment`).
- **A2. Rewrite `DEFERRED.md`** to mirror this plan's disposition table (§4) so it
  can't silently drift. Keep the "Intentional divergences" section but re-label it
  "Pending ratification" pending WS-F.

### WS-B — Parity proof + integration + cutover

- **B0. Build the differential parity harness as the spine.** The parity bar is
  "no unexplained divergence over a broad corpus," not a checklist. Stand up a
  harness that runs **port vs Babel** over: the compiler's own case corpus,
  **all of crashcat src**, three.js (already partially done), and a
  property/fuzz generator. Any divergence that isn't a ratified WS-F item is a P0
  bug. This harness *defines* done for items 1-2 and *finds* gaps the stale doc
  misses. *Acceptance:* harness runs in CI; divergence count = ratified-only.
- **B1. crashcat green on native build.** `pnpm test` + `test-tree-shaking` against
  native-built `dist/`.
- **B2. Differential behavioral check on crashcat.** Build native vs Babel, run
  crashcat physics/determinism scenarios against both, assert identical.
- **B3. Perf + size.** Step benchmarks + `dist/index.js` size, native vs Babel.
- **B4. Retire the Babel path.** After all gates: drop crashcat's Babel reliance;
  keep Babel adapters only as the B0/B2 oracle (recommended) or delete. Clean up
  `_crashcat_*.orig`, `rolldown.compilecat-test.mjs`.

### WS-C — Robustness gates

- **C1. Diagnostics — NOT STARTED.** `lib.rs:47-80` proceeds on oxc's best-effort
  `Program` and never surfaces `ParserReturn::errors`. Wire into a typed
  `Result<_, CompilerDiagnostic>` through napi/wasm + the plugin so bad input fails
  the build. *Acceptance:* malformed input → build error with file+span; pinned test.
- **C2. Source-map input chaining — NOT STARTED.** `lib.rs:71-79` emits a map but
  doesn't thread `inputSourceMap`. Also crashcat's `stripDebug` plugin runs before
  compilecat and returns `map: null` — fix both ends. *Acceptance:* a breakpoint in
  shipped `dist/index.js` resolves to the correct crashcat `.ts` line.

### WS-D — Capability parity (REQUIRED — Babel can, port can't)

These are inputs Babel optimizes that the port currently can't handle at all.

- **D1. Cross-module `@unroll`.** Resolve a loop bound/start/step that references a
  `const` defined in *another* module (the cross-file resolver already follows the
  edges for `@inline`/SROA; extend const-bound resolution across it). Babel does
  this; the port only does same-module unroll. *Acceptance:* differential test with
  a donor-module `const COUNT = N` driving an `@unroll` loop in a consumer.
- **D2. `export *` without an alias.** The cross-file resolver handles
  `export { x } from` and namespace re-export barrels but not bare `export *`.
  Port it. *Acceptance:* differential test inlining through an `export *` barrel.
- **D3. normalize α-rename (`renameForFlatten` / `MakeDeclaredNamesUnique`).**
  `normalize.rs` is structural-only. Port the scope-aware uniquify. Required for
  parity directly, and it **unblocks D6's `tryMergeBlock`**. *Acceptance:* a
  constructed flatten/inline name-collision produces correctly-renamed output
  matching Babel.

### WS-E — Optimization-completeness parity (REQUIRED — port output differs from Babel)

Port is correct here but produces different/larger output than Babel. Parity = match.

- **E1. dead-code: `tryOptimizeConditionalAfterAssign`** (`a=1; if(a)…` const-prop
  fold) and **nested block-flatten `tryMergeBlock`** (depends on D3).
- **E2. minimize-conditions: full `MinimizedCondition` shorter-form selection +
  `tryRemoveRepeatedStatements`.** The substitution family is already done.
- **E3. minimize-exit-points: switch-case minimization, `do…while(false)` break,
  try/labeled recursion.** *First reconcile* the doc-vs-audit conflict on whether
  if-sibling-hoisting is actually implemented (`DEFERRED.md:238` claims yes; audit
  read no) — check `minimize_exit_points.rs` before scoping.

*(WS-D and WS-E are gates, not polish. Sequence them by what the B0 harness flags
as live divergences — but all must land for done.)*

### WS-F — Intentional divergences: RATIFY or override (your call)

These are the ONLY permitted non-parity. Each is a deliberate, cargo-pinned choice
where matching Babel would *regress* something. Under a strict byte-parity reading
they'd flip to in-scope — that's your decision, item by item:

- **Bare member-access kept** (`a.b.c;` not dropped). Babel's `assumeGettersArePure`
  is **unsound** (getters can have side effects). Matching Babel here = a
  correctness regression. **Strong recommend: keep the divergence.**
- **Single-use object literal not inlined.** Competes with SROA (a port *superset*
  Babel lacks); inlining it would disable the higher-value scalarization.
  **Recommend: keep** (matching Babel loses a better optimization).
- **if/else not collapsed to ternary.** Behaviorally identical; readability choice;
  the downstream minifier does size collapse anyway. **Recommend: keep**, but this
  is the most defensible one to flip if you want byte-parity. (Needs
  `minimized-condition.ts` shorter-form machinery if flipped.)
- **TS preserved / opt-in gating / object-SROA superset** — these are the port's
  *design*, not Babel gaps (the port does more, or by-construction differently).
  Not parity items. Listed only for completeness.

**Decision needed from you:** ratify keep-as-is on the first three, or mark any to
flip to parity. Nothing else in this plan is optional.

---

## 3. Sequencing

```
M1  WS-A (truth-up)  →  WS-B0 (differential harness = the parity gate)
M2  WS-D (capability) ║ WS-E (opt-completeness) ║ WS-C (robustness)   [parallel,
        prioritized by what B0 flags as live divergences]
M3  WS-B1 → WS-B2 → WS-B3   (crashcat green, differential behavioral, perf/size)
M4  WS-F ratification  →  WS-B4 (retire Babel)  →  Done
```

Critical path: **A → B0 → {D,E,C to zero divergence} → B2/B3 → F → B4.**
Nothing is off the critical path; nothing is optional.

---

## 4. Per-item disposition (every DEFERRED.md unchecked item)

| DEFERRED.md item | Audited status | Disposition | WS |
|---|---|---|---|
| CFG/dataflow trio | **DONE**, wired | Verify + close | A1 |
| `@flatten` end-to-end | **DONE**, tested | Verify + close | A1 |
| strip-directives mixed-comment | **DONE** | Verify + close | A1 |
| Diagnostics (parser errors) | NOT-STARTED | **Required (gate)** | C1 |
| Source-map input chaining | NOT-STARTED | **Required (gate)** | C2 |
| Cross-module `@unroll` | NOT-STARTED | **Required (parity)** | D1 |
| `export *` without alias | NOT-STARTED | **Required (parity)** | D2 |
| normalize α-rename / MakeDeclaredNamesUnique | **DONE** (`block_flatten.rs`, lazy/on-collision) | Verify + close | D3 |
| dead-code: tryMergeBlock | **DONE** (`block_flatten.rs`; ordering fixed 06-18) | Verify + close | E1 |
| dead-code: tryOptimizeConditionalAfterAssign | PARTIAL | **Required (parity)** | E1 |
| single-use member-access inline | NOT-STARTED (path-1 bails on property reads) | **Required (parity)** | new (E4) |
| unroll aggressiveness vs Babel | divergent (native unrolls more) | **Decision** (match or ratify) | new |
| minimize-conditions: MinimizedCondition + tryRemoveRepeatedStatements | PARTIAL | **Required (parity)** | E2 |
| minimize-exit-points: switch / do-while(false) / labeled | PARTIAL | **Required (parity)** | E3 |
| minimized-condition if→ternary | NOT-STARTED | **Ratify** (recommend keep) | F |
| bare member-access kept | DONE (divergence) | **Ratify** (keep — soundness) | F |
| single-use object literal not inlined | DONE (divergence) | **Ratify** (keep — SROA) | F |

---

## 6b. Refined category breakdown (deeper sampling, 104 structural)

After normalizing cosmetic generated-temp names in the harness (114→104), the real
structural divergences sort into two kinds: **"native does MORE"** (valid extra
optimization, ratify-or-match like unroll) and **"native does LESS/different"**
(must-fix to match Babel). Proposed dispositions for a single batch approval:

| Category | Example | native vs Babel | Disposition (proposed) |
|---|---|---|---|
| **const-value propagation** | `EMPTY_SUB_SHAPE_ID`→`4294967295` (sub-shape.ts ×7, +many) | native const-props module-const values (keeps the exported decl); Babel keeps named refs | native does MORE → **RATIFIED** ✓ (harness-normalized; consistent w/ unroll; bundler inlines anyway) |
| **unroll aggressiveness** | `for(j=0;j<0)` setMassProperties; 128-trip epa | native unrolls more | **RATIFIED** ✓ |
| **member-access inline** | `let t=obj.prop` (motion-properties) | native does LESS | user chose **match** (hard; SROA-entangled — §5d/AL-5) |
| **else-after-return** | `if(c){return}else{X}`→`…}X` | native keeps else (does less) | **FIX** → E3 (minimize-exit-points / dead_code) |
| **De Morgan / negation form** | `!(!a\|\|!b)` vs `a&&b` | different form | **DONE** ✓ — ported `MinimizedCondition` cost model (`minimized_condition.rs`), applied to all condition slots. −23 structural (68→45); three.js behavioral stays green (cost-gated, unlike the reverted naive De Morgan). |
| **consecutive-if merge** | two `if`s same body → `if(a\|\|b)` | native keeps both (does less) | **FIX** → E2 (`tryRemoveRepeatedStatements`) — this was the raySphere "AL-0", NOT a miscompile |
| **result-temp naming** | `_compilecat_result_N` vs `_callee__result_N` | cosmetic; counter can't byte-match | **RATIFY** (harness-normalized ✓) |

If you ratify the two "native does MORE" categories (const-inlining + unroll, +
cosmetic naming), the must-fix set collapses to **E2 (De Morgan + if-merge) + E3
(else-after-return) + the member-access pipeline work** — i.e. the discrete E2/E3
done-whens plus the one hard item. That's the real remaining scope.

## 6. Alignment backlog — the 114, categorized + ordered (2026-06-18)

Sweep samples reveal the 114 structural divergences are a handful of recurring
patterns, mostly discrete pass-alignments. Ordered by (correctness, then
leverage×low-risk). Each lists: divergence → responsible pass → approach.

- **AL-0 — raySphere fold check (FIRST; correctness).** `if (discriminant < 0 || a
  < 1e-10)` (Babel) → `if (discriminant < 0)` (native): native dropped a clause.
  Confirm whether `a < 1e-10` is provably false here (sound fold, then it's just
  aggressive) or a fold **miscompile**. Files: `sphere-triangle.ts` (raySphere,
  raySphereFromOrigin). Pass: `fold` / const-prop. Reproduce minimally first.

- **AL-1 — block-inline result-temp naming (high leverage, low risk).** Native
  `_compilecat_result_<bignum>` (e.g. `_12000006`, a span-derived counter) vs
  Babel `_<callee>__result_<n>` (callee name + small sequential counter). Align
  the temp name + counter. Pass: `block_mutate` / `inline_functions`. Hits most
  block-inlined fns (estimate-collision-response, angle/axis/dual constraint
  parts, …) — likely closes a large chunk at once.

- **AL-2 — else-after-return removal.** `if (c) { …return } else { X }` (native
  keeps `else`) → `if (c) { …return } X` (Babel hoists the sibling out). Pass:
  `minimize_exit_points` (sibling-hoist) / `dead_code` (unreachable-else). Maps to
  **E3**. Files: closest-points, many. Discrete.

- **AL-3 — negation form / De Morgan.** Native `if (!(!a || !b || c || d))` vs
  Babel `if (a && b && !c && !d)`. Native over-applies the `!`-pushdown; match
  Babel's `tryMinimizeNot` / condition-form choice (don't distribute `!` across a
  `||`-chain when Babel keeps the `&&` form). Pass: `minimize_conditions`. Maps to
  **E2**. Files: cone-constraint, constraint parts. Discrete.

- **AL-4 — const-value inlining.** `Math.min(x, DEFAULT_CONVEX_RADIUS)` (Babel
  keeps the name) vs `Math.min(x, 0.05)` (native inlines the literal). Align
  module-const handling with Babel. Pass: `inline_variables` / `fold`. Files:
  support.ts, etc. Verify which direction Babel wants, then match.

- **AL-5 — member-access inline (HARD; do last / scope separately).** `let t =
  obj.prop; …t…` (native) vs inlined (Babel). Entangled with SROA/copy-prop (two
  local attempts increased divergence + broke SROA parity — see §5d). Needs
  flow-inline↔SROA ordering fidelity, not a local toggle.

- **AL-6 — unroll aggressiveness — RATIFIED.** Native unrolls static loops Babel
  bails on (incl. 128-trip `epa init`). No code change; exclude from gate.

**Order:** AL-0 (correctness) → AL-1 (naming, broad) → AL-2 → AL-3 → AL-4 →
re-measure → AL-5 (if still material). Then the done-when items: D1 cross-module
`@unroll` / D2 `export *` (capability — not in the intra-file sweep; verify via a
cross-file corpus), C1 diagnostics, C2 source-map chaining, then WS-B1/B2/B3
(crashcat green on native + behavioral/perf parity) and B4 (retire Babel).

Most of AL-1..AL-4 are discrete pass tweaks with cargo + sweep verification each.

## 5d. Landed + current state (2026-06-18, end of session)

**Landed (verified: 362 cargo + 187 parity green):**
- Fixed destructuring alias-inline miscompile (`inline_variables.rs`) + 2 tests.
- Fixed task-#29 block-inline-in-init-position miscompile (`flow_inline.rs` chained-
  decision deferral) + test. (DEFERRED.md's "✅ FIXED" was false; no guard existed.)
- Unroll-block merge: additive second `block_flatten` after unroll/sroa (`mod.rs`).
  −16 structural divergences, no regression.
- B0 harness (trustworthy), WS-A tracker banner.

**Current structural-divergent count: 114.** Status of the two decisions:
- **Unroll aggressiveness** — RATIFIED (user, 2026-06-18): native unrolls outer
  static loops Babel leaves; output is correct, just more unrolled. Accepted as a
  beneficial superset divergence (added to WS-F). No code change. Those divergences
  (`decompose…`, `setMassProperties`) are now out of the parity gate.
- **Member-access inline** — user chose "match Babel exactly", but this is NOT
  achievable as a local flow_inline change. TWO attempts (precise model, then
  Babel's blunt `mayHaveSideEffects` model) both made it WORSE: structural count
  114→142 / 114→144 AND broke `optimization-parity > SROA parity` each time.
  **Root cause: member-read inlining competes with SROA for the same
  `const v = obj.member` patterns.** Inlining `v` removes the local SROA would
  scalarize → native scalarizes less → diverges from Babel (which scalarized) +
  fails "NEW scalarizes ≥ OLD". Babel's pipeline resolves this flow-inline↔SROA
  competition by ordering/interaction that a local flow_inline toggle doesn't
  replicate. **Needs pipeline-level work** (understand Babel's flow-inline/SROA
  ordering), or reconsider. Both attempts reverted; flow_inline back to baseline.

Decision-independent work left: C1 diagnostics, C2 source maps (both touch the
public API → confirm shape first).

## 5c. WS-B0 findings (2026-06-18, refined harness)

Harness now compares **per top-level function body** (ungated top-level ignored),
through one printer with `comments:false`, `extra` stripped (canonical numerics),
and rename suffixes removed (approx alpha-equivalence). This removed four
false-positive classes (TS-strip, opt-in gating, comments, rename aggressiveness).

**Trustworthy count: 114 structural-divergent fns / 40 naming-only / 12 skipped**
(crashcat, forced `@optimize`). Naming-only = native renames only on real collision
(intentionally cleaner than Babel's eager `__N`); not gaps.

**Fixed this session (2 issues):**
1. Destructuring alias-inline miscompile (see below).
2. **Block-flatten ordering** — `block_flatten` ran at `mod.rs:76`, *before* `unroll`
   (77) / `sroa` (78), so the per-iteration `{ }` blocks the unroller emits were
   never merged (Babel merges in its post-unroll fixpoint). Moved `block_flatten`
   to after unroll+sroa. 361 cargo + 188 parity green; 174→160→(then harness
   refinements) structural.

**Categorized remaining gaps (from samples):**
- **Single-use member-access inline** — Babel inlines `obj.prop & 7` (single use,
  no intervening write); native keeps a `let t = obj.prop` temp (`inline_variables`
  rejects every property-read init via `contains_property_read`). Recurs across
  many fns (`addLinearVelocityStep`, `subLinearVelocityStep`, `moveKinematic`).
  Real gap — needs the sound single-use + no-intervening-mutation analysis Babel
  uses. Likely a large fraction of the 114.
- **Unroll aggressiveness (NOT a miscompile — investigated & cleared).** The
  `for (let j = 0; j < 0; j++)` in `decomposePrincipalMomentsOfInertia` is the
  *correct* unrolling of `for (let j = 0; j < ip; j++)` at `ip=0` (empty either
  way). Native unrolls outer static-count loops that Babel leaves intact (Babel
  appears to bail when the loop body contains nested loops / exceeds a size
  budget). Behavior identical; output differs. **Parity decision needed:** match
  Babel's unroll bail conditions, OR ratify "native unrolls more" as a beneficial
  superset divergence (like WS-F). Lower priority — no correctness issue.

Instrument: `compilecat/tst/parity/crashcat-sweep.parity.ts` → `_sweep-report.md`
(samples diff rename-normalized bodies, so they point at the real gap).

## 5b. WS-B0 findings (2026-06-18, first run)

Harness landed: `compilecat/tst/parity/crashcat-sweep.parity.ts` (runs in the
parity suite; writes `tst/parity/_sweep-report.md`). It TS-strips both inputs and
optionally injects `/* @optimize */` on every function so the two ratified
divergences (TS-preservation, opt-in gating) don't masquerade as gaps.

First-run counts over crashcat's 99 src files (TS-stripped): gated 58 match / 41
divergent; forced-@optimize 25 match / 62 divergent / 12 skipped (forced size cap).

**Triaged categories (samples, not the raw count, are the truth):**
- **Confirmed miscompile — FIXED.** `const [rX,rY,rZ] = p` under `@optimize` had
  the alias-inline path substitute the whole array for each element
  (`rZ` → `p`), dropping the destructuring. Root cause: `inline_variables.rs`
  alias path never checked the binding was a plain identifier. Fixed + cargo
  regression tests (`guard_keeps_array_destructuring_alias`,
  `guard_keeps_object_destructuring_alias`). Native rebuilt; repro now matches Babel.
- **Real gap — nested block not flattened.** Native leaves `{ … }` Babel merges
  → `tryMergeBlock` (E1), gated on α-rename (D3). Confirmed in `mass-properties.ts`.
- **Real gap — temp/α-rename naming.** Babel `__1` / `__result_11`; native `$1` /
  different inline-temp scheme. Cosmetic but a divergence — align the suffix
  scheme as part of D3 / inline-functions temp naming. Confirmed in
  `motion-properties.ts`, `rigid-body.ts`.
- **Harness artifact (NOT a gap) — top-level const fold/inline.** Babel optimizes
  ungated top-level code (its old whole-program behavior); native gates (ratified
  opt-in divergence). `forceOptimize` only annotates *functions*, so top-level
  `const`s (`bitmask.ts`, `body-id.ts`) still differ. **Harness TODO:** neutralize
  by comparing only within optimized function bodies, or annotate top-level too —
  until then the counts OVERSTATE real gaps.

**Takeaway:** the only *correctness* issue found is fixed. Remaining real gaps map
to D3 + E1 (block-flatten + naming), consistent with the plan. The headline count
is inflated by the top-level-gating artifact; refine the harness before treating
the number as the gate.

## 5. Risks

- **Parity-by-checklist is a trap.** The stale doc *under-counts* gaps. WS-B0's
  broad differential + fuzz corpus is the only thing that finds the unknown ones;
  treat the table above as a floor, not the spec.
- **Silent miscompiles** are the tail risk. B0 + B2 (vs Babel on crashcat's own
  code) are the mitigations.
- **"Match Babel" can reduce soundness** (bare member-access) — WS-F exists so we
  don't blindly regress correctness in the name of parity.
- **Source-map chain has a pre-existing break** at `stripDebug` (`map: null`) — C2
  must fix the plugin, not just the core.
