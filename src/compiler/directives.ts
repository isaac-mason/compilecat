// Authored `@*` directive vocabulary, ported from src/plugin/analyses/directives.ts.
// Standalone — no cross-tree imports. Same regex shapes so behavior matches.

import * as t from '@babel/types';

import { traverse } from './babel-interop';

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
    return DIRECTIVE_PATTERNS.inline.test(value) || DIRECTIVE_PATTERNS.flatten.test(value);
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

// Matches any directive that opts a function in to per-function cleanup
// (simplifier / inline-variables / remove-unused-code gating). Notably
// excludes `@inline` — that marks *callees*, not the functions that should
// receive cleanup; their callers are added by the inliner instead.
export function commentIsAnyOptInDirective(value: string): boolean {
    return (
        DIRECTIVE_PATTERNS.optimize.test(value) ||
        DIRECTIVE_PATTERNS.flatten.test(value) ||
        DIRECTIVE_PATTERNS.sroa.test(value) ||
        DIRECTIVE_PATTERNS.unroll.test(value)
    );
}

function commentListHasOptIn(cs: readonly t.Comment[] | null | undefined): boolean {
    if (!cs) return false;
    for (const c of cs) {
        if (commentIsAnyOptInDirective(c.value)) return true;
    }
    return false;
}

// Walk every Function node in `ast` and add it to `touched` if the function
// itself (or any statement inside its body, excluding nested functions) carries
// an opt-in directive (`@optimize` / `@flatten` / `@sroa` / `@unroll`).
//
// The body-scan picks up block-level opt-in markers authored as
// `function foo() { /* @optimize */ { ... } }`. Nested functions are skipped
// by the inner walker because they get their own visitor call from
// `traverse`, which handles their own membership independently.
export function collectOptIns(ast: t.File, touched: WeakSet<t.Function>): void {
    traverse(ast, {
        Function(path) {
            const node = path.node;
            if (touched.has(node)) return;
            if (hasLeadingDirective(node, path.parent, commentIsAnyOptInDirective)) {
                touched.add(node);
                return;
            }
            if (functionBodyHasOptIn(node)) {
                touched.add(node);
            }
        },
    });
}

function functionBodyHasOptIn(fn: t.Function): boolean {
    let found = false;
    const visit = (n: t.Node): void => {
        if (found) return;
        // Don't descend into nested functions — they get their own visit.
        if (n !== fn && t.isFunction(n)) return;
        if (commentListHasOptIn(n.leadingComments) || commentListHasOptIn(n.innerComments)) {
            found = true;
            return;
        }
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = (n as unknown as Record<string, unknown>)[k];
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c && typeof c === 'object' && 'type' in c) visit(c as t.Node);
                    if (found) return;
                }
            } else if (child && typeof child === 'object' && 'type' in child) {
                visit(child as t.Node);
            }
        }
    };
    visit(fn);
    return found;
}
