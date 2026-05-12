// Strip TypeScript-only syntax from a parsed Program so downstream passes
// (and the generator) only see JS. Mutates the AST in place.
//
// Handles:
//   - Type annotations on identifiers / params / declarators / functions
//     (delegated to node-util.stripTypeScriptOnly).
//   - Type-only import/export declarations and specifiers (dropped).
//   - TSEnumDeclaration → lowered to the IIFE shape tsc emits.
//   - TSInterfaceDeclaration, TSTypeAliasDeclaration, TSDeclareFunction,
//     TSModuleDeclaration, TSImportEqualsDeclaration → dropped.
//   - Type assertion wrappers (`expr as T`, `<T>expr`, `expr!`) → unwrapped.
//
// Out of scope:
//   - Runtime namespaces with executable bodies (`namespace N { ... }` that
//     emits an IIFE in tsc). Rare in bundled output; we drop the whole
//     declaration. Revisit if crashcat-or-similar starts depending on it.
//   - Parameter properties in constructors (`constructor(public x: number)`).
//     Same reasoning — bundled output doesn't typically carry these.

import * as t from '@babel/types';

import { stripTypeScriptOnly } from './node-util';

export function stripTypeScript(ast: t.File): void {
    const body = ast.program.body;

    for (let i = body.length - 1; i >= 0; i--) {
        const stmt = body[i];

        if (t.isTSEnumDeclaration(stmt)) {
            const lowered = lowerTsEnumToJs(stmt);
            if (lowered) {
                body.splice(i, 1, ...lowered);
            } else {
                body.splice(i, 1);
            }
            continue;
        }

        if (
            t.isTSInterfaceDeclaration(stmt) ||
            t.isTSTypeAliasDeclaration(stmt) ||
            t.isTSDeclareFunction(stmt) ||
            t.isTSModuleDeclaration(stmt) ||
            t.isTSImportEqualsDeclaration(stmt) ||
            t.isTSExportAssignment(stmt) ||
            t.isTSNamespaceExportDeclaration(stmt)
        ) {
            body.splice(i, 1);
            continue;
        }

        if (t.isImportDeclaration(stmt)) {
            if (stmt.importKind === 'type') {
                body.splice(i, 1);
                continue;
            }
            stmt.specifiers = stmt.specifiers.filter((s) => !(t.isImportSpecifier(s) && s.importKind === 'type'));
            if (stmt.specifiers.length === 0) {
                body.splice(i, 1);
                continue;
            }
        }

        if (t.isExportNamedDeclaration(stmt)) {
            if (stmt.exportKind === 'type') {
                body.splice(i, 1);
                continue;
            }
            stmt.specifiers = stmt.specifiers.filter((s) => !(t.isExportSpecifier(s) && s.exportKind === 'type'));
            if (
                stmt.declaration &&
                (t.isTSInterfaceDeclaration(stmt.declaration) ||
                    t.isTSTypeAliasDeclaration(stmt.declaration) ||
                    t.isTSDeclareFunction(stmt.declaration) ||
                    t.isTSEnumDeclaration(stmt.declaration) ||
                    t.isTSModuleDeclaration(stmt.declaration))
            ) {
                if (t.isTSEnumDeclaration(stmt.declaration)) {
                    const lowered = lowerTsEnumToJs(stmt.declaration);
                    if (lowered) {
                        body.splice(i, 1, ...lowered);
                        continue;
                    }
                }
                stmt.declaration = null;
                if (stmt.specifiers.length === 0 && !stmt.source) {
                    body.splice(i, 1);
                }
            }
        }
    }

    // Strip annotation slots + unwrap type-assertion wrappers everywhere else.
    stripTypeScriptOnly(ast);
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
            return t.expressionStatement(
                t.assignmentExpression('=', t.memberExpression(idRef(), t.stringLiteral(key), true), value),
            );
        }
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
