![cover](./cover.png)

[![Version](https://img.shields.io/npm/v/compilecat?style=for-the-badge)](https://www.npmjs.com/package/compilecat)
![GitHub Workflow Status (with event)](https://img.shields.io/github/actions/workflow/status/isaac-mason/compilecat/build-and-deploy.yml?style=for-the-badge)
[![Downloads](https://img.shields.io/npm/dt/compilecat.svg?style=for-the-badge)](https://www.npmjs.com/package/compilecat)

```bash
npm install compilecat
```

Ships a prebuilt native (napi) binary per platform plus a wasm fallback. No build step or toolchain needed.

# compilecat

> ⚠️ This is highly experimental! It's not clear yet if this tool is even a good idea! Browse to your heart's content but expect no stability right now.

A JavaScript/TypeScript compiler plugin for hot-path optimizations, driven by opt-in annotations. It does function inlining, scalar-replacement of aggregates (SROA), loop unrolling, and a Closure-style simplify tier (constant folding, purity-driven pure-call elimination, dead-store removal).

Built on a Rust/oxc core. Ships as a rollup-family `transform` plugin that optimizes each source file *before* bundling while keeping TypeScript. It is **cross-module aware**: when a file imports an `@inline` donor, the plugin resolves and reads the donor module, inlines across the module boundary, and drops the now-unused import. `addWatchFile` is wired in, so editing a donor re-transforms every consumer that inlined it.

## Usage

```js
// rollup.config.js
import compilecat from 'compilecat/rollup';

export default {
    plugins: [compilecat({ include: [/\/src\//] })],
};
```

`include` scopes which module ids compilecat transforms and reads as donors (picomatch globs and/or RegExps). It's required, so `node_modules` is never trawled unless a package is listed explicitly. Swap the subpath for other rollup-family bundlers: `compilecat/vite`, `compilecat/rolldown`. A browser/edge wasm backend is available at `compilecat/wasm`.

## Directives

All optimizations are opt-in via `/* @* */` block comments.

### `@inline`: inline at the call site

On a function declaration, every call within the chunk is replaced with the function body. In bundle mode the chunk is the whole tree-shaken program, so callers from other source files reach the annotated function naturally, with no cross-file resolver involved.

```ts
/* @inline */
function add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
    out[0] = a[0] + b[0];
    out[1] = a[1] + b[1];
    out[2] = a[2] + b[2];
    return out;
}

function step(result: Vec3, v1: Vec3, v2: Vec3) {
    add(result, v1, v2);
}
```

```ts
function step(result: Vec3, v1: Vec3, v2: Vec3) {
    result[0] = v1[0] + v2[0];
    result[1] = v1[1] + v2[1];
    result[2] = v1[2] + v2[2];
}
```

On a call site, inlines just that call. Useful for forcing a specific call:

```ts
import { vec3 } from 'mathcat';

function step(out: Vec3, v: Vec3) {
    /* @inline */ vec3.normalize(out, v);
}
```

Library code from `node_modules` is eligible for inlining whenever it ends up in the chunk and carries (or is targeted by) a directive. The resolver isn't doing anything special for libraries because bundling already pulled the body in.

### `@flatten`: inline every call inside this function

A caller-side bulk directive. Every resolvable call inside the annotated function's body is treated as if its call site had `/* @inline */`.

```ts
/* @flatten */
function step(out: Vec3, v: Vec3) {
    vec3.normalize(out, v);
    vec3.scale(out, out, 2);
}
```

### `@sroa`: break an array-literal local into scalars

Scalar Replacement of Aggregates. Converts `const v = [a, b, c]` plus constant-index accesses (`v[0]`, `v[1]`, ...) into scalar locals. Useful for tuple-shaped data (vec3, quat, mat4) in hot loops.

```ts
function step(dt: number) {
    const v: Vec3 = /* @sroa */ [0, 0, 0];
    v[0] = 1 * dt;
    v[1] = 2 * dt;
    v[2] = 3 * dt;
    use(v[0], v[1], v[2]);
}
```

```ts
function step(dt: number) {
    let v_0 = 1 * dt;
    let v_1 = 2 * dt;
    let v_2 = 3 * dt;
    use(v_0, v_1, v_2);
}
```

Escape analysis bails silently if the array leaks, whether by being passed to a function, spread, indexed non-constantly, aliased, or accessed via `.length`.

Can also be placed on an enclosing function to opt in every qualifying declaration inside it.

SROA also scalarizes **object/record locals** (`const v = { x, y, z }` with static `.x`/`.y`/`.z` accesses) and **typed-tuple locals** (`const v: Vec3 = mk()`), and performs **module-scratch localization**. A module-level scratch buffer reused as per-call temporary storage (the crashcat/mathcat house style `const _scratch = /*@__PURE__*/ [0, 0, 0]`, written and read inside one `@optimize` function) is proven safe (single-owner, killed-on-entry, non-re-entrant via a CFG must-reaching-definitions analysis) and scalarized into per-call locals, with the module const deleted. This borrows LLVM GlobalOpt's global-localization idea, fused into SROA so the buffer is never materialized as a per-call allocation.

### `@unroll`: unroll a loop with a static trip count

```ts
/* @unroll */
for (let i = 0; i < 3; i++) {
    process(i);
}
```

```ts
process(0);
process(1);
process(2);
```

Supports `for (let i = <lit>; i <(=) <lit>; i(++|+= <lit>)) { ... }` and `for (const x of <array literal>) { ... }`. Warns and leaves the loop untouched if the trip count isn't static or the body has loop-crossing `break`/`continue`/`return`.

### `@optimize`

Applies `@flatten`, `@sroa`, and `@unroll`. Does not apply `@inline`.

```ts
/* @optimize */
function step(out: Vec3, v: Vec3, dt: number) {
    const scaled: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) scaled[i] = v[i] * dt;
    vec3.add(out, out, scaled);
}
```

### `@pure`: assert a function is side-effect-free

compilecat runs a Closure-style purity analysis (a port of `PureFunctionIdentifier`) that proves most immutable-math helpers pure on its own. A call to a proven-pure function can be dropped when its result is unused, reordered, or de-duplicated, and it's emitted with a `/*@__PURE__*/` marker for the downstream bundler. `@pure` is a developer-assertion *override* for cases the analysis can't see through (e.g. a helper that bottoms out in an unresolved external call you know is pure):

```ts
/* @pure */
function lerp(a: number, b: number, t: number): number {
    return externalMathHelper(a, b, t);
}
```

Use it sparingly. Asserting purity on a function that actually has side effects will let those effects be optimized away.

## Pipeline

Each chunk that contains a compilecat directive runs through:

```
parse
  → normalize               (MakeDeclaredNamesUnique)
  → stamp-pure-calls        (purity analysis marks side-effect-free calls; emits /*@__PURE__*/)
  → inline-functions        (DIRECT + BLOCK inlining, FunctionArgumentInjector)
  → block-flatten           (lift the scaffolding blocks inlining emits)
  → loop-unroller
  → scalar-replace-aggregates  (incl. module-scratch localization — see below)
  → block-flatten           (lift the per-iteration blocks the unroller emits)
  → simplify (per-function fixpoint, ×8):
      peephole-fold-constants
      minimize-exit-points
      peephole-minimize-conditions
      inline-variables
      cleanup-residue
      peephole-remove-dead-code
      block-flatten          (lift bare blocks exposed during simplification)
      flow-sensitive-inline-variables   (CFG-based)
      dead-assignments-elimination      (CFG-based)
  → remove-unused-code      (drop bindings/imports left unused after inlining)
  → strip-directives        (remove the authored /* @* */ markers)
  → regenerate
```

Everything is gated: only constructs carrying a directive (and their subtrees), plus the directive-free consumers an `@inline` was inlined into, are ever rewritten. The rest of the file is left byte-identical.

Some of the optimization passes (Rust, under `rust/crates/compilecat_core/src/passes/`) are functional ports of corresponding `jscomp/*.java` files from Google Closure Compiler. Others, notably `@unroll` and `@sroa`, diverge. See [`NOTICE`](./NOTICE).

## Plugin options

The same options apply to every adapter (`compilecat/rollup`, `compilecat/vite`, `compilecat/rolldown`):

```ts
compilecat({
    include: string | RegExp | (string | RegExp)[],   // REQUIRED. picomatch
                                                       //  globs and/or RegExps
    exclude?: string | RegExp | (string | RegExp)[],  // additional skips
    sourcemap?: boolean,  // emit source maps. default true
    debug?: boolean,      // per-build timing + counter breakdown. default false
})
```

`include` is required and has no implicit default. It bounds both the files that get transformed *and* the donor modules that may be read and inlined, so `node_modules` is never trawled unless a package is listed explicitly (e.g. `['**/src/**', '**/node_modules/mathcat/**']`). It is plumbed through Rollup 4's hook-filter API, so under rolldown the scope test runs in Rust and out-of-scope files never enter the JS plugin handler at all. An in-scope file that calls an in-scope `@inline` function is always processed, even when it carries no directive of its own.

```ts
// e.g. only transform engine code; everything else (app code,
// node_modules, etc.) is invisible to compilecat.
compilecat({
    include: ['src/engine/**'],
})
```

## Acknowledgements

Heavily inspired by [unplugin-inline-functions](https://github.com/krispya/unplugin-inline-functions).

## Attribution

Some of the optimization passes under `rust/crates/compilecat_core/src/passes/`
are ports of corresponding files from the [Google Closure Compiler](https://github.com/google/closure-compiler),
licensed under the Apache License, Version 2.0. See [`NOTICE`](./NOTICE) for
required attribution. Compilecat itself is MIT-licensed (see [`LICENSE`](./LICENSE)).
