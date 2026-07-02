# Purity analysis — Closure-aligned side-effect summary

Grounded in Closure's actual source (`llm/closure/.../PureFunctionIdentifier.java`,
`AstAnalyzer.java`, `NodeUtil.java`). This is a port of `PureFunctionIdentifier`
(the analysis) — the developer-assertion path (`@pure` / `/*@__PURE__*/`) is the
*override* on top, not the primary mechanism.

## Why (not a toy)
compilecat inlines aggressively, so most calls vanish before the drop/reorder
passes — but purity is foundational for what inlining *doesn't* reach:
- **call-CSE** (`dot(a,b)+dot(a,b)` → once) — only sound if `dot` is pure;
- **DCE / code motion** of un-inlined (recursive, deliberately-not-inlined) calls;
- **annotation-free inlining decisions** — a *proven-pure* fn is always safe to
  inline/reorder, so the compiler stops needing `@inline`/`@pure` on everything
  (the mathcat payoff).

## Closure's model (verbatim)
Per-function summary = 4 bit flags (`PureFunctionIdentifier`):
`THROWS`, `MUTATES_GLOBAL_STATE` (subsumes all), `MUTATES_THIS`, `MUTATES_ARGUMENTS`.

Per-function body scan tracks two per-scope sets: `skiplistedVars` (a local that
holds a possibly-escaping ref) and `taintedVars` (a local whose *property* was
mutated). `visitLhsNode`:
- `this.x = …` → `MUTATES_THIS`.
- `obj.x = …`, obj a NAME local-to-this-container-scope → `taintedVars += obj`
  (deferred); obj a free/outer var → `MUTATES_GLOBAL_STATE`; obj multi-level
  (`a.b.c = …`) → `MUTATES_GLOBAL_STATE` (conservative).
- `x = …`, x local: if RHS not `evaluatesToLocalValue` → `skiplistedVars += x`.
  x free/outer → `MUTATES_GLOBAL_STATE`.
- `const x = v`: if `!evaluatesToLocalValue(v)` → skiplist x.

`exitScope` finalizes: a PARAM that is tainted & not skiplisted → `MUTATES_ARGUMENTS`;
a LOCAL that is skiplisted (aliases external) & tainted → `MUTATES_GLOBAL_STATE`;
a **clean local, tainted → NO flag** (pure local mutation — the immutable-math case).

`evaluatesToLocalValue` (NodeUtil): fresh literals (`ARRAYLIT`/`OBJECTLIT`/`FUNCTION`/
`CLASS`/`REGEXP`/`TEMPLATELIT`), `new` (usually), immutable primitives & pure
operators → local; property reads (`o.x`,`o[k]`), general `CALL`, `this`/`super` →
NOT local.

Calls (`visitCall`): `functionCallHasSideEffects` short-circuit (builtins / annotations),
else connect callee→caller in the **reverse** call graph. Unknown callee →
`MUTATES_GLOBAL_STATE`. `throw` → THROWS unless inside try/catch (`catchDepth`).

Propagation: `FixedPointGraphTraversal` over the reverse graph (worklist, NOT SCC).
Recursion converges via bitmask union. Refinements: `new` gives an unescaped `this`
(constructor `MUTATES_THIS` doesn't propagate); `allArgsUnescapedLocal` — if all
args are fresh locals, a callee that only `MUTATES_ARGUMENTS` is pure at that site.

Call-site marking (`markPureFunctionCalls`): OR all callee flags → `SideEffectFlags`;
`Math.*`/RegExp/known-builtin special-cases clear them.

`AstAnalyzer.mayHaveSideEffects` = our `is_side_effect_free` (inverted). Notably
Closure's `assumeGettersArePure` flag **is** our getter assumption — so
`is_side_effect_free`-with-member-reads-pure is literally Closure's config, already
aligned. (`GETELEM` `o[k]` is assumed getter-free too; `in`/`instanceof` are
`isSimpleOperator` → **pure** in Closure — our HOLE-1 fix is *stricter*, a
divergence to reconcile.)

## compilecat port mapping
- **Function keying / call graph:** by name (top-level `function NAME` / `const NAME
  = fn|arrow`), reusing `gather_all_callables`' shape. Reverse edges callee→caller.
- **Local-var tracking:** `oxc_semantic` `SymbolId` is the slot (shadow-safe),
  same pattern as `analysis/local_var_table.rs` / `cleanup_residue.rs`. "same
  container scope" = symbol's scope is the function scope.
- **Flags:** start with the 4-flag set; the drop/reorder consumer (`is_side_effect_free`)
  treats a call as effect-free iff its callee summary has **no flags** (v1). (`new`
  is assumed impure unless builtin; `throw` policy: treat THROWS as impure for
  droppability — Closure preserves throwing calls; revisit vs our throw-imprecision.)
- **No type system:** getter-purity assumed (getters/setters/`in`/`instanceof`/Proxy
  effects assumed absent), matching `assumeGettersArePure=true`.
- **Builtins:** the `Math.*`/`Number.*`/`JSON.*` allowlist already in
  `util::is_pure_builtin_callee` seeds the pure set.
- **Member-call callees** (`ns.method()`): unresolved → conservatively impure (out
  of scope; mathcat is consumed as identifier calls per the tests).

## Staging (v1 → v2)
- **v1 (this work):** the analysis (flags + local/escaping + fixpoint) → a
  name→summary map → stamp `CallExpression.pure = true` on calls whose callee
  summary has no flags. `is_side_effect_free` already honors `c.pure`, so every
  drop/reorder/substitute site inherits it, and codegen emits `/*@__PURE__*/`
  (downstream propagation). `@pure`/`/*@__PURE__*/` remain overrides for the
  un-analyzable tail (imports, dynamic dispatch).
- **v2 (later):** `allArgsUnescapedLocal` refinement (out-param calls pure when
  args are fresh); call-CSE using the summary; purity-driven auto-inline.
