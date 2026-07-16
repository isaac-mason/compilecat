// Faithful copy of crashcat's `rayCylinder` (collision/sphere-triangle.ts) driven
// by a small raycast-vs-many-cylinders host. `rayCylinder` is a dense
// multiple-return guard cascade (SIX `return Infinity` early exits interleaved
// with dot-product + quadratic-solve arithmetic) — inlining it into the
// `@optimize` host converts every return into a labelled-block break
// (`_inline_rayCylinder_<id>`), then folds/SROAs the quadratic temps. A denser
// sibling of the dbvt `rayDistanceToBox3` fixture. crashcat/mathcat are
// third-party and never modified; this is an annotated COPY.

// Ray origin is at (0,0,0); returns the smallest hit fraction in [0,1] or Infinity.
function rayCylinder(direction: number[], cylinderA: number[], cylinderB: number[], radius: number): number {
    const axisX = cylinderB[0] - cylinderA[0];
    const axisY = cylinderB[1] - cylinderA[1];
    const axisZ = cylinderB[2] - cylinderA[2];

    const startX = -cylinderA[0];
    const startY = -cylinderA[1];
    const startZ = -cylinderA[2];

    const startDotAxis = startX * axisX + startY * axisY + startZ * axisZ;
    const directionDotAxis = direction[0] * axisX + direction[1] * axisY + direction[2] * axisZ;
    const endDotAxis = startDotAxis + directionDotAxis;

    if (startDotAxis < 0 && endDotAxis < 0) {
        return Infinity;
    }

    const axisLenSq = axisX * axisX + axisY * axisY + axisZ * axisZ;
    if (startDotAxis > axisLenSq && endDotAxis > axisLenSq) {
        return Infinity;
    }

    const dirLenSq = direction[0] * direction[0] + direction[1] * direction[1] + direction[2] * direction[2];
    const a = axisLenSq * dirLenSq - directionDotAxis * directionDotAxis;

    if (Math.abs(a) < 1e-6) {
        return Infinity;
    }

    const startDotDir = startX * direction[0] + startY * direction[1] + startZ * direction[2];
    const startLenSq = startX * startX + startY * startY + startZ * startZ;

    const b = axisLenSq * startDotDir - directionDotAxis * startDotAxis;
    const c = axisLenSq * (startLenSq - radius * radius) - startDotAxis * startDotAxis;

    const det = b * b - a * c;
    if (det < 0) {
        return Infinity;
    }

    const t = -(b + Math.sqrt(det)) / a;

    if (t < 0 || t > 1) {
        return Infinity;
    }

    const hitDotAxis = startDotAxis + t * directionDotAxis;
    if (hitDotAxis < 0 || hitDotAxis > axisLenSq) {
        return Infinity;
    }

    return t;
}

/* @optimize */
export function castRayVsCylinders(direction: number[], aPoints: number[][], bPoints: number[][], radius: number): number {
    let best = Infinity;
    for (let i = 0; i < aPoints.length; i++) {
        const t = rayCylinder(direction, aPoints[i], bPoints[i], radius);
        if (t < best) best = t;
    }
    return best;
}
