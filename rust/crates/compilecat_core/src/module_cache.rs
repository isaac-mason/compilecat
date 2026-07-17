//! Persistent parsed-module cache (see `rust/ARCHITECTURE.md`).
//!
//! Caches parsed modules by `(path, content-hash)` so a module is parsed **once
//! per build** and reused — whatever role it plays (an inlining dependency today, a
//! type source for the type-resolution layer tomorrow, etc.). This layer is
//! deliberately role-agnostic: it knows about *modules*, not "dependencies". Callers
//! assign the role. `ParsedModule` owns its parse (source + arena + AST) so it
//! stays alive across calls; nodes are `clone_in`'d *out* into a consumer arena
//! at use time, keeping arenas independent.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;
use oxc_span::SourceType;

use crate::parse_program;

/// Owns the source string + arena that a parsed module's AST borrows from.
struct ModuleOwner {
    source: String,
    allocator: Allocator,
}

self_cell::self_cell! {
    /// A module parsed once and held alive — `(source, arena, Program)` bundled
    /// so the AST's borrow stays valid. Immutable; `self_cell` is the
    /// implementation, not part of the contract.
    pub struct ParsedModule {
        owner: ModuleOwner,
        #[covariant]
        dependent: Program,
    }
}

impl ParsedModule {
    /// Parse `source` once into an owned, self-referential module.
    pub fn parse(source: String, source_type: SourceType) -> Self {
        let owner = ModuleOwner { source, allocator: Allocator::default() };
        ParsedModule::new(owner, |o| parse_program(&o.allocator, &o.source, source_type))
    }

    /// The parsed program (lives as long as `self`). Nodes are `clone_in`'d *out*
    /// of it into a consumer arena at use time — `clone_in` takes the destination
    /// arena, so this module's own arena is never handed out.
    pub fn program(&self) -> &Program<'_> {
        self.borrow_dependent()
    }

    /// The original source text (for span-based comment/directive lookups).
    pub fn source(&self) -> &str {
        &self.borrow_owner().source
    }
}

/// Persistent, build-scoped cache of parsed modules, keyed by resolved path.
/// Held on the napi `Compiler` so it survives across `transform` calls; a module
/// is re-parsed only on a content-hash change (HMR / watch). Lives behind a
/// per-instance `RefCell` (the bundler drives plugin transforms on one JS
/// thread, so no cross-thread sharing of the `!Send` oxc ASTs).
#[derive(Default)]
pub struct ModuleCache {
    entries: HashMap<String, CachedModule>,
    /// Count of actual parses performed — proves parse-once in tests / lets the
    /// host report cache effectiveness.
    parses: u32,
}

struct CachedModule {
    content_hash: u64,
    parsed: ParsedModule,
}

fn hash_source(code: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    code.hash(&mut h);
    h.finish()
}

impl ModuleCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The cached parse for `path`, parsing only on a miss or a content change.
    /// The same source requested by N consumers is parsed once.
    pub fn get_or_parse(
        &mut self,
        path: &str,
        code: &str,
        source_type: SourceType,
    ) -> &ParsedModule {
        let hash = hash_source(code);
        let fresh = self.entries.get(path).is_some_and(|e| e.content_hash == hash);
        if !fresh {
            self.parses += 1;
            self.entries.insert(
                path.to_string(),
                CachedModule {
                    content_hash: hash,
                    parsed: ParsedModule::parse(code.to_string(), source_type),
                },
            );
        }
        &self.entries.get(path).expect("just inserted").parsed
    }

    /// The already-cached parse for `path` (immutable — for the read phase after
    /// `get_or_parse` has populated every needed module). `None` if not cached.
    pub fn get(&self, path: &str) -> Option<&ParsedModule> {
        self.entries.get(path).map(|e| &e.parsed)
    }

    /// Drop a module's entry (e.g. on `watchChange`) so it re-parses next time.
    pub fn invalidate(&mut self, path: &str) {
        self.entries.remove(path);
    }

    /// Total parses performed across this cache's lifetime.
    pub fn parse_count(&self) -> u32 {
        self.parses
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::CloneIn;

    #[test]
    fn parsed_module_holds_its_program() {
        let m = ParsedModule::parse(
            "export function add(a: number, b: number): number { return a + b; }".to_string(),
            SourceType::ts(),
        );
        assert_eq!(m.program().body.len(), 1);
        assert!(m.source().contains("add"));
    }

    #[test]
    fn nodes_clone_out_into_a_separate_arena() {
        // The crux: a node parsed in a module's persistent arena can be cloned
        // into a fresh (per-consumer) arena and outlive the module.
        let consumer_alloc = Allocator::default();
        let cloned = {
            let m = ParsedModule::parse("const X = [1, 2, 3];".to_string(), SourceType::ts());
            m.program().body.clone_in(&consumer_alloc)
        }; // module dropped here — the clone must remain valid
        assert_eq!(cloned.len(), 1);
        // Reprint the clone to prove it's intact after the source module is gone.
        let ast = oxc_ast::AstBuilder::new(&consumer_alloc);
        let prog =
            ast.program(oxc_span::SPAN, SourceType::ts(), "", ast.vec(), None, ast.vec(), cloned);
        let out = oxc_codegen::Codegen::new().build(&prog).code;
        assert!(out.contains("const X"), "cloned node reprints: {out}");
    }

    #[test]
    fn caches_parse_across_consumers() {
        let mut cache = ModuleCache::new();
        let code = "/* @inline */ export function add(a, b) { return a + b; }";
        // Simulate 5 consumers all importing the same module path.
        for _ in 0..5 {
            let p = cache.get_or_parse("/m/util.ts", code, SourceType::ts());
            assert_eq!(p.program().body.len(), 1);
        }
        assert_eq!(cache.parse_count(), 1, "module parsed once across 5 consumers");
    }

    #[test]
    fn reparses_on_content_change() {
        let mut cache = ModuleCache::new();
        cache.get_or_parse("/m/util.ts", "export const X = 1;", SourceType::ts());
        cache.get_or_parse("/m/util.ts", "export const X = 1;", SourceType::ts()); // hit
        cache.get_or_parse("/m/util.ts", "export const X = 2;", SourceType::ts()); // changed → reparse
        assert_eq!(cache.parse_count(), 2);
    }

    #[test]
    fn invalidate_forces_reparse() {
        let mut cache = ModuleCache::new();
        cache.get_or_parse("/m/util.ts", "export const X = 1;", SourceType::ts());
        cache.invalidate("/m/util.ts");
        cache.get_or_parse("/m/util.ts", "export const X = 1;", SourceType::ts());
        assert_eq!(cache.parse_count(), 2);
    }
}
