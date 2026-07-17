//! Port of the `remove-unused-code.ts` slice (jscomp `RemoveUnusedCode` subset):
//! drop bindings left unused after inlining so fully-inlined dependencies and their
//! imports don't linger in the intermediate TS output. Removes:
//!   - unused `let|const|var` declarators with a pure / absent init,
//!   - unused `function NAME() {}` declarations,
//!   - unused `class NAME {}` declarations (no side-effecting static members),
//!   - unused import specifiers, and whole imports once every specifier goes.
//!
//! "Unused" = the symbol has **zero resolved references** (read, write, OR type
//! — so type-only-used imports are preserved, which matters since we keep TS).
//! A write-only binding (reassigned, never read) is kept — its RHS may carry
//! effects; dead-assignment elimination is the right tool for that. Iterates to
//! fixpoint: removing one binding can make another unused.
//!
//! Detection is span-precise (shadow-safe) via `oxc_semantic`; removal is a
//! structural `VisitMut` that only touches *bare* declarations — exported ones
//! are `ExportNamedDeclaration` statements and are never matched, so exports are
//! preserved without an explicit check. Mirrors `cleanup_residue.rs`'s
//! semantic-detect + visit-mut-apply shape.

use std::collections::HashSet;

use oxc_allocator::{Allocator, TakeIn};
use oxc_ast::ast::*;
use oxc_ast::{AstBuilder, AstKind};
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_semantic::NodeId;

use super::util::{is_pure, is_side_effect_free};

pub fn run<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> u32 {
    let mut total = 0;
    loop {
        let removed = sweep(allocator, program);
        if removed == 0 {
            break;
        }
        total += removed;
    }
    total
}

/// One detect-then-remove pass. Rebuilds semantic so references reflect the
/// previous round's removals.
fn sweep<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> u32 {
    use oxc_semantic::SemanticBuilder;

    // `NodeId` of each removable declaration node / import specifier — NOT
    // span.start: compiler-generated declarations (SROA scalars, inline temps)
    // all carry SPAN(0,0), so span identity aliases distinct declarations and the
    // remover would drop a live binding alongside a dead sibling. `NodeId` is
    // collision-free (set by semantic) and stable across the `take_in` move.
    // (cf. reference_cfg_node_identity_keying; same fix as inline-variables/sroa.)
    let mut dead_decls: HashSet<NodeId> = HashSet::new();
    let mut dead_imports: HashSet<NodeId> = HashSet::new();
    {
        let semantic = SemanticBuilder::new().build(&*program).semantic;
        let scoping = semantic.scoping();
        let nodes = semantic.nodes();
        for sym in scoping.symbol_ids() {
            // Any reference (read / write / type) keeps the binding.
            if scoping.get_resolved_references(sym).next().is_some() {
                continue;
            }
            let decl_id = scoping.symbol_declaration(sym);
            match nodes.kind(decl_id) {
                AstKind::VariableDeclarator(d) => {
                    if !matches!(&d.id, BindingPattern::BindingIdentifier(_)) {
                        continue; // destructuring — out of scope
                    }
                    if d.init.as_ref().is_some_and(|i| !is_side_effect_free(i)) {
                        continue; // side-effecting init — keep
                    }
                    dead_decls.insert(decl_id);
                }
                AstKind::Function(_) => {
                    dead_decls.insert(decl_id);
                }
                AstKind::Class(c) => {
                    if class_has_side_effects(c) {
                        continue;
                    }
                    dead_decls.insert(decl_id);
                }
                AstKind::ImportSpecifier(_)
                | AstKind::ImportDefaultSpecifier(_)
                | AstKind::ImportNamespaceSpecifier(_) => {
                    dead_imports.insert(decl_id);
                }
                _ => {}
            }
        }
    }
    if dead_decls.is_empty() && dead_imports.is_empty() {
        return 0;
    }
    let mut r = Remover { ast: AstBuilder::new(allocator), dead_decls, dead_imports, count: 0 };
    r.visit_program(program);
    r.count
}

struct Remover<'a> {
    ast: AstBuilder<'a>,
    dead_decls: HashSet<NodeId>,
    dead_imports: HashSet<NodeId>,
    count: u32,
}

impl<'a> Remover<'a> {
    fn is_dead_decl(&self, node_id: NodeId) -> bool {
        self.dead_decls.contains(&node_id)
    }
}

impl<'a> VisitMut<'a> for Remover<'a> {
    fn visit_statements(&mut self, stmts: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, stmts); // recurse first (nested fns/blocks)
        let taken = stmts.take_in(self.ast.allocator);
        let mut out = self.ast.vec_with_capacity(taken.len());
        for stmt in taken {
            match stmt {
                Statement::FunctionDeclaration(ref f) if self.is_dead_decl(f.node_id.get()) => {
                    self.count += 1;
                }
                Statement::ClassDeclaration(ref c) if self.is_dead_decl(c.node_id.get()) => {
                    self.count += 1;
                }
                Statement::VariableDeclaration(mut vd) => {
                    let before = vd.declarations.len();
                    let decls = vd.declarations.take_in(self.ast.allocator);
                    let mut kept = self.ast.vec();
                    for d in decls {
                        if self.is_dead_decl(d.node_id.get()) {
                            self.count += 1;
                        } else {
                            kept.push(d);
                        }
                    }
                    if kept.is_empty() && before > 0 {
                        continue; // whole declaration gone
                    }
                    vd.declarations = kept;
                    out.push(Statement::VariableDeclaration(vd));
                }
                Statement::ImportDeclaration(mut imp) => {
                    let Some(specs) = imp.specifiers.take() else {
                        out.push(Statement::ImportDeclaration(imp)); // side-effect-only import
                        continue;
                    };
                    let had = specs.len();
                    let mut kept = self.ast.vec();
                    let mut removed = 0;
                    for s in specs {
                        let spec_id = match &s {
                            ImportDeclarationSpecifier::ImportSpecifier(x) => x.node_id.get(),
                            ImportDeclarationSpecifier::ImportDefaultSpecifier(x) => {
                                x.node_id.get()
                            }
                            ImportDeclarationSpecifier::ImportNamespaceSpecifier(x) => {
                                x.node_id.get()
                            }
                        };
                        if self.dead_imports.contains(&spec_id) {
                            removed += 1;
                        } else {
                            kept.push(s);
                        }
                    }
                    if removed == 0 {
                        imp.specifiers = Some(kept);
                        out.push(Statement::ImportDeclaration(imp));
                        continue;
                    }
                    self.count += removed;
                    if kept.is_empty() && had > 0 {
                        continue; // every specifier unused → drop the import
                    }
                    imp.specifiers = Some(kept);
                    out.push(Statement::ImportDeclaration(imp));
                }
                other => out.push(other),
            }
        }
        *stmts = out;
    }
}

/// Conservative port of `classBodyMayHaveSideEffects`: a class is unsafe to drop
/// if any member observably evaluates at definition time — a `static {}` block, a
/// side-effecting static field initializer, or a side-effecting computed key.
/// Methods are inert (function literals are values, not calls).
fn class_has_side_effects(c: &Class) -> bool {
    if c.super_class.as_ref().is_some_and(|s| !is_pure(s)) {
        return true;
    }
    for member in &c.body.body {
        match member {
            ClassElement::StaticBlock(_) => return true,
            ClassElement::PropertyDefinition(p) => {
                if p.computed && !key_is_pure(&p.key) {
                    return true;
                }
                if p.r#static && p.value.as_ref().is_some_and(|v| !is_pure(v)) {
                    return true;
                }
            }
            ClassElement::MethodDefinition(m) => {
                if m.computed && !key_is_pure(&m.key) {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

fn key_is_pure(key: &PropertyKey) -> bool {
    match key {
        PropertyKey::StaticIdentifier(_) | PropertyKey::PrivateIdentifier(_) => true,
        _ => key.as_expression().is_none_or(is_pure),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_codegen::Codegen;
    use oxc_span::SourceType;

    fn run_src(src: &str) -> String {
        let allocator = Allocator::default();
        let mut program = crate::parse_program(&allocator, src, SourceType::ts());
        run(&allocator, &mut program);
        Codegen::new().build(&program).code
    }

    #[test]
    fn keeps_live_span_zero_sibling_when_dead_one_removed() {
        // Regression: SROA emits `let v_0 = 1, v_1 = 2` where both declarators
        // carry SPAN(0,0). Here v_0 is dead (pure, unread) and v_1 is live. Keying
        // removal by span.start aliased them, so dropping v_0 also dropped the live
        // v_1 → `return v_1` referenced an undeclared binding. NodeId keying fixes
        // it. (cf. reference_cfg_node_identity_keying)
        let allocator = Allocator::default();
        let mut program = crate::parse_program(
            &allocator,
            "/* @sroa */ export function f() { const v = [1, 2]; return v[1]; }",
            SourceType::ts(),
        );
        // Generate the span-0 scalars, then run remove_unused in isolation (no
        // simplifier in between that would otherwise fold the dead scalar first).
        crate::passes::sroa::run(&allocator, &mut program, &std::collections::HashMap::new());
        run(&allocator, &mut program);
        let out = Codegen::new().build(&program).code;
        assert!(out.contains("v_1 = 2"), "live scalar v_1 must survive:\n{out}");
        assert!(out.contains("return v_1"), "use of v_1 still bound:\n{out}");
        assert!(!out.contains("v_0"), "dead scalar v_0 removed:\n{out}");
    }

    #[test]
    fn drops_one_declarator_from_multi() {
        // Only `dead` is dropped from the multi-declarator statement; `used` is kept.
        let out = run_src("const used = 1, dead = 2; export const r = used;");
        assert!(!out.contains("dead"), "dead declarator removed:\n{out}");
        assert!(out.contains("used = 1"), "used declarator kept:\n{out}");
    }

    #[test]
    fn conservative_keeps_recursive_function() {
        // Conservative: the self-call inside the body counts as a read, so `rec` is
        // KEPT even though it's unreachable (not exported, never called elsewhere).
        let out = run_src("function rec() { return rec(); }\nexport const r = 1;");
        assert!(out.contains("function rec"), "recursive fn kept (conservative):\n{out}");
    }

    #[test]
    fn drops_declarator_nested_in_block() {
        // A dead const inside a nested block of a live (exported) function is removed,
        // leaving the now-empty block.
        let out = run_src("export function f() { { const dead = 1; } return 2; }");
        assert!(!out.contains("dead"), "nested dead const removed:\n{out}");
        assert!(out.contains("return 2"), "live body kept:\n{out}");
    }

    #[test]
    fn drops_unused_class() {
        let out = run_src("class Dead {}\nexport const r = 1;");
        assert!(!out.contains("Dead"), "unused class removed:\n{out}");
        assert!(out.contains("r = 1"), "{out}");
    }

    #[test]
    fn keeps_class_with_static_side_effect_field() {
        // class_has_side_effects guard: a static field initializer with a call is a
        // module-load side effect, so the otherwise-unused class is kept.
        let out = run_src("class Live { static x = sideEffect(); }\nexport const r = 1;");
        assert!(out.contains("class Live"), "class with static side-effect field kept:\n{out}");
        assert!(out.contains("sideEffect"), "{out}");
    }

    #[test]
    fn keeps_class_with_static_init_block() {
        let out = run_src("class Live { static { sideEffect(); } }\nexport const r = 1;");
        assert!(out.contains("class Live"), "class with static init block kept:\n{out}");
        assert!(out.contains("sideEffect"), "{out}");
    }

    #[test]
    fn keeps_class_with_side_effecting_superclass() {
        let out = run_src("class Live extends sideEffect() {}\nexport const r = 1;");
        assert!(out.contains("class Live"), "class with side-effecting superclass kept:\n{out}");
        assert!(out.contains("sideEffect"), "{out}");
    }

    #[test]
    fn conservative_keeps_unused_destructuring_declarator() {
        // The pass bails on destructuring patterns (it only removes simple BindingIdentifier
        // declarators), so an unused object-destructuring const is KEPT.
        let out = run_src("const { a } = obj;\nexport const r = 1;");
        assert!(
            out.contains("{ a } = obj"),
            "destructuring declarator kept (conservative):\n{out}"
        );
    }

    #[test]
    fn drops_unused_default_and_namespace_imports() {
        // Both a default import (`import D`) and a namespace import (`import * as N`)
        // are removed when unreferenced.
        let out = run_src("import D from 'm'; import * as N from 'm2'; export const r = 1;");
        assert!(!out.contains("import"), "default + namespace imports removed:\n{out}");
        assert!(!out.contains('D') && !out.contains('N'), "{out}");
    }

    #[test]
    fn drops_unused_const() {
        let out = run_src("const used = 1;\nconst dead = 2;\nexport const r = used;");
        assert!(!out.contains("dead"), "unused const removed:\n{out}");
        assert!(out.contains("used"), "used const kept:\n{out}");
    }

    #[test]
    fn drops_unused_function_decl() {
        let out = run_src("function dead(){return 1;}\nexport function live(){return 2;}");
        assert!(!out.contains("function dead"), "unused fn removed:\n{out}");
        assert!(out.contains("function live"), "{out}");
    }

    #[test]
    fn keeps_exported_unused() {
        let out = run_src("export const x = 1;");
        assert!(out.contains("x"), "exported binding kept even if unreferenced:\n{out}");
    }

    #[test]
    fn keeps_side_effecting_init() {
        let out = run_src("const x = sideEffect();");
        assert!(out.contains("sideEffect"), "side-effecting init kept:\n{out}");
    }

    #[test]
    fn drops_pure_annotated_and_builtin_inits() {
        // `/*@__PURE__*/` marks the call side-effect-free (droppable); `Math.*` is
        // an allowlisted pure builtin. A plain unknown call stays.
        let pure = run_src("const a = /*@__PURE__*/ extern();");
        assert!(!pure.contains("extern"), "pure-annotated dead init dropped:\n{pure}");
        let builtin = run_src("const b = Math.max(1, 2);");
        assert!(!builtin.contains("Math.max"), "pure builtin dead init dropped:\n{builtin}");
        let plain = run_src("const c = extern();");
        assert!(plain.contains("extern"), "unknown call kept:\n{plain}");
    }

    #[test]
    fn keeps_write_only_var() {
        // reassigned but never read — keep (DAE territory).
        let out = run_src("let x = 1; x = 2;");
        assert!(out.contains("x = 2"), "write-only var kept:\n{out}");
    }

    #[test]
    fn fixpoint_cascades() {
        // `a` only used by `b`; once `b` (unused) goes, `a` becomes unused too.
        let out = run_src("const a = 1;\nconst b = a + 1;\nexport const r = 5;");
        assert!(!out.contains("const a"), "cascaded removal of a:\n{out}");
        assert!(!out.contains("const b"), "removal of b:\n{out}");
    }

    #[test]
    fn drops_unused_import_specifier_and_whole_import() {
        let out = run_src("import { a, b } from \"m\";\nexport const r = a;");
        assert!(out.contains("a"), "used import kept:\n{out}");
        assert!(!out.contains("b"), "unused specifier removed:\n{out}");
        let out2 = run_src("import { a } from \"m\";\nexport const r = 1;");
        assert!(!out2.contains("import"), "fully-unused import dropped:\n{out2}");
    }

    #[test]
    fn keeps_type_only_used_import() {
        // `T` referenced only in a type position must NOT be removed (we keep TS).
        let out = run_src("import { T } from \"m\";\nexport const r: T = mk();");
        assert!(out.contains('T'), "type-only-used import preserved:\n{out}");
    }

    #[test]
    fn keeps_side_effect_only_import() {
        let out = run_src("import \"m\";\nexport const r = 1;");
        assert!(out.contains("import"), "side-effect-only import kept:\n{out}");
    }
}
