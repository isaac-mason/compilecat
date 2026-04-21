/**
 * Single source of truth for compilecat's `@*` annotation vocabulary.
 *
 * Every zone name, its canonical regex, and the `@optimize` umbrella
 * membership live here. Other modules (zones.ts, discover.ts, the inline /
 * sroa / unroll transforms, the unplugin skip-gate) import from this file
 * so adding or renaming a directive is a one-line change.
 */

export type DirectiveKind = 'inline' | 'inline-body' | 'sroa' | 'unroll' | 'optimize';

/**
 * Authored-form patterns. The `inline` regex excludes the `-body` suffix so
 * `@inline-body` doesn't also register as `@inline`. `\b` at the tail stops
 * `@inline` from matching the `@inlined` breadcrumb compilecat writes back
 * into the output.
 */
export const DIRECTIVE_PATTERNS: Record<DirectiveKind, RegExp> = {
    inline: /@inline(?!-body)\b/,
    'inline-body': /@inline-body\b/,
    sroa: /@sroa\b/,
    unroll: /@unroll\b/,
    optimize: /@optimize\b/,
};

/**
 * Zones implied by `@optimize`. Deliberately narrow: decl-visibility
 * (`@inline`) is a separate axis from body-level aggressiveness — you
 * might want a function heavily optimized without wanting V8 to inline it
 * at every callsite.
 */
export const OPTIMIZE_DIRECTIVES: readonly DirectiveKind[] = ['inline-body', 'sroa', 'unroll'];

/**
 * True iff `value` (the text inside a `/* ... *​/` block comment) matches
 * the inline-specific directives — `@inline` or `@inline-body`. Used
 * by the post-inline sweep to strip consumed inline markers without touching
 * `@sroa`, `@unroll`, or `@optimize`, which later passes still need to read.
 *
 * Matches directives authored in the source, not the `@inlined` breadcrumb
 * compilecat writes back into the output.
 */
export function commentIsInlineDirective(value: string): boolean {
    return DIRECTIVE_PATTERNS.inline.test(value) || DIRECTIVE_PATTERNS['inline-body'].test(value);
}

/**
 * Fast pre-check for whole-file skip: does the source contain any of our
 * directive markers? Cheaper than parsing the file just to learn there's
 * nothing to do. Enumerates the known directive names — a typo'd `@inlien`
 * won't pass the gate, which is the usual tradeoff: fewer false positives
 * (so fewer wasted parses) at the cost of needing to update this regex when
 * we add a directive.
 */
export const ANY_DIRECTIVE_IN_SOURCE = /@(?:inline(?:-body)?|sroa|unroll|optimize)\b/;
