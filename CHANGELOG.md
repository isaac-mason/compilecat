# CHANGELOG

## v0.0.9

- feat: cross-package `.d.ts` type resolution
  — the type-shape oracle resolves imported type aliases from a package's declaration surface (package.json `exports` `"types"` condition -> `types`/`typings` -> sibling `.d.ts`) and follows the `.d.ts` re-export graph (bare `export * from`, named / `export type` re-exports; namespace `export * as ns` excluded). Type-directed passes (SROA, module-scratch localization) now fire on types imported from published packages that ship a `.js` + `.d.ts` split (e.g. `mathcat`'s `Vec3`/`Quat`), not only local/relative imports
- feat: removed the `MAX_DONORS` donor cap — donor gathering is bounded by the finite reachable graph (`seen` dedup + `inScope`), like a bundler, instead of a silent per-consumer count. Cross-module optimization no longer quietly degrades past a magic number of imports
- fix: `resolve_type_alias_shape` memoises `(donor, name)` — a densely cross-re-exporting `.d.ts` graph no longer re-expands exponentially (previously a multi-minute hang); `exports` wildcard subpaths resolve longest-match-wins; `watchChange` invalidates the package-entry caches on a dependency's `package.json` edit

## v0.0.1 - v0.0.8

- early releases, see commit history, CHANGELOG.md is maintained for following releases
