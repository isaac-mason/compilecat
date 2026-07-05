// Faithful copy of mathcat's `quat.fromEuler` (dist/quat.js): quaternion from
// Euler angles, dispatched by rotation ORDER. The distinct shape here is a
// switch over a STRING discriminant (6 orders) — unlike the numeric switch in the
// simplex-closest fixture — where every case is straight-line 4-component
// arithmetic sharing the SAME six precomputed trig temps (`c1..s3`). Stresses
// string-switch dispatch + heavy shared-subexpression reuse / fold across cases +
// local-var handling of the shared trig prelude. The original packs the order
// into `euler[3]` and warns on unknown orders; here `order` is a param and the
// unknown case is dropped (unreachable in tests). mathcat is third-party and
// never modified; this is an annotated COPY.

/* @optimize */
export function fromEuler(out: number[], x: number, y: number, z: number, order: string): number[] {
    const o = order || 'xyz';
    const c1 = Math.cos(x / 2);
    const c2 = Math.cos(y / 2);
    const c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2);
    const s2 = Math.sin(y / 2);
    const s3 = Math.sin(z / 2);
    switch (o) {
        case 'xyz':
            out[0] = s1 * c2 * c3 + c1 * s2 * s3;
            out[1] = c1 * s2 * c3 - s1 * c2 * s3;
            out[2] = c1 * c2 * s3 + s1 * s2 * c3;
            out[3] = c1 * c2 * c3 - s1 * s2 * s3;
            break;
        case 'yxz':
            out[0] = s1 * c2 * c3 + c1 * s2 * s3;
            out[1] = c1 * s2 * c3 - s1 * c2 * s3;
            out[2] = c1 * c2 * s3 - s1 * s2 * c3;
            out[3] = c1 * c2 * c3 + s1 * s2 * s3;
            break;
        case 'zxy':
            out[0] = s1 * c2 * c3 - c1 * s2 * s3;
            out[1] = c1 * s2 * c3 + s1 * c2 * s3;
            out[2] = c1 * c2 * s3 + s1 * s2 * c3;
            out[3] = c1 * c2 * c3 - s1 * s2 * s3;
            break;
        case 'zyx':
            out[0] = s1 * c2 * c3 - c1 * s2 * s3;
            out[1] = c1 * s2 * c3 + s1 * c2 * s3;
            out[2] = c1 * c2 * s3 - s1 * s2 * c3;
            out[3] = c1 * c2 * c3 + s1 * s2 * s3;
            break;
        case 'yzx':
            out[0] = s1 * c2 * c3 + c1 * s2 * s3;
            out[1] = c1 * s2 * c3 + s1 * c2 * s3;
            out[2] = c1 * c2 * s3 - s1 * s2 * c3;
            out[3] = c1 * c2 * c3 - s1 * s2 * s3;
            break;
        case 'xzy':
            out[0] = s1 * c2 * c3 - c1 * s2 * s3;
            out[1] = c1 * s2 * c3 - s1 * c2 * s3;
            out[2] = c1 * c2 * s3 + s1 * s2 * c3;
            out[3] = c1 * c2 * c3 + s1 * s2 * s3;
            break;
    }
    return out;
}
