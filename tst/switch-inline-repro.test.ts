// Regression: bare `case X: stmt; break;` cases (no `{ ... }` wrapper) had
// SwitchCase.consequent as a direct Statement[] but collectCallSites only
// tracked statement context inside BlockStatement/Program bodies. Calls inside
// those cases inherited the OUTER function-body context — so when inlined,
// the body got spliced BEFORE the enclosing switch instead of into the case.
//
// In crashcat this surfaced as gjk's computeClosestPointToSimplex: cases 2/3/4
// (bare-stmt form) had their kernel call sites' inlined bodies hoisted to
// before the switch, leaving the case bodies running only the setup statements
// against uninitialized scratch arrays.
//
// Fix:
//   - inline-functions.ts:collectCallSites — also update nextStmtCtx when
//     parent is SwitchCase with key='consequent'.
//   - function-injector.ts — widen CallSite.statementParent to include
//     SwitchCase; route all splices through a stmtList() helper.

import { describe, expect, it } from 'vitest';
import { Mode, transform } from '../src/compiler/pipeline';

function compile(src: string): string {
    return transform(src, { filename: 'sw.js', mode: Mode.WholeProgram }).code;
}

function evalFn(src: string, callExpr: string): unknown {
    return new Function(`${src};\nreturn ${callExpr};`)();
}

describe('inline into bare switch-case consequent', () => {
    // Mirrors gjk: case 2/3/4 are bare statements (no `{ ... }`) ending in
    // setup writes to module-scratch followed by an @optimize call, then break.
    // Outer is @optimize and is inlined into a caller — but the kernel calls
    // inside the cases must NOT be hoisted before the switch.
    it('matches source semantics for bare-statement cases with helper calls', () => {
        const src = `
            const _scratch = [0, 0, 0];

            /** @optimize */
            function kernel(out, a) {
                out.v = a[0] + a[1] + a[2];
            }

            /** @optimize */
            function dispatch(result, simplex) {
                const y = simplex.y;
                switch (simplex.size) {
                    case 1:
                        result.v = y[0];
                        break;
                    case 2:
                        _scratch[0] = y[0]; _scratch[1] = y[1]; _scratch[2] = y[2];
                        kernel(result, _scratch);
                        break;
                    case 3:
                        _scratch[0] = y[0] + y[3]; _scratch[1] = y[1] + y[4]; _scratch[2] = y[2] + y[5];
                        kernel(result, _scratch);
                        break;
                    default: throw new Error('bad');
                }
            }

            /** @optimize */
            function outer(simplex) {
                const result = { v: 0 };
                dispatch(result, simplex);
                return result.v;
            }

            globalThis.__outer = outer;
        `;
        const compiled = compile(src);

        for (const size of [1, 2, 3]) {
            const y = [1, 2, 3, 4, 5, 6, 7, 8, 9];
            const original = evalFn(src, `__outer({ size: ${size}, y: ${JSON.stringify(y)} })`);
            const out = evalFn(compiled, `__outer({ size: ${size}, y: ${JSON.stringify(y)} })`);
            expect(out).toEqual(original);
        }
    });

    // The same shape but the helper's return value is captured (init shape).
    it('matches source semantics when helper return value is consumed in bare case', () => {
        const src = `
            const _scratch = [0, 0, 0];

            /** @optimize */
            function kernel(a) {
                return a[0] * 100 + a[1] * 10 + a[2];
            }

            /** @optimize */
            function dispatch(simplex) {
                const y = simplex.y;
                let v;
                switch (simplex.size) {
                    case 1:
                        v = y[0];
                        break;
                    case 2:
                        _scratch[0] = y[0]; _scratch[1] = y[1]; _scratch[2] = y[2];
                        v = kernel(_scratch);
                        break;
                    default: throw new Error('bad');
                }
                return v;
            }

            /** @optimize */
            function outer(simplex) {
                return dispatch(simplex);
            }

            globalThis.__outer = outer;
        `;
        const compiled = compile(src);

        for (const size of [1, 2]) {
            const y = [3, 4, 5];
            const original = evalFn(src, `__outer({ size: ${size}, y: ${JSON.stringify(y)} })`);
            const out = evalFn(compiled, `__outer({ size: ${size}, y: ${JSON.stringify(y)} })`);
            expect(out).toEqual(original);
        }
    });
});
