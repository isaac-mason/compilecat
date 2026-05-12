![cover](./cover.png)

[![Version](https://img.shields.io/npm/v/compilecat?style=for-the-badge)](https://www.npmjs.com/package/compilecat)
![GitHub Workflow Status (with event)](https://img.shields.io/github/actions/workflow/status/isaac-mason/compilecat/build-and-deploy.yml?style=for-the-badge)
[![Downloads](https://img.shields.io/npm/dt/compilecat.svg?style=for-the-badge)](https://www.npmjs.com/package/compilecat)

```bash
> npm install github:isaac-mason/compilecat
# (npm coming soon!)
```

# compilecat

> ⚠️ This is highly experimental! It's not clear yet if this tool is even a good idea! Browse to your heart's content but expect no stability right now.

A JavaScript/TypeScript compiler plugin for hot-path optimizations — function inlining, scalar-replacement of aggregates (SROA), and loop unrolling — driven by opt-in annotations.

Built with Babel. Ships as a rollup-family plugin that runs in **bundle mode** via `renderChunk` — after the bundler has tree-shaken and concatenated modules, compilecat sees the chunk as a single program, so every `@inline` target is directly in scope without any cross-file resolver.

## Usage

```js
// rollup.config.js
import compilecat from 'compilecat/rollup';

export default {
    plugins: [compilecat()],
};
```

Swap the subpath for other rollup-family bundlers: `compilecat/vite`, `compilecat/rolldown`. Currently other bundlers are not supported.

## Directives

All optimizations are opt-in via `/* @* */` block comments.

### `@inline` — inline at the call site

On a function declaration, every call within the chunk is replaced with the function body. In bundle mode the chunk is the whole tree-shaken program, so callers from other source files reach the annotated function naturally — no cross-file resolver involved.

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

On a call site, inlines just that call — useful for one-off forcing of a particular call:

```ts
import { vec3 } from 'mathcat';

function step(out: Vec3, v: Vec3) {
    /* @inline */ vec3.normalize(out, v);
}
```

Library code from `node_modules` is eligible for inlining whenever it ends up in the chunk and carries (or is targeted by) a directive — the resolver isn't doing anything special for libraries because bundling already pulled the body in.

### `@flatten` — inline every call inside this function

A caller-side bulk directive. Every resolvable call inside the annotated function's body is treated as if its call site had `/* @inline */`.

```ts
/* @flatten */
function step(out: Vec3, v: Vec3) {
    vec3.normalize(out, v);
    vec3.scale(out, out, 2);
}
```

### `@sroa` — break an array-literal local into scalars

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

Escape analysis bails silently if the array leaks — passed to a function, spread, non-constant indexing, aliased, or accessed via `.length`.

Can also be placed on an enclosing function to opt in every qualifying declaration inside it.

### `@unroll` — unroll a loop with a static trip count

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

Applies `@flatten` + `@sroa` + `@unroll`. Intentionally does **not** apply `@inline`.

```ts
/* @optimize */
function step(out: Vec3, v: Vec3, dt: number) {
    const scaled: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) scaled[i] = v[i] * dt;
    vec3.add(out, out, scaled);
}
```

## Pipeline

Each chunk that contains a compilecat directive runs through:

```
parse
  → strip-typescript        (drop TS-only syntax so downstream passes see plain JS)
  → inline-functions        (DIRECT + BLOCK inlining, FunctionArgumentInjector)
  → loop-unroller
  → inline-variables (pre)  (collapse alias temps so SROA sees direct `name[i]` uses)
  → scalar-replace-aggregates
  → normalize               (MakeDeclaredNamesUnique — flips `isASTNormalized`)
  → simplify (per-function fixpoint):
      peephole-fold-constants
      minimize-exit-points
      peephole-minimize-conditions
      peephole-remove-dead-code
      flow-sensitive-inline-variables
      dead-assignments-elimination
  → inline-variables (post)
  → remove-unused-code
  → regenerate
```

Optimization passes under `src/compiler/` are functional ports of the
corresponding `jscomp/*.java` files from Google Closure Compiler. See
[`NOTICE`](./NOTICE).

## Plugin options

```ts
compilecat({
    debug?: boolean,          // log each transformed chunk. default false
})
```

## Acknowledgements

Heavily inspired by [unplugin-inline-functions](https://github.com/krispya/unplugin-inline-functions).

## Attribution

The optimization passes under `src/compiler/` are ports of corresponding files
from the [Google Closure Compiler](https://github.com/google/closure-compiler),
licensed under the Apache License, Version 2.0. See [`NOTICE`](./NOTICE) for
required attribution. Compilecat itself is MIT-licensed (see [`LICENSE`](./LICENSE)).
