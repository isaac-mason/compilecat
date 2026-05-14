import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
export type LocalVariableTable = {
    /** Resolve an identifier-use site to its lattice slot. Returns undefined
     *  when the identifier refers to something that isn't a local of this
     *  function (outer-scope capture, global, free reference). */
    resolve: (id: t.Identifier) => number | undefined;
    /** Slots whose binding is observable after the function returns:
     *  - referenced from inside a nested function (closure capture)
     *  - any param when `arguments` is referenced in the function body */
    escaped: Set<number>;
    /** Number of allocated slots. */
    size: number;
    /** Debug helper — name of the binding behind a slot. */
    nameOfSlot: (slot: number) => string;
    /** Debug helper — every slot allocated for `name` (multiple if shadowed). */
    slotsByName: (name: string) => readonly number[];
    /** AST node that defines the binding's scope (BlockStatement, Function,
     *  ForStatement, etc.). Used by FlowSensitiveInlineVariables to check
     *  that a slot is in lexical scope at a candidate use site. */
    scopeNodeOfSlot: (slot: number) => t.Node | undefined;
};
export declare function buildLocalVariableTable(fnPath: NodePath<t.Function>): LocalVariableTable;
