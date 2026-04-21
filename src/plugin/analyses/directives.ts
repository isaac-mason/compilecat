/**
 * Single source of truth for plugin-alt's `@cc-*` annotation vocabulary.
 *
 * Every zone name, its canonical regex, and the `@cc-optimize` umbrella
 * membership live here. Other modules (zones.ts, discover.ts, the inline /
 * sroa / unroll transforms, the unplugin skip-gate) import from this file
 * so adding or renaming a directive is a one-line change.
 */

export type DirectiveKind = 'inline' | 'inline-body' | 'sroa' | 'unroll' | 'optimize';

/**
 * Authored-form patterns. The `inline` regex excludes the `-body` suffix so
 * `@cc-inline-body` doesn't also register as `@cc-inline`.
 */
export const DIRECTIVE_PATTERNS: Record<DirectiveKind, RegExp> = {
    inline: /@cc-inline(?!-body)\b/,
    'inline-body': /@cc-inline-body\b/,
    sroa: /@cc-sroa\b/,
    unroll: /@cc-unroll\b/,
    optimize: /@cc-optimize\b/,
};

/**
 * Zones implied by `@cc-optimize`. Deliberately narrow: decl-visibility
 * (`@cc-inline`) is a separate axis from body-level aggressiveness — you
 * might want a function heavily optimized without wanting V8 to inline it
 * at every callsite.
 */
export const OPTIMIZE_DIRECTIVES: readonly DirectiveKind[] = ['inline-body', 'sroa', 'unroll'];

/**
 * True iff `value` (the text inside a `/* ... *​/` block comment) matches
 * the inline-specific directives — `@cc-inline` or `@cc-inline-body`. Used
 * by the post-inline sweep to strip consumed inline markers without touching
 * `@cc-sroa`, `@cc-unroll`, or `@cc-optimize`, which later passes still need
 * to read.
 *
 * Matches directives authored in the source, not the `@inlined` breadcrumb
 * plugin-alt writes back into the output.
 */
export function commentIsInlineDirective(value: string): boolean {
    return DIRECTIVE_PATTERNS.inline.test(value) || DIRECTIVE_PATTERNS['inline-body'].test(value);
}

/**
 * Fast pre-check for whole-file skip: does the source contain any `@cc-*`
 * marker at all? Cheaper than parsing the file just to learn there's nothing
 * to do. Deliberately doesn't enumerate the known directive names — a typo'd
 * `@cc-foo` still passes the gate, then the parser finds no match and is a
 * harmless no-op. Saves us updating this regex when we add a directive.
 */
export const ANY_DIRECTIVE_IN_SOURCE = /@cc-/;
