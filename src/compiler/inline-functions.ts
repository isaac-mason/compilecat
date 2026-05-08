// Port of jscomp/InlineFunctions.java (subset).
//
// Drives FunctionInjector: discovers candidate callees and call sites within
// a single program, classifies each, and performs the splice.
//
// v1 scope (same-file only):
//   - Candidate callees:
//     - `function NAME(...) { ... }` declarations at any block scope
//     - `const NAME = (...) => { ... }` / `const NAME = function (...) { ... }`
//   - Trigger:
//     - declaration carries an `@inline` JSDoc / leading block comment, OR
//     - call expression carries an `@inline` leading block comment
//   - Call sites:
//     - `NAME(args)` — Identifier callee matching a known candidate
//   - No method calls, no `this`/`arguments`, no recursion, no cross-file.
//
// Discovery is name-keyed. We don't model scope shadowing — if two callees
// share a name (top-level vs. nested), we conservatively treat the
// outermost as the only candidate. Cross-file inlining lives in the
// classic tree's `inline.ts` and is out of scope for v1 of the gcc port.

import * as nodePath from 'node:path';

import * as t from '@babel/types';

import { commentIsFlattenDirective, commentIsInlineDirective } from './directives';
import { getSlot } from './node-util';
import {
    type FileIndex,
    type ImportBinding,
    type IndexedFunction,
    type ModuleVar,
    indexFile,
} from './discover';
import { type FileCache, ensureIndexed } from './file-index';
import {
    type CallSite,
    type Callee,
    classifyCallee,
    inlineBlock,
    inlineDirect,
} from './function-injector';
import {
    type FileReader,
    defaultFileReader,
    resolveImportSource,
    resolveRelativeImport,
} from './resolve';

export type InlineResult = {
    /** Callees that were resolved at least once. */
    inlined: number;
    /** Call sites attempted (DIRECT or BLOCK). */
    calls: number;
    /** Call sites where injection succeeded. */
    succeeded: number;
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

type RequiredModuleVar = {
    sourceFile: string;
    name: string;
    moduleVar: ModuleVar;
};

type RequiredImport = {
    sourceFile: string;
    localName: string;
    binding: ImportBinding;
};

// ---------------------------------------------------------------------------
// Public entry.

export function inlineFunctions(root: t.Node, options: InlineOptions = {}): InlineResult {
    const result: InlineResult = { inlined: 0, calls: 0, succeeded: 0 };

    // Discover top-level (and nested) candidate functions.
    const candidates = new Map<string, Candidate>();
    discoverCandidates(root, candidates);

    // Cross-file context. Built once so the consumerIndex (free-ref analysis)
    // is shared across every call-site lookup.
    const xfile = buildCrossFileCtx(root, options);

    if (candidates.size === 0 && !xfile) return result;

    // Find call sites and inject. We pre-collect sites in a single pass so
    // that injection-time AST mutation can't disturb the iteration.
    const sites = collectCallSites(root, candidates, xfile);

    let nextId = 0;
    const opts = { nextId: () => nextId++ };

    for (const { candidate, site } of sites) {
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
            if (xfile && candidate.donor) trackDonorRefs(candidate, xfile);
        }
    }

    if (result.succeeded > 0) result.inlined = candidates.size;

    // Strip declaration-annotated callees once consumed. Conservative: only
    // strip if we successfully inlined at least one call. We don't yet track
    // per-candidate consumption, so we leave the declaration in place if any
    // identifier remains referencing it.
    stripFullyInlinedDecls(root, candidates, sites);

    // Hoist donor-side module-vars and imports referenced by spliced bodies.
    if (xfile && t.isFile(root)) {
        if (xfile.requiredImports.size > 0) {
            hoistRequiredImports(root, xfile);
        }
        if (xfile.requiredModuleVars.size > 0) {
            hoistRequiredModuleVars(root, xfile);
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Candidate discovery.

function discoverCandidates(
    root: t.Node,
    out: Map<string, Candidate>,
): void {
    const flattenInside = new Set<t.Function>();

    // Pass 1: detect @flatten functions — every call inside their body
    // becomes a candidate trigger even without explicit @inline.
    visit(root, (n) => {
        if (t.isFunction(n) && hasFlattenAnnotation(n)) flattenInside.add(n);
    });

    // Pass 2: register candidates.
    visitWithParents(root, (n, parent, _key, index) => {
        if (t.isFunctionDeclaration(n) && n.id) {
            const params = paramNames(n);
            if (params === null) return;
            const annotated = hasInlineAnnotation(n);
            const c: Candidate = {
                name: n.id.name,
                callee: { fn: n, paramNames: params },
                declAnnotated: annotated,
            };
            if (
                (parent && (t.isBlockStatement(parent) || t.isProgram(parent))) &&
                index !== undefined
            ) {
                c.declRef = { parent: parent as t.BlockStatement | t.Program, index };
            }
            if (!out.has(n.id.name)) out.set(n.id.name, c);
            return;
        }
        if (t.isVariableDeclaration(n) && n.declarations.length === 1) {
            const d = n.declarations[0];
            if (
                t.isIdentifier(d.id) &&
                (t.isArrowFunctionExpression(d.init) || t.isFunctionExpression(d.init))
            ) {
                const params = paramNames(d.init);
                if (params === null) return;
                const annotated = hasInlineAnnotation(n) || hasInlineAnnotation(d.init);
                const c: Candidate = {
                    name: d.id.name,
                    callee: { fn: d.init, paramNames: params },
                    declAnnotated: annotated,
                };
                if (
                    (parent && (t.isBlockStatement(parent) || t.isProgram(parent))) &&
                    index !== undefined
                ) {
                    c.declRef = { parent: parent as t.BlockStatement | t.Program, index };
                }
                if (!out.has(d.id.name)) out.set(d.id.name, c);
            }
        }
    });

    // (Flatten propagation is handled at call-site collection time.)
    void flattenInside;
}

function paramNames(fn: t.Function): string[] | null {
    const out: string[] = [];
    for (const p of fn.params) {
        if (!t.isIdentifier(p)) return null;
        out.push(p.name);
    }
    return out;
}

function hasInlineAnnotation(n: t.Node): boolean {
    const cs = (n.leadingComments ?? []) as t.Comment[];
    for (const c of cs) {
        if (c.type === 'CommentBlock' && commentIsInlineDirective(c.value)) return true;
        if (c.type === 'CommentLine' && commentIsInlineDirective(c.value)) return true;
    }
    return false;
}

function hasFlattenAnnotation(n: t.Node): boolean {
    const cs = (n.leadingComments ?? []) as t.Comment[];
    for (const c of cs) {
        if (c.type === 'CommentBlock' && commentIsFlattenDirective(c.value)) return true;
        if (c.type === 'CommentLine' && commentIsFlattenDirective(c.value)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Call site collection.

type Site = { candidate: Candidate; site: CallSite };

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
};

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
    };
}

function collectCallSites(
    root: t.Node,
    candidates: Map<string, Candidate>,
    xfile: CrossFileCtx | null,
): Site[] {
    const sites: Site[] = [];

    // Track current enclosing function (for flatten propagation).
    const flattenStack: boolean[] = [false];

    const walk = (
        n: t.Node,
        parent: t.Node | null,
        key: string,
        index: number | undefined,
        // Path of (statementParent, statementIndex, enclosingStatement).
        stmtCtx: { parent: t.BlockStatement | t.Program; index: number; stmt: t.Statement } | null,
    ): void => {
        const enteringFn = t.isFunction(n);
        if (enteringFn) {
            flattenStack.push(hasFlattenAnnotation(n));
        }

        // If this is a Statement child of a Block/Program, update stmtCtx.
        let nextStmtCtx = stmtCtx;
        if (
            parent &&
            (t.isBlockStatement(parent) || t.isProgram(parent)) &&
            key === 'body' &&
            index !== undefined &&
            t.isStatement(n)
        ) {
            nextStmtCtx = {
                parent: parent as t.BlockStatement | t.Program,
                index,
                stmt: n as t.Statement,
            };
        }

        // Detect call site.
        if (
            t.isCallExpression(n) &&
            nextStmtCtx !== null &&
            parent !== null
        ) {
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

        if (enteringFn) flattenStack.pop();
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
            const donorPath = resolveImportSource(
                xfile.consumerPath,
                binding.source,
                xfile.allowLibrary,
                xfile.reader,
            );
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

function resolveImportedCallee(
    importedName: string,
    binding: ImportBinding,
    xfile: CrossFileCtx,
): Candidate | null {
    return resolveImportedCalleeFrom(xfile.consumerPath, importedName, binding, xfile);
}

function resolveImportedCalleeFrom(
    fromFile: string,
    importedName: string,
    binding: ImportBinding,
    xfile: CrossFileCtx,
): Candidate | null {
    const donorPath = resolveImportSource(
        fromFile,
        binding.source,
        xfile.allowLibrary,
        xfile.reader,
    );
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
        xfile.requiredImports.set(key, {
            sourceFile: donorPath,
            localName: name,
            binding: b,
        });
    }
}

// ---------------------------------------------------------------------------
// Hoisting donor module-vars + imports.
//
// Mirrors classic's logic: imports are rewritten relative to the consumer
// file (or kept as bare specifiers for library imports). Module-var clones
// are inserted right after the import block. Collisions are skipped — when
// the consumer already has a binding by the same name, we leave the spliced
// body's reference to bind to whatever is in scope (matching classic).

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

    type Spec = {
        localName: string;
        importedName: string;
        style: 'named' | 'default' | 'namespace';
    };
    const byTarget = new Map<string, { source: string; specs: Spec[] }>();

    const consumerDir = nodePath.dirname(consumerFile);

    for (const req of xfile.requiredImports.values()) {
        const binding = req.binding;
        if (!binding) continue;
        if (existingBindings.has(binding.localName)) continue;

        let rewrittenSource = binding.source;
        if (
            binding.source.startsWith('./') ||
            binding.source.startsWith('../') ||
            binding.source.startsWith('/')
        ) {
            const abs = resolveRelativeImport(req.sourceFile, binding.source, reader);
            if (abs) {
                let rel = nodePath.relative(consumerDir, abs);
                if (!rel.startsWith('.')) rel = `./${rel}`;
                rel = rel.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
                rewrittenSource = rel;
            }
        }

        const bucket = byTarget.get(rewrittenSource) ?? {
            source: rewrittenSource,
            specs: [],
        };
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
                specifiers.push(
                    t.importSpecifier(t.identifier(s.localName), t.identifier(s.importedName)),
                );
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

    const toInsert: t.VariableDeclaration[] = [];
    const insertedKeys = new Set<string>();

    for (const [key, req] of xfile.requiredModuleVars) {
        if (insertedKeys.has(key)) continue;
        if (consumerLocals.has(req.name)) continue;
        const cloned = cloneModuleVarForHoisting(req.moduleVar, req.name);
        if (!cloned) continue;
        toInsert.push(cloned);
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

function cloneModuleVarForHoisting(
    moduleVar: ModuleVar,
    name: string,
): t.VariableDeclaration | null {
    const matching = moduleVar.declaration.declarations.find(
        (d) => t.isIdentifier(d.id) && d.id.name === name,
    );
    if (!matching) return null;
    return t.variableDeclaration(moduleVar.declaration.kind, [
        t.cloneNode(matching, true, false),
    ]);
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

function stripFullyInlinedDecls(
    root: t.Node,
    candidates: Map<string, Candidate>,
    sites: Site[],
): void {
    void root;
    // Remove declarations that are decl-annotated and have at least one
    // successful site, and have no surviving identifier reads outside the
    // declaration itself. We approximate "no surviving reads" by re-scanning
    // the AST and counting identifier reads of each candidate name.
    const succeededByName = new Map<string, number>();
    for (const s of sites) {
        succeededByName.set(s.candidate.name, (succeededByName.get(s.candidate.name) ?? 0) + 1);
    }

    for (const [name, c] of candidates) {
        if (c.donor) continue;
        if (!c.declAnnotated) continue;
        if (!c.declRef) continue;
        if ((succeededByName.get(name) ?? 0) === 0) continue;
        // We don't currently re-scan for residual reads; conservatively do so.
        // (Cheap.) Skip strip if any identifier read of `name` remains.
        const anyResidual = anyResidualReference(c.declRef.parent, name, c.declRef.index);
        if (anyResidual) continue;
        c.declRef.parent.body.splice(c.declRef.index, 1);
        // Adjust later candidate indices in the same parent.
        for (const other of candidates.values()) {
            if (
                other.declRef &&
                other.declRef.parent === c.declRef.parent &&
                other.declRef.index > c.declRef.index
            ) {
                other.declRef.index--;
            }
        }
    }
}

function anyResidualReference(
    parent: t.BlockStatement | t.Program,
    name: string,
    skipIndex: number,
): boolean {
    let found = false;
    for (let i = 0; i < parent.body.length; i++) {
        if (i === skipIndex) continue;
        const stmt = parent.body[i];
        visit(stmt, (n, parentNode, key) => {
            if (found) return;
            if (
                t.isIdentifier(n) &&
                n.name === name &&
                !isWriteContext(n, parentNode, key)
            ) {
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

function visit(
    root: t.Node,
    fn: (n: t.Node, parent: t.Node | null, key: string, index?: number) => void,
): void {
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

function visitWithParents(
    root: t.Node,
    fn: (n: t.Node, parent: t.Node | null, key: string, index?: number) => void,
): void {
    visit(root, fn);
}
