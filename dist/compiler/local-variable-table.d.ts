import * as t from '@babel/types';
export type LocalVariableTable = {
    /** Insertion-ordered map: name → index in the BitSet lattice. */
    readonly indexByName: Map<string, number>;
    /** Names whose values can be observed after the function returns
     *  (closure capture, `arguments` aliasing). Treated as live-out. */
    readonly escaped: Set<string>;
    /** Total count — convenience. */
    readonly size: number;
};
export declare function buildLocalVariableTable(fn: t.Function): LocalVariableTable;
