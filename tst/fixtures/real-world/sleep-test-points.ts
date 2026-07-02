// Faithful distillation of crashcat's `getSleepTestPoints` (body/sleep.ts): compute
// three sleep-detection test points (com, com+axis1*s1, com+axis2*s2), picking the
// two largest AABB extent axes via a 3-way branch. Rich real-world shape for the
// module-scratch optimization:
//   - `_extents` (vec3) and `_axis` (vec3) are literal-indexed → SCALARIZE,
//   - `_rot` (mat3) is DYNAMIC-indexed (`_rot[c1]`, c1 a variable) → correctly BAILS,
//   - a 3-way if/else-if/else branch selects the axis columns.
// The mathcat ops (box3.extents, mat3.fromQuat, vec3.scaleAndAdd) are faithful copies
// marked `@inline`. mathcat/crashcat are third-party and never modified; this is an
// annotated COPY.

/* @inline */ function box3extents(o: number[], box: number[]): void {
    o[0] = (box[3] - box[0]) * 0.5;
    o[1] = (box[4] - box[1]) * 0.5;
    o[2] = (box[5] - box[2]) * 0.5;
}

/* @inline */ function mat3FromQuat(o: number[], q: number[]): void {
    const x = q[0];
    const y = q[1];
    const z = q[2];
    const w = q[3];
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const yx = y * x2;
    const yy = y * y2;
    const zx = z * x2;
    const zy = z * y2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    o[0] = 1 - yy - zz;
    o[3] = yx - wz;
    o[6] = zx + wy;
    o[1] = yx + wz;
    o[4] = 1 - xx - zz;
    o[7] = zy - wx;
    o[2] = zx - wy;
    o[5] = zy + wx;
    o[8] = 1 - xx - yy;
}

/* @inline */ function v3scaleAndAdd(o: number[], a: number[], b: number[], s: number): void {
    o[0] = a[0] + b[0] * s;
    o[1] = a[1] + b[1] * s;
    o[2] = a[2] + b[2] * s;
}

// Module scratch — crashcat house style.
const _extents = /* @__PURE__ */ [0, 0, 0];
const _rot = /* @__PURE__ */ [0, 0, 0, 0, 0, 0, 0, 0, 0];
const _axis = /* @__PURE__ */ [0, 0, 0];

/* @optimize */
export function sleepTestPoints(
    out0: number[],
    out1: number[],
    out2: number[],
    com: number[],
    aabb: number[],
    quat: number[],
): void {
    // point 0 = center of mass
    out0[0] = com[0];
    out0[1] = com[1];
    out0[2] = com[2];

    box3extents(_extents, aabb);
    const ex = _extents[0];
    const ey = _extents[1];
    const ez = _extents[2];

    mat3FromQuat(_rot, quat);

    // pick the two largest extent axes (drop the smallest)
    let c1: number;
    let s1: number;
    let c2: number;
    let s2: number;
    if (ex <= ey && ex <= ez) {
        c1 = 3;
        s1 = ey;
        c2 = 6;
        s2 = ez;
    } else if (ey <= ez) {
        c1 = 0;
        s1 = ex;
        c2 = 6;
        s2 = ez;
    } else {
        c1 = 0;
        s1 = ex;
        c2 = 3;
        s2 = ey;
    }

    // point 1 = com + axis1 * s1  (axis1 = _rot column c1 — DYNAMIC index into _rot)
    _axis[0] = _rot[c1];
    _axis[1] = _rot[c1 + 1];
    _axis[2] = _rot[c1 + 2];
    v3scaleAndAdd(out1, com, _axis, s1);

    // point 2 = com + axis2 * s2
    _axis[0] = _rot[c2];
    _axis[1] = _rot[c2 + 1];
    _axis[2] = _rot[c2 + 2];
    v3scaleAndAdd(out2, com, _axis, s2);
}
