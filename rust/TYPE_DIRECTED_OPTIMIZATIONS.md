# Type-directed optimizations — landscape & reference

Future/reference only — **not a commitment to build**. A map of where the type
oracle (the `@sroa` type-shape resolver, see ARCHITECTURE.md) could compound, and
which LLVM-grade ideas do / don't apply to a **TS→TS, emit-JS** optimizer.

## The framing that sorts everything

LLVM optimizes a **typed low-level IR** where "type" = machine representation
(`i32`, `ptr`, `struct`); its biggest wins are about lowering to efficient machine
code. We emit **JS** → rolldown → a JS engine. We **cannot touch machine
representation** — the engine's JIT owns it (and pays at runtime to rediscover
types we already know statically). So our type leverage has a different shape:

> **Feed the JIT a fast, stable shape, and statically remove work the engine
> can't.**

That split decides what's worth it.

## Maps to us — the real opportunity (high value)

- **Devirtualization / monomorphization of calls** — the big one. `shape.area()`
  where `shape: Circle` statically → call/inline `Circle.area` directly.
  Disproportionately valuable in JS: it keeps the engine's inline caches
  **monomorphic** (poly/megamorphic dispatch is a top JIT-deopt source). It's
  "inlining, but the type picks the target" — the natural next big pass after
  type-aware SROA, built on the same oracle + the inliner.
- **Object/aggregate scalar replacement** — ✅ **done** for both tuples (slices
  1–2) and records (slice 3): non-escaping `{x,y,z}` literals and typed
  `const v: Vec3 = mk()` (interface / object-type alias, local or imported) →
  named scalars, removing the allocation the GC would chase. Next here: interface
  `extends`, optional fields, object struct-of-arrays.
- **Struct-of-arrays / data-layout transforms** — type says `Particle[]` is
  `{x,y,z}[]` → rewrite to parallel `x[]`/`y[]`/`z[]` for cache locality in hot
  loops. The engine won't do this for you; genuine source-level win for math/sim.
- **Type-narrowed dead code & const folding** — discriminated-union switches that
  rule out tags; `if (typeof x==='string')` where `x: number` → dead branch.
- **`const enum` inlining** (`Color.Red` → literal) — ⏸ **deferred (low impact,
  2026-06-15).** Cheap and the cross-module angle is real (bundlers can't inline
  const enums across files under `isolatedModules`; we could, via the cache), but
  it's a niche win — const enums are uncommon and the payoff per use is small.
  Sound by a TS invariant (const enums are member-access-only → no escape analysis
  needed), so it's easy to pick up later if a real codebase needs it. The literal
  `ResolvedType` variants it would have introduced are the same ones type-narrowed
  DCE consumes, so that slice subsumes the groundwork.
- **Escape analysis** — already used for SROA; generalizes to allocation removal
  wherever the type bounds the shape. ✅ **Extended** to *module-scratch
  localization*: a module-level scratch buffer used as per-call storage in one
  `@optimize` function is localized-and-scalarized (LLVM GlobalOpt idea fused into
  SROA), proven safe by a CFG killed-on-entry must-reaching-defs analysis.

## Does NOT map — out of scope by construction (we emit JS)

The JS engine's JIT owns these; we can't express them in source:
- Register allocation, instruction selection, **unboxing / NaN-boxing**.
- **SIMD auto-vectorization** — no portable SIMD in JS source; would need a WASM
  target (a different product).
- **Bounds-check elimination** — JS source has no explicit checks; the JIT elides
  them. (Tuple SROA already removes indexing, which is the source-level slice.)

## Enablers, not direct wins for us

- **Generic monomorphization** — in Rust/C++ it removes boxing/dispatch; in JS
  generics are **erased** (zero runtime cost), so specializing `f<number>` only
  *enables* further numeric inlining/folding — lower priority than it looks.
- **Type-guided inlining cost models** — inline by type-derived size/shape; feeds
  the above.

## Through-line

The high-value subset is the **algorithmic, high-level** type-directed passes
(devirt/monomorphization, object-SROA, SoA, type-narrowed DCE), **not** the
machine-representation ones (regalloc, SIMD, unboxing) — the engine already does
those and we can't reach them. The **type-shape oracle built for SROA is the
substrate for all of them**; SROA was slice 1; **devirtualization is the next big
algorithmic one**. Machine-level wins would be a WASM-target conversation —
a different product entirely.
