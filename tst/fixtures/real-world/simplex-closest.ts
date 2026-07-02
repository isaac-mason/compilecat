// Faithful distillation of crashcat's `computeClosestPointToSimplex` (collision/
// gjk.ts): a `switch (simplex.size)` dispatch where each case (point / segment /
// triangle / tetrahedron) computes the closest point into a module scratch, then
// writes `out`. This is the switch-scalarization shape — every case writes all
// scratch fields, so at the post-switch read they're must-written on all paths and
// the scratch scalarizes. The per-case math is simplified (centroid stand-in for the
// real barycentric helpers) but the control-flow shape is faithful. mathcat/crashcat
// are third-party and never modified; this is an annotated COPY.

const _closest = /* @__PURE__ */ [0, 0, 0];

/* @optimize */
export function closestOnSimplex(out: number[], size: number, y: number[]): number[] {
    switch (size) {
        case 1: {
            // single point
            _closest[0] = y[0];
            _closest[1] = y[1];
            _closest[2] = y[2];
            break;
        }
        case 2: {
            // segment midpoint
            _closest[0] = (y[0] + y[3]) * 0.5;
            _closest[1] = (y[1] + y[4]) * 0.5;
            _closest[2] = (y[2] + y[5]) * 0.5;
            break;
        }
        case 3: {
            // triangle centroid
            _closest[0] = (y[0] + y[3] + y[6]) / 3;
            _closest[1] = (y[1] + y[4] + y[7]) / 3;
            _closest[2] = (y[2] + y[5] + y[8]) / 3;
            break;
        }
        default: {
            // tetrahedron centroid (size 4) / fallback
            _closest[0] = (y[0] + y[3] + y[6] + y[9]) * 0.25;
            _closest[1] = (y[1] + y[4] + y[7] + y[10]) * 0.25;
            _closest[2] = (y[2] + y[5] + y[8] + y[11]) * 0.25;
        }
    }
    out[0] = _closest[0];
    out[1] = _closest[1];
    out[2] = _closest[2];
    return out;
}
