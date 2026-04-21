export type Vec3 = [x: number, y: number, z: number];

export type Body = {
  position: Vec3;
  velocity: Vec3;
  mass: number;
};

/** @inline */
export function vec3Add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

/** @inline */
export function vec3Scale(out: Vec3, v: Vec3, scale: number): Vec3 {
  out[0] = v[0] * scale;
  out[1] = v[1] * scale;
  out[2] = v[2] * scale;
  return out;
}

/** @inline */
export function vec3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
