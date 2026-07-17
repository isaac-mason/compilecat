//! The type-shape oracle: a small, demand-driven TS type resolver
//! (`oxc TSType → ResolvedType`, or bail with `None`).
//!
//! It models only the *structure of written type annotations* — not inference,
//! narrowing, or type-level computation. Every unmodeled form returns `None`,
//! and `None` is always safe (the consuming optimization simply doesn't fire).
//!
//! Lives in `analysis/` because it's cross-cutting: SROA projects a
//! `ResolvedType` down to a [`Shape`] via [`shape_of`] to scalarize aggregates,
//! and the cross-file driver runs [`build_alias_shapes`] over dependency programs to
//! resolve *imported* types. Future passes (const-enum, narrowing) will consume
//! the richer `ResolvedType` variants directly.

use std::collections::{HashMap, HashSet};

use oxc_ast::ast::*;

/// The statically-known shape of an aggregate — a fixed tuple (indexed) or a
/// fixed record (named fields). Drives both decl rewriting and access rewriting
/// in SROA.
#[derive(Clone)]
pub(crate) enum Shape {
    Tuple(usize),
    Object(Vec<String>),
}

impl Shape {
    pub(crate) fn len(&self) -> usize {
        match self {
            Shape::Tuple(n) => *n,
            Shape::Object(f) => f.len(),
        }
    }

    /// Scalar-name suffixes in declaration order — `0,1,2,…` for a tuple, the
    /// field names for a record. The scalar for binding `v` is `v_<suffix>`.
    pub(crate) fn suffixes(&self) -> Vec<String> {
        match self {
            Shape::Tuple(n) => (0..*n).map(|i| i.to_string()).collect(),
            Shape::Object(f) => f.clone(),
        }
    }
}

/// A resolved TS type — only the structure optimizations consume. Owned (no
/// borrow into the program), so it can outlive the program mutation.
///
/// `allow(dead_code)`: the literal/union payloads are produced by the resolver
/// today but not yet *read* — they're the substrate the next type-directed
/// passes (const-enum inlining, type-narrowed DCE) will consume. SROA only reads
/// the `Tuple`/`Object` structure via `shape_of`.
#[derive(Clone)]
#[allow(dead_code)]
pub(crate) enum ResolvedType {
    Number,
    String,
    Boolean,
    BigInt,
    Symbol,
    Null,
    Undefined,
    /// Literal types (`42`, `"red"`, `true`) — drive const-fold / narrowing.
    NumberLit(f64),
    StringLit(String),
    BoolLit(bool),
    /// `[T0, T1, …]` — fixed arity (element types are `Unknown` for now; SROA
    /// only needs the arity).
    Tuple(Vec<ResolvedType>),
    /// `{ a: T; b: U }` — ordered fields (member types resolved leniently).
    Object(Vec<(String, ResolvedType)>),
    /// `A | B` — not a fixed shape (SROA bails), but modeled for narrowing.
    Union(Vec<ResolvedType>),
    /// Typed but no useful structure (`any` / `unknown` / `object` / an
    /// unresolved member). Distinct from `None` (= "form not modeled at all").
    Unknown,
}

/// Project a resolved type to the aggregate `Shape` SROA scalarizes — only
/// tuples and records have one.
pub(crate) fn shape_of(t: &ResolvedType) -> Option<Shape> {
    match t {
        ResolvedType::Tuple(els) => Some(Shape::Tuple(els.len())),
        ResolvedType::Object(fields) => {
            Some(Shape::Object(fields.iter().map(|(n, _)| n.clone()).collect()))
        }
        _ => None,
    }
}

/// Rebuild a `ResolvedType` from a `Shape` the caller already resolved
/// cross-module (member/element types are lost across the boundary → `Unknown`,
/// which is fine: SROA only needs the shape).
pub(crate) fn reconstruct(shape: &Shape) -> ResolvedType {
    match shape {
        Shape::Tuple(n) => ResolvedType::Tuple(vec![ResolvedType::Unknown; *n]),
        Shape::Object(fields) => ResolvedType::Object(
            fields.iter().map(|n| (n.clone(), ResolvedType::Unknown)).collect(),
        ),
    }
}

/// A top-level type declaration the resolver can follow a reference into.
pub(crate) enum TypeDecl<'b, 'a> {
    Alias(&'b TSType<'a>),
    Interface(&'b TSInterfaceDeclaration<'a>),
}

/// How a type-reference *name* is resolved — the only thing that differs between
/// the two resolution phases:
///  - `Decls`: the declaration phase, following alias/interface bodies in the
///    AST (read-only, before mutation).
///  - `Resolved`: the use-site phase, looking names up in the already-resolved
///    borrow-free map (during mutation).
pub(crate) enum NameSrc<'b, 'a, 'm> {
    Decls(&'m HashMap<String, TypeDecl<'b, 'a>>),
    Resolved(&'m HashMap<String, ResolvedType>),
}

/// Resolve a top-level type by name.
fn resolve_name(src: &NameSrc, name: &str, seen: &mut HashSet<String>) -> Option<ResolvedType> {
    match src {
        NameSrc::Resolved(map) => map.get(name).cloned(),
        NameSrc::Decls(decls) => {
            if !seen.insert(name.to_string()) {
                return None; // cycle
            }
            let out = match decls.get(name)? {
                TypeDecl::Alias(ty) => resolve_ast(ty, src, seen),
                TypeDecl::Interface(i) => resolve_interface(i, src, seen),
            };
            seen.remove(name);
            out
        }
    }
}

/// Resolve a TS type AST node to a `ResolvedType`, delegating reference names to
/// `src`. The structural arms are shared by both phases; unmodeled forms bail.
pub(crate) fn resolve_ast(
    ty: &TSType,
    src: &NameSrc,
    seen: &mut HashSet<String>,
) -> Option<ResolvedType> {
    match ty {
        TSType::TSNumberKeyword(_) => Some(ResolvedType::Number),
        TSType::TSStringKeyword(_) => Some(ResolvedType::String),
        TSType::TSBooleanKeyword(_) => Some(ResolvedType::Boolean),
        TSType::TSBigIntKeyword(_) => Some(ResolvedType::BigInt),
        TSType::TSSymbolKeyword(_) => Some(ResolvedType::Symbol),
        TSType::TSNullKeyword(_) => Some(ResolvedType::Null),
        TSType::TSUndefinedKeyword(_) => Some(ResolvedType::Undefined),
        TSType::TSAnyKeyword(_) | TSType::TSUnknownKeyword(_) | TSType::TSObjectKeyword(_) => {
            Some(ResolvedType::Unknown)
        }

        TSType::TSLiteralType(l) => match &l.literal {
            TSLiteral::NumericLiteral(n) => Some(ResolvedType::NumberLit(n.value)),
            TSLiteral::StringLiteral(s) => Some(ResolvedType::StringLit(s.value.to_string())),
            TSLiteral::BooleanLiteral(b) => Some(ResolvedType::BoolLit(b.value)),
            _ => None,
        },

        // Fixed tuple → arity only (rest/optional aren't fixed-shape → bail).
        TSType::TSTupleType(t) => {
            for el in &t.element_types {
                if matches!(el, TSTupleElement::TSRestType(_) | TSTupleElement::TSOptionalType(_)) {
                    return None;
                }
            }
            Some(ResolvedType::Tuple(vec![ResolvedType::Unknown; t.element_types.len()]))
        }

        TSType::TSTypeLiteral(lit) => {
            resolve_object_members(&lit.members, src, seen).map(ResolvedType::Object)
        }

        TSType::TSParenthesizedType(p) => resolve_ast(&p.type_annotation, src, seen),

        TSType::TSUnionType(u) => {
            let variants = u
                .types
                .iter()
                .map(|m| resolve_ast(m, src, seen).unwrap_or(ResolvedType::Unknown))
                .collect();
            Some(ResolvedType::Union(variants))
        }

        // `A & B` → merge record field sets (bail if any member isn't a record).
        TSType::TSIntersectionType(it) => {
            let mut parts = Vec::with_capacity(it.types.len());
            for m in &it.types {
                parts.push(resolve_ast(m, src, seen)?);
            }
            merge_objects(parts)
        }

        TSType::TSTypeReference(r) => {
            let TSTypeName::IdentifierReference(id) = &r.type_name else { return None };
            // Type arguments are ignored: field *names* don't depend on them, so
            // a generic record alias resolves its shape (members → `Unknown`).
            resolve_name(src, id.name.as_str(), seen)
        }

        // conditional / mapped / keyof / typeof / indexed-access / template-
        // literal / array / function / infer / … → not modeled → bail.
        _ => None,
    }
}

/// An interface's resolved type — own property fields plus those merged in from
/// each `extends` clause (when the base is a plain named record).
fn resolve_interface(
    iface: &TSInterfaceDeclaration,
    src: &NameSrc,
    seen: &mut HashSet<String>,
) -> Option<ResolvedType> {
    let mut fields = resolve_object_members(&iface.body.body, src, seen)?;
    for h in &iface.extends {
        let Expression::Identifier(id) = &h.expression else { return None }; // `ns.Base` → bail
        let base = resolve_name(src, id.name.as_str(), &mut seen.clone())?;
        let ResolvedType::Object(base_fields) = base else { return None }; // non-record base → bail
        for (n, t) in base_fields {
            if !fields.iter().any(|(en, _)| en == &n) {
                fields.push((n, t)); // own fields take precedence
            }
        }
    }
    Some(ResolvedType::Object(fields))
}

/// Resolve an object type's members to `(name, type)` pairs, in order. Bails on
/// any non-plain member *kind* (method/index/call sig, optional, computed,
/// non-identifier key, duplicate); a member whose *type* isn't modeled resolves
/// leniently to `Unknown` so the record's field set is never lost.
fn resolve_object_members(
    members: &[TSSignature],
    src: &NameSrc,
    seen: &mut HashSet<String>,
) -> Option<Vec<(String, ResolvedType)>> {
    let mut fields: Vec<(String, ResolvedType)> = Vec::with_capacity(members.len());
    for m in members {
        let TSSignature::TSPropertySignature(p) = m else { return None };
        if p.optional || p.computed {
            return None;
        }
        let PropertyKey::StaticIdentifier(key) = &p.key else { return None };
        let name = key.name.to_string();
        if fields.iter().any(|(n, _)| n == &name) {
            return None; // duplicate key
        }
        let ty = p
            .type_annotation
            .as_ref()
            .and_then(|ta| resolve_ast(&ta.type_annotation, src, seen))
            .unwrap_or(ResolvedType::Unknown);
        fields.push((name, ty));
    }
    if fields.is_empty() {
        return None;
    }
    Some(fields)
}

/// Merge resolved records into one (union of fields) — the operation behind both
/// intersection (`A & B`) and interface `extends`. `None` if any part isn't a
/// record or the merged set is empty.
fn merge_objects(parts: Vec<ResolvedType>) -> Option<ResolvedType> {
    let mut fields: Vec<(String, ResolvedType)> = Vec::new();
    for part in parts {
        let ResolvedType::Object(fs) = part else { return None };
        for (n, t) in fs {
            if !fields.iter().any(|(en, _)| en == &n) {
                fields.push((n, t));
            }
        }
    }
    if fields.is_empty() {
        return None;
    }
    Some(ResolvedType::Object(fields))
}

/// Resolve every top-level `type`/`interface` in a module to a `ResolvedType`,
/// borrow-free. The declaration phase of the resolver.
pub(crate) fn build_type_map(program: &Program) -> HashMap<String, ResolvedType> {
    let mut decls: HashMap<String, TypeDecl> = HashMap::new();
    for stmt in &program.body {
        let decl = match stmt {
            Statement::TSTypeAliasDeclaration(a) => {
                Some((a.id.name.to_string(), TypeDecl::Alias(&a.type_annotation)))
            }
            Statement::TSInterfaceDeclaration(i) => {
                Some((i.id.name.to_string(), TypeDecl::Interface(i.as_ref())))
            }
            Statement::ExportNamedDeclaration(e) => match &e.declaration {
                Some(Declaration::TSTypeAliasDeclaration(a)) => {
                    Some((a.id.name.to_string(), TypeDecl::Alias(&a.type_annotation)))
                }
                Some(Declaration::TSInterfaceDeclaration(i)) => {
                    Some((i.id.name.to_string(), TypeDecl::Interface(i.as_ref())))
                }
                _ => None,
            },
            _ => None,
        };
        if let Some((name, d)) = decl {
            decls.insert(name, d);
        }
    }
    let src = NameSrc::Decls(&decls);
    let mut out = HashMap::new();
    for name in decls.keys() {
        let mut seen = HashSet::new();
        if let Some(rt) = resolve_name(&src, name, &mut seen) {
            out.insert(name.clone(), rt);
        }
    }
    out
}

/// Whether `name` is declared at top level as a type alias or interface (bare or
/// exported) in this program — regardless of whether it resolves to a scalarizable
/// `Shape`. The cross-file resolver needs this to tell "declared here but not a
/// scalarizable shape" (authoritative — shadows a same-named re-export/`export *`)
/// from "not declared here" (keep following the re-export graph). Mirrors the
/// declaration collection in `build_type_map`.
pub(crate) fn declares_type(program: &Program, name: &str) -> bool {
    program.body.iter().any(|stmt| match stmt {
        Statement::TSTypeAliasDeclaration(a) => a.id.name.as_str() == name,
        Statement::TSInterfaceDeclaration(i) => i.id.name.as_str() == name,
        Statement::ExportNamedDeclaration(e) => matches!(
            &e.declaration,
            Some(Declaration::TSTypeAliasDeclaration(a)) if a.id.name.as_str() == name
        ) || matches!(
            &e.declaration,
            Some(Declaration::TSInterfaceDeclaration(i)) if i.id.name.as_str() == name
        ),
        _ => false,
    })
}

/// Top-level `type X`/`interface X` → `Shape`, for the cross-file driver to
/// resolve an *imported* type's shape from a dependency program. Thin projection over
/// the resolver's declaration phase.
pub(crate) fn build_alias_shapes(program: &Program) -> HashMap<String, Shape> {
    build_type_map(program)
        .into_iter()
        .filter_map(|(name, rt)| shape_of(&rt).map(|s| (name, s)))
        .collect()
}
