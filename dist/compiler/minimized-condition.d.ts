import * as t from '@babel/types';
export type MinimizationStyle = 'PREFER_UNNEGATED' | 'ALLOW_LEADING_NOT';
export type MeasuredNode = {
    node: t.Node | null;
    children: MeasuredNode[] | null;
    length: number;
    changed: boolean;
};
export type MinimizedCondition = {
    positive: MeasuredNode;
    negative: MeasuredNode;
};
export declare function fromConditionNode(n: t.Node): MinimizedCondition;
export declare function unoptimized(n: t.Node): MinimizedCondition;
export declare function getMinimized(mc: MinimizedCondition, style: MinimizationStyle): MeasuredNode;
export declare function isMeasuredNot(m: MeasuredNode): boolean;
export declare function withoutNot(m: MeasuredNode): MeasuredNode;
export declare function isLowerPrecedenceThan(m: MeasuredNode, prec: number): boolean;
export declare function willChange(m: MeasuredNode, original: t.Node): boolean;
export declare function buildReplacement(m: MeasuredNode): t.Node;
