// Authored `@*` directive vocabulary, ported from src/plugin/analyses/directives.ts.
// Standalone — no cross-tree imports. Same regex shapes so behavior matches.

import * as t from '@babel/types';

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
        DIRECTIVE_PATTERNS.inline.test(value) || DIRECTIVE_PATTERNS.flatten.test(value) || DIRECTIVE_PATTERNS.optimize.test(value)
    );
}

export function commentIsFlattenDirective(value: string): boolean {
    return DIRECTIVE_PATTERNS.flatten.test(value) || DIRECTIVE_PATTERNS.optimize.test(value);
}

export function commentIsSroaDirective(value: string): boolean {
    return DIRECTIVE_PATTERNS.sroa.test(value) || DIRECTIVE_PATTERNS.optimize.test(value);
}

export function isExportWrapper(n: t.Node | null): boolean {
    return n !== null && (t.isExportNamedDeclaration(n) || t.isExportDefaultDeclaration(n));
}

// Babel attaches JSDoc preceding `export function` / `export default function`
// (and `export const foo = ...`) to the export wrapper, not the inner
// declaration. `hasLeadingDirective` checks the node's own leadingComments and
// falls back to the wrapping parent's, so authored `@inline`/`@optimize`/etc.
// on the export node still counts.
export function hasLeadingDirective(n: t.Node, parent: t.Node | null, pred: (commentValue: string) => boolean): boolean {
    if (matchLeadingComment(n, pred)) return true;
    if (isExportWrapper(parent) && matchLeadingComment(parent as t.Node, pred)) return true;
    return false;
}

function matchLeadingComment(n: t.Node, pred: (value: string) => boolean): boolean {
    const cs = (n.leadingComments ?? []) as t.Comment[];
    for (const c of cs) {
        if (pred(c.value)) return true;
    }
    return false;
}
