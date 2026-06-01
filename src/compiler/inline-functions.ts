// Port of jscomp/InlineFunctions.java (subset).
//
// Drives FunctionInjector: discovers candidate callees and call sites,
// classifies each, and performs the splice.
//
// Operates on a single Program. In WholeProgram (bundle-mode) this is the
// entire chunk after rollup has resolved imports — every callee in scope is
// reachable directly. In PerFile (transform-mode) the Program is one source
// file; passing a CrossFileCtx (consumerPath + fileCache) extends discovery
// to follow imports into donor modules, splice donor bodies into the
// consumer, and hoist the module-vars / imports the spliced body references.
//
//   - Candidate callees:
//     - `function NAME(...) { ... }` declarations at any block scope
//     - `const NAME = (...) => { ... }` / `const NAME = function (...) { ... }`
//     - (cross-file) any of the above exported from a resolved donor module
//   - Trigger:
//     - declaration carries an `@inline` JSDoc / leading block comment, OR
//     - call expression carries an `@inline` leading block comment, OR
//     - call sits inside a `@flatten`-annotated function
//   - Call sites:
//     - `NAME(args)` — Identifier callee matching a known candidate (local or
//       cross-file via a named import)
//     - `NS.NAME(args)` — namespace member call against a namespace import or
//       namespace re-export
//   - No method calls, no `this`/`arguments`, no recursion.
//
// Discovery is name-keyed. We don't model scope shadowing — if two callees
// share a name (top-level vs. nested), we conservatively treat the
// outermost as the only candidate.

import * as nodePath from 'node:path';

import * as t from '@babel/types';

import { commentIsFlattenDirective, commentIsInlineDirective, hasLeadingDirective } from './directives';
import { type FileIndex, type ImportBinding, type IndexedFunction, type ModuleVar, indexFile } from './discover';
import { type FileCache, ensureIndexed } from './file-index';
import { type CallSite, type Callee, classifyCallee, inlineBlock, inlineDirect } from './function-injector';
import { getSlot } from './node-util';
import { type FileReader, defaultFileReader, resolveImportSource, resolveRelativeImport } from './resolve';

export type InlineResult = {
    /** Number of distinct candidates that were resolved at least once. */
    inlined: number;
    /** Call sites attempted (DIRECT or BLOCK). */
    calls: number;
    /** Call sites where injection succeeded. */
    succeeded: number;
    /** Donor file paths whose bodies were spliced into the consumer. PerFile
     *  callers use these to register watchers (e.g. `this.addWatchFile`) so
     *  consumers re-transform when a donor changes. Empty in WholeProgram. */
    donorPaths: Set<string>;
};

export type InlineOptions = {
    /** Absolute path of the consumer file. Required to enable cross-file. */
    consumerPath?: string;
    /** Shared cache for parsed donor files. Required to enable cross-file. */
    fileCache?: FileCache;
    /** File reader; defaults to disk. */
    fileReader?: FileReader;
    /** Permit inlining from `node_modules` when the call site opts in. */
    allowLibraryInline?: boolean;
    /** Set populated with every enclosing function of a successful inline. */
    touched?: WeakSet<t.Function>;
};

type Candidate = {
    name: string;
    callee: Callee;
    /** True when the declaration carries `@inline` (apply at every call). */
    declAnnotated: boolean;
    /** Path-index info for stripping the original declaration after we've
     *  consumed all uses, when declAnnotated is true. Cross-file candidates
     *  do not have declRef — they live in a different file. */
    declRef?: { parent: t.BlockStatement | t.Program; index: number };
    /** Set when the candidate was resolved cross-file. Carries the donor
     *  IndexedFunction so we know which donor module-vars / imports the
     *  spliced body references and must hoist into the consumer. */
    donor?: { donorPath: string; donorIndex: FileIndex; fn: IndexedFunction };
};

type RequiredModuleVar = { sourceFile: string; name: string; moduleVar: ModuleVar };
type RequiredImport = { sourceFile: string; localName: string; binding: ImportBinding };

type CrossFileCtx = {
    consumerPath: string;
    consumerIndex: FileIndex;
    cache: FileCache;
    reader: FileReader;
    allowLibrary: boolean;
    /** Memo of cross-file candidate lookups, keyed by `${donorPath}::${name}`. */
    memo: Map<string, Candidate | null>;
    /** Donor module-vars referenced by spliced bodies; hoisted into consumer. */
    requiredModuleVars: Map<string, RequiredModuleVar>;
    /** Donor imports referenced by spliced bodies; hoisted into consumer. */
    requiredImports: Map<string, RequiredImport>;
    /** Every donor whose body was actually spliced. */
    donorPaths: Set<string>;
};

// ---------------------------------------------------------------------------
// Public entry.

export function inlineFunctions(root: t.Node, options: InlineOptions = {}): InlineResult {
    const result: InlineResult = {
        inlined: 0,
        calls: 0,
        succeeded: 0,
        donorPaths: new Set(),
    };

    // Discover top-level (and nested) local candidate functions.
    const candidates = new Map<string, Candidate>();
    discoverCandidates(root, candidates);

    // Cross-file context. Built once so the consumerIndex (free-ref analysis)
    // is shared across every call-site lookup.
    const xfile = buildCrossFileCtx(root, options);

    if (candidates.size === 0 && !xfile) return result;

    // Find call sites and inject. Pre-collected in a single pass so that
    // injection-time AST mutation can't disturb the iteration.
    const sites = collectCallSites(root, candidates, xfile);

    let nextId = 0;
    const opts = { nextId: () => nextId++ };

    for (const { candidate, site, enclosingFunction } of sites) {
        const fn = candidate.callee.fn;
        const cls = classifyCallee(fn);
        if (cls.mode === 'NO') continue;

        result.calls++;
        let ok = false;
        if (cls.mode === 'DIRECT') {
            ok = inlineDirect(candidate.callee, site);
            if (!ok) {
                // Fall back to BLOCK if DIRECT can't substitute (e.g. side-effect
                // arg used twice).
                ok = inlineBlock(candidate.callee, site, opts);
            }
        } else {
            ok = inlineBlock(candidate.callee, site, opts);
        }
        if (ok) {
            result.succeeded++;
            if (enclosingFunction) options.touched?.add(enclosingFunction);
            if (xfile && candidate.donor) {
                trackDonorRefs(candidate, xfile);
                xfile.donorPaths.add(candidate.donor.donorPath);
            }
        }
    }

    if (result.succeeded > 0) result.inlined = candidates.size;

    // Strip declaration-annotated callees once consumed. Conservative: only
    // strip if we successfully inlined at least one call AND no residual
    // identifier reads remain in the same parent block.
    stripFullyInlinedDecls(candidates, sites);

    // Hoist donor-side module-vars and imports referenced by spliced bodies.
    if (xfile && t.isFile(root)) {
        if (xfile.requiredImports.size > 0) hoistRequiredImports(root, xfile);
        if (xfile.requiredModuleVars.size > 0) hoistRequiredModuleVars(root, xfile);
        for (const p of xfile.donorPaths) result.donorPaths.add(p);
    }

    return result;
}

// ---------------------------------------------------------------------------
// Candidate discovery.

function discoverCandidates(root: t.Node, out: Map<string, Candidate>): void {
    visitWithParents(root, (n, parent, _key, index) => {
        if (t.isFunctionDeclaration(n) && n.id) {
            const params = paramNames(n);
            if (params === null) return;
            const annotated = hasInlineAnnotation(n, parent);
            const c: Candidate = {
                name: n.id.name,
                callee: { fn: n, paramNames: params },
                declAnnotated: annotated,
            };
            if (parent && (t.isBlockStatement(parent) || t.isProgram(parent)) && index !== undefined) {
                c.declRef = { parent: parent as t.BlockStatement | t.Program, index };
            }
            if (!out.has(n.id.name)) out.set(n.id.name, c);
            return;
        }
        if (t.isVariableDeclaration(n) && n.declarations.length === 1) {
            const d = n.declarations[0];
            if (t.isIdentifier(d.id) && (t.isArrowFunctionExpression(d.init) || t.isFunctionExpression(d.init))) {
                const params = paramNames(d.init);
                if (params === null) return;
                const annotated = hasInlineAnnotation(n, parent) || hasInlineAnnotation(d.init);
                const c: Candidate = {
                    name: d.id.name,
                    callee: { fn: d.init, paramNames: params },
                    declAnnotated: annotated,
                };
                if (parent && (t.isBlockStatement(parent) || t.isProgram(parent)) && index !== undefined) {
                    c.declRef = { parent: parent as t.BlockStatement | t.Program, index };
                }
                if (!out.has(d.id.name)) out.set(d.id.name, c);
            }
        }
    });
}

function paramNames(fn: t.Function): string[] | null {
    const out: string[] = [];
    for (const p of fn.params) {
        if (!t.isIdentifier(p)) return null;
        out.push(p.name);
    }
    return out;
}

function hasInlineAnnotation(n: t.Node, parent: t.Node | null = null): boolean {
    return hasLeadingDirective(n, parent, commentIsInlineDirective);
}

function hasFlattenAnnotation(n: t.Node, parent: t.Node | null = null): boolean {
    return hasLeadingDirective(n, parent, commentIsFlattenDirective);
}

// ---------------------------------------------------------------------------
// Cross-file context bootstrap.

function buildCrossFileCtx(root: t.Node, opts: InlineOptions): CrossFileCtx | null {
    if (!opts.consumerPath || !opts.fileCache) return null;
    if (!t.isFile(root)) return null;
    const reader = opts.fileReader ?? defaultFileReader;
    const consumerIndex = indexFile(opts.consumerPath, root);
    return {
        consumerPath: opts.consumerPath,
        consumerIndex,
        cache: opts.fileCache,
        reader,
        allowLibrary: opts.allowLibraryInline === true,
        memo: new Map(),
        requiredModuleVars: new Map(),
        requiredImports: new Map(),
        donorPaths: new Set(),
    };
}

// ---------------------------------------------------------------------------
// Call site collection.

type Site = { candidate: Candidate; site: CallSite; enclosingFunction: t.Function | null };

function collectCallSites(root: t.Node, candidates: Map<string, Candidate>, xfile: CrossFileCtx | null): Site[] {
    const sites: Site[] = [];

    // Track current enclosing function (for flatten propagation + downstream
    // touched-set bookkeeping).
    const flattenStack: boolean[] = [false];
    const fnStack: (t.Function | null)[] = [null];

    const walk = (
        n: t.Node,
        parent: t.Node | null,
        key: string,
        index: number | undefined,
        // Path of (statementParent, statementIndex, enclosingStatement).
        stmtCtx: {
            parent: t.BlockStatement | t.Program | t.SwitchCase;
            index: number;
            stmt: t.Statement;
        } | null,
    ): void => {
        const enteringFn = t.isFunction(n);
        if (enteringFn) {
            flattenStack.push(hasFlattenAnnotation(n, parent));
            fnStack.push(n as t.Function);
        }

        let nextStmtCtx = stmtCtx;
        if (parent && index !== undefined && t.isStatement(n)) {
            if ((t.isBlockStatement(parent) || t.isProgram(parent)) && key === 'body') {
                nextStmtCtx = {
                    parent: parent as t.BlockStatement | t.Program,
                    index,
                    stmt: n as t.Statement,
                };
            } else if (t.isSwitchCase(parent) && key === 'consequent') {
                // SwitchCase.consequent is a Statement[] just like Block.body —
                // bare `case X: stmt; break;` cases (no `{ ... }` wrapper) need
                // the same statement-context tracking so inlines splice inside
                // the case, not before the enclosing switch.
                nextStmtCtx = {
                    parent: parent as t.SwitchCase,
                    index,
                    stmt: n as t.Statement,
                };
            }
        }

        if (t.isCallExpression(n) && nextStmtCtx !== null && parent !== null) {
            const cand = resolveCandidateForCall(n, candidates, xfile);
            if (cand !== null) {
                const callsiteAnnotated = hasInlineAnnotationOnCall(n, parent, key);
                const enclosingFlatten = flattenStack[flattenStack.length - 1];
                if (cand.declAnnotated || callsiteAnnotated || enclosingFlatten) {
                    sites.push({
                        candidate: cand,
                        site: {
                            call: n,
                            enclosingStatement: nextStmtCtx.stmt,
                            statementParent: nextStmtCtx.parent,
                            statementIndex: nextStmtCtx.index,
                            callParent: parent,
                            callKey: key,
                            callIndex: index,
                        },
                        enclosingFunction: fnStack[fnStack.length - 1],
                    });
                }
            }
        }

        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c) walk(c, n, k, i, nextStmtCtx);
                }
            } else {
                walk(child, n, k, undefined, nextStmtCtx);
            }
        }

        if (enteringFn) {
            flattenStack.pop();
            fnStack.pop();
        }
    };

    walk(root, null, '', undefined, null);

    return sites;
}

// ---------------------------------------------------------------------------
// Candidate resolution at a call site (local or cross-file).

function resolveCandidateForCall(
    call: t.CallExpression,
    localCandidates: Map<string, Candidate>,
    xfile: CrossFileCtx | null,
): Candidate | null {
    const callee = call.callee;

    if (t.isIdentifier(callee)) {
        const name = callee.name;
        const local = localCandidates.get(name);
        if (local) return local;
        if (!xfile) return null;
        const binding = xfile.consumerIndex.imports.get(name);
        if (!binding) return null;
        return resolveImportedCallee(binding.importedName, binding, xfile);
    }

    if (t.isMemberExpression(callee) && !callee.computed) {
        if (!xfile) return null;
        if (!t.isIdentifier(callee.object)) return null;
        if (!t.isIdentifier(callee.property)) return null;
        const nsName = callee.object.name;
        const fnName = callee.property.name;

        const binding = xfile.consumerIndex.imports.get(nsName);
        if (binding && binding.style === 'namespace') {
            return resolveImportedCallee(fnName, binding, xfile);
        }
        const reexportSource = xfile.consumerIndex.namespaceReexports.get(nsName);
        if (reexportSource) {
            const fakeBinding: ImportBinding = {
                localName: nsName,
                importedName: '*',
                style: 'namespace',
                source: reexportSource,
            };
            return resolveImportedCallee(fnName, fakeBinding, xfile);
        }

        // `import { ns } from 'pkg'` where the donor file re-exports `ns` as a
        // namespace (`export * as ns from './impl'` or
        // `import * as ns from './impl'; export { ns };`). Follow through.
        if (binding && binding.style === 'named') {
            const donorPath = resolveImportSource(xfile.consumerPath, binding.source, xfile.allowLibrary, xfile.reader);
            if (!donorPath) return null;
            const donorIndex = ensureIndexed(xfile.cache, donorPath, xfile.reader);
            if (!donorIndex) return null;
            let nsSource = donorIndex.namespaceReexports.get(binding.importedName);
            if (!nsSource) {
                const nsImport = donorIndex.imports.get(binding.importedName);
                if (nsImport?.style === 'namespace') nsSource = nsImport.source;
            }
            if (!nsSource) return null;
            const fakeBinding: ImportBinding = {
                localName: nsName,
                importedName: '*',
                style: 'namespace',
                source: nsSource,
            };
            // Resolve `fnName` from the *donor* file's perspective.
            return resolveImportedCalleeFrom(donorPath, fnName, fakeBinding, xfile);
        }
    }
    return null;
}

function resolveImportedCallee(importedName: string, binding: ImportBinding, xfile: CrossFileCtx): Candidate | null {
    return resolveImportedCalleeFrom(xfile.consumerPath, importedName, binding, xfile);
}

function resolveImportedCalleeFrom(
    fromFile: string,
    importedName: string,
    binding: ImportBinding,
    xfile: CrossFileCtx,
): Candidate | null {
    const donorPath = resolveImportSource(fromFile, binding.source, xfile.allowLibrary, xfile.reader);
    if (!donorPath) return null;

    const memoKey = `${donorPath}::${importedName}`;
    if (xfile.memo.has(memoKey)) return xfile.memo.get(memoKey) ?? null;

    const donorIndex = ensureIndexed(xfile.cache, donorPath, xfile.reader);
    if (!donorIndex) {
        xfile.memo.set(memoKey, null);
        return null;
    }

    const donorFn = donorIndex.functions.get(importedName);
    if (!donorFn) {
        xfile.memo.set(memoKey, null);
        return null;
    }

    const cand = buildCrossFileCandidate(donorFn, donorPath, donorIndex);
    xfile.memo.set(memoKey, cand);
    return cand;
}

/**
 * Build a Candidate from a donor IndexedFunction. The body's references to
 * donor module-vars and imports are tracked through `Candidate.donor`; on
 * successful inline we register them so the post-pass can hoist clones into
 * the consumer file. Calls to *other* donor functions cannot be hoisted
 * (they would require pulling whole functions across), so we reject those.
 */
function buildCrossFileCandidate(
    donorFn: IndexedFunction,
    donorPath: string,
    donorIndex: FileIndex,
): Candidate | null {
    // We don't pull donor function definitions across files. If the donor
    // body calls another donor function, the splice would leave an unbound
    // reference in the consumer. Bail.
    if (donorFn.functionRefs.size > 0) return null;
    // Donor body references a top-level binding we can't classify
    // (e.g. classes) — the hoister wouldn't know how to bring it along.
    // Bail rather than emitting a broken inline.
    if (donorFn.unresolvedRefs.size > 0) return null;

    const params: string[] = [];
    for (const p of donorFn.params) {
        if (!t.isIdentifier(p)) return null;
        params.push(p.name);
    }

    return {
        name: donorFn.name,
        callee: { fn: donorFn.fnNode, paramNames: params },
        declAnnotated: donorFn.hasInlineAnnotation,
        donor: { donorPath, donorIndex, fn: donorFn },
    };
}

function trackDonorRefs(candidate: Candidate, xfile: CrossFileCtx): void {
    if (!candidate.donor) return;
    const { donorPath, donorIndex, fn } = candidate.donor;

    for (const name of fn.moduleVarRefs) {
        const mv = donorIndex.moduleVars.get(name);
        if (!mv) continue;
        const key = `${donorPath}::${name}`;
        if (xfile.requiredModuleVars.has(key)) continue;
        xfile.requiredModuleVars.set(key, { sourceFile: donorPath, name, moduleVar: mv });
    }
    for (const name of fn.importRefs) {
        const b = donorIndex.imports.get(name);
        if (!b) continue;
        const key = `${donorPath}::${name}`;
        if (xfile.requiredImports.has(key)) continue;
        xfile.requiredImports.set(key, { sourceFile: donorPath, localName: name, binding: b });
    }
}

// ---------------------------------------------------------------------------
// Hoisting donor module-vars + imports.
//
// Imports are rewritten relative to the consumer file (or kept as bare
// specifiers for library imports). Module-var clones are inserted right
// after the import block. Collisions are skipped — when the consumer
// already has a binding by the same name, we leave the spliced body's
// reference to bind to whatever is in scope.

function hoistRequiredImports(ast: t.File, xfile: CrossFileCtx): void {
    const consumerIndex = xfile.consumerIndex;
    const reader = xfile.reader;
    const consumerFile = xfile.consumerPath;

    const existingBindings = new Set<string>([
        ...consumerIndex.imports.keys(),
        ...consumerIndex.functions.keys(),
        ...consumerIndex.moduleVars.keys(),
    ]);
    for (const stmt of ast.program.body) {
        if (t.isImportDeclaration(stmt)) {
            for (const spec of stmt.specifiers) existingBindings.add(spec.local.name);
        }
    }

    type Spec = { localName: string; importedName: string; style: 'named' | 'default' | 'namespace' };
    const byTarget = new Map<string, { source: string; specs: Spec[] }>();

    const consumerDir = nodePath.dirname(consumerFile);

    for (const req of xfile.requiredImports.values()) {
        const binding = req.binding;
        if (!binding) continue;
        if (existingBindings.has(binding.localName)) continue;

        let rewrittenSource = binding.source;
        if (binding.source.startsWith('./') || binding.source.startsWith('../') || binding.source.startsWith('/')) {
            const abs = resolveRelativeImport(req.sourceFile, binding.source, reader);
            if (abs) {
                let rel = nodePath.relative(consumerDir, abs);
                if (!rel.startsWith('.')) rel = `./${rel}`;
                rel = rel.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
                rewrittenSource = rel;
            }
        }

        const bucket = byTarget.get(rewrittenSource) ?? { source: rewrittenSource, specs: [] };
        bucket.specs.push({
            localName: binding.localName,
            importedName: binding.importedName,
            style: binding.style,
        });
        byTarget.set(rewrittenSource, bucket);
        existingBindings.add(binding.localName);
    }

    if (byTarget.size === 0) return;

    const importsToInsert: t.ImportDeclaration[] = [];
    for (const { source, specs } of byTarget.values()) {
        const specifiers: t.ImportDeclaration['specifiers'] = [];
        for (const s of specs) {
            if (s.style === 'default') {
                specifiers.push(t.importDefaultSpecifier(t.identifier(s.localName)));
            } else if (s.style === 'namespace') {
                specifiers.push(t.importNamespaceSpecifier(t.identifier(s.localName)));
            } else {
                specifiers.push(t.importSpecifier(t.identifier(s.localName), t.identifier(s.importedName)));
            }
        }
        importsToInsert.push(t.importDeclaration(specifiers, t.stringLiteral(source)));
    }

    ast.program.body.unshift(...importsToInsert);
}

function hoistRequiredModuleVars(ast: t.File, xfile: CrossFileCtx): void {
    const consumerIndex = xfile.consumerIndex;
    const consumerLocals = new Set<string>([
        ...consumerIndex.moduleVars.keys(),
        ...consumerIndex.functions.keys(),
        ...consumerIndex.imports.keys(),
    ]);
    for (const stmt of ast.program.body) {
        if (t.isImportDeclaration(stmt)) {
            for (const spec of stmt.specifiers) consumerLocals.add(spec.local.name);
        }
    }

    const toInsert: t.Statement[] = [];
    const insertedKeys = new Set<string>();

    for (const [key, req] of xfile.requiredModuleVars) {
        if (insertedKeys.has(key)) continue;
        if (consumerLocals.has(req.name)) continue;
        const cloned = cloneModuleVarForHoisting(req.moduleVar, req.name);
        if (!cloned) continue;
        toInsert.push(...cloned);
        insertedKeys.add(key);
    }

    if (toInsert.length === 0) return;

    const body = ast.program.body;
    let insertAt = 0;
    for (let i = 0; i < body.length; i++) {
        if (t.isImportDeclaration(body[i])) insertAt = i + 1;
        else break;
    }
    body.splice(insertAt, 0, ...toInsert);
}

function cloneModuleVarForHoisting(moduleVar: ModuleVar, name: string): t.Statement[] | null {
    const decl = moduleVar.declaration;
    if (t.isTSEnumDeclaration(decl)) {
        if (decl.id.name !== name) return null;
        return lowerTsEnumToJs(decl);
    }
    const matching = decl.declarations.find((d) => t.isIdentifier(d.id) && d.id.name === name);
    if (!matching) return null;
    return [t.variableDeclaration(decl.kind, [t.cloneNode(matching, true, false)])];
}

// Lower a TSEnumDeclaration to the TypeScript-equivalent JS emit. Matches
// `tsc --target esnext` output: numeric members get reverse-mapping; string
// members get forward-only assignment. Returns null if any member has a
// non-literal initializer we can't evaluate at compile time.
//
//   enum E { A = 0, B = 1 }
// becomes:
//   var E;
//   (function (E) {
//       E[E["A"] = 0] = "A";
//       E[E["B"] = 1] = "B";
//   })(E || (E = {}));
function lowerTsEnumToJs(decl: t.TSEnumDeclaration): t.Statement[] | null {
    const name = decl.id.name;
    type Resolved = { key: string; value: t.NumericLiteral | t.StringLiteral };
    const resolved: Resolved[] = [];
    let nextNumeric: number | null = 0;

    for (const m of decl.members) {
        const keyName = t.isIdentifier(m.id) ? m.id.name : t.isStringLiteral(m.id) ? m.id.value : null;
        if (keyName === null) return null;

        let value: t.NumericLiteral | t.StringLiteral;
        if (m.initializer) {
            const init = m.initializer;
            if (t.isNumericLiteral(init)) {
                value = t.numericLiteral(init.value);
                nextNumeric = init.value + 1;
            } else if (t.isUnaryExpression(init) && init.operator === '-' && t.isNumericLiteral(init.argument)) {
                value = t.numericLiteral(-init.argument.value);
                nextNumeric = (value.value as number) + 1;
            } else if (t.isStringLiteral(init)) {
                value = t.stringLiteral(init.value);
                // After a string init, auto-increment is no longer valid in TS.
                nextNumeric = null;
            } else {
                return null;
            }
        } else {
            if (nextNumeric === null) return null;
            value = t.numericLiteral(nextNumeric);
            nextNumeric += 1;
        }
        resolved.push({ key: keyName, value });
    }

    const idRef = (): t.Identifier => t.identifier(name);
    const bodyStmts: t.Statement[] = resolved.map(({ key, value }) => {
        if (t.isStringLiteral(value)) {
            // E["KEY"] = "VAL";  (no reverse mapping for string members)
            return t.expressionStatement(
                t.assignmentExpression('=', t.memberExpression(idRef(), t.stringLiteral(key), true), value),
            );
        }
        // E[E["KEY"] = VAL] = "KEY";  (reverse mapping for numeric members)
        return t.expressionStatement(
            t.assignmentExpression(
                '=',
                t.memberExpression(
                    idRef(),
                    t.assignmentExpression('=', t.memberExpression(idRef(), t.stringLiteral(key), true), value),
                    true,
                ),
                t.stringLiteral(key),
            ),
        );
    });

    const iife = t.expressionStatement(
        t.callExpression(t.functionExpression(null, [idRef()], t.blockStatement(bodyStmts)), [
            t.logicalExpression('||', idRef(), t.assignmentExpression('=', idRef(), t.objectExpression([]))),
        ]),
    );

    return [t.variableDeclaration('var', [t.variableDeclarator(idRef())]), iife];
}

// ---------------------------------------------------------------------------

function hasInlineAnnotationOnCall(call: t.CallExpression, parent: t.Node, key: string): boolean {
    if (hasInlineAnnotation(call)) return true;
    // Comment may attach to enclosing ExpressionStatement.
    if (key === 'expression' && t.isExpressionStatement(parent) && hasInlineAnnotation(parent)) {
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Decl stripping.

function stripFullyInlinedDecls(candidates: Map<string, Candidate>, sites: Site[]): void {
    const succeededByName = new Map<string, number>();
    for (const s of sites) {
        succeededByName.set(s.candidate.name, (succeededByName.get(s.candidate.name) ?? 0) + 1);
    }

    for (const [name, c] of candidates) {
        if (c.donor) continue;
        if (!c.declAnnotated) continue;
        if (!c.declRef) continue;
        if ((succeededByName.get(name) ?? 0) === 0) continue;
        const anyResidual = anyResidualReference(c.declRef.parent, name, c.declRef.index);
        if (anyResidual) continue;
        c.declRef.parent.body.splice(c.declRef.index, 1);
        for (const other of candidates.values()) {
            if (other.declRef && other.declRef.parent === c.declRef.parent && other.declRef.index > c.declRef.index) {
                other.declRef.index--;
            }
        }
    }
}

function anyResidualReference(parent: t.BlockStatement | t.Program, name: string, skipIndex: number): boolean {
    let found = false;
    for (let i = 0; i < parent.body.length; i++) {
        if (i === skipIndex) continue;
        const stmt = parent.body[i];
        visit(stmt, (n, parentNode, key) => {
            if (found) return;
            if (t.isIdentifier(n) && n.name === name && !isWriteContext(n, parentNode, key)) {
                found = true;
            }
        });
        if (found) return true;
    }
    return false;
}

function isWriteContext(n: t.Identifier, parent: t.Node | null, key: string): boolean {
    if (parent === null) return false;
    if (t.isVariableDeclarator(parent) && key === 'id') return true;
    if (t.isFunctionDeclaration(parent) && key === 'id') return true;
    if (t.isFunctionExpression(parent) && key === 'id') return true;
    if (t.isAssignmentExpression(parent) && key === 'left') return true;
    if (t.isUpdateExpression(parent) && key === 'argument') return true;
    if (t.isMemberExpression(parent) && key === 'property' && !parent.computed) return true;
    if (t.isObjectProperty(parent) && key === 'key' && !parent.computed) return true;
    if (t.isLabeledStatement(parent) && key === 'label') return true;
    if (t.isBreakStatement(parent) && key === 'label') return true;
    if (t.isContinueStatement(parent) && key === 'label') return true;
    void n;
    return false;
}

// ---------------------------------------------------------------------------
// Tiny visitor utilities.

function visit(root: t.Node, fn: (n: t.Node, parent: t.Node | null, key: string, index?: number) => void): void {
    const walk = (n: t.Node, parent: t.Node | null, key: string, index?: number): void => {
        fn(n, parent, key, index);
        for (const k of t.VISITOR_KEYS[n.type] ?? []) {
            const child = getSlot(n, k);
            if (child === null || child === undefined) continue;
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    const c = child[i];
                    if (c) walk(c, n, k, i);
                }
            } else {
                walk(child, n, k);
            }
        }
    };
    walk(root, null, '');
}

function visitWithParents(root: t.Node, fn: (n: t.Node, parent: t.Node | null, key: string, index?: number) => void): void {
    visit(root, fn);
}
