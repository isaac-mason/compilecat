// Distilled from crashcat/src/collision/gjk.ts (computeClosestPointOnTriangle) —
// a real hot GJK kernel: dense vec3 math, branches, ternaries, out-param writes,
// one @inline pure helper (clamp, as mathcat provides it). A representative
// real-world correctness + optimality fixture. DO NOT edit to game the optimizer;
// it should read like authored physics code.
type Vec3 = number[];
type ClosestPointResult = { point: Vec3; pointSet: number };

/* @inline */ function clamp(x: number, lo: number, hi: number): number {
    return x < lo ? lo : x > hi ? hi : x;
}

/**
 * @optimize
 */
export function computeClosestPointOnTriangle(
    out: ClosestPointResult,
    inA: Vec3,
    inB: Vec3,
    inC: Vec3,
    mustIncludeC: boolean,
    squaredTolerance: number,
): void {
    // the most accurate normal is calculated by using the two shortest edges
    const acx = inC[0] - inA[0];
    const acy = inC[1] - inA[1];
    const acz = inC[2] - inA[2];

    const bcx = inC[0] - inB[0];
    const bcy = inC[1] - inB[1];
    const bcz = inC[2] - inB[2];

    const swapAC = bcx * bcx + bcy * bcy + bcz * bcz < acx * acx + acy * acy + acz * acz;

    // choose a and c based on swap
    const ax = swapAC ? inC[0] : inA[0];
    const ay = swapAC ? inC[1] : inA[1];
    const az = swapAC ? inC[2] : inA[2];
    const cx = swapAC ? inA[0] : inC[0];
    const cy = swapAC ? inA[1] : inC[1];
    const cz = swapAC ? inA[2] : inC[2];

    // calculate normal
    const abx = inB[0] - ax;
    const aby = inB[1] - ay;
    const abz = inB[2] - az;

    const ac_x = cx - ax;
    const ac_y = cy - ay;
    const ac_z = cz - az;

    const nx = aby * ac_z - abz * ac_y;
    const ny = abz * ac_x - abx * ac_z;
    const nz = abx * ac_y - aby * ac_x;

    const normalLengthSquared = nx * nx + ny * ny + nz * nz;

    // check degenerate
    if (normalLengthSquared < 1.0e-10) {
        // degenerate, fallback to vertices and edges
        let closestSet = 0b0100;
        let closestX = inC[0];
        let closestY = inC[1];
        let closestZ = inC[2];
        let bestDistanceSquared = inC[0] * inC[0] + inC[1] * inC[1] + inC[2] * inC[2];

        if (!mustIncludeC) {
            // try vertex A
            const aLengthSquared = inA[0] * inA[0] + inA[1] * inA[1] + inA[2] * inA[2];

            if (aLengthSquared < bestDistanceSquared) {
                closestSet = 0b0001;
                closestX = inA[0];
                closestY = inA[1];
                closestZ = inA[2];
                bestDistanceSquared = aLengthSquared;
            }

            // try vertex B
            const bLengthSquared = inB[0] * inB[0] + inB[1] * inB[1] + inB[2] * inB[2];
            if (bLengthSquared < bestDistanceSquared) {
                closestSet = 0b0010;
                closestX = inB[0];
                closestY = inB[1];
                closestZ = inB[2];
                bestDistanceSquared = bLengthSquared;
            }
        }

        // edge AC
        const ac2x = cx - ax;
        const ac2y = cy - ay;
        const ac2z = cz - az;
        const acLengthSquared = ac2x * ac2x + ac2y * ac2y + ac2z * ac2z;

        if (acLengthSquared > squaredTolerance) {
            const v = clamp(-(ax * ac2x + ay * ac2y + az * ac2z) / acLengthSquared, 0.0, 1.0);
            const qx = ax + ac2x * v;
            const qy = ay + ac2y * v;
            const qz = az + ac2z * v;

            const distanceSquared = qx * qx + qy * qy + qz * qz;

            if (distanceSquared < bestDistanceSquared) {
                closestSet = 0b0101;
                closestX = qx;
                closestY = qy;
                closestZ = qz;
                bestDistanceSquared = distanceSquared;
            }
        }

        // edge BC
        const bc2x = inC[0] - inB[0];
        const bc2y = inC[1] - inB[1];
        const bc2z = inC[2] - inB[2];

        const bcLengthSquared = bc2x * bc2x + bc2y * bc2y + bc2z * bc2z;

        if (bcLengthSquared > squaredTolerance) {
            const v = clamp(-(inB[0] * bc2x + inB[1] * bc2y + inB[2] * bc2z) / bcLengthSquared, 0.0, 1.0);

            const qx = inB[0] + bc2x * v;
            const qy = inB[1] + bc2y * v;
            const qz = inB[2] + bc2z * v;

            const distanceSquared = qx * qx + qy * qy + qz * qz;

            if (distanceSquared < bestDistanceSquared) {
                closestSet = 0b0110;
                closestX = qx;
                closestY = qy;
                closestZ = qz;
                bestDistanceSquared = distanceSquared;
            }
        }

        if (!mustIncludeC) {
            // edge AB
            const ab2x = inB[0] - inA[0];
            const ab2y = inB[1] - inA[1];
            const ab2z = inB[2] - inA[2];

            const abLengthSquared = ab2x * ab2x + ab2y * ab2y + ab2z * ab2z;

            if (abLengthSquared > squaredTolerance) {
                const v = clamp(-(inA[0] * ab2x + inA[1] * ab2y + inA[2] * ab2z) / abLengthSquared, 0.0, 1.0);

                const qx = inA[0] + ab2x * v;
                const qy = inA[1] + ab2y * v;
                const qz = inA[2] + ab2z * v;

                const distanceSquared = qx * qx + qy * qy + qz * qz;

                if (distanceSquared < bestDistanceSquared) {
                    closestSet = 0b0011;
                    closestX = qx;
                    closestY = qy;
                    closestZ = qz;
                }
            }
        }

        out.pointSet = closestSet;
        out.point[0] = closestX;
        out.point[1] = closestY;
        out.point[2] = closestZ;

        return;
    }

    // check if P in vertex region outside A
    const apx = -ax;
    const apy = -ay;
    const apz = -az;

    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = ac_x * apx + ac_y * apy + ac_z * apz;

    if (d1 <= 0.0 && d2 <= 0.0) {
        out.pointSet = swapAC ? 0b0100 : 0b0001;
        out.point[0] = ax;
        out.point[1] = ay;
        out.point[2] = az;
        return;
    }

    // check if P in vertex region outside B
    const bpx = -inB[0];
    const bpy = -inB[1];
    const bpz = -inB[2];

    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = ac_x * bpx + ac_y * bpy + ac_z * bpz;

    if (d3 >= 0.0 && d4 <= d3) {
        out.pointSet = 0b0010;
        out.point[0] = inB[0];
        out.point[1] = inB[1];
        out.point[2] = inB[2];
        return;
    }

    // check if P in edge region of AB
    if (d1 * d4 <= d3 * d2 && d1 >= 0.0 && d3 <= 0.0) {
        const v = d1 / (d1 - d3);
        out.pointSet = swapAC ? 0b0110 : 0b0011;
        out.point[0] = ax + abx * v;
        out.point[1] = ay + aby * v;
        out.point[2] = az + abz * v;
        return;
    }

    // check if P in vertex region outside C
    const cpx = -cx;
    const cpy = -cy;
    const cpz = -cz;

    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = ac_x * cpx + ac_y * cpy + ac_z * cpz;

    if (d6 >= 0.0 && d5 <= d6) {
        out.pointSet = swapAC ? 0b0001 : 0b0100;
        out.point[0] = cx;
        out.point[1] = cy;
        out.point[2] = cz;
        return;
    }

    // check if P in edge region of AC
    if (d5 * d2 <= d1 * d6 && d2 >= 0.0 && d6 <= 0.0) {
        const w = d2 / (d2 - d6);
        out.pointSet = 0b0101;
        out.point[0] = ax + ac_x * w;
        out.point[1] = ay + ac_y * w;
        out.point[2] = az + ac_z * w;
        return;
    }

    // check if P in edge region of BC
    const diff_d4_d3 = d4 - d3;
    const diff_d5_d6 = d5 - d6;
    if (d3 * d6 <= d5 * d4 && diff_d4_d3 >= 0.0 && diff_d5_d6 >= 0.0) {
        const w = diff_d4_d3 / (diff_d4_d3 + diff_d5_d6);
        out.pointSet = swapAC ? 0b0011 : 0b0110;

        const bcx = cx - inB[0];
        const bcy = cy - inB[1];
        const bcz = cz - inB[2];

        out.point[0] = inB[0] + bcx * w;
        out.point[1] = inB[1] + bcy * w;
        out.point[2] = inB[2] + bcz * w;
        return;
    }

    // P inside face region
    out.pointSet = 0b0111;

    const sumx = ax + inB[0] + cx;
    const sumy = ay + inB[1] + cy;
    const sumz = az + inB[2] + cz;

    const scale = (sumx * nx + sumy * ny + sumz * nz) / (3 * normalLengthSquared);
    out.point[0] = nx * scale;
    out.point[1] = ny * scale;
    out.point[2] = nz * scale;
}