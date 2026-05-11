import * as t from '@babel/types';
export declare function isFileNormalized(file: t.Node): boolean;
export declare function markFileNormalized(file: t.Node): void;
export type NormalizeResult = {
    /** Number of bindings renamed. */
    renamed: number;
};
export declare function makeDeclaredNamesUnique(file: t.File): NormalizeResult;
