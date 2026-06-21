# Publishing compilecat (npm + napi platform packages)

The native (Rust/oxc) core ships as **prebuilt per-platform npm packages**, the
SOTA napi-rs pattern (rolldown, swc, oxc all do this). Consumers `npm i
compilecat` and npm pulls the one binary matching their machine — no Rust
toolchain, no build-on-install.

> **Prerequisite:** this requires publishing to **npm**. The platform binaries
> are resolved as `optionalDependencies` from the registry, which a `github:`
> install cannot do. Adopting this means crashcat (and any consumer) installs
> `compilecat` from npm, not github.

## Package topology

```
compilecat                      ← the only thing users install (the rollup plugin)
│  • dist/ (bundled plugin)
│  • dist/core/ (the napi loader: index.js + index.d.ts)   ← folded in, NOT a separate pkg
│  • optionalDependencies:
│       @compilecat/core-darwin-arm64
│       @compilecat/core-darwin-x64
│       @compilecat/core-linux-x64-gnu
│       @compilecat/core-linux-arm64-gnu
│       @compilecat/core-win32-x64-msvc
│
└── @compilecat/core-<triple>   ← one tiny pkg per platform, each = one .node + os/cpu/libc manifest
```

**Decision (option b):** there is **no `@compilecat/core` parent package.** The
napi loader is folded into `compilecat`; `@compilecat/core` is only a *naming
base* for the per-platform packages. "core" matches our own vocabulary for the
engine (`compiler.ts`: "the compilecat (oxc/Rust) core").

At runtime the loader probes the local dev `.node` first, then
`require('@compilecat/core-<triple>')` — so the same code path serves dev and
published installs.

## Targets (from `rust/crates/compilecat_napi` `napi.targets`)

| Triple                     | Package                          | Built on        |
|----------------------------|----------------------------------|-----------------|
| aarch64-apple-darwin       | `@compilecat/core-darwin-arm64`  | macos-latest    |
| x86_64-apple-darwin        | `@compilecat/core-darwin-x64`    | macos-latest    |
| x86_64-unknown-linux-gnu   | `@compilecat/core-linux-x64-gnu` | ubuntu-latest   |
| aarch64-unknown-linux-gnu  | `@compilecat/core-linux-arm64-gnu` | ubuntu (zig cross) |
| x86_64-pc-windows-msvc     | `@compilecat/core-win32-x64-msvc`| windows-latest  |

(Add `-linux-x64-musl` / `-linux-arm64-musl` later for Alpine; not needed for
crashcat's ubuntu CI.)

---

## One-time setup

### 1. npm org
Create the free **`@compilecat`** org on npm (public packages). Owns the
`@compilecat/core-*` namespace.

### 2. napi config — `rust/crates/compilecat_napi/package.json`
```jsonc
{
  "name": "compilecat-napi",
  "private": true,                       // build tool, never published directly
  "napi": {
    "binaryName": "compilecat",
    "packageName": "@compilecat/core",   // → platform pkgs @compilecat/core-<triple>
    "targets": [ /* the 5 triples above */ ]
  }
}
```
Then regenerate the per-platform manifests:
```bash
cd rust/crates/compilecat_napi && napi create-npm-dirs
# writes npm/<triple>/package.json (name @compilecat/core-<triple> + os/cpu/libc) — commit these
```
> Note: the currently-committed loader still references the old
> `compilecat-native-<triple>` names. After the `packageName` change, a fresh
> `napi build` regenerates `index.js` with `@compilecat/core-<triple>`.

### 3. Fold the loader into `compilecat`
- Build step (in `build:native` or a copy step): copy the generated
  `index.js` + `index.d.ts` → `dist/core/`.
- `src/compiler.ts`: `require('../rust/crates/compilecat_napi/index.js')` →
  `require('./core/index.js')` (resolved within `dist/` after bundling).
- `.gitignore`: add `dist/core/*.node` — the dev binary copied next to the
  loader must NOT be committed (committed `dist/` carries the loader only;
  binaries ship via the platform packages).

### 4. Root `package.json`
```jsonc
{
  "version": "0.1.0",                    // start real versioning
  "files": ["dist", "README.md", "LICENSE", "NOTICE"],   // dist now includes dist/core loader
  "optionalDependencies": {
    "@compilecat/core-darwin-arm64": "0.1.0",
    "@compilecat/core-darwin-x64": "0.1.0",
    "@compilecat/core-linux-x64-gnu": "0.1.0",
    "@compilecat/core-linux-arm64-gnu": "0.1.0",
    "@compilecat/core-win32-x64-msvc": "0.1.0"
  }
}
```
(`napi version` keeps these in lockstep with the root version on each release.)

---

## CI (`.github/workflows/`)

Scaffold from the napi-rs template (`napi new` emits a ready matrix), then trim
to our targets. Shape:

**build job — matrix over targets**
- `macos-latest`: `napi build --platform --release --target aarch64-apple-darwin` (and x64)
- `ubuntu-latest`: `--target x86_64-unknown-linux-gnu`; aarch64-gnu via zig (`--target ... --zig`)
- `windows-latest`: `--target x86_64-pc-windows-msvc`
- each uploads its `compilecat.<triple>.node` artifact

**publish job — needs: [build]**
```bash
napi artifacts          # drops each .node into npm/<triple>/
napi prepublish -t npm  # finalizes platform package manifests
# publish platform packages + the root compilecat package
npm publish --access public   # (loop over npm/* then the root)
```
Secret: `NPM_TOKEN` (automation token with publish rights on `@compilecat` + `compilecat`).

---

## Release runbook

```bash
# 1. bump + sync versions
npm version 0.1.1                 # root
napi version                      # syncs optionalDependencies to match
# 2. push a tag → CI builds all triples, publishes platform pkgs + root
git tag v0.1.1 && git push --tags
```

## Consumer (crashcat)

```diff
- "compilecat": "github:isaac-mason/compilecat",
+ "compilecat": "^0.1.0",
```
On install npm pulls `compilecat` + the single `@compilecat/core-<triple>`
matching the machine. crashcat's ubuntu CI gets `@compilecat/core-linux-x64-gnu`;
your mac gets `@compilecat/core-darwin-arm64`. No Rust, no committed binaries.

## Dev loop (unchanged)

```bash
pnpm build:native     # builds the local .node + loader; copied to dist/core/
pnpm test             # loader finds the local binary first; platform pkgs irrelevant locally
```

## Optional: wasm fallback

You already build `compilecat/wasm`. Publishing it as a final loader fallback
(napi can emit a wasm branch) covers any platform the matrix misses — exactly
what oxc/lightningcss do. Defer until needed.
