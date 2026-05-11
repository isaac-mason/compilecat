import * as t from '@babel/types';
/**
 * The condition-bearing child of a control structure. Mirrors Closure's
 * `getConditionExpression` — null for things like `for(;;)` where the test
 * slot is empty.
 */
export declare function getConditionExpression(node: t.Node): t.Expression | null;
/**
 * Whether `node` is a statement (control-flow-significant). Closure uses this
 * to decide what gets its own CFG node. Babel's `t.isStatement` covers most
 * of this but excludes `SwitchCase` (which we treat as case body sequence
 * elements), so the test composes both.
 */
export declare function isStatement(node: t.Node): boolean;
/**
 * Whether `node` is a loop construct. Used by ControlFlowAnalysis when
 * resolving break/continue targets.
 */
export declare function isLoop(node: t.Node): boolean;
/**
 * Whether `node` is a target for an unlabeled `break`. In ECMAScript that's
 * any loop or a switch.
 */
export declare function isBreakTarget(node: t.Node): boolean;
/**
 * Whether `node` is a target for an unlabeled `continue` — loops only.
 */
export declare function isContinueTarget(node: t.Node): boolean;
/**
 * Babel models a `for(;;)` body as the LAST child. Closure's NodeUtil exposes
 * helpers to navigate this; here it's just `.body` for every loop kind.
 */
export declare function getLoopBody(loop: t.Node): t.Statement | null;
/**
 * Whether node introduces a new function scope. Mirrors Closure's
 * `isFunctionDeclaration` / `isFunction` group — for our purposes we treat
 * all function-like things uniformly (the CFG builder bails on async /
 * generator at the body level rather than here).
 */
export declare function isFunction(node: t.Node): boolean;
/**
 * The body of a function-like node (always a BlockStatement in practice for
 * declarations and named expressions; arrow-with-expression-body is the
 * exception — caller must handle that case explicitly if it cares).
 */
export declare function getFunctionBody(fn: t.Function): t.BlockStatement | t.Expression;
/**
 * Port of NodeUtil.isStatementBlock (NodeUtil.java:2170):
 *   return n.isRoot() || n.isScript() || n.isBlock() || n.isModuleBody();
 *
 * Babel has no ROOT or MODULE_BODY token — Program covers both.
 */
export declare function isStatementBlock(n: t.Node): boolean;
/**
 * Port of NodeUtil.canMergeBlock (NodeUtil.java:2516):
 *
 *   for (Node c = block.getFirstChild(); c != null; c = c.getNext()) {
 *     switch (c.getToken()) {
 *       case LABEL -> {
 *         if (canMergeBlock(c)) continue; else return false;
 *       }
 *       case CONST, LET, CLASS, FUNCTION -> { return false; }
 *       default -> { continue; }
 *     }
 *   }
 *   return true;
 *
 * Babel mapping:
 *   LABEL    → LabeledStatement
 *   CONST    → VariableDeclaration with kind === 'const'
 *   LET      → VariableDeclaration with kind === 'let'
 *   CLASS    → ClassDeclaration
 *   FUNCTION → FunctionDeclaration
 *
 * Closure's recursive `canMergeBlock(c)` on a LABEL iterates the LABEL's
 * children — label name (NAME, default branch) plus the labeled statement
 * (which falls into one of the cases). The LabeledStatement node in Babel
 * has a single body slot; we replicate the same semantics by inspecting it.
 */
export declare function canMergeBlock(block: t.BlockStatement): boolean;
/**
 * Port of NodeUtil.tryMergeBlock (NodeUtil.java:2490):
 *
 *   boolean canMerge = ignoreBlockScopedDeclarations || canMergeBlock(block);
 *   if (isStatementBlock(parent) && canMerge) {
 *     // splice block's children up into parent in-place; detach block
 *     return true;
 *   }
 *   return false;
 *
 * Babel doesn't expose Closure's child-pointer API, so the caller passes the
 * parent statement array and the index of the block within it; we splice
 * directly. Returns the number of statements spliced in (== the block's
 * child count) when the merge happened, or 0 when it was rejected.
 */
export declare function tryMergeBlock(block: t.BlockStatement, parentBody: t.Statement[], indexInParent: number, parent: t.Node, ignoreBlockScopedDeclarations: boolean): number;
/**
 * Closure's `isLiteralValue` — recognises primitive literal nodes used by
 * dataflow / fold passes. The `includeFunctions` flag matches Closure's
 * second-arg convention.
 */
export declare function isLiteralValue(node: t.Node, includeFunctions: boolean): boolean;
/**
 * Identifier nodes that name a binding (LHS of declaration, function param,
 * write target). Closure spells this `isName`; on Babel we just check for an
 * Identifier or a destructuring pattern element.
 */
export declare function isName(node: t.Node): node is t.Identifier;
/** Convenience: true if node is `undefined` keyword usage (an Identifier). */
export declare function isUndefined(node: t.Node): boolean;
export declare const AND_PRECEDENCE = 6;
export declare const OR_PRECEDENCE = 5;
export declare function precedence(node: t.Node): number;
export declare function areNodesEqual(a: t.Node, b: t.Node): boolean;
/** Read `parent[key]` without losing exhaustiveness on the concrete type. */
export declare function getSlot(parent: t.Node, key: string): t.Node | (t.Node | null)[] | null | undefined;
/** Write `parent[key]` (or `parent[key][index]` if `index` provided). */
export declare function setSlot(parent: t.Node, key: string, index: number | undefined, value: t.Node | null): void;
