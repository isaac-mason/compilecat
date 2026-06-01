// Behavioral equivalence: source → transform → eval must match
// source → eval for a set of hand-picked patterns. The patterns target
// optimizations that are easy to break under prior-phase AST mutation:
//
//   - renameForFlatten over `binding.referencePaths` (stale-binding bug)
//   - 3-state may-use lattice collapse in FSIV
//   - precomputed transfer events in must-def / may-use
//
// A divergence here means the compiled output computes a different value
// than the source — i.e. the optimization changed semantics.

import { describe, expect, it } from 'vitest';

import { Mode, transform } from '../src/compiler/pipeline';

function evalFn(src: string, callExpr: string): unknown {
    // Stash the call result on a host object so it survives DCE in the compiled
    // output. Module-level executable code is preserved by the pipeline.
    const wrapped = `const __out = {}; ${src};\n__out.v = ${callExpr};\nreturn __out.v;`;
    // biome-ignore lint/security/noGlobalEval: tests intentionally eval compiled output
    return new Function(wrapped)();
}

function compile(src: string): string {
    return transform(src, { filename: 'eq.js', mode: Mode.WholeProgram }).code;
}

function check(src: string, callExpr: string): void {
    // Top-level side effect on globalThis keeps the call reachable from the
    // pipeline's perspective (removeUnusedCode keeps statements with effects).
    const driver = `\nglobalThis.__result = ${callExpr};`;
    const original = evalFn(src + driver, '(typeof globalThis !== "undefined" ? globalThis.__result : undefined)');
    const compiled = evalFn(compile(src + driver), '(typeof globalThis !== "undefined" ? globalThis.__result : undefined)');
    expect(compiled).toEqual(original);
}

describe('Semantic equivalence — renameForFlatten + nested block collisions', () => {
    it('inner-block let shadowing function-scope var', () => {
        const src = `
            function f(p) {
                let t = p * 2;
                let acc = 0;
                {
                    let t = 100;
                    acc += t;
                }
                {
                    let t = 200;
                    acc += t;
                }
                return acc + t;
            }
        `;
        check(src, 'f(3)');
    });

    it('sibling-block lets with same name + uses after flatten', () => {
        const src = `
            function f(p) {
                let out = 0;
                { let i = 1; out += i * p; }
                { let i = 2; out += i * p; }
                { let i = 3; out += i * p; }
                return out;
            }
        `;
        check(src, 'f(7)');
    });

    it('@optimize with multiple inlined helpers using same temp name', () => {
        const src = `
            /** @inline */
            function add(a, b) { let t = a + b; return t; }
            /** @inline */
            function mul(a, b) { let t = a * b; return t; }
            /** @optimize */
            function f(x, y) {
                let t = x - y;
                const s = add(x, y);
                const p = mul(x, y);
                return t + s + p;
            }
            globalThis.__f = f;
        `;
        check(src + 'function call() { return __f(5, 3); }', 'call()');
    });

    it('@optimize function with reassignments in shadowing blocks', () => {
        const src = `
            /** @optimize */
            function f(p) {
                let acc = 0;
                let i = p;
                acc += i;
                {
                    let i = 10;
                    i = i + 1;
                    acc += i;
                }
                {
                    let i = 20;
                    i++;
                    acc += i;
                }
                return acc + i;
            }
        `;
        check(src, 'f(2)');
    });

    it('@optimize with destructuring rebinding in nested blocks', () => {
        const src = `
            /** @optimize */
            function f(arr) {
                let s = 0;
                {
                    const [a, b] = arr;
                    s += a + b;
                }
                {
                    const [a, b] = [arr[1], arr[0]];
                    s += a * b;
                }
                return s;
            }
        `;
        check(src + 'function call() { return f([3, 4]); }', 'call()');
    });

    it('@optimize with default-value param referencing outer name', () => {
        const src = `
            /** @optimize */
            function f(p) {
                let t = p;
                {
                    let t = 5;
                    function inner(x = t) { return x; }
                    t = inner() + t;
                    return t;
                }
            }
        `;
        check(src, 'f(99)');
    });

    it('@optimize with try/catch param shadow', () => {
        const src = `
            /** @optimize */
            function f(p) {
                let e = p;
                let s = 0;
                try { throw 1; } catch (e) { s += e; }
                try { throw 2; } catch (e) { s += e * 10; }
                return s + e;
            }
        `;
        check(src, 'f(100)');
    });

    it('inlined helper writes through aliased temp', () => {
        // Exercises must-def + may-use interplay. The helper does
        // x += y; sink(x). After inlining, the consumer's `x` (different
        // slot than the helper's `x`) must not be aliased.
        const src = `
            /** @inline */
            function helper(a, b) {
                let x = a;
                x += b;
                return x;
            }
            /** @optimize */
            function f(p, q, r) {
                let x = p * q;
                const h = helper(p, q);
                {
                    let x = r;
                    return x + h;
                }
            }
        `;
        check(src + 'function call() { return f(2, 3, 4); }', 'call()');
    });

    it('FSIV does not over-inline across kill in branch', () => {
        // x is assigned in two branches with the same identifier-text but
        // distinct AST nodes. May-use must collapse to BOTTOM, FSIV must
        // not inline.
        const src = `
            /** @optimize */
            function f(cond, p) {
                let x;
                if (cond) {
                    x = p + 1;
                } else {
                    x = p - 1;
                }
                return x * 2;
            }
        `;
        check(src, 'f(true, 5)');
        check(src, 'f(false, 5)');
    });

    it('loop with @optimize and inner-block shadow', () => {
        const src = `
            /** @optimize */
            function f(n) {
                let s = 0;
                for (let i = 0; i < n; i++) {
                    {
                        let s = i * 2;
                        sink(s);
                    }
                    s += i;
                }
                function sink(v) { return v; }
                return s;
            }
        `;
        check(src, 'f(5)');
    });

    it('update expression on shadowed inner binding', () => {
        const src = `
            /** @optimize */
            function f(n) {
                let i = n;
                let out = i;
                {
                    let i = 0;
                    while (i < 3) {
                        i++;
                        out += i;
                    }
                }
                return out + i;
            }
        `;
        check(src, 'f(10)');
    });
});

describe('Semantic equivalence — vector-like patterns from crashcat', () => {
    it('vec3 lerp via inline + @optimize', () => {
        const src = `
            /** @inline */
            function lerp(out, a, b, t) {
                const ax = a[0]; const ay = a[1]; const az = a[2];
                out[0] = ax + t * (b[0] - ax);
                out[1] = ay + t * (b[1] - ay);
                out[2] = az + t * (b[2] - az);
            }
            /** @inline */
            function copy(out, a) {
                out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
            }
            /** @optimize */
            function f(outBuf, a, b, c, t) {
                if (t <= 0) {
                    copy(outBuf, a);
                    return 0;
                } else if (t >= 1) {
                    copy(outBuf, b);
                    return 1;
                } else {
                    lerp(outBuf, a, b, t);
                    return 2;
                }
            }
            globalThis.__f = f;
        `;
        const make = () =>
            `(function () { const out = [0,0,0]; const flag = __f(out, [1,2,3], [4,5,6], [7,8,9], 0.25); return [flag, out[0], out[1], out[2]]; })()`;
        const original = evalFn(src, make());
        const compiled = evalFn(compile(src), make());
        expect(compiled).toEqual(original);
    });

    it('point-in-box check after inlined transform', () => {
        const src = `
            /** @inline */
            function conjugate(out, q) {
                out[0] = -q[0]; out[1] = -q[1]; out[2] = -q[2]; out[3] = q[3];
            }
            /** @inline */
            function transformQuat(out, v, q) {
                const x = v[0], y = v[1], z = v[2];
                const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
                const ix = qw * x + qy * z - qz * y;
                const iy = qw * y + qz * x - qx * z;
                const iz = qw * z + qx * y - qy * x;
                const iw = -qx * x - qy * y - qz * z;
                out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
                out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
                out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
            }
            /** @optimize */
            function pointInBox(pX, pY, pZ, boxQ, halfX, halfY, halfZ) {
                const qConj = [0, 0, 0, 0];
                conjugate(qConj, boxQ);
                const local = [pX, pY, pZ];
                transformQuat(local, local, qConj);
                return Math.abs(local[0]) <= halfX
                    && Math.abs(local[1]) <= halfY
                    && Math.abs(local[2]) <= halfZ;
            }
            globalThis.__f = pointInBox;
        `;
        const probe = `(function () {
            // identity quaternion
            return [
                __f(0, 0, 0, [0,0,0,1], 1, 1, 1),
                __f(2, 0, 0, [0,0,0,1], 1, 1, 1),
                __f(0.5, 0.5, 0.5, [0,0,0,1], 1, 1, 1),
            ];
        })()`;
        const original = evalFn(src, probe);
        const compiled = evalFn(compile(src), probe);
        expect(compiled).toEqual(original);
    });
});
