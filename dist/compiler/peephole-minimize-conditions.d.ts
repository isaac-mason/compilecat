import * as t from '@babel/types';
export type MinimizeResult = {
    minimized: number;
};
export declare function runPeepholeMinimizeConditions(root: t.Node): MinimizeResult;
