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

Built with Babel, packaged with [unplugin](https://unplugin.unjs.io/) to work with rollup, vite, webpack, esbuild, and rolldown.

## Usage

```js
// rollup.config.js
import compilecat from 'compilecat/rollup';

export default {
    plugins: [compilecat()],
};
```

Swap the subpath for other bundlers: `compilecat/vite`, `compilecat/webpack`, `compilecat/esbuild`, `compilecat/rolldown`.

## Directives

All optimizations are opt-in via `/* @* */` block comments.

### `@inline` — inline at the call site

On a function declaration, every call within the file (and cross-file, for callers that import it) is replaced with the function body:

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

On a call site, inlines just that call — useful when the callee is in a library you don't control:

```ts
import { vec3 } from 'mathcat';

function step(out: Vec3, v: Vec3) {
    /* @inline */ vec3.normalize(out, v);
}
```

Library (`node_modules`) inlining happens only at explicitly annotated call sites — compilecat never eagerly scans `node_modules`.

### `@inline-body` — inline every call inside this function

A caller-side bulk directive. Every resolvable call inside the annotated function's body is treated as if its call site had `/* @inline */`.

```ts
/* @inline-body */
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

Applies `@inline-body` + `@sroa` + `@unroll`. Intentionally does **not** apply `@inline`.

```ts
/* @optimize */
function step(out: Vec3, v: Vec3, dt: number) {
    const scaled: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) scaled[i] = v[i] * dt;
    vec3.add(out, out, scaled);
}
```

## Pipeline

Each matched file runs through:

```
parse → inline → simplify (constfold + copyprop + dce) → unroll → sroa → simplify → regenerate
```

The simplifier is a fixpoint and runs twice — once after inlining, once after unroll + SROA — to clean up the constants and scalars each pass exposes.

## Plugin options

```ts
compilecat({
    debug?: boolean,          // log each transformed file. default false
    crossFile?: boolean,      // resolve @inline across relative imports. default true
    libraryInline?: boolean,  // permit callsite-annotated inlines from node_modules. default true
    fileReader?: FileReader,  // override cross-file reader (default: node:fs)
})
```

## Programmatic API

```ts
import { transform, createFileCache } from 'compilecat';

const fileCache = createFileCache();

const { code, map } = transform(source, absolutePath, {
    sourceMaps: true,
    fileCache,
    allowLibraryInline: true,
});
```

## Acknowledgements

Heavily inspired by [unplugin-inline-functions](https://github.com/krispya/unplugin-inline-functions).
