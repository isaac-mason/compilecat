// Faithful copy of mathcat's `quat.slerp` (dist/quat.js): shortest-arc spherical
// interpolation between two quaternions. The interesting shape for the optimizer:
//   - a dot-SIGN-FLIP `if` that reassigns all four `b` components (`bx…bw` are
//     `let`, mutated in the branch → scalarization / conditional-def stress),
//   - a second `if` (standard slerp with `acos`/`sin` trig) vs a linear-lerp
//     `else`, where `omega/sinom/scale0/scale1` are conditionally defined then
//     read once (classic partial-SSA / conditional-def handling + fold).
// `EPSILON` (mathcat common.js = 0.000001) is inlined as a literal. mathcat is
// third-party and never modified; this is an annotated COPY.

/* @optimize */
export function slerp(out: number[], a: number[], b: number[], t: number): number[] {
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const aw = a[3];
    let bx = b[0];
    let by = b[1];
    let bz = b[2];
    let bw = b[3];

    let omega: number;
    let cosom: number;
    let sinom: number;
    let scale0: number;
    let scale1: number;

    // calc cosine
    cosom = ax * bx + ay * by + az * bz + aw * bw;
    // adjust signs (if necessary)
    if (cosom < 0.0) {
        cosom = -cosom;
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
    }
    // calculate coefficients
    if (1.0 - cosom > 0.000001) {
        // standard case (slerp)
        omega = Math.acos(cosom);
        sinom = Math.sin(omega);
        scale0 = Math.sin((1.0 - t) * omega) / sinom;
        scale1 = Math.sin(t * omega) / sinom;
    } else {
        // "from" and "to" quaternions are very close → linear interpolation
        scale0 = 1.0 - t;
        scale1 = t;
    }

    out[0] = scale0 * ax + scale1 * bx;
    out[1] = scale0 * ay + scale1 * by;
    out[2] = scale0 * az + scale1 * bz;
    out[3] = scale0 * aw + scale1 * bw;
    return out;
}
