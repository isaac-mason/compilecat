// Authored `@*` directive vocabulary, ported from src/plugin/analyses/directives.ts.
// Standalone — no cross-tree imports. Same regex shapes so behavior matches.

export type DirectiveKind = 'inline' | 'flatten' | 'sroa' | 'unroll' | 'optimize';

export const DIRECTIVE_PATTERNS: Record<DirectiveKind, RegExp> = {
    inline: /@inline\b/,
    flatten: /@flatten\b/,
    sroa: /@sroa\b/,
    unroll: /@unroll\b/,
    optimize: /@optimize\b/,
};

export const OPTIMIZE_DIRECTIVES: readonly DirectiveKind[] = ['flatten', 'sroa', 'unroll'];

export const ANY_DIRECTIVE_IN_SOURCE = /@(?:inline|flatten|sroa|unroll|optimize)\b/;

export function commentIsInlineDirective(value: string): boolean {
    return (
        DIRECTIVE_PATTERNS.inline.test(value) ||
        DIRECTIVE_PATTERNS.flatten.test(value) ||
        DIRECTIVE_PATTERNS.optimize.test(value)
    );
}

export function commentIsFlattenDirective(value: string): boolean {
    return DIRECTIVE_PATTERNS.flatten.test(value) || DIRECTIVE_PATTERNS.optimize.test(value);
}
