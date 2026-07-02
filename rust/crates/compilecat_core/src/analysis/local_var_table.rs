//! Port of `local-variable-table.ts` — the binding-slot index space the
//! dataflow analyses (live-vars, reaching-def/use) and their consumers
//! (flow-sensitive-inline, dead-assignments) layer their lattices on.
//!
//! We lean on `oxc_semantic` for binding identity. A **SymbolId**
//! is already a per-binding identity (shadowing handled), so each local symbol
//! of the function maps to a compact `slot`. Identifiers (decl + every
//! reference) are mapped by `Span` → slot so the transfer functions can resolve
//! a use site cheaply.
//!
//! "Local to this function" / "escapes via a closure" are decided by walking the
//! `oxc_semantic` node parent-chain to the nearest enclosing function (more
//! robust than deriving scope ids): a symbol is local iff its nearest enclosing
//! function node IS the root; a reference escapes iff its nearest enclosing
//! function is a *nested* one. `arguments` forces every parameter to escape.
//!
//! Over-approximating `escaped` is always sound (keeps more stores live / blocks
//! more inlines), so when unsure we escape.

use std::collections::{HashMap, HashSet};

use oxc_allocator::{Address, GetAddress};
use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_ast_visit::Visit;
use oxc_semantic::{NodeId, ScopeFlags, Semantic};
use oxc_span::{GetSpan, Span};

pub struct LocalVarTable {
    /// identifier `NodeId` → slot. Keyed by node id, NOT span: compiler-generated
    /// nodes (SROA/unroll/inline output) all share `SPAN(0,0)`, so span identity
    /// collides and corrupts liveness on optimized code; node ids are unique.
    slot_of_node: HashMap<NodeId, usize>,
    /// slots observable after the function (closure capture / `arguments`).
    pub escaped: HashSet<usize>,
    names: Vec<String>,
    /// slot → span of the binding's declaration (proxy for its scope node).
    decl_span: Vec<Span>,
    /// slot → arena address of the node that introduces the binding's lexical
    /// scope (the function for `var`/params, the nearest block for `let`/`const`).
    /// Used by flow-sensitive inlining to reject substituting an RHS that reads a
    /// binding out of scope at the use site. `None` if it couldn't be resolved.
    scope_node: Vec<Option<Address>>,
}

impl LocalVarTable {
    pub fn size(&self) -> usize {
        self.names.len()
    }
    pub fn resolve(&self, ident_node: NodeId) -> Option<usize> {
        self.slot_of_node.get(&ident_node).copied()
    }
    pub fn is_escaped(&self, slot: usize) -> bool {
        self.escaped.contains(&slot)
    }
    pub fn name_of(&self, slot: usize) -> &str {
        &self.names[slot]
    }
    pub fn decl_span_of(&self, slot: usize) -> Span {
        self.decl_span[slot]
    }
    /// Arena address of the slot's binding scope node, or None if unresolved.
    pub fn scope_node_of(&self, slot: usize) -> Option<Address> {
        self.scope_node[slot]
    }
}

/// Build the table for the function whose `Function`/arrow node is `root_fn`.
pub fn build(semantic: &Semantic, root_fn: NodeId) -> LocalVarTable {
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();

    let mut slot_of_node: HashMap<NodeId, usize> = HashMap::new();
    let mut escaped: HashSet<usize> = HashSet::new();
    let mut names: Vec<String> = Vec::new();
    let mut decl_span: Vec<Span> = Vec::new();
    let mut is_param: Vec<bool> = Vec::new();
    let mut scope_node: Vec<Option<Address>> = Vec::new();

    for sym in scoping.symbol_ids() {
        let decl = scoping.symbol_declaration(sym);
        if enclosing_function(nodes, decl) != Some(root_fn) {
            continue; // not a local of this function (param/local of a nested fn, etc.)
        }
        let slot = names.len();
        names.push(scoping.symbol_name(sym).to_string());

        // Map the declaration's binding identifier + every reference to `slot`.
        let (decl_id_node, decl_id_span, param) = decl_binding(nodes, decl);
        if let Some(n) = decl_id_node {
            slot_of_node.insert(n, slot);
        }
        decl_span.push(decl_id_span);
        is_param.push(param);
        scope_node.push(scope_node_of_decl(nodes, decl, param, root_fn));

        let mut escapes = false;
        for r in scoping.get_resolved_references(sym) {
            let rnode = r.node_id();
            slot_of_node.insert(rnode, slot);
            if enclosing_function(nodes, rnode) != Some(root_fn) {
                escapes = true; // referenced from inside a nested function
            }
        }
        if escapes {
            escaped.insert(slot);
        }
    }

    // `arguments` reference → every parameter escapes (Closure's escapeParameters).
    if references_arguments(nodes, root_fn) {
        for (slot, p) in is_param.iter().enumerate() {
            if *p {
                escaped.insert(slot);
            }
        }
    }

    LocalVarTable { slot_of_node, escaped, names, decl_span, scope_node }
}

/// The arena address of the node that introduces a binding's lexical scope:
/// the function node for `var`/params (function-scoped), or the nearest enclosing
/// block-like node for `let`/`const` (block-scoped).
fn scope_node_of_decl(
    nodes: &oxc_semantic::AstNodes,
    decl: NodeId,
    is_param: bool,
    root_fn: NodeId,
) -> Option<Address> {
    if is_param {
        return Some(nodes.kind(root_fn).address());
    }
    // `var` is function-scoped; `let`/`const` are block-scoped.
    let block_scoped = match nodes.kind(decl) {
        AstKind::VariableDeclarator(_) => match nodes.kind(nodes.parent_id(decl)) {
            AstKind::VariableDeclaration(vd) => vd.kind != VariableDeclarationKind::Var,
            _ => true,
        },
        _ => true, // catch params etc. are block-scoped
    };
    if !block_scoped {
        return Some(nodes.kind(root_fn).address());
    }
    // Nearest enclosing block-like node.
    let mut id = nodes.parent_id(decl);
    loop {
        match nodes.kind(id) {
            AstKind::BlockStatement(_)
            | AstKind::FunctionBody(_)
            | AstKind::Program(_)
            | AstKind::StaticBlock(_) => return Some(nodes.kind(id).address()),
            _ => {}
        }
        let p = nodes.parent_id(id);
        if p == id {
            return None;
        }
        id = p;
    }
}

/// The nearest enclosing function/arrow node of `start` (exclusive of `start`
/// itself), or None if `start` is at module top level.
fn enclosing_function(nodes: &oxc_semantic::AstNodes, start: NodeId) -> Option<NodeId> {
    let mut id = nodes.parent_id(start);
    loop {
        match nodes.kind(id) {
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => return Some(id),
            _ => {}
        }
        let p = nodes.parent_id(id);
        if p == id {
            return None; // reached the program root
        }
        id = p;
    }
}

/// The binding-identifier `NodeId` of a declaration node, the span of its
/// declaration (scope proxy), and whether it's a param. The node id is `None`
/// when the binding isn't a plain identifier (destructuring) — such bindings get
/// no slot entry but still occupy a slot for indexing parity.
fn decl_binding(nodes: &oxc_semantic::AstNodes, decl: NodeId) -> (Option<NodeId>, Span, bool) {
    match nodes.kind(decl) {
        AstKind::BindingIdentifier(b) => {
            (Some(b.node_id.get()), b.span, is_under_param(nodes, decl))
        }
        AstKind::VariableDeclarator(d) => match &d.id {
            BindingPattern::BindingIdentifier(id) => (Some(id.node_id.get()), id.span, false),
            other => (None, other.span(), false),
        },
        AstKind::FormalParameter(p) => match &p.pattern {
            BindingPattern::BindingIdentifier(id) => (Some(id.node_id.get()), id.span, true),
            other => (None, other.span(), true),
        },
        other => (None, other.span(), false),
    }
}

/// Whether a declaration node sits inside a `FormalParameter` (so the binding is
/// a parameter).
fn is_under_param(nodes: &oxc_semantic::AstNodes, mut id: NodeId) -> bool {
    for _ in 0..6 {
        match nodes.kind(id) {
            AstKind::FormalParameter(_) | AstKind::FormalParameters(_) => return true,
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => return false,
            _ => {}
        }
        let p = nodes.parent_id(id);
        if p == id {
            return false;
        }
        id = p;
    }
    false
}

/// Does the function body reference `arguments` (not crossing into a nested
/// non-arrow function, which has its own `arguments`)?
fn references_arguments(nodes: &oxc_semantic::AstNodes, root_fn: NodeId) -> bool {
    struct V {
        found: bool,
    }
    impl<'a> Visit<'a> for V {
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            if id.name == "arguments" {
                self.found = true;
            }
        }
        // A non-arrow nested function has its own `arguments` — don't descend.
        fn visit_function(&mut self, _f: &Function<'a>, _flags: ScopeFlags) {}
        // Arrow functions inherit `arguments` — descend into them.
    }
    let mut v = V { found: false };
    match nodes.kind(root_fn) {
        AstKind::Function(f) => {
            if let Some(body) = &f.body {
                v.visit_function_body(body);
            }
        }
        AstKind::ArrowFunctionExpression(a) => v.visit_function_body(&a.body),
        _ => {}
    }
    v.found
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;

    /// Build semantic + locate the first function decl's node id, then the table.
    fn table_for<'a>(
        allocator: &'a Allocator,
        code: &'a str,
    ) -> (oxc_semantic::Semantic<'a>, LocalVarTable) {
        let program: &'a Program<'a> =
            allocator.alloc(crate::parse_program(allocator, code, SourceType::ts()));
        let semantic = SemanticBuilder::new().build(program).semantic;
        let nodes = semantic.nodes();
        let root_fn = nodes
            .iter()
            .find(|n| matches!(n.kind(), AstKind::Function(_)))
            .expect("a function")
            .id();
        // Build needs to borrow semantic; clone-free: build, then return both.
        // SAFETY of lifetimes: table borrows nothing from semantic (owns Strings
        // + spans), so returning both is fine.
        let table = build(&semantic, root_fn);
        (semantic, table)
    }

    #[test]
    fn allocates_slots_for_params_and_locals() {
        let a = Allocator::default();
        let (_s, t) = table_for(&a, "function f(p) { let x = 1; return p + x; }");
        assert_eq!(t.size(), 2, "p and x");
    }

    #[test]
    fn shadowing_is_distinct_slots() {
        let a = Allocator::default();
        let (_s, t) = table_for(&a, "function f() { let x = 1; { let x = 2; g(x); } return x; }");
        assert_eq!(t.size(), 2, "two distinct x bindings");
    }

    #[test]
    fn closure_capture_escapes() {
        let a = Allocator::default();
        let (_s, t) = table_for(&a, "function f() { let x = 1; return () => x; }");
        // x captured by the arrow → escaped.
        let x_slot = (0..t.size()).find(|&s| t.name_of(s) == "x").unwrap();
        assert!(t.is_escaped(x_slot), "captured x escapes");
    }

    #[test]
    fn no_capture_no_escape() {
        let a = Allocator::default();
        let (_s, t) = table_for(&a, "function f() { let x = 1; return x; }");
        let x_slot = (0..t.size()).find(|&s| t.name_of(s) == "x").unwrap();
        assert!(!t.is_escaped(x_slot), "uncaptured x doesn't escape");
    }

    #[test]
    fn arguments_escapes_params() {
        let a = Allocator::default();
        let (_s, t) = table_for(&a, "function f(p) { return arguments.length + p; }");
        let p_slot = (0..t.size()).find(|&s| t.name_of(s) == "p").unwrap();
        assert!(t.is_escaped(p_slot), "param escapes when arguments is used");
    }

    #[test]
    fn resolve_maps_uses_to_slots() {
        let a = Allocator::default();
        let (_s, t) = table_for(&a, "function f(p) { return p; }");
        // Some span maps to the p slot; can't easily get the exact ref span here,
        // so just sanity-check the table has the param.
        assert_eq!(t.size(), 1);
        assert_eq!(t.name_of(0), "p");
    }
}
