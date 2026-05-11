import * as t from '@babel/types';
export type ExitPointsResult = {
    minimized: number;
};
/**
 * Operates on any AST root (Program, File, Function body — anything). We use
 * a manual walker rather than @babel/traverse to avoid the scope/parentPath
 * requirement when invoked on a non-Program subtree (the simplifier passes
 * a function body here).
 */
export declare function runMinimizeExitPoints(root: t.Node): ExitPointsResult;
