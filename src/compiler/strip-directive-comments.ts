// Strip authored `@inline`/`@flatten`/`@sroa`/`@unroll`/`@optimize` directives
// from comment text once all passes have consumed them. Run at the end of the
// pipeline so directives are still visible to producers (inliner, sroa, etc.).
//
// Policy: remove just the directive token. If the surrounding comment has
// unrelated text, the comment is kept with the marker removed. If the comment
// is *only* the marker (whitespace-only after strip), the comment node is
// removed entirely.

import traverse from '@babel/traverse';
import type * as t from '@babel/types';

const DIRECTIVE_RE = /@(?:inline|flatten|sroa|unroll|optimize)\b/g;

export function stripDirectiveComments(file: t.File): void {
    const toDelete = new WeakSet<t.Comment>();
    const seen = new WeakSet<t.Comment>();

    const clean = (c: t.Comment): void => {
        if (seen.has(c)) return;
        seen.add(c);
        if (!c.value.includes('@')) return;
        const cleaned = c.value.replace(DIRECTIVE_RE, '');
        if (cleaned === c.value) return;
        if (/^[\s*]*$/.test(cleaned)) {
            toDelete.add(c);
            return;
        }
        // Collapse runs of internal whitespace left by removal, keep edges
        // tidy. `/* @inline foo */` → `/* foo */`.
        c.value = cleaned.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
        if (c.type === 'CommentBlock') {
            c.value = c.value.replace(/^\s+|\s+$/g, ' ');
            if (!c.value.startsWith(' ')) c.value = ` ${c.value}`;
            if (!c.value.endsWith(' ')) c.value = `${c.value} `;
        }
    };

    const cleanList = (arr: readonly t.Comment[] | null | undefined): void => {
        if (!arr) return;
        for (const c of arr) clean(c);
    };

    traverse(file, {
        enter(p) {
            cleanList(p.node.leadingComments);
            cleanList(p.node.trailingComments);
            cleanList(p.node.innerComments);
        },
    });
    cleanList(file.comments as readonly t.Comment[] | null);

    const removeDeleted = (arr: t.Comment[] | null | undefined): t.Comment[] | null | undefined => {
        if (!arr) return arr;
        for (let i = arr.length - 1; i >= 0; i--) {
            if (toDelete.has(arr[i])) arr.splice(i, 1);
        }
        return arr;
    };

    traverse(file, {
        enter(p) {
            removeDeleted(p.node.leadingComments as t.Comment[] | null | undefined);
            removeDeleted(p.node.trailingComments as t.Comment[] | null | undefined);
            removeDeleted(p.node.innerComments as t.Comment[] | null | undefined);
        },
    });
    removeDeleted(file.comments as t.Comment[] | null | undefined);
}
