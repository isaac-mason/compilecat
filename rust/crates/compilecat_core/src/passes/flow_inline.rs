//! Port of `flow-sensitive-inline-variables.ts` (jscomp
//! `FlowSensitiveInlineVariables`).
//!
//! Replaces a single read of a local with that local's defining RHS when:
//!   1. exactly one definition must reach the read,
//!   2. that def's RHS has exactly one reachable use (this read),
//!   3. the RHS is pure and a safe shape (no member/new/array/object/class/regex),
//!   4. no interfering side effect lies between def and use (intra-expression
//!      pre/post checks + an inter-node CFG path check),
//!   5. the use is not inside a loop,
//!   6. every free local the RHS reads is still in lexical scope at the use.
//!
//! Variable identity is by binding *slot* (never by name) — see
//! `local_var_table`. Drives must-reaching-def + maybe-reaching-use + the
//! `some_path_satisfies` graph utility.
//!
//! Analyze→apply split (oxc can't mutate through the CFG's immutable borrow):
//! `analyze` builds a node-id-keyed substitution map (use → cloned RHS) plus a
//! set of def-drops; `apply` (a `VisitMut`) performs them after borrows drop.

use std::collections::{HashMap, HashSet};

use oxc_allocator::{Address, Allocator, CloneIn, GetAddress, UnstableAddress};
use oxc_ast::ast::*;
use oxc_ast::{AstBuilder, AstKind};
use oxc_ast_visit::{walk_mut, Visit, VisitMut};
use oxc_semantic::{AstNodes, NodeId, ScopeFlags};

use crate::analysis::cfg::{self, ControlFlowGraph};
use crate::analysis::graph::some_path_satisfies;
use crate::analysis::local_var_table::{self, LocalVarTable};
use crate::analysis::reaching::{
    depends_on_outer_scope_vars, run_maybe_reaching, run_must_reaching, Definition,
};
use crate::passes::util::is_pure;

// ── public entry ─────────────────────────────────────────────────────────────

/// Per-function driver: for each opted-in (`touched`) function, build a CFG +
/// reaching analyses and inline single-def→single-use variables. Analyze
/// (immutable) → node-id-keyed substitutions + drops, applied once after.
pub fn run<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    touched: &HashSet<u32>,
) -> u32 {
    use oxc_semantic::SemanticBuilder;

    // Phase A — analysis (borrows program via semantic): emit owned, node-id-keyed
    // decisions only (no AST refs), so the immutable borrow ends with the block.
    let (use_to_src, drops) = {
        let semantic = SemanticBuilder::new().build(&*program).semantic;
        let nodes = semantic.nodes();
        // Address → NodeId, so a CFG node (keyed by Address) can be mapped back
        // to its semantic node for ancestry/sibling queries.
        let mut addr_to_nid: HashMap<Address, NodeId> = HashMap::new();
        for n in nodes.iter() {
            addr_to_nid.insert(n.kind().address(), n.id());
        }

        let mut use_to_src: HashMap<NodeId, NodeId> = HashMap::new();
        let mut drops = Drops::default();
        for node in nodes.iter() {
            let (body, fn_node) = match node.kind() {
                AstKind::Function(f) => match f.body.as_ref() {
                    Some(b) if touched.contains(&f.span.start) => (&**b, node.id()),
                    _ => continue,
                },
                AstKind::ArrowFunctionExpression(a) if touched.contains(&a.span.start) => {
                    (&*a.body, node.id())
                }
                _ => continue,
            };
            let Some(cfg) = cfg::build(AstKind::FunctionBody(body)) else { continue };
            let table = local_var_table::build(&semantic, fn_node);
            if table.size() == 0 {
                continue;
            }
            analyze_fn(
                nodes,
                &addr_to_nid,
                fn_node,
                &cfg,
                &table,
                &mut use_to_src,
                &mut drops,
            );
        }
        (use_to_src, drops)
    };

    if use_to_src.is_empty() && drops.is_empty() {
        return 0;
    }

    // Phase B — clone each def RHS (a fresh borrow with no semantic, so the
    // resulting `Expression<'a>` arena clones don't pin `program`'s borrow).
    let mut subs: HashMap<NodeId, Expression<'a>> = HashMap::new();
    {
        let needed: HashSet<NodeId> = use_to_src.values().copied().collect();
        let mut src_to_expr: HashMap<NodeId, Expression<'a>> = HashMap::new();
        let mut col = RhsCollector { allocator, needed: &needed, out: &mut src_to_expr };
        col.visit_program(&*program);
        for (&use_nid, &src_nid) in &use_to_src {
            if let Some(e) = src_to_expr.get(&src_nid) {
                subs.insert(use_nid, e.clone_in(allocator));
            }
        }
    }

    // Phase C — apply substitutions + def-drops.
    let mut a = Applier { ast: AstBuilder::new(allocator), subs, drops, count: 0 };
    a.visit_program(program);
    a.count
}

/// Clones the RHS of each declarator/assignment whose node id is `needed`.
struct RhsCollector<'n, 'o, 'a> {
    allocator: &'a Allocator,
    needed: &'n HashSet<NodeId>,
    out: &'o mut HashMap<NodeId, Expression<'a>>,
}

impl<'a> Visit<'a> for RhsCollector<'_, '_, 'a> {
    fn visit_variable_declarator(&mut self, d: &VariableDeclarator<'a>) {
        if self.needed.contains(&d.node_id.get()) {
            if let Some(init) = &d.init {
                self.out.insert(d.node_id.get(), init.clone_in(self.allocator));
            }
        }
        oxc_ast_visit::walk::walk_variable_declarator(self, d);
    }
    fn visit_assignment_expression(&mut self, a: &AssignmentExpression<'a>) {
        if self.needed.contains(&a.node_id.get()) {
            self.out.insert(a.node_id.get(), a.right.clone_in(self.allocator));
        }
        oxc_ast_visit::walk::walk_assignment_expression(self, a);
    }
}

#[derive(Default)]
struct Drops {
    /// ExpressionStatement node id → remove (assign-def drop).
    expr_stmt: HashSet<NodeId>,
    /// VariableDeclaration node id → remove whole (const single-declarator drop).
    decl_whole: HashSet<NodeId>,
    /// VariableDeclarator node id → splice out (const multi-declarator drop).
    declarator: HashSet<NodeId>,
    /// VariableDeclarator node id → null its init (let/var drop, keep binding).
    null_init: HashSet<NodeId>,
}

impl Drops {
    fn is_empty(&self) -> bool {
        self.expr_stmt.is_empty()
            && self.decl_whole.is_empty()
            && self.declarator.is_empty()
            && self.null_init.is_empty()
    }
}

// ── per-function analysis ────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn analyze_fn<'a>(
    nodes: &AstNodes<'a>,
    addr_to_nid: &HashMap<Address, NodeId>,
    fn_node: NodeId,
    cfg: &ControlFlowGraph<'a>,
    table: &LocalVarTable,
    use_to_src: &mut HashMap<NodeId, NodeId>,
    drops: &mut Drops,
) {
    let fn_root = cfg.node(cfg.entry).map(|k| k.address());
    let Some(fn_root) = fn_root else { return };
    let Some(must) = run_must_reaching(cfg, table, fn_root) else { return };
    let Some(maybe) = run_maybe_reaching(cfg, table) else { return };

    // Gather candidate (slot, def, use, use-cfg-node) tuples.
    let mut candidates: Vec<Candidate> = Vec::new();
    for id in 0..cfg.node_count() {
        if id == cfg.entry || id == cfg.implicit_return {
            continue;
        }
        let Some(value) = cfg.node(id) else { continue };
        read_idents_in_value(value, &mut |idref| {
            let Some(slot) = table.resolve(idref.node_id.get()) else { return };
            if table.is_escaped(slot) {
                return;
            }
            let Some(def) = must.get_def(slot, id) else { return };
            if def.node == fn_root {
                return; // parameter sentinel
            }
            if depends_on_outer_scope_vars(def) {
                return;
            }
            candidates.push(Candidate {
                slot,
                def: def.clone(),
                use_nid: idref.node_id.get(),
                use_cfg: id,
            });
        });
    }

    // Collect all viable decisions first, then drop any whose use-site sits
    // inside another decision's dropped subtree. Applying both in one analyze→
    // apply pass corrupts: dropping the outer node removes the inner use's
    // container, orphaning its substitution (e.g. `const r = _t; return r` with
    // `_t = v` — inlining `r` drops `const r = _t`, which holds `_t`'s only use,
    // so inlining `_t` then writes into a deleted node → `return undefined`).
    // The outer simplify fixpoint re-runs flow-inline and resolves the deferred
    // ones one link per iteration (Closure's iterate-to-fixpoint model).
    let mut decisions: Vec<(NodeId, NodeId, DefDrop)> = Vec::new();
    for c in candidates {
        if let Some((src_nid, drop)) =
            can_inline(nodes, addr_to_nid, fn_node, cfg, table, &maybe, &c)
        {
            decisions.push((c.use_nid, src_nid, drop));
        }
    }
    let drop_nodes: HashSet<NodeId> = decisions.iter().map(|(_, _, d)| d.node()).collect();
    for (use_nid, src_nid, drop) in decisions {
        // Defer if this use is a descendant of any decision's dropped subtree.
        if nodes.ancestor_ids(use_nid).any(|a| drop_nodes.contains(&a)) {
            continue;
        }
        use_to_src.insert(use_nid, src_nid);
        match drop {
            DefDrop::ExprStmt(n) => {
                drops.expr_stmt.insert(n);
            }
            DefDrop::DeclWhole(n) => {
                drops.decl_whole.insert(n);
            }
            DefDrop::Declarator(n) => {
                drops.declarator.insert(n);
            }
            DefDrop::NullInit(n) => {
                drops.null_init.insert(n);
            }
        }
    }
}

struct Candidate {
    slot: usize,
    def: Definition,
    use_nid: NodeId,
    use_cfg: usize,
}

enum DefDrop {
    ExprStmt(NodeId),
    DeclWhole(NodeId),
    Declarator(NodeId),
    NullInit(NodeId),
}

impl DefDrop {
    fn node(&self) -> NodeId {
        match *self {
            DefDrop::ExprStmt(n)
            | DefDrop::DeclWhole(n)
            | DefDrop::Declarator(n)
            | DefDrop::NullInit(n) => n,
        }
    }
}

// ── canInline ────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn can_inline<'a>(
    nodes: &AstNodes<'a>,
    addr_to_nid: &HashMap<Address, NodeId>,
    fn_node: NodeId,
    cfg: &ControlFlowGraph<'a>,
    table: &LocalVarTable,
    maybe: &crate::analysis::reaching::MaybeResult,
    c: &Candidate,
) -> Option<(NodeId, DefDrop)> {
    let def_cfg = cfg.id_of_addr(c.def.node)?;
    let def_value = cfg.node(def_cfg)?;
    let use_value = cfg.node(c.use_cfg)?;

    // 1. Locate the exact declarator / assignment producing the def.
    let loc = locate_def_expr(nodes, def_value, c.slot, table)?;
    if let DefLocKind::Assign { top_level: false, .. } = loc.kind {
        return None;
    }
    let rhs = loc.rhs;

    // 1b. RHS pure.
    if !is_pure(rhs) {
        return None;
    }
    // 2. RHS shape safe.
    if !is_rhs_safe_to_inline(rhs) {
        return None;
    }

    // 3. Pre/post intra-expression side effects on slots the def depends on.
    let slots = &c.def.depends;
    if check_post(def_value, loc.expr_addr, slots, table)
        || check_pre(use_value, use_node_addr(nodes, c.use_nid), slots, table)
    {
        return None;
    }

    // 4. Exactly one syntactic use of the slot inside the use's CFG node.
    if count_slot_uses(use_value, c.slot, table) != 1 {
        return None;
    }

    // 5. Use not inside a loop.
    if is_within_loop(nodes, c.use_nid, fn_node) {
        return None;
    }

    // 6. Exactly one use reaches after the def, and it's this use.
    if maybe.unique_use_after(c.slot, def_cfg) != Some(c.use_nid) {
        return None;
    }

    // 7. Path side-effect check, unless def and use cfg nodes are adjacent siblings.
    if !are_adjacent_siblings(nodes, addr_to_nid, c.def.node, use_value.address()) {
        let interfering = |gid: usize| -> bool {
            match cfg.node(gid) {
                Some(k) => subtree_has_interfering(k, slots, table),
                None => false,
            }
        };
        if some_path_satisfies(&cfg.graph, def_cfg, c.use_cfg, false, interfering) {
            return None;
        }
    }

    // 8. Scope visibility — every free local the RHS reads must be in scope at use.
    if !rhs_identifiers_in_scope_at(nodes, addr_to_nid, rhs, c.use_nid, table) {
        return None;
    }

    let (src_nid, drop) = match loc.kind {
        DefLocKind::Assign { stmt_nid, assign_nid, .. } => (assign_nid, DefDrop::ExprStmt(stmt_nid)),
        DefLocKind::Var { decl_const, decl_nid, single, declarator_nid } => {
            let drop = if decl_const {
                if single {
                    DefDrop::DeclWhole(decl_nid)
                } else {
                    DefDrop::Declarator(declarator_nid)
                }
            } else {
                DefDrop::NullInit(declarator_nid)
            };
            (declarator_nid, drop)
        }
    };
    Some((src_nid, drop))
}

// ── locate def ───────────────────────────────────────────────────────────────

struct DefLoc<'a> {
    kind: DefLocKind,
    rhs: &'a Expression<'a>,
    /// Address of the declarator / assignment node (for pre/post indexing).
    expr_addr: Address,
}

enum DefLocKind {
    Var { decl_const: bool, decl_nid: NodeId, single: bool, declarator_nid: NodeId },
    Assign { top_level: bool, stmt_nid: NodeId, assign_nid: NodeId },
}

/// Find the `VariableDeclarator` / top-level `AssignmentExpression` inside the
/// def's CFG-node value that writes `slot`.
fn locate_def_expr<'a>(
    nodes: &AstNodes<'a>,
    value: AstKind<'a>,
    slot: usize,
    table: &LocalVarTable,
) -> Option<DefLoc<'a>> {
    match value {
        AstKind::VariableDeclaration(vd) => {
            let single = vd.declarations.len() == 1;
            let decl_const = vd.kind == VariableDeclarationKind::Const;
            for d in &vd.declarations {
                if let (BindingPattern::BindingIdentifier(id), Some(init)) = (&d.id, &d.init) {
                    if table.resolve(id.node_id.get()) == Some(slot) {
                        return Some(DefLoc {
                            kind: DefLocKind::Var {
                                decl_const,
                                decl_nid: vd.node_id.get(),
                                single,
                                declarator_nid: d.node_id.get(),
                            },
                            rhs: init,
                            expr_addr: d.unstable_address(),
                        });
                    }
                }
            }
            None
        }
        AstKind::ExpressionStatement(es) => {
            let stmt_nid = es.node_id.get();
            // top-level iff the statement's expression IS the assignment.
            let assign = find_assign_to_slot(&es.expression, slot, table)?;
            let top_level = matches!(&es.expression, Expression::AssignmentExpression(a)
                if std::ptr::eq(&**a, assign));
            Some(DefLoc {
                kind: DefLocKind::Assign { top_level, stmt_nid, assign_nid: assign.node_id.get() },
                rhs: &assign.right,
                expr_addr: assign.unstable_address(),
            })
        }
        _ => {
            // Other CFG-node shapes (e.g. a bare assignment used as a for-update).
            let _ = nodes;
            None
        }
    }
}

/// First `=`-assignment to `slot` in `e` (top-level of the expression tree;
/// recurses through sequence/paren only — matching where a CFG-node assign sits).
fn find_assign_to_slot<'a>(
    e: &'a Expression<'a>,
    slot: usize,
    table: &LocalVarTable,
) -> Option<&'a AssignmentExpression<'a>> {
    match e {
        Expression::AssignmentExpression(a) => {
            if a.operator == AssignmentOperator::Assign {
                if let AssignmentTarget::AssignmentTargetIdentifier(id) = &a.left {
                    if table.resolve(id.node_id.get()) == Some(slot) {
                        return Some(a);
                    }
                }
            }
            None
        }
        Expression::SequenceExpression(s) => {
            s.expressions.iter().find_map(|e| find_assign_to_slot(e, slot, table))
        }
        Expression::ParenthesizedExpression(p) => find_assign_to_slot(&p.expression, slot, table),
        _ => None,
    }
}

// ── isRhsSafeToInline ────────────────────────────────────────────────────────

fn is_rhs_safe_to_inline(rhs: &Expression) -> bool {
    struct V {
        unsafe_: bool,
    }
    impl<'a> Visit<'a> for V {
        fn visit_function(&mut self, _f: &Function<'a>, _: ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {}
        fn visit_expression(&mut self, e: &Expression<'a>) {
            if self.unsafe_ {
                return;
            }
            match e {
                Expression::StaticMemberExpression(_)
                | Expression::ComputedMemberExpression(_)
                | Expression::PrivateFieldExpression(_)
                | Expression::ArrayExpression(_)
                | Expression::ObjectExpression(_)
                | Expression::RegExpLiteral(_)
                | Expression::NewExpression(_)
                | Expression::ClassExpression(_) => {
                    self.unsafe_ = true;
                    return;
                }
                _ => {}
            }
            oxc_ast_visit::walk::walk_expression(self, e);
        }
    }
    let mut v = V { unsafe_: false };
    v.visit_expression(rhs);
    !v.unsafe_
}

// ── intra-expression side-effect checks (pre/post) ───────────────────────────
//
// Pre-order enter/leave indices over the CFG-node value subtree give a clean
// formulation of Closure's right/left-sibling-up-the-chain walks:
//   post(n) = ∃ interfering m with enter[m] > leave[n]   (evaluated after n)
//   pre(n)  = ∃ interfering m with leave[m] < enter[n]   (evaluated before n)
// where "interfering" = a call/new, `delete`, or an assign/update to a checked
// slot, excluding nested-function bodies.

struct Interfering {
    enter: u32,
    leave: u32,
    /// None = unconditional (call/new/delete); Some(slot) = write to that slot.
    slot: Option<usize>,
}

struct Indexer<'t> {
    order: u32,
    enter: HashMap<Address, u32>,
    leave: HashMap<Address, u32>,
    fn_depth: u32,
    interfering: Vec<Interfering>,
    table: &'t LocalVarTable,
}

impl<'a> Visit<'a> for Indexer<'_> {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        let addr = kind.address();
        let e = self.order;
        self.order += 1;
        self.enter.insert(addr, e);
        if self.fn_depth == 0 {
            let interfering_slot: Option<Option<usize>> = match kind {
                AstKind::CallExpression(_) | AstKind::NewExpression(_) => Some(None),
                AstKind::UnaryExpression(u) if u.operator == UnaryOperator::Delete => Some(None),
                AstKind::AssignmentExpression(a) => match &a.left {
                    AssignmentTarget::AssignmentTargetIdentifier(id) => {
                        self.table.resolve(id.node_id.get()).map(Some)
                    }
                    _ => None,
                },
                AstKind::UpdateExpression(u) => match &u.argument {
                    SimpleAssignmentTarget::AssignmentTargetIdentifier(id) => {
                        self.table.resolve(id.node_id.get()).map(Some)
                    }
                    _ => None,
                },
                _ => None,
            };
            if let Some(slot) = interfering_slot {
                self.interfering.push(Interfering { enter: e, leave: 0, slot });
            }
        }
        if matches!(kind, AstKind::Function(_) | AstKind::ArrowFunctionExpression(_)) {
            self.fn_depth += 1;
        }
    }

    fn leave_node(&mut self, kind: AstKind<'a>) {
        if matches!(kind, AstKind::Function(_) | AstKind::ArrowFunctionExpression(_)) {
            self.fn_depth -= 1;
        }
        let addr = kind.address();
        let l = self.order;
        self.order += 1;
        self.leave.insert(addr, l);
        // Backfill the leave index for an interfering record opened at this node.
        if let Some(&en) = self.enter.get(&addr) {
            for rec in self.interfering.iter_mut() {
                if rec.enter == en {
                    rec.leave = l;
                }
            }
        }
    }
}

fn index_tree<'t>(root: AstKind, table: &'t LocalVarTable) -> Indexer<'t> {
    let mut ix = Indexer {
        order: 0,
        enter: HashMap::new(),
        leave: HashMap::new(),
        fn_depth: 0,
        interfering: Vec::new(),
        table,
    };
    // Walk the specific node kind.
    walk_kind(&mut ix, root);
    ix
}

fn walk_kind<'a>(v: &mut Indexer<'_>, kind: AstKind<'a>) {
    match kind {
        AstKind::ExpressionStatement(s) => v.visit_expression_statement(s),
        AstKind::VariableDeclaration(s) => v.visit_variable_declaration(s),
        AstKind::ReturnStatement(s) => v.visit_return_statement(s),
        AstKind::ThrowStatement(s) => v.visit_throw_statement(s),
        AstKind::IfStatement(s) => v.visit_expression(&s.test),
        AstKind::WhileStatement(s) => v.visit_expression(&s.test),
        AstKind::DoWhileStatement(s) => v.visit_expression(&s.test),
        AstKind::ForStatement(s) => {
            if let Some(t) = &s.test {
                v.visit_expression(t);
            }
        }
        AstKind::SwitchStatement(s) => v.visit_expression(&s.discriminant),
        AstKind::SwitchCase(s) => {
            if let Some(t) = &s.test {
                v.visit_expression(t);
            }
        }
        AstKind::AssignmentExpression(a) => v.visit_assignment_expression(a),
        AstKind::UpdateExpression(u) => v.visit_update_expression(u),
        AstKind::SequenceExpression(s) => v.visit_sequence_expression(s),
        AstKind::CallExpression(c) => v.visit_call_expression(c),
        _ => {}
    }
}

fn check_post(root: AstKind, n: Address, slots: &HashSet<usize>, table: &LocalVarTable) -> bool {
    let ix = index_tree(root, table);
    let Some(&leave_n) = ix.leave.get(&n) else { return false };
    ix.interfering.iter().any(|r| r.enter > leave_n && interfering_hits(r, slots))
}

fn check_pre(
    root: AstKind,
    n: Option<Address>,
    slots: &HashSet<usize>,
    table: &LocalVarTable,
) -> bool {
    let Some(n) = n else { return false };
    let ix = index_tree(root, table);
    let Some(&enter_n) = ix.enter.get(&n) else { return false };
    ix.interfering.iter().any(|r| r.leave < enter_n && interfering_hits(r, slots))
}

fn interfering_hits(r: &Interfering, slots: &HashSet<usize>) -> bool {
    match r.slot {
        None => true,                    // call / new / delete
        Some(s) => slots.contains(&s),   // assign/update to a depended-on slot
    }
}

/// Whole-subtree interfering check (no positional info) — the CFG path predicate.
fn subtree_has_interfering(value: AstKind, slots: &HashSet<usize>, table: &LocalVarTable) -> bool {
    struct V<'t> {
        yes: bool,
        slots: &'t HashSet<usize>,
        table: &'t LocalVarTable,
    }
    impl<'a> Visit<'a> for V<'_> {
        fn visit_function(&mut self, _f: &Function<'a>, _: ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _a: &ArrowFunctionExpression<'a>) {}
        fn visit_expression(&mut self, e: &Expression<'a>) {
            if self.yes {
                return;
            }
            match e {
                Expression::CallExpression(_) | Expression::NewExpression(_) => {
                    self.yes = true;
                    return;
                }
                Expression::UnaryExpression(u) if u.operator == UnaryOperator::Delete => {
                    self.yes = true;
                    return;
                }
                Expression::AssignmentExpression(a) => {
                    if let AssignmentTarget::AssignmentTargetIdentifier(id) = &a.left {
                        if let Some(s) = self.table.resolve(id.node_id.get()) {
                            if self.slots.contains(&s) {
                                self.yes = true;
                                return;
                            }
                        }
                    }
                }
                Expression::UpdateExpression(u) => {
                    if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = &u.argument {
                        if let Some(s) = self.table.resolve(id.node_id.get()) {
                            if self.slots.contains(&s) {
                                self.yes = true;
                                return;
                            }
                        }
                    }
                }
                _ => {}
            }
            oxc_ast_visit::walk::walk_expression(self, e);
        }
    }
    let mut v = V { yes: false, slots, table };
    walk_value_for_interfering(&mut v, value);
    v.yes
}

fn walk_value_for_interfering<'a>(v: &mut impl Visit<'a>, value: AstKind<'a>) {
    // The CFG node value is a statement or expression; visit its expressions.
    match value {
        AstKind::ExpressionStatement(s) => v.visit_expression(&s.expression),
        AstKind::VariableDeclaration(vd) => {
            for d in &vd.declarations {
                if let Some(i) = &d.init {
                    v.visit_expression(i);
                }
            }
        }
        AstKind::ReturnStatement(s) => {
            if let Some(a) = &s.argument {
                v.visit_expression(a);
            }
        }
        AstKind::ThrowStatement(s) => v.visit_expression(&s.argument),
        AstKind::IfStatement(s) => v.visit_expression(&s.test),
        AstKind::WhileStatement(s) => v.visit_expression(&s.test),
        AstKind::DoWhileStatement(s) => v.visit_expression(&s.test),
        AstKind::ForStatement(s) => {
            if let Some(t) = &s.test {
                v.visit_expression(t);
            }
        }
        AstKind::SwitchStatement(s) => v.visit_expression(&s.discriminant),
        AstKind::SwitchCase(s) => {
            if let Some(t) = &s.test {
                v.visit_expression(t);
            }
        }
        AstKind::AssignmentExpression(a) => v.visit_assignment_expression(a),
        AstKind::UpdateExpression(u) => v.visit_update_expression(u),
        AstKind::SequenceExpression(s) => v.visit_sequence_expression(s),
        AstKind::CallExpression(c) => v.visit_call_expression(c),
        _ => {}
    }
}

// ── identifier-read traversal ────────────────────────────────────────────────

fn read_idents_in_value<'a>(value: AstKind<'a>, f: &mut impl FnMut(&IdentifierReference<'a>)) {
    match value {
        AstKind::ExpressionStatement(s) => walk_reads(&s.expression, f),
        AstKind::VariableDeclaration(vd) => {
            for d in &vd.declarations {
                if let Some(i) = &d.init {
                    walk_reads(i, f);
                }
            }
        }
        AstKind::ReturnStatement(s) => {
            if let Some(a) = &s.argument {
                walk_reads(a, f);
            }
        }
        AstKind::ThrowStatement(s) => walk_reads(&s.argument, f),
        AstKind::IfStatement(s) => walk_reads(&s.test, f),
        AstKind::WhileStatement(s) => walk_reads(&s.test, f),
        AstKind::DoWhileStatement(s) => walk_reads(&s.test, f),
        AstKind::ForStatement(s) => {
            if let Some(t) = &s.test {
                walk_reads(t, f);
            }
        }
        AstKind::SwitchStatement(s) => walk_reads(&s.discriminant, f),
        AstKind::SwitchCase(s) => {
            if let Some(t) = &s.test {
                walk_reads(t, f);
            }
        }
        AstKind::AssignmentExpression(a) => {
            walk_target_reads(&a.left, f);
            walk_reads(&a.right, f);
        }
        AstKind::UpdateExpression(u) => walk_simple_target_reads(&u.argument, f),
        AstKind::SequenceExpression(s) => {
            for e in &s.expressions {
                walk_reads(e, f);
            }
        }
        AstKind::CallExpression(c) => {
            walk_reads(&c.callee, f);
            walk_arg_reads(&c.arguments, f);
        }
        AstKind::IdentifierReference(id) => f(id),
        AstKind::StaticMemberExpression(m) => walk_reads(&m.object, f),
        AstKind::ComputedMemberExpression(m) => {
            walk_reads(&m.object, f);
            walk_reads(&m.expression, f);
        }
        AstKind::BinaryExpression(b) => {
            walk_reads(&b.left, f);
            walk_reads(&b.right, f);
        }
        _ => {}
    }
}

fn walk_reads<'a>(e: &Expression<'a>, f: &mut impl FnMut(&IdentifierReference<'a>)) {
    match e {
        Expression::Identifier(id) => f(id),
        Expression::BinaryExpression(b) => {
            walk_reads(&b.left, f);
            walk_reads(&b.right, f);
        }
        Expression::LogicalExpression(l) => {
            walk_reads(&l.left, f);
            walk_reads(&l.right, f);
        }
        Expression::UnaryExpression(u) => walk_reads(&u.argument, f),
        Expression::ConditionalExpression(c) => {
            walk_reads(&c.test, f);
            walk_reads(&c.consequent, f);
            walk_reads(&c.alternate, f);
        }
        Expression::SequenceExpression(s) => {
            for e in &s.expressions {
                walk_reads(e, f);
            }
        }
        Expression::ParenthesizedExpression(p) => walk_reads(&p.expression, f),
        Expression::CallExpression(c) => {
            walk_reads(&c.callee, f);
            walk_arg_reads(&c.arguments, f);
        }
        Expression::NewExpression(c) => {
            walk_reads(&c.callee, f);
            walk_arg_reads(&c.arguments, f);
        }
        Expression::ChainExpression(c) => match &c.expression {
            ChainElement::CallExpression(inner) => {
                walk_reads(&inner.callee, f);
                walk_arg_reads(&inner.arguments, f);
            }
            ChainElement::StaticMemberExpression(m) => walk_reads(&m.object, f),
            ChainElement::ComputedMemberExpression(m) => {
                walk_reads(&m.object, f);
                walk_reads(&m.expression, f);
            }
            ChainElement::PrivateFieldExpression(m) => walk_reads(&m.object, f),
            _ => {}
        },
        Expression::StaticMemberExpression(m) => walk_reads(&m.object, f),
        Expression::ComputedMemberExpression(m) => {
            walk_reads(&m.object, f);
            walk_reads(&m.expression, f);
        }
        Expression::PrivateFieldExpression(m) => walk_reads(&m.object, f),
        Expression::AssignmentExpression(a) => {
            walk_target_reads(&a.left, f);
            walk_reads(&a.right, f);
        }
        Expression::UpdateExpression(u) => walk_simple_target_reads(&u.argument, f),
        Expression::TemplateLiteral(t) => {
            for e in &t.expressions {
                walk_reads(e, f);
            }
        }
        Expression::TaggedTemplateExpression(t) => {
            walk_reads(&t.tag, f);
            for e in &t.quasi.expressions {
                walk_reads(e, f);
            }
        }
        Expression::ArrayExpression(a) => {
            for el in &a.elements {
                match el {
                    ArrayExpressionElement::SpreadElement(s) => walk_reads(&s.argument, f),
                    ArrayExpressionElement::Elision(_) => {}
                    _ => {
                        if let Some(e) = el.as_expression() {
                            walk_reads(e, f);
                        }
                    }
                }
            }
        }
        Expression::ObjectExpression(o) => {
            for p in &o.properties {
                match p {
                    ObjectPropertyKind::ObjectProperty(prop) => {
                        if prop.computed {
                            if let PropertyKey::StaticIdentifier(_) = &prop.key {
                            } else if let Some(e) = prop.key.as_expression() {
                                walk_reads(e, f);
                            }
                        }
                        walk_reads(&prop.value, f);
                    }
                    ObjectPropertyKind::SpreadProperty(s) => walk_reads(&s.argument, f),
                }
            }
        }
        // TS type-only wrappers carry the inner expression's reads and persist in
        // TS→TS output — recurse into the wrapped expression.
        Expression::TSAsExpression(e) => walk_reads(&e.expression, f),
        Expression::TSSatisfiesExpression(e) => walk_reads(&e.expression, f),
        Expression::TSNonNullExpression(e) => walk_reads(&e.expression, f),
        Expression::TSTypeAssertion(e) => walk_reads(&e.expression, f),
        Expression::TSInstantiationExpression(e) => walk_reads(&e.expression, f),
        Expression::ImportExpression(e) => {
            walk_reads(&e.source, f);
            if let Some(o) = &e.options {
                walk_reads(o, f);
            }
        }
        // literals, functions, classes/JSX (cfg bails), this, super,
        // await/yield (cfg bails) → no reads.
        _ => {}
    }
}

/// Reads in call/new arguments, including spread args (`f(...x)`) — `Argument`'s
/// `as_expression()` returns `None` for a `SpreadElement`, so a plain
/// `as_expression()` loop silently drops spread reads.
fn walk_arg_reads<'a>(
    args: &oxc_allocator::Vec<'a, Argument<'a>>,
    f: &mut impl FnMut(&IdentifierReference<'a>),
) {
    for arg in args {
        match arg {
            Argument::SpreadElement(s) => walk_reads(&s.argument, f),
            _ => {
                if let Some(e) = arg.as_expression() {
                    walk_reads(e, f);
                }
            }
        }
    }
}

/// Reads inside an assignment *target* — only member objects/computed keys are
/// reads; the target identifier itself is a write. Destructuring targets are
/// conservatively skipped (never emits a write identifier as a read).
fn walk_target_reads<'a>(t: &AssignmentTarget<'a>, f: &mut impl FnMut(&IdentifierReference<'a>)) {
    if let Some(m) = t.as_member_expression() {
        walk_member_object_reads(m, f);
    }
}

fn walk_simple_target_reads<'a>(
    t: &SimpleAssignmentTarget<'a>,
    f: &mut impl FnMut(&IdentifierReference<'a>),
) {
    if let Some(m) = t.as_member_expression() {
        walk_member_object_reads(m, f);
    }
}

fn walk_member_object_reads<'a>(
    m: &MemberExpression<'a>,
    f: &mut impl FnMut(&IdentifierReference<'a>),
) {
    match m {
        MemberExpression::ComputedMemberExpression(c) => {
            walk_reads(&c.object, f);
            walk_reads(&c.expression, f);
        }
        MemberExpression::StaticMemberExpression(s) => walk_reads(&s.object, f),
        MemberExpression::PrivateFieldExpression(p) => walk_reads(&p.object, f),
    }
}

fn count_slot_uses(value: AstKind, slot: usize, table: &LocalVarTable) -> usize {
    let mut count = 0;
    read_idents_in_value(value, &mut |id| {
        if table.resolve(id.node_id.get()) == Some(slot) {
            count += 1;
        }
    });
    count
}

// ── scope / loop / adjacency queries (via semantic parent chain) ─────────────

fn use_node_addr(nodes: &AstNodes, use_nid: NodeId) -> Option<Address> {
    Some(nodes.kind(use_nid).address())
}

fn is_within_loop(nodes: &AstNodes, use_nid: NodeId, fn_node: NodeId) -> bool {
    let mut id = nodes.parent_id(use_nid);
    loop {
        if id == fn_node {
            return false;
        }
        match nodes.kind(id) {
            AstKind::WhileStatement(_)
            | AstKind::DoWhileStatement(_)
            | AstKind::ForStatement(_)
            | AstKind::ForInStatement(_)
            | AstKind::ForOfStatement(_) => return true,
            _ => {}
        }
        let p = nodes.parent_id(id);
        if p == id {
            return false;
        }
        id = p;
    }
}

fn are_adjacent_siblings(
    nodes: &AstNodes,
    addr_to_nid: &HashMap<Address, NodeId>,
    def_addr: Address,
    use_addr: Address,
) -> bool {
    let Some(&def_nid) = addr_to_nid.get(&def_addr) else { return false };
    let Some(&use_nid) = addr_to_nid.get(&use_addr) else { return false };
    let dp = nodes.parent_id(def_nid);
    let up = nodes.parent_id(use_nid);
    if dp != up {
        return false;
    }
    // Find positions in the parent's statement list (consecutive → adjacent).
    let list = stmt_list(nodes.kind(dp));
    let Some(list) = list else { return false };
    let di = list.iter().position(|s| s.address() == def_addr);
    let ui = list.iter().position(|s| s.address() == use_addr);
    matches!((di, ui), (Some(d), Some(u)) if u == d + 1)
}

fn stmt_list<'a>(kind: AstKind<'a>) -> Option<&'a oxc_allocator::Vec<'a, Statement<'a>>> {
    match kind {
        AstKind::BlockStatement(b) => Some(&b.body),
        AstKind::Program(p) => Some(&p.body),
        AstKind::FunctionBody(b) => Some(&b.statements),
        AstKind::SwitchCase(c) => Some(&c.consequent),
        _ => None,
    }
}

/// Condition 8: every free local Identifier the RHS reads must resolve to a slot
/// whose binding scope node is an ancestor of the use site.
fn rhs_identifiers_in_scope_at(
    nodes: &AstNodes,
    addr_to_nid: &HashMap<Address, NodeId>,
    rhs: &Expression,
    use_nid: NodeId,
    table: &LocalVarTable,
) -> bool {
    let use_ancestors = ancestor_addrs(nodes, use_nid);
    let mut ok = true;
    walk_reads(rhs, &mut |id| {
        if !ok {
            return;
        }
        let Some(slot) = table.resolve(id.node_id.get()) else { return }; // outer/global → safe
        let Some(scope_addr) = table.scope_node_of(slot) else {
            ok = false;
            return;
        };
        let _ = addr_to_nid;
        if !use_ancestors.contains(&scope_addr) {
            ok = false;
        }
    });
    ok
}

fn ancestor_addrs(nodes: &AstNodes, start: NodeId) -> HashSet<Address> {
    let mut out = HashSet::new();
    let mut id = start;
    loop {
        out.insert(nodes.kind(id).address());
        let p = nodes.parent_id(id);
        if p == id {
            break;
        }
        id = p;
    }
    out
}

// ── apply ────────────────────────────────────────────────────────────────────

struct Applier<'a> {
    ast: AstBuilder<'a>,
    subs: HashMap<NodeId, Expression<'a>>,
    drops: Drops,
    count: u32,
}

impl<'a> VisitMut<'a> for Applier<'a> {
    fn visit_expression(&mut self, expr: &mut Expression<'a>) {
        if let Expression::Identifier(id) = &*expr {
            if let Some(rep) = self.subs.remove(&id.node_id.get()) {
                *expr = rep;
                self.count += 1;
                return;
            }
        }
        walk_mut::walk_expression(self, expr);
    }

    fn visit_variable_declaration(&mut self, vd: &mut VariableDeclaration<'a>) {
        walk_mut::walk_variable_declaration(self, vd);
        // Splice out dropped declarators; null inits for dropped-but-kept ones.
        if !self.drops.declarator.is_empty() {
            let taken = std::mem::replace(&mut vd.declarations, self.ast.vec());
            let mut out = self.ast.vec_with_capacity(taken.len());
            for d in taken {
                if self.drops.declarator.contains(&d.node_id.get()) {
                    continue;
                }
                out.push(d);
            }
            vd.declarations = out;
        }
        for d in vd.declarations.iter_mut() {
            if self.drops.null_init.contains(&d.node_id.get()) && d.init.is_some() {
                d.init = None;
            }
        }
    }

    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts);
        let taken = std::mem::replace(stmts, self.ast.vec());
        let mut out = self.ast.vec_with_capacity(taken.len());
        for stmt in taken {
            // Drops are consequences of an inline, not counted separately (the
            // `count` tracks inlined variables).
            match &stmt {
                Statement::ExpressionStatement(es)
                    if self.drops.expr_stmt.contains(&es.node_id.get()) =>
                {
                    continue;
                }
                Statement::VariableDeclaration(vd)
                    if self.drops.decl_whole.contains(&vd.node_id.get()) =>
                {
                    continue;
                }
                _ => {}
            }
            out.push(stmt);
        }
        *stmts = out;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;

    /// Run flow-inline in isolation over the given source; top-level function
    /// declarations are opted in. Returns (normalized code, inlined count).
    fn flow(code: &str) -> (String, u32) {
        let allocator = Allocator::default();
        let program: &mut Program =
            allocator.alloc(crate::parse_program(&allocator, code, SourceType::ts()));
        let mut touched = HashSet::new();
        for s in &program.body {
            if let Statement::FunctionDeclaration(f) = s {
                touched.insert(f.span.start);
            }
        }
        let n = run(&allocator, program, &touched);
        let code = Codegen::new()
            .build(program)
            .code
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        (code, n)
    }

    #[test]
    fn inlines_single_def_into_single_use() {
        let (out, n) = flow("function f() { var x = 1; return x; }");
        assert_eq!(n, 1, "{out}");
        assert!(out.contains("return 1"), "{out}");
        assert!(out.contains("var x;"), "bare declarator kept: {out}");
    }

    #[test]
    fn inlines_top_level_assign_def() {
        let (out, n) = flow("function f(p) { var x; x = p + 1; return x; }");
        assert_eq!(n, 1, "{out}");
        assert!(out.contains("return p + 1"), "{out}");
    }

    #[test]
    fn chained_decisions_do_not_orphan_a_def() {
        // Regression (task #29 / WS-B0 sweep): block-inline-in-init residue
        // `let _t; _t = E; const r = _t; return r;` has two chained inline
        // decisions. Applying both in one pass deletes `_t`'s assignment (its only
        // use sits inside the dropped `const r = _t`), leaving `return _t` →
        // `undefined`. The deferral keeps the program coherent; the fixpoint
        // collapses the rest. The computation must never be dropped.
        let (out, _) = flow("function f(x) { let _t; _t = x + 1; const r = _t; return r; }");
        assert!(out.contains("x + 1"), "computation must survive (not orphaned):\n{out}");
    }

    #[test]
    fn preserves_bare_declarator_for_later_write() {
        let (out, n) =
            flow("function f(a, b) { let firstLinkTo = a; use(firstLinkTo); firstLinkTo = b; }");
        assert_eq!(n, 1, "{out}");
        assert!(out.contains("let firstLinkTo;"), "{out}");
        assert!(out.contains("use(a)"), "{out}");
        assert!(out.contains("firstLinkTo = b"), "{out}");
    }

    #[test]
    fn does_not_inline_when_used_twice() {
        let (_out, n) = flow("function f() { var x = compute(); use(x); use(x); }");
        assert_eq!(n, 0);
    }

    #[test]
    fn does_not_inline_impure_rhs() {
        let (out, n) = flow("function f() { var x = sideEffect(); return x; }");
        assert_eq!(n, 0);
        assert!(out.contains("sideEffect()"), "{out}");
    }

    #[test]
    fn does_not_inline_member_rhs() {
        let (_out, n) = flow("function f(o) { var x = o.p; mutate(o); return x; }");
        assert_eq!(n, 0);
    }

    #[test]
    fn does_not_inline_across_interfering_call_path() {
        let (_out, n) = flow("function f(a, b) { var x = a + b; impure(); return x; }");
        assert_eq!(n, 0);
    }

    #[test]
    fn inlines_across_adjacent_statement() {
        let (out, n) = flow("function f(p) { var x = p + 1; return x; }");
        assert_eq!(n, 1, "{out}");
        assert!(out.contains("return p + 1"), "{out}");
    }

    #[test]
    fn bails_when_use_inside_loop() {
        let (_out, n) = flow("function f(p) { var x = p + 1; while (cond) { use(x); } }");
        assert_eq!(n, 0);
    }

    #[test]
    fn bails_when_closure_captures() {
        let (_out, n) = flow("function f() { var x = 1; return function() { return x; }; }");
        assert_eq!(n, 0);
    }

    #[test]
    fn does_not_inline_outer_def_into_inner_block_use() {
        let (out, _n) =
            flow("function f(p) { var x = p + 1; { let x = 7; sink(x); } return x; }");
        assert!(out.contains("sink(7)"), "inner read must be 7, not p+1: {out}");
    }

    #[test]
    fn no_inline_when_cfg_bails_on_try() {
        let (out, n) = flow("function f() { try { var x = 1; return x; } catch (e) {} }");
        assert_eq!(n, 0, "cfg bailed → no inline: {out}");
        assert!(out.contains("var x = 1"), "{out}");
    }

    #[test]
    fn does_not_inline_across_scope_boundary() {
        let (out, _n) = flow(
            "function f() { let _r; { let inner = compute(); _r = inner; } return _r; }",
        );
        assert!(!out.contains("return inner"), "inner is out of scope at return: {out}");
    }
}
