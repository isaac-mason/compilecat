// Faithful distillation of crashcat's dbvt `castRay` (broadphase/dbvt.ts) — the
// case we've been working from. It exercises three things at once:
//
//   1. TRANSITIVE inlining: `castRay` is `@optimize` (⇒ `@flatten`), so it inlines
//      `setRay`; `setRay`'s body calls `copy` (a vec3 leaf op), and that call is
//      only EXPOSED by inlining `setRay`. Transitive inlining must then inline
//      `copy` too (the real `raycast3.set → vec3.copy` chain), not leave a residual
//      `copy(...)` call.
//   2. A module-level NESTED scratch `_ray` ({origin,dir,len}) written by `setRay`
//      then read into scalars — the shape module-scratch elimination targets next.
//   3. `rayDistanceToBox3`, a MULTIPLE-return AABB slab test → block-inlined into a
//      labelled block (`_inline_rayDistanceToBox3_<id>`), run per candidate box.
//
// The per-node dbvt tree walk is flattened to a scan over candidate boxes so the
// kernel is self-contained and its result is checkable against the source over
// random inputs. mathcat/crashcat are third-party and never modified; this is an
// annotated COPY.

// vec3 copy — a leaf op. Plain (not `@inline`): it inlines ONLY because it's
// exposed inside `setRay` after `castRay`'s `@flatten` pulls `setRay` in, which is
// exactly the transitive case.
function copy(o: number[], a: number[]): number[] {
    o[0] = a[0];
    o[1] = a[1];
    o[2] = a[2];
    return o;
}

// raycast3.set — copies origin/direction into the scratch ray, sets its length.
// Calls `copy` twice (the calls transitive inlining must resolve).
function setRay(r: { origin: number[]; dir: number[]; len: number }, o: number[], d: number[], l: number): void {
    copy(r.origin, o);
    copy(r.dir, d);
    r.len = l;
}

// rayDistanceToBox3 — normalized distance (0-1) to the box entry point, or
// Infinity if the ray misses. Multiple early returns ⇒ block-inline / labelled.
function rayDistanceToBox3(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    len: number,
    box: number[],
): number {
    let tMin = 0;
    let tMax = len;
    if (Math.abs(dx) < 1e-10) {
        if (ox < box[0] || ox > box[3]) return Infinity;
    } else {
        const inv = 1 / dx;
        const t0 = (box[0] - ox) * inv;
        const t1 = (box[3] - ox) * inv;
        const near = t0 < t1 ? t0 : t1;
        const far = t0 < t1 ? t1 : t0;
        tMin = near > tMin ? near : tMin;
        tMax = far < tMax ? far : tMax;
        if (tMax < tMin) return Infinity;
    }
    if (Math.abs(dy) < 1e-10) {
        if (oy < box[1] || oy > box[4]) return Infinity;
    } else {
        const inv = 1 / dy;
        const t0 = (box[1] - oy) * inv;
        const t1 = (box[4] - oy) * inv;
        const near = t0 < t1 ? t0 : t1;
        const far = t0 < t1 ? t1 : t0;
        tMin = near > tMin ? near : tMin;
        tMax = far < tMax ? far : tMax;
        if (tMax < tMin) return Infinity;
    }
    if (Math.abs(dz) < 1e-10) {
        if (oz < box[2] || oz > box[5]) return Infinity;
    } else {
        const inv = 1 / dz;
        const t0 = (box[2] - oz) * inv;
        const t1 = (box[5] - oz) * inv;
        const near = t0 < t1 ? t0 : t1;
        const far = t0 < t1 ? t1 : t0;
        tMin = near > tMin ? near : tMin;
        tMax = far < tMax ? far : tMax;
        if (tMax < tMin) return Infinity;
    }
    return tMin >= 0 ? tMin / len : Infinity;
}

// Module scratch — crashcat house style (`raycast3.create()`). Nested vec3s.
const _ray = /* @__PURE__ */ { origin: [0, 0, 0], dir: [0, 0, 0], len: 0 };

/* @optimize */
export function castRay(origin: number[], direction: number[], length: number, boxes: number[][]): number {
    setRay(_ray, origin, direction, length);
    const ox = _ray.origin[0];
    const oy = _ray.origin[1];
    const oz = _ray.origin[2];
    const dx = _ray.dir[0];
    const dy = _ray.dir[1];
    const dz = _ray.dir[2];
    const rayLen = _ray.len;

    let best = Infinity;
    for (let i = 0; i < boxes.length; i++) {
        const dist = rayDistanceToBox3(ox, oy, oz, dx, dy, dz, rayLen, boxes[i]);
        if (dist < best) best = dist;
    }
    return best;
}
