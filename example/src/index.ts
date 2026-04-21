import { vec3Add, vec3Scale, vec3Dot, type Vec3, type Body } from './math';

export type Constraint = {
  normal: Vec3;
  body: Body;
  lambda: number;
};

export function integrate(body: Body, dt: number): void {
  const gravity: Vec3 = [0, -9.8, 0];
  const temp: Vec3 = [0, 0, 0];

  // apply gravity: velocity += gravity * dt
  /* @inline */ vec3Scale(temp, gravity, dt);
  /* @inline */ vec3Add(body.velocity, body.velocity, temp);

  // move position: position += velocity * dt
  /* @inline */ vec3Scale(temp, body.velocity, dt);
  /* @inline */ vec3Add(body.position, body.position, temp);
}

export function kineticEnergy(body: Body): number {
  const v2 = /* @inline */ vec3Dot(body.velocity, body.velocity);
  return 0.5 * body.mass * v2;
}
