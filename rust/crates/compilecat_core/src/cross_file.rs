//! Cross-module inlining (phase 2, TODO #3) — the differentiated value.
//!
//! The consumer imports an `@inline` donor (`import { add } from './math'`).
//! The JS plugin resolves + reads the donor modules and hands them here; this
//! driver inlines the imported calls and drops the now-unused imports. After
//! that, the normal whole-program pipeline (local inline, fold, cleanup) runs.
//!
//! Scope: DIRECT/BLOCK donors. Module-scope **declarations** the spliced body
//! needs (consts, helper fns/classes — transitively) are **copied** into the
//! consumer (copy-then-clean): the normal pipeline then folds literal consts and
//! drops dead copies. Shared-mutable module state copied this way splits across
//! consumers — a documented `@inline` limitation, not a special case here.
//! Deferred: donors whose body needs an **imported** dep (would need the import
//! re-resolved relative to the donor) — those are left un-inlined for now.
//!
//! Name collisions (α-rename, soundness): a needed donor dep whose name collides
//! with a *different* entity already in the consumer — a consumer-original
//! top-level binding, or a *different* donor's already-copied dep — would, if
//! copied verbatim, make the spliced body bind to the consumer's entity (a
//! MISCOMPILE: the consumer's value, not the donor's). On such a *true* collision
//! the dep is α-renamed to a fresh `<name>$cf<N>` (avoiding all consumer + hoisted
//! names) **consistently** across the cloned hoist decl, the cloned export body,
//! and any other cloned donor deps that reference it. The rename runs on CLONED
//! donor material only — the shared parse cache is never mutated. A re-copy of the
//! *same* donor's *same* dep is a legitimate dedupe (same entity) and reuses the
//! name established on first copy, not a rename. The rename is scope-accurate
//! (skips nested scopes that rebind the name as a param/local); a shape it can't
//! safely rename instead bails the export's inline (call + import preserved →
//! correct binding via the normal import — a missed optimization, never wrong).

use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::ast::*;
use oxc_ast::AstBuilder;
use oxc_ast_visit::{walk, walk_mut, Visit, VisitMut};
use oxc_codegen::{Codegen, CodegenOptions, CodegenReturn};
use oxc_span::{GetSpan, SourceType};

use crate::options::{Mode, Stats, TransformOptions, TransformOutput};
use crate::parse_program;
use crate::passes;
use crate::passes::inline_functions::{
    classify_block, classify_block_arrow, classify_direct, classify_direct_arrow, inline_with,
    top_level_function, BlockCandidate, Candidate,
};

/// A donor module the consumer imports from.
pub struct Donor {
    /// The specifier the consumer used to import it (`./math`).
    pub specifier: String,
    /// The donor's own resolved path — used to rebase the donor's *relative*
    /// imports when forwarding them into the consumer, and to match this module
    /// as a re-export target. Empty if unknown.
    pub path: String,
    pub code: String,
    /// Resolved `… from '<specifier>'` edges of *this* donor: each (specifier,
    /// path) lets the core follow a re-export (`export * as vec3 from './vec3'`)
    /// to the donor at that path without re-implementing module resolution.
    pub resolved: Vec<(String, String)>,
}

pub fn transform_cross_file(
    consumer: &str,
    donors: &[Donor],
    options: &TransformOptions,
    cache: &mut crate::ModuleCache,
) -> TransformOutput {
    let allocator = Allocator::default();
    let source_type = options.source_type();
    let mut program = parse_program(&allocator, consumer, source_type);

    // Phase 1: parse every donor once into the (persistent) cache, keyed by path.
    // The cache outlives this call, so its `&Program`s coerce to the per-call
    // arena lifetime; candidate bodies are `clone_in`'d out of them into
    // `allocator` at splice time.
    for d in donors {
        cache.get_or_parse(&d.path, &d.code, donor_source_type(d, source_type));
    }

    // local import name → (specifier, imported name); namespace local → specifier
    let imports = collect_named_imports(&program);
    let namespaces = collect_namespace_imports(&program);

    let mut reg = Registrar::new(&program);
    let consumer_path = &options.filename;

    // Named / default imports: `import { add }` / `import add` → key on the local
    // call name. Falls through to re-export following for barrel modules.
    for (local, specifier, imported) in &imports {
        let Some(donor) = donors.iter().find(|d| &d.specifier == specifier) else { continue };
        let donor_program = cache.get(&donor.path).expect("cached in phase 1").program();

        // (a/b) callable or object-namespace export of the directly-imported donor.
        if reg.register_named(
            donor_program,
            &donor.path,
            consumer_path,
            imported,
            local,
            &allocator,
        ) {
            continue;
        }

        // (c) namespace re-export: barrel has `export * as <imported> from S`
        // → treat `local` as a namespace of the target module's @inline exports.
        if let Some((target, target_program)) =
            resolve_namespace_reexport(donor_program, donor, donors, imported, cache)
        {
            reg.register_namespace(target_program, &target.path, consumer_path, local, &allocator);
            continue;
        }

        // (d) named re-export: barrel has `export { <name> as <imported> } from S`
        // → resolve to `name` in the target module.
        if let Some((target, target_program, name)) =
            resolve_named_reexport(donor_program, donor, donors, imported, cache)
        {
            reg.register_named(
                target_program,
                &target.path,
                consumer_path,
                &name,
                local,
                &allocator,
            );
            continue;
        }
    }

    // Namespace imports: `import * as vec3 from 'm'; vec3.add(…)`.
    for (ns_local, specifier) in &namespaces {
        let Some(donor) = donors.iter().find(|d| &d.specifier == specifier) else { continue };
        let donor_program = cache.get(&donor.path).expect("cached in phase 1").program();
        reg.register_namespace(donor_program, &donor.path, consumer_path, ns_local, &allocator);
    }

    let mut stats = Stats::default();
    // Cross-file `@inline` targets carry no directive of their own; record the
    // consumer functions that call a donor BEFORE inlining (the calls vanish
    // after) so the cleanup gate cleans their inlined residue.
    let mut inline_targets: std::collections::HashSet<u32> = std::collections::HashSet::new();
    // One inline-temp counter for the WHOLE chunk: cross-file donor inlining
    // (`inline_with`, `flatten_into_hosts`) then the local pipeline (`run_all_gated`
    // via `uid_base`) — so every generated temp name is unique across all of them.
    let mut uid = 0u32;
    if !reg.direct.is_empty() || !reg.block.is_empty() {
        let keys: std::collections::HashSet<String> =
            reg.direct.keys().chain(reg.block.keys()).cloned().collect();
        inline_targets = passes::inline_functions::functions_calling(&program, &keys);
        stats.inlined += inline_with(&allocator, &mut program, &reg.direct, &reg.block, &mut uid);
        remove_unused_imports(&allocator, &mut program, &reg.inlined_locals);
        prepend_imports(&allocator, &mut program, reg.forward);
        insert_after_imports(&allocator, &mut program, reg.hoist);
    }

    // Cross-file `@flatten`/`@optimize`: a host inlines its *imported* callees
    // (any callable, not just `@inline`) — the cross-module analogue of the local
    // flatten pass, and what `@optimize` hot-path functions need when their helpers
    // live in other modules. Reuses the same resolution (`register_export` +
    // dep forwarding) and application (`flatten_into_hosts`, host-scoped) as the
    // `@inline` and local-flatten paths.
    let flatten_spans = passes::inline_functions::collect_flatten_spans(&program);
    if !flatten_spans.is_empty() {
        let host_calls = call_names_in_hosts(&program, &flatten_spans);
        let mut freg = Registrar::new(&program);

        // (1) Named imports the host calls directly (`add(…)` from `import { add }`).
        for (local, specifier, imported) in &imports {
            // Skip names already inlined by the `@inline` pass, and imports the
            // hosts never call.
            if reg.inlined_locals.contains(local) || !host_calls.contains(local) {
                continue;
            }
            let Some(donor) = donors.iter().find(|d| &d.specifier == specifier) else { continue };
            let Some(parsed) = cache.get(&donor.path) else { continue };
            if let Some(export) = find_export(parsed.program(), imported, false) {
                if freg.register_export(
                    parsed.program(),
                    &donor.path,
                    consumer_path,
                    local.clone(),
                    &export,
                    &allocator,
                ) {
                    freg.inlined_locals.insert(local.clone());
                }
            }
        }

        // (2) Namespace-member calls (`vec3.add(…)`): resolve `vec3` to the module
        // whose exports are its members, then register each member the host calls.
        // `vec3` is either a direct `import * as vec3 from M`, or a barrel
        // re-export (`import { vec3 } from B` where B does `import * as vec3 from
        // M; export { vec3 }` — mathcat's shape). The library is never modified;
        // only the host's `@flatten`/`@optimize` calls drive the inlining.
        let mut ns_targets: Vec<(String, &Donor)> = Vec::new();
        for (ns_local, specifier) in &namespaces {
            if let Some(donor) = donors.iter().find(|d| &d.specifier == specifier) {
                ns_targets.push((ns_local.clone(), donor));
            }
        }
        for (local, specifier, imported) in &imports {
            let Some(barrel) = donors.iter().find(|d| &d.specifier == specifier) else { continue };
            let Some(parsed) = cache.get(&barrel.path) else { continue };
            if let Some(src) = reexported_namespace_source(parsed.program(), imported) {
                if let Some(target) = resolve_reexport_target(barrel, donors, &src) {
                    ns_targets.push((local.clone(), target));
                }
            }
        }
        for (ns_local, target) in ns_targets {
            if reg.inlined_locals.contains(&ns_local) {
                continue;
            }
            let Some(parsed) = cache.get(&target.path) else { continue };
            for export in find_all_inline_exports(parsed.program(), false) {
                let key = format!("{ns_local}.{}", export.name);
                if !host_calls.contains(&key) {
                    continue;
                }
                if freg.register_export(
                    parsed.program(),
                    &target.path,
                    consumer_path,
                    key,
                    &export,
                    &allocator,
                ) {
                    freg.inlined_locals.insert(ns_local.clone());
                }
            }
        }

        if !freg.direct.is_empty() || !freg.block.is_empty() {
            prepend_imports(&allocator, &mut program, freg.forward);
            insert_after_imports(&allocator, &mut program, freg.hoist);
            stats.inlined += passes::inline_functions::flatten_into_hosts(
                &allocator,
                &mut program,
                &flatten_spans,
                &freg.direct,
                &freg.block,
                &mut uid,
            );
            remove_unused_imports(&allocator, &mut program, &freg.inlined_locals);
        }
    }

    // Cross-module type resolution: resolve each imported type's shape (tuple
    // arity or record field set) from its donor module's AST (in the cache), so
    // type-aware SROA can fire on a `const v: Vec3 = …` where `Vec3` is imported.
    // Built before the pipeline so the oracle holds owned shapes, no borrow into
    // the donor programs.
    let sroa_external_shapes = collect_imported_type_shapes(&imports, donors, cache);

    // Normal whole-program pipeline: local inline, unroll, sroa, fold, cleanup…
    // `inline_targets` opts the (directive-free) cross-file `@inline` consumers
    // into the cleanup gate so their inlined residue is cleaned.
    passes::run_all_gated(
        &allocator,
        &mut program,
        Mode::WholeProgram,
        &mut stats,
        &sroa_external_shapes,
        &inline_targets,
        uid,
    );

    let codegen_options = CodegenOptions {
        source_map_path: options.sourcemap.then(|| std::path::PathBuf::from(&options.filename)),
        ..CodegenOptions::default()
    };
    let CodegenReturn { code, map, .. } =
        Codegen::new().with_options(codegen_options).build(&program);

    TransformOutput { code, map: map.map(|m| m.to_json_string()), stats }
}

/// Parse source type for a donor — prefer its real resolved `path` (correct
/// extension even behind an extensionless specifier), then the specifier, then
/// the consumer's type.
fn donor_source_type(donor: &Donor, fallback: SourceType) -> SourceType {
    SourceType::from_path(&donor.path)
        .or_else(|_| SourceType::from_path(&donor.specifier))
        .unwrap_or(fallback)
}

/// Accumulates inline candidates + the donor deps to copy/forward into the
/// consumer. Its methods resolve a donor export (callable, object namespace, or
/// re-export target) and register it; the `hoisted` set dedupes copied/forwarded
/// deps across every donor and export. Reused for the directly-imported donor and
/// for any re-export target module.
struct Registrar<'a> {
    direct: std::collections::HashMap<String, Candidate<'a>>,
    block: std::collections::HashMap<String, BlockCandidate<'a>>,
    inlined_locals: HashSet<String>,
    forward: Vec<Statement<'a>>,
    hoist: Vec<Statement<'a>>,
    /// Every top-level name now live in the consumer for collision detection:
    /// consumer-original bindings (frozen, seeded here) plus the *final* names of
    /// every dep copied so far. A needed donor dep whose name is in here but is a
    /// *different* entity (see `copied`) is a true collision → α-rename.
    hoisted: HashSet<String>,
    /// Consumer-original top-level binding names, kept separate from the growing
    /// `hoisted` set so a collision with one is always a true collision (never a
    /// legit same-donor dedupe).
    consumer_names: HashSet<String>,
    /// (donor_path, donor-original dep name) → the final name that dep was copied
    /// under (its own name, or an α-renamed `<name>$cf<N>`). A re-copy of the same
    /// donor's same dep reuses this name (legit dedupe); a *different* donor's dep
    /// of the same name does not match here, so it's a true collision.
    copied: HashMap<(String, String), String>,
    /// Monotonic counter for minting fresh `$cf<N>` names.
    rename_counter: u32,
}

impl<'a> Registrar<'a> {
    fn new(consumer: &Program<'a>) -> Self {
        let mut consumer_names = HashSet::new();
        for stmt in &consumer.body {
            collect_top_level_binding_names(stmt, &mut consumer_names);
        }
        Registrar {
            direct: std::collections::HashMap::new(),
            block: std::collections::HashMap::new(),
            inlined_locals: HashSet::new(),
            forward: Vec::new(),
            hoist: Vec::new(),
            hoisted: consumer_names.clone(),
            consumer_names,
            copied: HashMap::new(),
            rename_counter: 0,
        }
    }

    /// Classify one export under `key` (a plain or `obj.member` call key) and
    /// pull its module deps. Returns whether it inlined.
    ///
    /// Soundness: needed donor deps whose names *truly collide* with a different
    /// consumer / other-donor entity are α-renamed to fresh `$cf<N>` names,
    /// consistently across the cloned export body + the cloned deps (so the body
    /// binds to the donor's entity, not the consumer's same-named one). If a
    /// truly-colliding needed name is supplied by a donor *import* (which we can't
    /// safely rename here), the export's inline is bailed instead (returns false →
    /// the call + import are preserved → correct binding via the normal import).
    fn register_export(
        &mut self,
        program: &Program<'a>,
        donor_path: &str,
        consumer_path: &str,
        key: String,
        export: &DonorExport<'_, 'a>,
        allocator: &'a Allocator,
    ) -> bool {
        let needed = needed_module_names(program, export);

        // Resolve each needed name to a final consumer name, detecting true
        // collisions. `None` from here = a collision we can't resolve (an
        // import-supplied dep) → bail this export.
        let Some(rename) = self.plan_renames(program, donor_path, &needed) else {
            return false;
        };

        // Classify the export body. With renames, classify a *renamed clone* of
        // the donor callable so the spliced body references the fresh names; the
        // cache is never touched. Without renames, classify the borrowed donor
        // node directly (fast path).
        let (direct, block) = if rename.is_empty() {
            (export.callable.classify_direct(allocator), export.callable.classify_block(allocator))
        } else {
            let renamed = clone_and_rename_callable(&export.callable, &rename, allocator);
            (renamed.classify_direct(allocator), renamed.classify_block(allocator))
        };

        let registered = if let Some(c) = direct {
            self.direct.insert(key, c);
            true
        } else if let Some(c) = block {
            self.block.insert(key, c);
            true
        } else {
            false
        };
        if registered {
            pull_donor_deps(
                program,
                donor_path,
                consumer_path,
                &needed,
                &rename,
                allocator,
                &mut self.forward,
                &mut self.hoist,
                &mut self.hoisted,
                &mut self.copied,
            );
        }
        registered
    }

    /// Decide the final consumer name for each needed donor dep, detecting true
    /// name collisions. Returns `name → fresh-name` only for names that must be
    /// α-renamed (collision-free names map to themselves and are omitted), or
    /// `None` to signal a bail (a truly-colliding name supplied by a donor import,
    /// which can't be safely renamed in the cloned body alone).
    fn plan_renames(
        &mut self,
        program: &Program<'a>,
        donor_path: &str,
        needed: &HashSet<String>,
    ) -> Option<HashMap<String, String>> {
        let mut rename = HashMap::new();
        for n in needed {
            // Same donor's same dep already copied (possibly renamed) → reuse the
            // established name. A legit dedupe, never a collision.
            if let Some(final_name) = self.copied.get(&(donor_path.to_string(), n.clone())) {
                if final_name != n {
                    rename.insert(n.clone(), final_name.clone());
                }
                continue;
            }
            // Not yet copied from this donor. A true collision is a name already
            // live in the consumer (original binding or a *different* entity's
            // copied dep) — i.e. present in `hoisted` but not as this donor's `n`.
            let collides = self.hoisted.contains(n);
            if !collides {
                continue; // copy under its own name, no rename
            }
            // It's a true collision. We can only resolve it by copying a renamed
            // clone of the donor *decl* that supplies `n`. If `n` is supplied by a
            // donor import (no copyable decl), bail — renaming the body alone
            // would leave it unbound / mis-resolved.
            if !donor_decl_supplies(program, n) {
                return None;
            }
            let fresh = self.mint_fresh(n);
            rename.insert(n.clone(), fresh);
        }
        Some(rename)
    }

    /// A fresh `<base>$cf<N>` name that collides with no consumer-original name
    /// and no name copied so far. Reserves it in `hoisted` so later deps avoid it.
    fn mint_fresh(&mut self, base: &str) -> String {
        loop {
            self.rename_counter += 1;
            let candidate = format!("{base}$cf{}", self.rename_counter);
            if !self.hoisted.contains(&candidate) && !self.consumer_names.contains(&candidate) {
                return candidate;
            }
        }
    }

    /// Resolve `imported` as a callable (`import { add }`) or an object namespace
    /// (`import { vec3 }; vec3.add`) of `program`, registered under `local`.
    fn register_named(
        &mut self,
        program: &Program<'a>,
        donor_path: &str,
        consumer_path: &str,
        imported: &str,
        local: &str,
        allocator: &'a Allocator,
    ) -> bool {
        if let Some(export) = find_inline_export(program, imported) {
            if self.register_export(
                program,
                donor_path,
                consumer_path,
                local.to_string(),
                &export,
                allocator,
            ) {
                self.inlined_locals.insert(local.to_string());
                return true;
            }
        }
        let mut any = false;
        for (member, callable) in object_export_methods(program, imported) {
            let export = DonorExport { name: member.clone(), callable };
            let key = format!("{local}.{member}");
            if self.register_export(program, donor_path, consumer_path, key, &export, allocator) {
                any = true;
            }
        }
        if any {
            self.inlined_locals.insert(local.to_string());
        }
        any
    }

    /// Register every `@inline` export of `program` as a member of `ns_local`
    /// (`vec.add`). Returns whether any member inlined.
    fn register_namespace(
        &mut self,
        program: &Program<'a>,
        donor_path: &str,
        consumer_path: &str,
        ns_local: &str,
        allocator: &'a Allocator,
    ) -> bool {
        let mut any = false;
        for export in find_all_inline_exports(program, true) {
            let key = format!("{ns_local}.{}", export.name);
            if self.register_export(program, donor_path, consumer_path, key, &export, allocator) {
                any = true;
            }
        }
        if any {
            self.inlined_locals.insert(ns_local.to_string());
        }
        any
    }
}

/// `export * as <imported> from S` in the barrel → the re-export target donor +
/// its cached program (whose `@inline` exports become the consumer binding's
/// members).
fn resolve_namespace_reexport<'b, 'd, 'c>(
    barrel: &Program<'b>,
    barrel_donor: &Donor,
    donors: &'d [Donor],
    imported: &str,
    cache: &'c crate::ModuleCache,
) -> Option<(&'d Donor, &'c Program<'c>)> {
    for stmt in &barrel.body {
        let Statement::ExportAllDeclaration(e) = stmt else { continue };
        let Some(exported) = &e.exported else { continue }; // `export *` (no alias) deferred
        if exported.name().as_str() != imported {
            continue;
        }
        let target = resolve_reexport_target(barrel_donor, donors, e.source.value.as_str())?;
        return Some((target, cache.get(&target.path)?.program()));
    }
    None
}

/// `export { <name> as <imported> } from S` → (target donor, cached program, the
/// name to resolve in the target).
fn resolve_named_reexport<'b, 'd, 'c>(
    barrel: &Program<'b>,
    barrel_donor: &Donor,
    donors: &'d [Donor],
    imported: &str,
    cache: &'c crate::ModuleCache,
) -> Option<(&'d Donor, &'c Program<'c>, String)> {
    for stmt in &barrel.body {
        let Statement::ExportNamedDeclaration(e) = stmt else { continue };
        let Some(source) = &e.source else { continue };
        for spec in &e.specifiers {
            if spec.exported.name().as_str() != imported {
                continue;
            }
            let target = resolve_reexport_target(barrel_donor, donors, source.value.as_str())?;
            return Some((
                target,
                cache.get(&target.path)?.program(),
                spec.local.name().to_string(),
            ));
        }
    }
    None
}

/// A barrel that re-exports a whole namespace object it imported:
/// `import * as <ns> from S; export { <ns> as <imported> }` (a *sourceless*
/// export clause over a namespace local). Returns the namespace import source
/// `S` — the module whose exports are the object's members. Distinct from
/// `export * as x from S` / `export { x } from S` (those carry their own source
/// and are followed by `resolve_namespace_reexport` / `resolve_named_reexport`).
fn reexported_namespace_source(barrel: &Program, imported: &str) -> Option<String> {
    // exported name `imported` → its local binding name in the barrel
    let mut local = None;
    for stmt in &barrel.body {
        let Statement::ExportNamedDeclaration(e) = stmt else { continue };
        if e.source.is_some() {
            continue; // a sourced clause is a direct cross-module re-export
        }
        for spec in &e.specifiers {
            if spec.exported.name().as_str() == imported {
                local = Some(spec.local.name().to_string());
            }
        }
    }
    let local = local?;
    // that local must be a namespace import: `import * as <local> from S`
    for stmt in &barrel.body {
        let Statement::ImportDeclaration(imp) = stmt else { continue };
        let Some(specs) = &imp.specifiers else { continue };
        for s in specs {
            if let ImportDeclarationSpecifier::ImportNamespaceSpecifier(n) = s {
                if n.local.name.as_str() == local {
                    return Some(imp.source.value.to_string());
                }
            }
        }
    }
    None
}

/// The donor a re-export `from '<specifier>'` points at, via the barrel's
/// plugin-provided resolution map (exact resolved-path match — the core never
/// re-implements module resolution).
fn resolve_reexport_target<'d>(
    barrel_donor: &Donor,
    donors: &'d [Donor],
    specifier: &str,
) -> Option<&'d Donor> {
    let path = barrel_donor
        .resolved
        .iter()
        .find(|(s, _)| s.as_str() == specifier)
        .map(|(_, p)| p.as_str())?;
    donors.iter().find(|d| d.path.as_str() == path)
}

/// `import { x }` / `import { x as y }` → (local, specifier, imported); a
/// default import (`import x from`) is folded in as imported = `"default"`, so
/// the donor side resolves it through the same path.
/// Call keys (`fn` or `obj.member`) used inside the bodies of `@flatten`/
/// `@optimize` hosts — the candidate set cross-file flatten resolves (so we only
/// pull in imports the hosts actually call).
fn call_names_in_hosts(program: &Program, flatten_spans: &HashSet<u32>) -> HashSet<String> {
    struct V {
        names: HashSet<String>,
    }
    impl<'a> Visit<'a> for V {
        fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
            match &call.callee {
                Expression::Identifier(id) => {
                    self.names.insert(id.name.to_string());
                }
                Expression::StaticMemberExpression(m) => {
                    if let Expression::Identifier(obj) = &m.object {
                        self.names.insert(format!("{}.{}", obj.name, m.property.name));
                    }
                }
                _ => {}
            }
            walk::walk_call_expression(self, call);
        }
    }
    let mut v = V { names: HashSet::new() };
    for stmt in &program.body {
        if flatten_spans.contains(&stmt.span().start) {
            v.visit_statement(stmt);
        }
    }
    v.names
}

fn collect_named_imports(program: &Program) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for stmt in &program.body {
        let Statement::ImportDeclaration(imp) = stmt else { continue };
        let specifier = imp.source.value.to_string();
        let Some(specs) = &imp.specifiers else { continue };
        for s in specs {
            match s {
                ImportDeclarationSpecifier::ImportSpecifier(named) => {
                    out.push((
                        named.local.name.to_string(),
                        specifier.clone(),
                        named.imported.name().to_string(),
                    ));
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(def) => {
                    out.push((
                        def.local.name.to_string(),
                        specifier.clone(),
                        "default".to_string(),
                    ));
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {} // handled separately
            }
        }
    }
    out
}

/// Resolve the shape (tuple arity or record field set) of each imported type
/// from its donor module, keyed by the consumer's local name — the seed for
/// cross-module type-aware SROA. For `import { Vec3 } from './math'` where
/// `./math` has `export type Vec3 = [number, number, number]` (or `export
/// interface Vec3 { x; y; z }`), yields the resolved `Shape`. Reuses the SROA
/// oracle's `build_alias_shapes` over the donor program (so donor-local alias /
/// interface chains resolve). The same `imports` list drives inlining; type
/// names that aren't scalarizable shapes simply don't resolve here.
///
/// Deferred: a type re-exported through a barrel (`export type { Vec3 } from …`)
/// — the donor that declares it isn't the directly-imported module, so its
/// alias map won't carry the name. Direct imports + donor-local chains only.
fn collect_imported_type_shapes(
    imports: &[(String, String, String)],
    donors: &[Donor],
    cache: &crate::ModuleCache,
) -> HashMap<String, crate::analysis::type_shape::Shape> {
    let mut out = HashMap::new();
    for (local, specifier, imported) in imports {
        // Try every donor sharing this specifier, taking the first that yields a shape.
        // The plugin emits `[...runtime, ...typeSource]`, so a runtime `.js` (types
        // stripped → resolves nothing) is tried before the `.d.ts` that declares the
        // alias. Safe because a stripped `.js` never resolves a type; a future donor
        // that is a real `.ts` declaring a same-named-but-different type would make this
        // order load-bearing — keep type-source donors last.
        for donor in donors.iter().filter(|d| &d.specifier == specifier) {
            let mut visited = HashSet::new();
            if let Some(shape) = resolve_type_alias_shape(imported, donor, donors, cache, 0, &mut visited) {
                out.insert(local.clone(), shape);
                break;
            }
        }
    }
    out
}

/// Cycle/blow-up guard for type re-export following (belt-and-suspenders alongside
/// the `visited` set, which already bounds traversal to O(donors × names)).
const MAX_TYPE_REEXPORT_DEPTH: usize = 32;

/// Resolve an imported type alias `imported` to its `Shape`, starting at `donor`
/// and following re-exports across the donor graph — the shape a package's public
/// type surface actually has: types declared in one `.d.ts`, re-exported through a
/// barrel entry (`mathcat`'s `dist/index.d.ts` does `export * from './types.js'`).
///
/// Three sources, in order: (1) an alias declared locally in this module; (2) a
/// named re-export `export { X as imported } from S`; (3) a bare wildcard
/// `export * from S` (which the value/@inline path defers, but a flat type name
/// must be followed through).
///
/// `visited` memoises `(donor, name)` pairs: a densely cross-re-exporting `.d.ts`
/// graph would otherwise re-expand shared nodes exponentially (fanout^depth). Keyed
/// by name too so a donor legitimately reached to resolve a *different* re-exported
/// name is not spuriously skipped. NB: donor modules are parsed by their path
/// extension, so the type-source donor must carry a TS/`.d.ts` path or its
/// `export type`s are dropped as JS.
fn resolve_type_alias_shape(
    imported: &str,
    donor: &Donor,
    donors: &[Donor],
    cache: &crate::ModuleCache,
    depth: usize,
    visited: &mut HashSet<String>,
) -> Option<crate::analysis::type_shape::Shape> {
    if depth > MAX_TYPE_REEXPORT_DEPTH {
        return None;
    }
    // (donor, name) already explored on this resolution → its contribution is
    // deterministic, so re-visiting can only re-find (propagated already) or re-fail.
    if !visited.insert(format!("{}\u{0}{}", donor.path, imported)) {
        return None;
    }
    let parsed = cache.get(&donor.path)?;
    let program = parsed.program();

    // (1) declared locally in this module.
    if let Some(shape) = crate::analysis::type_shape::build_alias_shapes(program).get(imported) {
        return Some(shape.clone());
    }

    // (2) `export { <local> as imported } from S` (incl. `export type { … } from S`).
    if let Some((target, _target_program, local)) =
        resolve_named_reexport(program, donor, donors, imported, cache)
    {
        if let Some(shape) = resolve_type_alias_shape(&local, target, donors, cache, depth + 1, visited) {
            return Some(shape);
        }
    }

    // (3) bare wildcard `export * from S` — flattens S's exports into this module.
    for stmt in &program.body {
        let Statement::ExportAllDeclaration(e) = stmt else { continue };
        if e.exported.is_some() {
            continue; // `export * as ns from S` — a namespace binding, not a flat alias
        }
        let Some(target) = resolve_reexport_target(donor, donors, e.source.value.as_str()) else {
            continue;
        };
        if let Some(shape) = resolve_type_alias_shape(imported, target, donors, cache, depth + 1, visited) {
            return Some(shape);
        }
    }

    None
}

/// Token starts that carry a leading `@inline` comment. The comment attaches to
/// the following token — the fn span for a bare decl, the `export` span for an
/// exported one — so both are checked when matching.
fn donor_inline_spans(donor: &Program) -> HashSet<u32> {
    crate::passes::directives::annotated_spans(donor, &["@inline"])
}

/// An inlinable callable donor export — a `function` declaration / expression or
/// an arrow, however it was written (`export function add`, `export const add =
/// (a,b) => …`). Abstracts the AST shape so discovery, dependency analysis, and
/// classification are uniform. `Copy` (just a reference) so one callable can be
/// surfaced under several exported names.
#[derive(Clone, Copy)]
enum Callable<'b, 'a> {
    Func(&'b Function<'a>),
    Arrow(&'b ArrowFunctionExpression<'a>),
}

impl<'b, 'a> Callable<'b, 'a> {
    fn body_statements(&self) -> &'b [Statement<'a>] {
        match self {
            Callable::Func(f) => f.body.as_deref().map(|b| b.statements.as_slice()).unwrap_or(&[]),
            Callable::Arrow(a) => a.body.statements.as_slice(),
        }
    }
    fn param_names(&self) -> Vec<String> {
        let items = match self {
            Callable::Func(f) => &f.params.items,
            Callable::Arrow(a) => &a.params.items,
        };
        items
            .iter()
            .filter_map(|p| match &p.pattern {
                BindingPattern::BindingIdentifier(id) => Some(id.name.to_string()),
                _ => None,
            })
            .collect()
    }
    fn classify_direct(&self, allocator: &'a Allocator) -> Option<Candidate<'a>> {
        match self {
            Callable::Func(f) => classify_direct(f, allocator),
            Callable::Arrow(a) => classify_direct_arrow(a, allocator),
        }
    }
    fn classify_block(&self, allocator: &'a Allocator) -> Option<BlockCandidate<'a>> {
        match self {
            Callable::Func(f) => classify_block(f, allocator),
            Callable::Arrow(a) => classify_block_arrow(a, allocator),
        }
    }
}

/// A named `@inline` export of a donor module.
struct DonorExport<'b, 'a> {
    name: String,
    callable: Callable<'b, 'a>,
}

/// An arrow / function-expression initializer becomes a `Callable`.
fn callable_of_init<'b, 'a>(init: &'b Expression<'a>) -> Option<Callable<'b, 'a>> {
    match init {
        Expression::ArrowFunctionExpression(a) => Some(Callable::Arrow(a)),
        Expression::FunctionExpression(f) => Some(Callable::Func(f)),
        _ => None,
    }
}

/// Collect the `@inline` callables a statement *declares*, keyed by their local
/// binding name: a top-level `function`, or `const NAME = <arrow|function-expr>`
/// (bare or exported). The export surface (which local is visible under which
/// exported name) is resolved separately in `find_all_inline_exports`.
fn inline_exports_of<'b, 'a>(
    stmt: &'b Statement<'a>,
    inline_spans: &HashSet<u32>,
    require_inline: bool,
    out: &mut Vec<DonorExport<'b, 'a>>,
) {
    // `@inline` attaches to the statement (`export`/`const`/`function`) start, or
    // to the bare function span. For flatten (`require_inline = false`) every
    // callable counts — the host inlines all its callees, not just `@inline` ones.
    let annotated = !require_inline || inline_spans.contains(&stmt.span().start);
    if let Some(f) = top_level_function(stmt) {
        if annotated || inline_spans.contains(&f.span.start) {
            if let Some(id) = &f.id {
                out.push(DonorExport { name: id.name.to_string(), callable: Callable::Func(f) });
            }
        }
        return;
    }
    if !annotated {
        return;
    }
    let var_decl = match stmt {
        Statement::VariableDeclaration(v) => Some(v.as_ref()),
        Statement::ExportNamedDeclaration(e) => match &e.declaration {
            Some(Declaration::VariableDeclaration(v)) => Some(v.as_ref()),
            _ => None,
        },
        _ => None,
    };
    if let Some(v) = var_decl {
        for d in &v.declarations {
            let BindingPattern::BindingIdentifier(id) = &d.id else { continue };
            let Some(init) = &d.init else { continue };
            if let Some(callable) = callable_of_init(init) {
                out.push(DonorExport { name: id.name.to_string(), callable });
            }
        }
    }
}

/// A named (bare or exported) `@inline` callable export of the donor.
fn find_inline_export<'b, 'a>(donor: &'b Program<'a>, name: &str) -> Option<DonorExport<'b, 'a>> {
    find_export(donor, name, true)
}

/// A named (bare or exported) callable export of the donor. `require_inline`
/// gates on `@inline` (for `@inline` cross-file inlining); `false` matches any
/// callable (for cross-file `@flatten`/`@optimize`, where the host inlines all
/// its callees).
fn find_export<'b, 'a>(
    donor: &'b Program<'a>,
    name: &str,
    require_inline: bool,
) -> Option<DonorExport<'b, 'a>> {
    find_all_inline_exports(donor, require_inline).into_iter().find(|e| e.name == name)
}

/// All `@inline` callables the donor actually *exports*, each under the name a
/// consumer sees — every method a namespace import (`import * as vec3`) might
/// call. Resolves the export surface: `export function add` (own name),
/// `export { add as plus }` clauses (renamed), but not bare un-exported helpers
/// (those reach the consumer only as copied deps, never as importable names).
fn find_all_inline_exports<'b, 'a>(
    donor: &'b Program<'a>,
    require_inline: bool,
) -> Vec<DonorExport<'b, 'a>> {
    let inline_spans = if require_inline { donor_inline_spans(donor) } else { HashSet::new() };

    // local binding name → callable (every `@inline` callable, or every callable
    // when `require_inline` is false — the flatten case).
    let mut callables: std::collections::HashMap<String, Callable<'b, 'a>> =
        std::collections::HashMap::new();
    for stmt in &donor.body {
        let mut decls = Vec::new();
        inline_exports_of(stmt, &inline_spans, require_inline, &mut decls);
        for d in decls {
            callables.insert(d.name, d.callable);
        }
    }

    let mut out = Vec::new();
    for stmt in &donor.body {
        match stmt {
            Statement::ExportNamedDeclaration(e) if e.declaration.is_some() => {
                // `export function add` / `export const add = …` → own name.
                let mut names = HashSet::new();
                collect_top_level_binding_names(stmt, &mut names);
                for local in names {
                    if let Some(c) = callables.get(&local) {
                        out.push(DonorExport { name: local, callable: *c });
                    }
                }
            }
            Statement::ExportNamedDeclaration(e) if e.source.is_none() => {
                // `export { add as plus }` (a local re-export clause). A clause
                // with a `source` is a cross-module re-export — deferred (task 7).
                for spec in &e.specifiers {
                    let local = spec.local.name().to_string();
                    if let Some(c) = callables.get(&local) {
                        out.push(DonorExport {
                            name: spec.exported.name().to_string(),
                            callable: *c,
                        });
                    }
                }
            }
            Statement::ExportDefaultDeclaration(e)
                if !require_inline || inline_spans.contains(&stmt.span().start) =>
            {
                // `export default function/arrow/<ident>` → name `"default"`.
                if let Some(c) = default_callable(&e.declaration, &callables) {
                    out.push(DonorExport { name: "default".to_string(), callable: c });
                }
            }
            _ => {}
        }
    }
    out
}

/// The callable behind a `export default …`: a function/arrow/function-expr, or
/// `export default x` indirection resolved against the donor's @inline bindings.
fn default_callable<'b, 'a>(
    kind: &'b ExportDefaultDeclarationKind<'a>,
    callables: &std::collections::HashMap<String, Callable<'b, 'a>>,
) -> Option<Callable<'b, 'a>> {
    match kind {
        ExportDefaultDeclarationKind::FunctionDeclaration(f) => Some(Callable::Func(f)),
        ExportDefaultDeclarationKind::FunctionExpression(f) => Some(Callable::Func(f)),
        ExportDefaultDeclarationKind::ArrowFunctionExpression(a) => Some(Callable::Arrow(a)),
        ExportDefaultDeclarationKind::Identifier(id) => callables.get(id.name.as_str()).copied(),
        _ => None,
    }
}

/// Exported name → local binding name across the donor's export surface
/// (`export const vec3` → vec3→vec3; `export { v as vec3 }` → vec3→v). Used to
/// locate an object-namespace export by the name a consumer imports.
fn export_name_to_local(donor: &Program) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for stmt in &donor.body {
        let Statement::ExportNamedDeclaration(e) = stmt else { continue };
        if e.declaration.is_some() {
            let mut names = HashSet::new();
            collect_top_level_binding_names(stmt, &mut names);
            for n in names {
                out.insert(n.clone(), n);
            }
        } else if e.source.is_none() {
            for spec in &e.specifiers {
                out.insert(spec.exported.name().to_string(), spec.local.name().to_string());
            }
        }
    }
    out
}

/// The `@inline` methods/function-properties of an object-namespace export
/// (`export const vec3 = { /* @inline */ add(a,b){…}, … }`), as (memberName,
/// callable). A `@inline` on the whole `export const` annotates every member.
fn object_export_methods<'b, 'a>(
    donor: &'b Program<'a>,
    exported_name: &str,
) -> Vec<(String, Callable<'b, 'a>)> {
    let inline_spans = donor_inline_spans(donor);

    // `export default { … }` — the object is in the default declaration, not a
    // named const binding.
    if exported_name == "default" {
        for stmt in &donor.body {
            let Statement::ExportDefaultDeclaration(e) = stmt else { continue };
            if let ExportDefaultDeclarationKind::ObjectExpression(obj) = &e.declaration {
                let whole = inline_spans.contains(&stmt.span().start);
                return extract_object_methods(obj, whole, &inline_spans);
            }
        }
        return Vec::new();
    }

    let locals = export_name_to_local(donor);
    let Some(local) = locals.get(exported_name) else { return Vec::new() };

    for stmt in &donor.body {
        let var = match stmt {
            Statement::VariableDeclaration(v) => Some(v.as_ref()),
            Statement::ExportNamedDeclaration(e) => match &e.declaration {
                Some(Declaration::VariableDeclaration(v)) => Some(v.as_ref()),
                _ => None,
            },
            _ => None,
        };
        let Some(v) = var else { continue };
        for d in &v.declarations {
            let BindingPattern::BindingIdentifier(id) = &d.id else { continue };
            if id.name.as_str() != local {
                continue;
            }
            let Some(Expression::ObjectExpression(obj)) = &d.init else { continue };
            let whole = inline_spans.contains(&stmt.span().start);
            return extract_object_methods(obj, whole, &inline_spans);
        }
    }
    Vec::new()
}

fn extract_object_methods<'b, 'a>(
    obj: &'b ObjectExpression<'a>,
    whole: bool,
    inline_spans: &HashSet<u32>,
) -> Vec<(String, Callable<'b, 'a>)> {
    let mut out = Vec::new();
    for p in &obj.properties {
        let ObjectPropertyKind::ObjectProperty(prop) = p else { continue };
        let name = match &prop.key {
            PropertyKey::StaticIdentifier(id) => id.name.to_string(),
            PropertyKey::StringLiteral(s) => s.value.to_string(),
            _ => continue,
        };
        if !(whole || inline_spans.contains(&prop.span.start)) {
            continue;
        }
        if let Some(callable) = callable_of_init(&prop.value) {
            out.push((name, callable));
        }
    }
    out
}

/// `import * as ns from 'm'` → (ns, specifier).
fn collect_namespace_imports(program: &Program) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for stmt in &program.body {
        let Statement::ImportDeclaration(imp) = stmt else { continue };
        let specifier = imp.source.value.to_string();
        let Some(specs) = &imp.specifiers else { continue };
        for s in specs {
            if let ImportDeclarationSpecifier::ImportNamespaceSpecifier(n) = s {
                out.push((n.local.name.to_string(), specifier.clone()));
            }
        }
    }
    out
}

/// Forward the donor imports + copy the donor decls that a needed-set requires
/// into the consumer accumulators. Shared by named and namespace inlining; the
/// `hoisted` set dedupes across donors and functions.
#[allow(clippy::too_many_arguments)]
fn pull_donor_deps<'a>(
    donor_program: &Program<'a>,
    donor_path: &str,
    consumer_path: &str,
    needed: &HashSet<String>,
    rename: &HashMap<String, String>,
    allocator: &'a Allocator,
    forward: &mut Vec<Statement<'a>>,
    hoist: &mut Vec<Statement<'a>>,
    hoisted: &mut HashSet<String>,
    copied: &mut HashMap<(String, String), String>,
) {
    // Forward needed donor imports, rebasing relative specifiers to the consumer.
    // (A truly-colliding import dep is bailed earlier in `plan_renames`, so any
    // import that reaches here is collision-free and forwarded under its own name.)
    for stmt in &donor_program.body {
        let Statement::ImportDeclaration(imp) = stmt else { continue };
        let rebased = rebase_specifier(&imp.source.value, donor_path, consumer_path);
        if let Some(fwd) = forward_import(imp, needed, &rebased, allocator, hoisted) {
            forward.push(fwd);
        }
    }
    // Copy needed donor decls (donor source order preserves dependency order).
    for stmt in &donor_program.body {
        let mut names = HashSet::new();
        collect_top_level_binding_names(stmt, &mut names);
        if names.is_empty() || names.is_disjoint(needed) {
            continue;
        }
        // Already copied? Only skip when *every* name this decl binds was already
        // copied from THIS donor (a legit dedupe of the same entity). A name
        // present in `hoisted` but not in `copied` for this donor was a true
        // collision — it gets a fresh name via `rename`, so we still copy here.
        let all_dedup = names.iter().all(|n| {
            copied.contains_key(&(donor_path.to_string(), n.clone())) || !needed.contains(n)
        });
        if all_dedup {
            continue; // this donor's contribution already present
        }
        if let Some(h) = hoist_decl_renamed(stmt, rename, allocator) {
            for n in &names {
                let final_name = rename.get(n).cloned().unwrap_or_else(|| n.clone());
                hoisted.insert(final_name.clone());
                copied.insert((donor_path.to_string(), n.clone()), final_name);
            }
            hoist.push(h);
        }
    }
}

/// Clone a donor decl for hoisting (unwrapping any `export`), then α-rename every
/// name in `rename` consistently inside the clone — its own binding ids and every
/// internal reference (skipping nested scopes that rebind the name). Operates on
/// the clone only; the donor program is never mutated.
fn hoist_decl_renamed<'a>(
    stmt: &Statement<'a>,
    rename: &HashMap<String, String>,
    allocator: &'a Allocator,
) -> Option<Statement<'a>> {
    let mut cloned = hoist_decl(stmt, allocator)?;
    if !rename.is_empty() {
        apply_renames_stmt(&mut cloned, rename, allocator);
    }
    Some(cloned)
}

/// Does a hoistable (non-import) donor decl bind `name`? Used to decide whether a
/// truly-colliding needed name can be α-renamed (it can only be renamed if we copy
/// the decl that supplies it; an import-supplied name is bailed instead).
fn donor_decl_supplies(donor: &Program, name: &str) -> bool {
    for stmt in &donor.body {
        if matches!(stmt, Statement::ImportDeclaration(_)) {
            continue;
        }
        let mut names = HashSet::new();
        collect_top_level_binding_names(stmt, &mut names);
        if names.contains(name) && hoist_decl_kind(stmt) {
            return true;
        }
    }
    false
}

/// Whether `hoist_decl` would copy this statement (a hoistable module-scope decl).
fn hoist_decl_kind(stmt: &Statement) -> bool {
    match stmt {
        Statement::VariableDeclaration(_)
        | Statement::FunctionDeclaration(_)
        | Statement::ClassDeclaration(_)
        | Statement::TSTypeAliasDeclaration(_)
        | Statement::TSInterfaceDeclaration(_)
        | Statement::TSEnumDeclaration(_) => true,
        Statement::ExportNamedDeclaration(e) => e.declaration.is_some(),
        _ => false,
    }
}

/// Clone the donor callable into the arena, α-rename `rename` consistently inside
/// the clone, and return a `Callable` over the clone (the donor cache is never
/// touched). The clone is arena-allocated so its `&'a` reference outlives the call.
fn clone_and_rename_callable<'b, 'a>(
    callable: &Callable<'b, 'a>,
    rename: &HashMap<String, String>,
    allocator: &'a Allocator,
) -> Callable<'a, 'a> {
    match callable {
        Callable::Func(f) => {
            let mut cloned = (*f).clone_in(allocator);
            apply_renames_function(&mut cloned, rename, allocator);
            Callable::Func(allocator.alloc(cloned))
        }
        Callable::Arrow(a) => {
            let mut cloned = (*a).clone_in(allocator);
            apply_renames_arrow(&mut cloned, rename, allocator);
            Callable::Arrow(allocator.alloc(cloned))
        }
    }
}

/// Scope-aware α-rename of every name in `rename` inside a (cloned) statement.
fn apply_renames_stmt<'a>(
    stmt: &mut Statement<'a>,
    rename: &HashMap<String, String>,
    allocator: &'a Allocator,
) {
    for (from, to) in rename {
        let to_a: &'a str = allocator.alloc_str(to);
        let mut r = CfRename { from, to: to_a };
        r.visit_statement(stmt);
    }
}

fn apply_renames_function<'a>(
    func: &mut Function<'a>,
    rename: &HashMap<String, String>,
    allocator: &'a Allocator,
) {
    for (from, to) in rename {
        let to_a: &'a str = allocator.alloc_str(to);
        // A param/local of the donor fn that shadows `from` blocks the rename of
        // its body — `CfRename` guards that. The fn's own name never matches a
        // needed dep (a dep is referenced by, not equal to, the export).
        let mut r = CfRename { from, to: to_a };
        r.visit_function(func, oxc_semantic::ScopeFlags::empty());
    }
}

fn apply_renames_arrow<'a>(
    arrow: &mut ArrowFunctionExpression<'a>,
    rename: &HashMap<String, String>,
    allocator: &'a Allocator,
) {
    for (from, to) in rename {
        let to_a: &'a str = allocator.alloc_str(to);
        let mut r = CfRename { from, to: to_a };
        r.visit_arrow_function_expression(arrow);
    }
}

/// Scope-aware renamer over CLONED donor material: rewrites every free occurrence
/// of `from` (binding ids and references) to `to`, but does not descend into
/// nested scopes that rebind `from` as a param or local (those shadow the
/// module-scope name we're renaming). Mirrors `block_flatten`'s `ScopeRename`.
struct CfRename<'s, 'a> {
    from: &'s str,
    to: &'a str,
}

impl<'a> VisitMut<'a> for CfRename<'_, 'a> {
    fn visit_function(&mut self, func: &mut Function<'a>, flags: oxc_semantic::ScopeFlags) {
        if !function_binds(func, self.from) {
            walk_mut::walk_function(self, func, flags);
        }
    }

    fn visit_arrow_function_expression(&mut self, arrow: &mut ArrowFunctionExpression<'a>) {
        let shadows = params_bind(&arrow.params, self.from)
            || stmts_bind(&arrow.body.statements, self.from);
        if !shadows {
            walk_mut::walk_arrow_function_expression(self, arrow);
        }
    }

    fn visit_binding_identifier(&mut self, id: &mut BindingIdentifier<'a>) {
        if id.name == self.from {
            id.name = self.to.into();
        }
    }

    fn visit_identifier_reference(&mut self, id: &mut IdentifierReference<'a>) {
        if id.name == self.from {
            id.name = self.to.into();
        }
    }

    fn visit_block_statement(&mut self, block: &mut BlockStatement<'a>) {
        if !stmts_bind(&block.body, self.from) {
            walk_mut::walk_block_statement(self, block);
        }
    }

    fn visit_catch_clause(&mut self, node: &mut CatchClause<'a>) {
        let shadows = node.param.as_ref().is_some_and(|p| pattern_binds(&p.pattern, self.from));
        if !shadows {
            walk_mut::walk_catch_clause(self, node);
        }
    }
}

/// Does this function bind `name` (a param, or any declaration in its body without
/// crossing into a further nested function)? Such a function shadows the captured
/// module-scope name, so the renamer must not descend into it.
fn function_binds(func: &Function, name: &str) -> bool {
    params_bind(&func.params, name)
        || func.body.as_ref().is_some_and(|b| stmts_bind(&b.statements, name))
}

fn params_bind(params: &FormalParameters, name: &str) -> bool {
    params.items.iter().any(|p| pattern_binds(&p.pattern, name))
        || params.rest.as_ref().is_some_and(|r| pattern_binds(&r.rest.argument, name))
}

/// Any declaration of `name` (var/let/const/function/class/param) anywhere in
/// `stmts` without crossing into a nested function. Conservative shadow check.
fn stmts_bind(stmts: &[Statement], name: &str) -> bool {
    struct V<'n> {
        name: &'n str,
        found: bool,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_function(&mut self, _f: &Function<'a>, _: oxc_semantic::ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {}
        fn visit_binding_identifier(&mut self, id: &BindingIdentifier<'a>) {
            if id.name == self.name {
                self.found = true;
            }
        }
    }
    let mut v = V { name, found: false };
    for s in stmts {
        v.visit_statement(s);
    }
    v.found
}

fn pattern_binds(pattern: &BindingPattern, name: &str) -> bool {
    let mut names = Vec::new();
    collect_binding_pattern_names(pattern, &mut names);
    names.iter().any(|n| n == name)
}

fn collect_binding_pattern_names(pattern: &BindingPattern, out: &mut Vec<String>) {
    match pattern {
        BindingPattern::BindingIdentifier(id) => out.push(id.name.to_string()),
        BindingPattern::ObjectPattern(o) => {
            for p in &o.properties {
                collect_binding_pattern_names(&p.value, out);
            }
            if let Some(rest) = &o.rest {
                collect_binding_pattern_names(&rest.argument, out);
            }
        }
        BindingPattern::ArrayPattern(a) => {
            for el in a.elements.iter().flatten() {
                collect_binding_pattern_names(el, out);
            }
            if let Some(rest) = &a.rest {
                collect_binding_pattern_names(&rest.argument, out);
            }
        }
        BindingPattern::AssignmentPattern(a) => {
            collect_binding_pattern_names(&a.left, out);
        }
    }
}

/// Identifier references (uses, not bindings) reachable from a node.
#[derive(Default)]
struct RefCollector {
    refs: HashSet<String>,
}
impl<'a> Visit<'a> for RefCollector {
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        self.refs.insert(id.name.to_string());
    }
}

/// Donor module-scope names the export's body needs — transitively (a needed
/// const may reference another const / helper fn). Params, the export's own
/// name (recursion), and plain globals are excluded.
fn needed_module_names(donor: &Program, export: &DonorExport) -> HashSet<String> {
    let mut module_names: HashSet<String> = HashSet::new();
    for stmt in &donor.body {
        collect_top_level_binding_names(stmt, &mut module_names);
    }
    let params: HashSet<String> = export.callable.param_names().into_iter().collect();
    let self_name = Some(export.name.clone());

    let mut body_refs = RefCollector::default();
    for s in export.callable.body_statements() {
        body_refs.visit_statement(s);
    }

    let mut needed: HashSet<String> = HashSet::new();
    let mut work: Vec<String> = body_refs
        .refs
        .into_iter()
        .filter(|r| {
            module_names.contains(r) && !params.contains(r) && Some(r) != self_name.as_ref()
        })
        .collect();
    while let Some(n) = work.pop() {
        if !needed.insert(n.clone()) {
            continue;
        }
        // Pull in module names referenced by whatever declares `n`.
        for stmt in &donor.body {
            let mut names = HashSet::new();
            collect_top_level_binding_names(stmt, &mut names);
            if !names.contains(&n) {
                continue;
            }
            let mut decl_refs = RefCollector::default();
            decl_refs.visit_statement(stmt);
            for r in decl_refs.refs {
                if module_names.contains(&r) && !needed.contains(&r) {
                    work.push(r);
                }
            }
        }
    }
    needed
}

/// The local name a single import specifier binds.
fn import_spec_local<'a>(s: &'a ImportDeclarationSpecifier) -> &'a str {
    match s {
        ImportDeclarationSpecifier::ImportSpecifier(n) => n.local.name.as_str(),
        ImportDeclarationSpecifier::ImportDefaultSpecifier(n) => n.local.name.as_str(),
        ImportDeclarationSpecifier::ImportNamespaceSpecifier(n) => n.local.name.as_str(),
    }
}

/// Forward a donor import into the consumer, keeping only the specifiers the
/// body needs (and not already bound in the consumer), with the source rewritten
/// to `rebased`. Returns `None` if nothing from this import is needed.
fn forward_import<'a>(
    imp: &ImportDeclaration<'a>,
    needed: &HashSet<String>,
    rebased: &str,
    allocator: &'a Allocator,
    bound: &mut HashSet<String>,
) -> Option<Statement<'a>> {
    let specs = imp.specifiers.as_ref()?;
    let ast = AstBuilder::new(allocator);
    let mut kept = ast.vec();
    for s in specs {
        let local = import_spec_local(s);
        if needed.contains(local) && !bound.contains(local) {
            bound.insert(local.to_string());
            kept.push(s.clone_in(allocator));
        }
    }
    if kept.is_empty() {
        return None;
    }
    let mut cloned = imp.clone_in(allocator);
    cloned.specifiers = Some(kept);
    // Re-point the source; clear `raw` so codegen prints the new value.
    cloned.source.value = Str::from(allocator.alloc_str(rebased));
    cloned.source.raw = None;
    Some(Statement::ImportDeclaration(ast.alloc(cloned)))
}

/// Rewrite a donor import specifier so it resolves the same target from the
/// consumer's location. Bare/absolute specifiers are location-independent and
/// pass through; relative ones are rebased by lexical path math (the bundler
/// re-resolves the result, so extensions/index files need not be known here).
fn rebase_specifier(spec: &str, donor_path: &str, consumer_path: &str) -> String {
    let is_relative =
        spec.starts_with("./") || spec.starts_with("../") || spec == "." || spec == "..";
    if !is_relative || donor_path.is_empty() {
        return spec.to_string();
    }
    // Resolve `spec` against the donor's directory.
    let mut target = parent_components(donor_path);
    for seg in spec.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                target.pop();
            }
            c => target.push(c.to_string()),
        }
    }
    // Make it relative to the consumer's directory.
    let from = parent_components(consumer_path);
    let common = from.iter().zip(&target).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = vec!["..".to_string(); from.len() - common];
    parts.extend(target[common..].iter().cloned());
    match parts.first() {
        None => ".".to_string(),
        Some(p) if p == ".." => parts.join("/"),
        _ => format!("./{}", parts.join("/")),
    }
}

/// Directory components of a file path, with `.`/`..` segments normalized. The
/// leading empty segment of an absolute path is dropped — fine because rebasing
/// only diffs two paths under the same root.
fn parent_components(path: &str) -> Vec<String> {
    let segs: Vec<&str> = path.split('/').collect();
    let dir = &segs[..segs.len().saturating_sub(1)]; // drop the filename
    let mut comps: Vec<String> = Vec::new();
    for s in dir {
        match *s {
            "" | "." => {}
            ".." => {
                comps.pop();
            }
            c => comps.push(c.to_string()),
        }
    }
    comps
}

/// Clone a donor module-scope declaration for copying into the consumer.
/// `export` wrappers are unwrapped so we don't add exports to the consumer.
fn hoist_decl<'a>(stmt: &Statement<'a>, allocator: &'a Allocator) -> Option<Statement<'a>> {
    match stmt {
        Statement::VariableDeclaration(_)
        | Statement::FunctionDeclaration(_)
        | Statement::ClassDeclaration(_)
        | Statement::TSTypeAliasDeclaration(_)
        | Statement::TSInterfaceDeclaration(_)
        | Statement::TSEnumDeclaration(_) => Some(stmt.clone_in(allocator)),
        Statement::ExportNamedDeclaration(e) => {
            e.declaration.as_ref().map(|d| Statement::from(d.clone_in(allocator)))
        }
        _ => None,
    }
}

/// Prepend forwarded imports to the top of the consumer body (they join the
/// leading import block, so copied decls still land after all imports).
fn prepend_imports<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    imports: Vec<Statement<'a>>,
) {
    if imports.is_empty() {
        return;
    }
    let ast = AstBuilder::new(allocator);
    let body = std::mem::replace(&mut program.body, ast.vec());
    let mut new_body = ast.vec_with_capacity(body.len() + imports.len());
    for s in imports {
        new_body.push(s);
    }
    for s in body {
        new_body.push(s);
    }
    program.body = new_body;
}

/// Insert copied decls right after the consumer's leading import block.
fn insert_after_imports<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    hoist: Vec<Statement<'a>>,
) {
    if hoist.is_empty() {
        return;
    }
    let ast = AstBuilder::new(allocator);
    let body = std::mem::replace(&mut program.body, ast.vec());
    let mut new_body = ast.vec_with_capacity(body.len() + hoist.len());
    let mut hoist = Some(hoist);
    for stmt in body {
        if hoist.is_some() && !matches!(stmt, Statement::ImportDeclaration(_)) {
            for h in hoist.take().unwrap() {
                new_body.push(h);
            }
        }
        new_body.push(stmt);
    }
    if let Some(rest) = hoist {
        for h in rest {
            new_body.push(h);
        }
    }
    program.body = new_body;
}

fn collect_top_level_binding_names(stmt: &Statement, out: &mut HashSet<String>) {
    let decl = match stmt {
        Statement::ExportNamedDeclaration(e) => e.declaration.as_ref(),
        Statement::FunctionDeclaration(_)
        | Statement::VariableDeclaration(_)
        | Statement::ClassDeclaration(_) => {
            None // handled below
        }
        Statement::ImportDeclaration(imp) => {
            if let Some(specs) = &imp.specifiers {
                for s in specs {
                    let name = match s {
                        ImportDeclarationSpecifier::ImportSpecifier(n) => n.local.name.as_str(),
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(n) => {
                            n.local.name.as_str()
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(n) => {
                            n.local.name.as_str()
                        }
                    };
                    out.insert(name.to_string());
                }
            }
            return;
        }
        _ => return,
    };
    let target = match stmt {
        Statement::FunctionDeclaration(f) => {
            f.id.as_ref().map(|id| id.name.to_string()).into_iter().collect::<Vec<_>>()
        }
        Statement::ClassDeclaration(c) => {
            c.id.as_ref().map(|id| id.name.to_string()).into_iter().collect()
        }
        Statement::VariableDeclaration(v) => v
            .declarations
            .iter()
            .filter_map(|d| match &d.id {
                BindingPattern::BindingIdentifier(id) => Some(id.name.to_string()),
                _ => None,
            })
            .collect(),
        _ => match decl {
            Some(Declaration::FunctionDeclaration(f)) => {
                f.id.as_ref().map(|id| id.name.to_string()).into_iter().collect()
            }
            Some(Declaration::ClassDeclaration(c)) => {
                c.id.as_ref().map(|id| id.name.to_string()).into_iter().collect()
            }
            Some(Declaration::VariableDeclaration(v)) => v
                .declarations
                .iter()
                .filter_map(|d| match &d.id {
                    BindingPattern::BindingIdentifier(id) => Some(id.name.to_string()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        },
    };
    out.extend(target);
}

/// Drop import specifiers for `inlined` locals that now have zero references;
/// remove an import declaration when it has no specifiers left.
fn remove_unused_imports<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    inlined: &HashSet<String>,
) {
    // Count remaining references by name.
    struct Counter<'o> {
        counts: &'o mut std::collections::HashMap<String, u32>,
    }
    impl<'a> Visit<'a> for Counter<'_> {
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            *self.counts.entry(id.name.to_string()).or_insert(0) += 1;
            walk::walk_identifier_reference(self, id);
        }
    }
    let mut counts = std::collections::HashMap::new();
    let mut c = Counter { counts: &mut counts };
    c.visit_program(program);

    let dead: HashSet<&str> = inlined
        .iter()
        .filter(|n| counts.get(n.as_str()).copied().unwrap_or(0) == 0)
        .map(String::as_str)
        .collect();
    if dead.is_empty() {
        return;
    }

    let ast = oxc_ast::AstBuilder::new(allocator);
    let body = std::mem::replace(&mut program.body, ast.vec());
    let mut kept = ast.vec_with_capacity(body.len());
    for stmt in body {
        if let Statement::ImportDeclaration(mut imp) = stmt {
            if let Some(specs) = imp.specifiers.take() {
                let mut new_specs = ast.vec();
                for s in specs {
                    let local = match &s {
                        ImportDeclarationSpecifier::ImportSpecifier(n) => n.local.name.as_str(),
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(n) => {
                            n.local.name.as_str()
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(n) => {
                            n.local.name.as_str()
                        }
                    };
                    if !dead.contains(local) {
                        new_specs.push(s);
                    }
                }
                if new_specs.is_empty() {
                    continue; // whole import removed
                }
                imp.specifiers = Some(new_specs);
            }
            kept.push(Statement::ImportDeclaration(imp));
        } else {
            kept.push(stmt);
        }
    }
    program.body = kept;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::options::Mode;

    fn opts() -> TransformOptions {
        TransformOptions {
            filename: "entry.ts".into(),
            source_type: None,
            mode: Mode::PerFile,
            sourcemap: false,
        }
    }

    // A representative module of ~`n_fns` exported functions (each ~4 lines with
    // a type annotation + a small body), to measure real oxc parse cost.
    fn gen_module(n_fns: usize) -> String {
        let mut s = String::from("const EPSILON = 1e-6;\n");
        for i in 0..n_fns {
            s.push_str(&format!(
                "export function f{i}(a: number, b: number): number {{\n  const t = a * b + EPSILON;\n  if (t > {i}) return t - {i};\n  return t + {i};\n}}\n"
            ));
        }
        s
    }

    #[test]
    #[ignore = "timing benchmark — run with --release --ignored --nocapture"]
    fn bench_parse_cost() {
        use std::time::Instant;
        for n_fns in [10usize, 75, 750] {
            let code = gen_module(n_fns);
            let lines = code.lines().count();
            let bytes = code.len();
            let iters = 2000u32;
            // warmup
            for _ in 0..50 {
                let a = Allocator::default();
                std::hint::black_box(parse_program(&a, &code, SourceType::ts()));
            }
            let start = Instant::now();
            for _ in 0..iters {
                let a = Allocator::default();
                std::hint::black_box(parse_program(&a, &code, SourceType::ts()));
            }
            let elapsed = start.elapsed();
            let per = elapsed.as_secs_f64() * 1e6 / iters as f64; // µs
            println!(
                "PARSE {lines:>5} lines / {bytes:>6} B : {per:>8.1} µs/parse  | 100x={:.1}ms 500x={:.1}ms",
                per * 100.0 / 1000.0,
                per * 500.0 / 1000.0
            );
        }
    }

    fn run(consumer: &str, donors: &[(&str, &str)]) -> String {
        let donors: Vec<Donor> = donors
            .iter()
            .map(|(s, c)| Donor {
                specifier: (*s).into(),
                // The cache keys on path, so give each donor a unique one
                // (derive from the specifier — real builds pass resolved paths).
                path: format!("/test{}", s),
                code: (*c).into(),
                resolved: Vec::new(),
            })
            .collect();
        let mut cache = crate::ModuleCache::new();
        transform_cross_file(consumer, &donors, &opts(), &mut cache).code
    }

    #[test]
    fn cache_parses_a_donor_once_across_consumers() {
        // Two consumers importing the same donor (shared cache) → parsed once.
        let donor =
            "/* @inline */ export function add(a: number, b: number): number { return a + b; }";
        let donors = vec![Donor {
            specifier: "./m".into(),
            path: "/m.ts".into(),
            code: donor.into(),
            resolved: Vec::new(),
        }];
        let mut cache = crate::ModuleCache::new();
        let c1 = "import { add } from \"./m\";\nexport function f(x: number): number { return add(x, 1); }";
        let c2 = "import { add } from \"./m\";\nexport function g(y: number): number { return add(y, 2); }";
        let o1 = transform_cross_file(c1, &donors, &opts(), &mut cache).code;
        let o2 = transform_cross_file(c2, &donors, &opts(), &mut cache).code;
        assert!(o1.contains("x + 1") && o2.contains("y + 2"), "both inlined:\n{o1}\n{o2}");
        assert_eq!(cache.parse_count(), 1, "donor parsed once across two consumers");
    }

    #[test]
    fn resolves_imported_tuple_type_for_sroa() {
        // `Vec3` is defined+exported in the donor; the consumer imports it and
        // annotates an aggregate with it. Cross-module type resolution gives the
        // arity (3) so type-aware SROA destructures the opaque `mk()` initializer.
        let consumer = r#"import { Vec3 } from "./math";
/* @sroa */ export function f(): number { const v: Vec3 = mk(); v[0] = v[1] + v[2]; return v[0]; }"#;
        let donor = "export type Vec3 = [number, number, number];";
        let out = run(consumer, &[("./math", donor)]);
        assert!(
            out.contains("v_0") && out.contains("v_1") && out.contains("v_2"),
            "SROA fired via the imported type:\n{out}"
        );
        assert!(!out.contains("v[1]"), "indexing rewritten to scalars:\n{out}");
    }

    #[test]
    fn resolves_imported_type_through_donor_local_alias_chain() {
        // The donor exports an alias of a local alias of a tuple — the oracle
        // follows the chain in the donor program.
        let consumer = r#"import { Vec2 } from "./math";
/* @sroa */ export function f(): number { const v: Vec2 = mk(); return v[0] + v[1]; }"#;
        let donor = "type Pair = [number, number];\nexport type Vec2 = Pair;";
        let out = run(consumer, &[("./math", donor)]);
        assert!(out.contains("v_0") && out.contains("v_1"), "SROA fired via alias chain:\n{out}");
    }

    #[test]
    fn resolves_imported_type_through_wildcard_reexport_barrel() {
        // The real mathcat shape: the package entry `.d.ts` re-exports its types
        // from a sibling module via a bare `export * from './types.js'`. The oracle
        // must follow the wildcard re-export across the donor graph to recover the
        // tuple arity (4) so type-aware SROA destructures the opaque `mk()` init.
        let consumer = r#"import { Quat } from "mathcat";
/* @sroa */ export function f(): number { const v: Quat = mk(); v[0] = v[1] + v[2] + v[3]; return v[0]; }"#;
        let donors = vec![
            barrel_donor(
                "mathcat",
                "/nm/mathcat/dist/index.d.ts",
                "export * from './types.js';",
                &[("./types.js", "/nm/mathcat/dist/types.d.ts")],
            ),
            barrel_donor(
                "./types.js",
                "/nm/mathcat/dist/types.d.ts",
                "export type Quat = [number, number, number, number];",
                &[],
            ),
        ];
        let out = transform_cross_file(consumer, &donors, &opts(), &mut crate::ModuleCache::new()).code;
        assert!(
            out.contains("v_0") && out.contains("v_3"),
            "SROA fired via the wildcard-reexport type:\n{out}"
        );
        assert!(!out.contains("v[1]"), "indexing rewritten to scalars:\n{out}");
    }

    #[test]
    fn dense_reexport_graph_does_not_blow_up() {
        // A fully-connected wildcard re-export graph with NO matching type forces a
        // full traversal. Without the `(donor, name)` visited memo this re-expands
        // shared nodes exponentially (fanout^depth) and hangs for minutes; with it,
        // traversal is O(nodes). Wall-clock guard turns a regression into a clear
        // failure rather than a CI timeout.
        let n = 14;
        let mut donors = vec![Donor {
            specifier: "densepkg".into(),
            path: "/p/index.d.ts".into(),
            code: (0..n).map(|j| format!("export * from './m{j}.js';")).collect::<Vec<_>>().join("\n"),
            resolved: (0..n).map(|j| (format!("./m{j}.js"), format!("/p/m{j}.d.ts"))).collect(),
        }];
        for i in 0..n {
            donors.push(Donor {
                specifier: format!("./m{i}.js"),
                path: format!("/p/m{i}.d.ts"),
                // each node re-exports every OTHER node (dense) — no `Quat` anywhere.
                code: (0..n)
                    .filter(|j| *j != i)
                    .map(|j| format!("export * from './m{j}.js';"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                resolved: (0..n)
                    .filter(|j| *j != i)
                    .map(|j| (format!("./m{j}.js"), format!("/p/m{j}.d.ts")))
                    .collect(),
            });
        }
        let consumer = r#"import { Quat } from "densepkg";
/* @sroa */ export function f(): number { const v: Quat = mk(); return v[0] + v[1] + v[2] + v[3]; }"#;
        let start = std::time::Instant::now();
        let out = transform_cross_file(consumer, &donors, &opts(), &mut crate::ModuleCache::new()).code;
        let elapsed = start.elapsed();
        assert!(elapsed.as_secs() < 5, "dense graph must not blow up (took {elapsed:?})");
        assert!(!out.contains("v_0"), "Quat is undeclared → no scalarization:\n{out}");
    }

    #[test]
    fn does_not_follow_namespace_reexport_for_a_flat_type_name() {
        // A namespace re-export (`export * as ns from S`) exposes `ns.X`, NOT a flat
        // `X`, so an `import { X }` from the barrel must NOT resolve through it. The
        // type oracle only follows FLAT re-exports; SROA must not fire here.
        let consumer = r#"import { Quat } from "mathcat";
/* @sroa */ export function f(): number { const v: Quat = mk(); v[0] = v[1] + v[2] + v[3]; return v[0]; }"#;
        let donors = vec![
            barrel_donor(
                "mathcat",
                "/nm/mathcat/dist/index.d.ts",
                "export * as types from './types.js';",
                &[("./types.js", "/nm/mathcat/dist/types.d.ts")],
            ),
            barrel_donor(
                "./types.js",
                "/nm/mathcat/dist/types.d.ts",
                "export type Quat = [number, number, number, number];",
                &[],
            ),
        ];
        let out = transform_cross_file(consumer, &donors, &opts(), &mut crate::ModuleCache::new()).code;
        assert!(out.contains("v[1]"), "SROA must NOT fire via a namespace re-export:\n{out}");
        assert!(!out.contains("v_0"), "no scalarization expected:\n{out}");
    }

    #[test]
    fn resolves_imported_object_type_alias_for_sroa() {
        // The donor exports a `type X = { … }` object-type alias (not an
        // interface); the consumer imports it and types an opaque aggregate.
        let consumer = r#"import { Vec3 } from "./math";
/* @sroa */ export function f(): number { const v: Vec3 = mk(); v.x = v.y + v.z; return v.x; }"#;
        let donor = "export type Vec3 = { x: number; y: number; z: number };";
        let out = run(consumer, &[("./math", donor)]);
        assert!(
            out.contains("v_x") && out.contains("v_y") && out.contains("v_z"),
            "object SROA fired via the imported type alias:\n{out}"
        );
        assert!(!out.contains("v.x"), "field accesses rewritten:\n{out}");
    }

    #[test]
    fn cross_file_flatten_inlines_imported_callee() {
        // A `@optimize` host calls an IMPORTED, *non-@inline* function — it must
        // inline across the module boundary (cross-file flatten), which the
        // `@inline` path alone wouldn't do.
        let consumer = "import { helper } from \"./m\";\n/* @optimize */ export function host(x: number): number { return helper(x) + 1; }";
        let donor = "export function helper(a: number): number { return a * 2; }";
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("helper("), "imported callee inlined into @optimize host:\n{out}");
        assert!(out.contains("x * 2"), "body spliced:\n{out}");
    }

    #[test]
    fn cross_file_flatten_inlines_direct_namespace_member() {
        // A `@optimize` host calls a *namespace-member* of a directly imported,
        // non-@inline module (`import * as vec3 from M; vec3.add(…)`).
        let consumer = "import * as vec3 from \"./m\";\n/* @optimize */ export function host(x: number): number { return vec3.add(x, 1); }";
        let donor = "export function add(a: number, b: number): number { return a + b; }";
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("vec3.add"), "namespace member inlined into @optimize host:\n{out}");
        assert!(out.contains("x + 1"), "body spliced:\n{out}");
    }

    #[test]
    fn cross_file_flatten_inlines_reexported_namespace_member() {
        // mathcat's shape: the consumer imports a namespace object the barrel
        // re-exports (`import * as vec3 from M; export { vec3 }`). A `@optimize`
        // host calls a member of it; the library is non-@inline and untouched.
        let consumer = r#"import { vec3 } from "./ns";
/* @optimize */ export function host(x) { return vec3.add(x, 1); }"#;
        let barrel = "import * as vec3 from \"./vec3.js\";\nexport { vec3 };";
        let vec3 = "export function add(a, b) { return a + b; }";
        let donors = vec![
            barrel_donor("./ns", "/n/ns.js", barrel, &[("./vec3.js", "/n/vec3.js")]),
            barrel_donor("./vec3.js", "/n/vec3.js", vec3, &[]),
        ];
        let out =
            transform_cross_file(consumer, &donors, &opts(), &mut crate::ModuleCache::new()).code;
        assert!(!out.contains("vec3.add"), "re-exported namespace member inlined:\n{out}");
        assert!(out.contains("x + 1"), "body spliced:\n{out}");
    }

    #[test]
    fn cross_file_flatten_leaves_non_host_callers() {
        // The same imported callee called OUTSIDE a flatten host stays a call.
        let consumer = "import { helper } from \"./m\";\n/* @optimize */ export function host(x: number): number { return helper(x); }\nexport function other(y: number): number { return helper(y); }";
        let donor = "export function helper(a: number): number { return a * 2; }";
        let out = run(consumer, &[("./m", donor)]);
        assert!(out.contains("helper(y)"), "call outside host untouched:\n{out}");
        assert!(out.contains("x * 2"), "host call inlined:\n{out}");
    }

    #[test]
    fn resolves_imported_interface_with_extends() {
        // The donor's exported interface extends a local base; cross-module
        // resolution merges the inherited fields.
        let consumer = r#"import { Vec } from "./math";
/* @sroa */ export function f(): number { const v: Vec = mk(); v.x = v.y + v.z; return v.x; }"#;
        let donor = "interface Base { x: number }\nexport interface Vec extends Base { y: number; z: number }";
        let out = run(consumer, &[("./math", donor)]);
        assert!(
            out.contains("v_x") && out.contains("v_y") && out.contains("v_z"),
            "imported interface `extends` resolved across modules:\n{out}"
        );
    }

    #[test]
    fn unresolvable_imported_type_does_not_fire_sroa() {
        // A non-tuple imported type yields no arity → SROA leaves the aggregate.
        let consumer = r#"import { Thing } from "./math";
/* @sroa */ export function f(): unknown { const v: Thing = mk(); return v[0]; }"#;
        let donor = "export type Thing = { x: number };";
        let out = run(consumer, &[("./math", donor)]);
        assert!(out.contains("v[0]"), "no arity → aggregate untouched:\n{out}");
        assert!(!out.contains("v_0"), "{out}");
    }

    #[test]
    fn hoists_and_folds_a_module_const() {
        let consumer = r#"import { scale } from "./m";
export function f(x: number): number { return scale(x); }"#;
        let donor = "const FACTOR = 3;\n/* @inline */ export function scale(v: number): number { return v * FACTOR; }";
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("import"), "import should be dropped:\n{out}");
        assert!(!out.contains("scale"), "call should be inlined:\n{out}");
        // literal const folds away via the cleanup pipeline
        assert!(out.contains("x * 3"), "FACTOR should fold to 3:\n{out}");
        assert!(!out.contains("FACTOR"), "folded const should be dead-removed:\n{out}");
    }

    #[test]
    fn copies_a_non_literal_const_dep() {
        let consumer = r#"import { origin } from "./m";
export function f(): number[] { return origin(); }"#;
        let donor = "const ZERO = [0, 0, 0];\n/* @inline */ export function origin(): number[] { return ZERO; }";
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("origin("), "call should be inlined:\n{out}");
        // array const is not foldable → copied into the consumer, referenced
        assert!(out.contains("ZERO"), "non-literal const should be copied:\n{out}");
        assert!(out.contains("const ZERO ="), "copied const keeps its initializer:\n{out}");
    }

    #[test]
    fn hoists_a_transitive_helper_chain() {
        let consumer = r#"import { area } from "./m";
export function f(r: number): number { return area(r); }"#;
        let donor = "const PI = 3.14;\nfunction sq(n: number): number { return n * n; }\n/* @inline */ export function area(r: number): number { return PI * sq(r); }";
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("area("), "outer call inlined:\n{out}");
        // sq is a needed helper → copied; PI is a literal const → folds
        assert!(out.contains("function sq"), "helper fn should be copied:\n{out}");
        assert!(out.contains("3.14"), "PI literal present (folded or copied):\n{out}");
    }

    #[test]
    fn forwards_a_bare_specifier_import_dep() {
        // donor body needs `clamp` from a bare package — forward verbatim.
        let consumer = r#"import { norm } from "./m";
export function f(x: number): number { return norm(x); }"#;
        let donor = r#"import { clamp } from "math-utils";
/* @inline */ export function norm(v: number): number { return clamp(v); }"#;
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("norm("), "call should be inlined:\n{out}");
        assert!(out.contains("clamp(x)"), "body spliced with the import ref:\n{out}");
        assert!(
            out.contains(r#"import { clamp } from "math-utils""#),
            "bare import forwarded verbatim:\n{out}"
        );
    }

    #[test]
    fn forwards_and_rebases_a_relative_import_dep() {
        // donor at /proj/lib/m.ts imports ./util → /proj/lib/util; consumer at
        // /proj/app/entry.ts must see it as ../lib/util.
        let consumer = r#"import { norm } from "../lib/m";
export function f(x: number): number { return norm(x); }"#;
        let donor = r#"import { clamp } from "./util";
/* @inline */ export function norm(v: number): number { return clamp(v); }"#;
        let donors = vec![Donor {
            specifier: "../lib/m".into(),
            path: "/proj/lib/m.ts".into(),
            code: donor.into(),
            resolved: Vec::new(),
        }];
        let mut o = opts();
        o.filename = "/proj/app/entry.ts".into();
        let out = transform_cross_file(consumer, &donors, &o, &mut crate::ModuleCache::new()).code;
        assert!(out.contains("clamp(x)"), "body spliced:\n{out}");
        assert!(
            out.contains(r#"from "../lib/util""#),
            "relative import rebased to the consumer's location:\n{out}"
        );
    }

    #[test]
    fn dedupes_a_forwarded_import_across_two_donors() {
        // two @inline donors from the same module both need `clamp` — forward once.
        let consumer = r#"import { lo, hi } from "./m";
export function f(x: number): number { return lo(x) + hi(x); }"#;
        let donor = r#"import { clamp } from "pkg";
/* @inline */ export function lo(v: number): number { return clamp(v); }
/* @inline */ export function hi(v: number): number { return clamp(v) + 1; }"#;
        let out = run(consumer, &[("./m", donor)]);
        assert_eq!(out.matches("import { clamp }").count(), 1, "forwarded once:\n{out}");
    }

    // Barrel donors carry a `resolved` map so the core can follow re-exports by
    // path (mirrors what the plugin provides).
    fn barrel_donor(specifier: &str, path: &str, code: &str, resolved: &[(&str, &str)]) -> Donor {
        Donor {
            specifier: specifier.into(),
            path: path.into(),
            code: code.into(),
            resolved: resolved.iter().map(|(s, p)| ((*s).into(), (*p).into())).collect(),
        }
    }

    #[test]
    fn follows_a_namespace_reexport_barrel() {
        // gl-matrix v3 shape: barrel re-exports a submodule as a namespace.
        let consumer = r#"import { vec3 } from "mathcat";
export function f(x: number): number { return vec3.add(x, 1); }"#;
        let barrel = r#"export * as vec3 from "./vec3.js";"#;
        let vec3 = r#"const EPSILON = 1e-6;
/* @inline */ export function add(a, b) { return a + b; }"#;
        let donors = vec![
            barrel_donor(
                "mathcat",
                "/n/mathcat/index.js",
                barrel,
                &[("./vec3.js", "/n/mathcat/vec3.js")],
            ),
            barrel_donor("./vec3.js", "/n/mathcat/vec3.js", vec3, &[]),
        ];
        let out =
            transform_cross_file(consumer, &donors, &opts(), &mut crate::ModuleCache::new()).code;
        assert!(!out.contains("vec3"), "barrel namespace import removed:\n{out}");
        assert!(out.contains("x + 1"), "re-exported member inlined:\n{out}");
    }

    #[test]
    fn follows_a_named_reexport_barrel() {
        // barrel: export { add as plus } from "./math.js"
        let consumer = r#"import { plus } from "mathcat";
export function f(x: number): number { return plus(x, 1); }"#;
        let barrel = r#"export { add as plus } from "./math.js";"#;
        let math = "/* @inline */ export function add(a, b) { return a + b; }";
        let donors = vec![
            barrel_donor(
                "mathcat",
                "/n/mathcat/index.js",
                barrel,
                &[("./math.js", "/n/mathcat/math.js")],
            ),
            barrel_donor("./math.js", "/n/mathcat/math.js", math, &[]),
        ];
        let out =
            transform_cross_file(consumer, &donors, &opts(), &mut crate::ModuleCache::new()).code;
        assert!(!out.contains("plus("), "named re-export inlined:\n{out}");
        assert!(out.contains("x + 1"), "{out}");
    }

    #[test]
    fn inlines_a_default_function_export() {
        // export default function + import add from "m"
        let consumer = r#"import add from "./m";
export function f(x: number): number { return add(x, 1); }"#;
        let donor = "/* @inline */ export default function add(a: number, b: number): number { return a + b; }";
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("import"), "default import dropped:\n{out}");
        assert!(out.contains("x + 1"), "default fn inlined:\n{out}");
    }

    #[test]
    fn inlines_a_default_arrow_export() {
        let consumer = r#"import add from "./m";
export function f(x: number): number { return add(x, 1); }"#;
        let donor = "/* @inline */ export default (a: number, b: number): number => a + b;";
        let out = run(consumer, &[("./m", donor)]);
        assert!(out.contains("x + 1"), "default arrow inlined:\n{out}");
    }

    #[test]
    fn inlines_a_default_object_export_member() {
        // export default { add } consumed as `import vec from "m"; vec.add(...)`.
        let consumer = r#"import vec from "./m";
export function f(x: number): number { return vec.add(x, 1); }"#;
        let donor = r#"/* @inline */ export default {
  add(a: number, b: number): number { return a + b; },
};"#;
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("vec"), "default object import removed:\n{out}");
        assert!(out.contains("x + 1"), "default object member inlined:\n{out}");
    }

    #[test]
    fn inlines_mixed_default_and_named_import() {
        // import add, { sub } from "m" — both halves inline.
        let consumer = r#"import add, { sub } from "./m";
export function f(x: number): number { return add(x, 1) + sub(x, 2); }"#;
        let donor = r#"/* @inline */ export default function add(a: number, b: number): number { return a + b; }
/* @inline */ export function sub(a: number, b: number): number { return a - b; }"#;
        let out = run(consumer, &[("./m", donor)]);
        assert!(out.contains("x + 1"), "default half inlined:\n{out}");
        assert!(out.contains("x - 2"), "named half inlined:\n{out}");
        assert!(!out.contains("import"), "both specifiers dropped:\n{out}");
    }

    #[test]
    fn inlines_object_namespace_members_whole_annotation() {
        // import { vec3 } from "m"; vec3.add(x, 1) where vec3 is an object whose
        // whole `export const` is @inline-annotated.
        let consumer = r#"import { vec3 } from "./m";
export function f(x: number): number { return vec3.add(x, 1); }"#;
        let donor = r#"/* @inline */ export const vec3 = {
  add(a: number, b: number): number { return a + b; },
  sub(a: number, b: number): number { return a - b; },
};"#;
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("vec3"), "object namespace import removed:\n{out}");
        assert!(out.contains("x + 1"), "object method inlined:\n{out}");
    }

    #[test]
    fn inlines_object_namespace_member_per_method_annotation() {
        // only `add` is annotated; `sub` isn't → vec.sub kept, import kept.
        let consumer = r#"import { vec } from "./m";
export function f(x: number): number { return vec.add(x, 1) + vec.sub(x, 2); }"#;
        let donor = r#"export const vec = {
  /* @inline */ add: (a: number, b: number): number => a + b,
  sub: (a: number, b: number): number => a - b,
};"#;
        let out = run(consumer, &[("./m", donor)]);
        assert!(out.contains("x + 1"), "annotated method inlined:\n{out}");
        assert!(out.contains("vec.sub(x, 2)"), "unannotated method kept:\n{out}");
    }

    #[test]
    fn object_namespace_member_with_a_module_dep() {
        let consumer = r#"import { vec } from "./m";
export function f(x: number): number { return vec.scale(x); }"#;
        let donor = r#"const FACTOR = 3;
/* @inline */ export const vec = { scale(v: number): number { return v * FACTOR; } };"#;
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("vec.scale"), "member inlined:\n{out}");
        assert!(out.contains("x * 3"), "module dep folded:\n{out}");
    }

    #[test]
    fn inlines_an_aliased_named_import() {
        // import { add as plus } — keyed by the local alias, resolved by the
        // imported name.
        let consumer = r#"import { add as plus } from "./m";
export function f(x: number): number { return plus(x, 1); }"#;
        let donor =
            "/* @inline */ export function add(a: number, b: number): number { return a + b; }";
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("plus("), "aliased call inlined:\n{out}");
        assert!(out.contains("x + 1"), "{out}");
    }

    #[test]
    fn inlines_through_a_renaming_export_clause() {
        // donor exports a bare @inline fn under a different name via a clause.
        let consumer = r#"import { plus } from "./m";
export function f(x: number): number { return plus(x, 1); }"#;
        let donor = "/* @inline */ function add(a: number, b: number): number { return a + b; }\nexport { add as plus };";
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("plus("), "renamed export inlined:\n{out}");
        assert!(out.contains("x + 1"), "{out}");
    }

    #[test]
    fn renaming_export_clause_via_namespace_member() {
        let consumer = r#"import * as v from "./m";
export function f(x: number): number { return v.plus(x, 1); }"#;
        let donor = "/* @inline */ function add(a: number, b: number): number { return a + b; }\nexport { add as plus };";
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("v.plus"), "renamed namespace member inlined:\n{out}");
        assert!(out.contains("x + 1"), "{out}");
    }

    #[test]
    fn inlines_an_arrow_const_export() {
        // export const add = (a,b) => a + b
        let consumer = r#"import { add } from "./m";
export function f(x: number): number { return add(x, 1); }"#;
        let donor = "/* @inline */ export const add = (a: number, b: number): number => a + b;";
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("import"), "import dropped:\n{out}");
        assert!(out.contains("x + 1"), "arrow inlined:\n{out}");
    }

    #[test]
    fn inlines_a_function_expression_const_export() {
        let consumer = r#"import { add } from "./m";
export function f(x: number): number { return add(x, 1); }"#;
        let donor = "/* @inline */ export const add = function(a: number, b: number): number { return a + b; };";
        let out = run(consumer, &[("./m", donor)]);
        assert!(out.contains("x + 1"), "function-expression const inlined:\n{out}");
    }

    #[test]
    fn arrow_const_export_with_a_module_dep() {
        // arrow body referencing a module const exercises pull_donor_deps + fold.
        let consumer = r#"import { scale } from "./m";
export function f(x: number): number { return scale(x); }"#;
        let donor = "const FACTOR = 3;\n/* @inline */ export const scale = (v: number): number => v * FACTOR;";
        let out = run(consumer, &[("./m", donor)]);
        assert!(out.contains("x * 3"), "dep folded through arrow:\n{out}");
        assert!(!out.contains("FACTOR"), "literal const removed:\n{out}");
    }

    #[test]
    fn inlines_arrow_const_via_namespace_member_call() {
        let consumer = r#"import * as vec from "./m";
export function f(x: number): number { return vec.add(x, 1); }"#;
        let donor = "/* @inline */ export const add = (a: number, b: number): number => a + b;";
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("vec"), "namespace import removed:\n{out}");
        assert!(out.contains("x + 1"), "arrow member call inlined:\n{out}");
    }

    #[test]
    fn inlines_namespace_member_calls() {
        // import * as vec3 from "m"; vec3.add(x, 1) → x + 1, with the namespace
        // import dropped once every member call is inlined.
        let consumer = r#"import * as vec3 from "./m";
export function f(x: number): number { return vec3.add(x, 1); }"#;
        let donor = r#"/* @inline */ export function add(a: number, b: number): number { return a + b; }
/* @inline */ export function sub(a: number, b: number): number { return a - b; }"#;
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("vec3"), "namespace import fully removed:\n{out}");
        assert!(out.contains("x + 1"), "member call inlined:\n{out}");
    }

    #[test]
    fn namespace_member_call_with_a_module_dep() {
        // a namespace method needing a module const exercises pull_donor_deps
        // through the member-call path.
        let consumer = r#"import * as mathcat from "./m";
export function f(x: number): number { return mathcat.scale(x); }"#;
        let donor = r#"const FACTOR = 3;
/* @inline */ export function scale(v: number): number { return v * FACTOR; }"#;
        let out = run(consumer, &[("./m", donor)]);
        assert!(!out.contains("mathcat"), "namespace import removed:\n{out}");
        assert!(out.contains("x * 3"), "dep folded through member call:\n{out}");
    }

    #[test]
    fn keeps_namespace_import_when_a_member_is_not_inlinable() {
        // only `add` is @inline; `mul` isn't → vec.mul(...) stays, import kept.
        let consumer = r#"import * as vec from "./m";
export function f(x: number): number { return vec.add(x, 1) + vec.mul(x, 2); }"#;
        let donor = r#"/* @inline */ export function add(a: number, b: number): number { return a + b; }
export function mul(a: number, b: number): number { return a * b; }"#;
        let out = run(consumer, &[("./m", donor)]);
        assert!(out.contains("x + 1"), "add inlined:\n{out}");
        assert!(out.contains("vec.mul(x, 2)"), "non-inline member kept:\n{out}");
        assert!(out.contains("import"), "namespace import kept (mul still used):\n{out}");
    }

    #[test]
    fn alpha_renames_a_colliding_donor_dep_const() {
        // SCALE repro (confirmed miscompile): the donor's `bump` body needs the
        // donor's `SCALE = 2`, but the consumer already declares a *different*
        // `SCALE = 100`. Copying the donor const verbatim would make the spliced
        // body bind to the consumer's 100 → wrong (1001). The donor dep must be
        // α-renamed so the body still uses the donor's 2 → 21.
        let consumer = r#"import { bump } from "./donor";
const SCALE = 100;
/* @optimize */ export function run() { return bump(10); }
export function useScale() { return SCALE; }"#;
        let donor = "export const SCALE = 2;\n/* @inline */ export function bump(x) { return x * SCALE + 1; }";
        let out = run(consumer, &[("./donor", donor)]);
        assert!(!out.contains("bump("), "donor call inlined:\n{out}");
        // The inlined `run` must compute 10*2+1 = 21 (donor's SCALE), folded.
        assert!(out.contains("21"), "inlined body uses the donor's SCALE (→21):\n{out}");
        assert!(!out.contains("1001"), "must NOT bind to the consumer's SCALE (1001):\n{out}");
        // The consumer's own SCALE = 100 binding is untouched and still used.
        assert!(out.contains("100"), "consumer's own SCALE preserved:\n{out}");
        assert!(out.contains("return 100") || out.contains("return SCALE"),
            "useScale still returns the consumer's SCALE:\n{out}");
    }

    #[test]
    fn no_rename_when_donor_dep_name_is_free() {
        // Control: no collision (consumer has no `SCALE`) → the donor dep keeps its
        // own name, no `$cf` suffix, and the body folds to the donor's value.
        let consumer = r#"import { bump } from "./donor";
/* @optimize */ export function run() { return bump(10); }"#;
        let donor = "export const SCALE = 2;\n/* @inline */ export function bump(x) { return x * SCALE + 1; }";
        let out = run(consumer, &[("./donor", donor)]);
        assert!(!out.contains("$cf"), "no rename minted when there is no collision:\n{out}");
        assert!(out.contains("21"), "folds to the donor's value:\n{out}");
    }

    #[test]
    fn alpha_renames_a_colliding_transitive_helper() {
        // The colliding dep is a *helper fn* reached transitively (bump → helper →
        // SCALE), and the consumer declares a different `helper`. Both the body and
        // the copied helper must rename consistently so the donor's helper is used.
        let consumer = r#"import { bump } from "./donor";
function helper(n) { return n + 1000; }
/* @optimize */ export function run() { return bump(10); }
export function useHelper() { return helper(0); }"#;
        let donor = "function helper(n) { return n * 2; }\n/* @inline */ export function bump(x) { return helper(x); }";
        let out = run(consumer, &[("./donor", donor)]);
        assert!(!out.contains("bump("), "call inlined:\n{out}");
        // run() = helper_donor(10) = 10*2 = 20, not the consumer's helper (1010).
        assert!(out.contains("20") || out.contains("10 * 2"), "donor helper used:\n{out}");
        assert!(
            out.contains("1000") || out.contains("1e3"),
            "consumer's own helper preserved:\n{out}"
        );
        // The consumer's helper binding must remain callable for useHelper.
        assert!(out.contains("function helper"), "consumer helper kept:\n{out}");
    }

    #[test]
    fn rebase_helper_cases() {
        // bare + absolute pass through
        assert_eq!(rebase_specifier("lodash", "/a/b/m.ts", "/a/c/e.ts"), "lodash");
        // sibling of donor, seen from a sibling consumer dir
        assert_eq!(rebase_specifier("./util", "/proj/lib/m.ts", "/proj/app/e.ts"), "../lib/util");
        // same dir
        assert_eq!(rebase_specifier("./util", "/proj/m.ts", "/proj/e.ts"), "./util");
        // parent traversal in the donor spec
        assert_eq!(rebase_specifier("../core/x", "/proj/lib/m.ts", "/proj/lib/e.ts"), "../core/x");
    }
}
