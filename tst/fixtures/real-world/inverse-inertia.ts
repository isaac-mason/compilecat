// Faithful distillation of crashcat's `getInverseInertiaForRotation`
// (body/motion-properties.ts): world-space inverse inertia I⁻¹ = R·diag·Rᵀ with
// R = bodyRotation · quatToMat(inertiaRotation), then DOF-masked. This is the
// richest fixture — it stacks THREE optimizations at once:
//   1. TRANSITIVE inline: `@optimize` flattens the driver's four back-to-back mat4
//      kernels (fromQuat → multiply3x3 → scale → multiply3x3RightTransposed) into
//      one straight-line block (~110 statements, ~40 temps).
//   2. Module-scratch scalarization: `_inertiaRotMat`/`_rotation`/`_scaled` are
//      flat mat4[16] scratches, written by one inlined op then read by the next —
//      single-owner + killed-on-entry, so they scalarize (const deleted).
//   3. A DOF-mask `if` branch (bitmask-gated per-column scaling) → fold + branch.
// The `MotionProperties` struct is flattened to plain params (inertiaRotation quat,
// invInertiaDiagonal vec3, allowedDegreesOfFreedom bitmask). mathcat/crashcat are
// third-party and never modified; this is an annotated COPY.

// mat4.fromQuat — quaternion → 4x4 rotation matrix.
function m4fromQuat(out: number[], q: number[]): number[] {
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
    out[0] = 1 - yy - zz;
    out[1] = yx + wz;
    out[2] = zx - wy;
    out[3] = 0;
    out[4] = yx - wz;
    out[5] = 1 - xx - zz;
    out[6] = zy + wx;
    out[7] = 0;
    out[8] = zx + wy;
    out[9] = zy - wx;
    out[10] = 1 - xx - yy;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
}

// mat4.multiply3x3 — 3x3-of-4x4 multiply (b0/b1/b2 reassigned per column).
function m4multiply3x3(out: number[], a: number[], b: number[]): number[] {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    let b0 = b[0];
    let b1 = b[1];
    let b2 = b[2];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22;
    out[3] = 0;
    b0 = b[4];
    b1 = b[5];
    b2 = b[6];
    out[4] = b0 * a00 + b1 * a10 + b2 * a20;
    out[5] = b0 * a01 + b1 * a11 + b2 * a21;
    out[6] = b0 * a02 + b1 * a12 + b2 * a22;
    out[7] = 0;
    b0 = b[8];
    b1 = b[9];
    b2 = b[10];
    out[8] = b0 * a00 + b1 * a10 + b2 * a20;
    out[9] = b0 * a01 + b1 * a11 + b2 * a21;
    out[10] = b0 * a02 + b1 * a12 + b2 * a22;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
}

// mat4.scale — scale columns 0/1/2 by v.x/v.y/v.z.
function m4scale(out: number[], a: number[], v: number[]): number[] {
    const x = v[0];
    const y = v[1];
    const z = v[2];
    out[0] = a[0] * x;
    out[1] = a[1] * x;
    out[2] = a[2] * x;
    out[3] = a[3] * x;
    out[4] = a[4] * y;
    out[5] = a[5] * y;
    out[6] = a[6] * y;
    out[7] = a[7] * y;
    out[8] = a[8] * z;
    out[9] = a[9] * z;
    out[10] = a[10] * z;
    out[11] = a[11] * z;
    out[12] = a[12];
    out[13] = a[13];
    out[14] = a[14];
    out[15] = a[15];
    return out;
}

// mat4.multiply3x3RightTransposed — out = a · bᵀ (3x3 only).
function m4multiply3x3RightTransposed(out: number[], a: number[], b: number[]): number[] {
    const a00 = a[0];
    const a01 = a[1];
    const a02 = a[2];
    const a10 = a[4];
    const a11 = a[5];
    const a12 = a[6];
    const a20 = a[8];
    const a21 = a[9];
    const a22 = a[10];
    let bt0 = b[0];
    let bt1 = b[4];
    let bt2 = b[8];
    out[0] = bt0 * a00 + bt1 * a10 + bt2 * a20;
    out[1] = bt0 * a01 + bt1 * a11 + bt2 * a21;
    out[2] = bt0 * a02 + bt1 * a12 + bt2 * a22;
    out[3] = 0;
    bt0 = b[1];
    bt1 = b[5];
    bt2 = b[9];
    out[4] = bt0 * a00 + bt1 * a10 + bt2 * a20;
    out[5] = bt0 * a01 + bt1 * a11 + bt2 * a21;
    out[6] = bt0 * a02 + bt1 * a12 + bt2 * a22;
    out[7] = 0;
    bt0 = b[2];
    bt1 = b[6];
    bt2 = b[10];
    out[8] = bt0 * a00 + bt1 * a10 + bt2 * a20;
    out[9] = bt0 * a01 + bt1 * a11 + bt2 * a21;
    out[10] = bt0 * a02 + bt1 * a12 + bt2 * a22;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
}

// Module scratch — the intermediate matrices threaded between the four ops.
const _inertiaRotMat = /* @__PURE__ */ [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const _rotation = /* @__PURE__ */ [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const _scaled = /* @__PURE__ */ [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/* @optimize */
export function getInverseInertiaForRotation(
    out: number[],
    inertiaRotation: number[],
    invInertiaDiagonal: number[],
    allowedDegreesOfFreedom: number,
    bodyRotation: number[],
): number[] {
    // step 1: inertia rotation quaternion → matrix
    m4fromQuat(_inertiaRotMat, inertiaRotation);
    // step 2: rotation = bodyRotation * inertiaRotMat
    m4multiply3x3(_rotation, bodyRotation, _inertiaRotMat);
    // step 3: scale rotation columns by inverse inertia diagonal
    m4scale(_scaled, _rotation, invInertiaDiagonal);
    // step 4: out = scaled * rotationᵀ
    m4multiply3x3RightTransposed(out, _scaled, _rotation);

    // step 5: mask out DOFs that are not allowed
    const allowedRotationAxis = (allowedDegreesOfFreedom >> 3) & 0b111;
    if (allowedRotationAxis !== 0b111) {
        const maskX = allowedRotationAxis & 0b001 ? 1.0 : 0.0;
        const maskY = allowedRotationAxis & 0b010 ? 1.0 : 0.0;
        const maskZ = allowedRotationAxis & 0b100 ? 1.0 : 0.0;
        out[0] *= maskX * maskX;
        out[1] *= maskY * maskX;
        out[2] *= maskZ * maskX;
        out[4] *= maskX * maskY;
        out[5] *= maskY * maskY;
        out[6] *= maskZ * maskY;
        out[8] *= maskX * maskZ;
        out[9] *= maskY * maskZ;
        out[10] *= maskZ * maskZ;
    }
    return out;
}
