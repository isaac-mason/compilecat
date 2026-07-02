// Real crashcat pattern: a module-level vec3 scratch buffer (allocated once,
// `/* @__PURE__ */`) reused per call, written via out-param mathcat ops and read
// into `out`. Modelled on `updatePositionFromCenterOfMass` (rigid-body.ts) but with
// the scratch used DIRECTLY (no local alias) — the shape that compilecat's
// module-scratch scalar replacement scalarizes (like `getInverseInertiaForRotation`).
// The vec3 ops are faithful copies of mathcat's, marked `@inline` so cross-op the
// scratch collapses to `_scratch[i] = …` member stores that SROA then scalarizes.
// mathcat/crashcat are third-party and never modified; this is an annotated COPY.

/* @inline */ function v3copy(out: number[], a: number[]): number[] {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    return out;
}

/* @inline */ function v3sub(out: number[], a: number[], b: number[]): number[] {
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    out[2] = a[2] - b[2];
    return out;
}

/* @inline */ function v3transformQuat(out: number[], a: number[], q: number[]): number[] {
    const qx = q[0];
    const qy = q[1];
    const qz = q[2];
    const qw = q[3];
    const x = a[0];
    const y = a[1];
    const z = a[2];
    let uvx = qy * z - qz * y;
    let uvy = qz * x - qx * z;
    let uvz = qx * y - qy * x;
    let uuvx = qy * uvz - qz * uvy;
    let uuvy = qz * uvx - qx * uvz;
    let uuvz = qx * uvy - qy * uvx;
    const w2 = qw * 2;
    uvx *= w2;
    uvy *= w2;
    uvz *= w2;
    uuvx *= 2;
    uuvy *= 2;
    uuvz *= 2;
    out[0] = x + uvx + uuvx;
    out[1] = y + uvy + uuvy;
    out[2] = z + uvz + uuvz;
    return out;
}

/* @inline */ function v3cross(out: number[], a: number[], b: number[]): number[] {
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const bx = b[0];
    const by = b[1];
    const bz = b[2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
}

// Module scratch — crashcat house style (`vec3.create()` → [0,0,0]). Each entry
// owns its OWN scratch so single-ownership holds per function.
const _scratch = /* @__PURE__ */ [0, 0, 0];
const _scratchAliased = /* @__PURE__ */ [0, 0, 0];
const _scratchCross = /* @__PURE__ */ [0, 0, 0];

// DIRECT scratch use → scalarizes (like getInverseInertiaForRotation).
/* @optimize */
export function updatePosition(
    out: number[],
    shapeCenterOfMass: number[],
    quaternion: number[],
    comPosition: number[],
): number[] {
    v3copy(_scratch, shapeCenterOfMass);
    v3transformQuat(_scratch, _scratch, quaternion);
    v3sub(out, comPosition, _scratch);
    return out;
}

// LOCAL-ALIAS scratch use (`const s = _scratchAliased`) → v1 BAILS (the bare `_s`
// reference reads as an escape). Faithful to `updatePositionFromCenterOfMass`.
// Kept correct either way; pins the v2 alias-following opportunity.
/* @optimize */
export function updatePositionAliased(
    out: number[],
    shapeCenterOfMass: number[],
    quaternion: number[],
    comPosition: number[],
): number[] {
    const s = _scratchAliased;
    v3copy(s, shapeCenterOfMass);
    v3transformQuat(s, s, quaternion);
    v3sub(out, comPosition, s);
    return out;
}

// DIRECT scratch, cross+sub mix (e.g. a surface tangent) → scalarizes.
/* @optimize */
export function tangent(out: number[], a: number[], b: number[], c: number[]): number[] {
    v3sub(_scratchCross, b, a);
    v3cross(out, _scratchCross, c);
    return out;
}
