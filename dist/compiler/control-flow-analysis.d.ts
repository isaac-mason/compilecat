import * as t from '@babel/types';
import { type ControlFlowGraph } from './control-flow-graph';
export type BuildCfgOptions = {
    /** The CFG root — typically a function body (BlockStatement) or a Program. */
    root: t.Node;
    /**
     * If true, walk into nested functions and assign them priorities (still
     * separate CFG nodes, treated atomically from the outer CFG's perspective).
     * Defaults to false. Closure default also false.
     */
    shouldTraverseFunctions?: boolean;
};
/**
 * Build a CFG for `root`. Returns null if `root` contains constructs we bail
 * on (try/with/yield/await/generator/async). The caller should treat that as
 * "skip this function for any analysis that needs a CFG".
 */
export declare function buildControlFlowGraph(opts: BuildCfgOptions): ControlFlowGraph | null;
export declare function computeFallThrough(n: t.Node): t.Node;
