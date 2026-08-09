import { Vec3 } from "./Vec3";
import { dsqrt, dsin, dcos, datan2, dasin, dacos, dabs, dsign, HALF_PI } from "../DeterministicMath";

export class Quat {
  constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}

  set(x: number, y: number, z: number, w: number): this {
    this.x = x; this.y = y; this.z = z; this.w = w;
    return this;
  }

  identity(): this {
    this.x = 0; this.y = 0; this.z = 0; this.w = 1;
    return this;
  }

  copy(q: Quat): this {
    this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w;
    return this;
  }

  clone(): Quat {
    return new Quat(this.x, this.y, this.z, this.w);
  }

  multiply(q: Quat): this {
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    const bx = q.x, by = q.y, bz = q.z, bw = q.w;
    this.x = aw * bx + ax * bw + ay * bz - az * by;
    this.y = aw * by - ax * bz + ay * bw + az * bx;
    this.z = aw * bz + ax * by - ay * bx + az * bw;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  invert(): this {
    const dot = this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
    if (dot > 0) {
      const invDot = 1 / dot;
      this.x *= -invDot; this.y *= -invDot; this.z *= -invDot; this.w *= invDot;
    }
    return this;
  }

  normalize(): this {
    const len = dsqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
    if (len > 1e-8) {
      const inv = 1 / len;
      this.x *= inv; this.y *= inv; this.z *= inv; this.w *= inv;
    }
    return this;
  }

  rotateVec3(v: Vec3): Vec3 {
    const qx = this.x, qy = this.y, qz = this.z, qw = this.w;
    const ix = qw * v.x + qy * v.z - qz * v.y;
    const iy = qw * v.y + qz * v.x - qx * v.z;
    const iz = qw * v.z + qx * v.y - qy * v.x;
    const iw = -qx * v.x - qy * v.y - qz * v.z;
    return new Vec3(
      ix * qw + iw * -qx + iy * -qz - iz * -qy,
      iy * qw + iw * -qy + iz * -qx - ix * -qz,
      iz * qw + iw * -qz + ix * -qy - iy * -qx
    );
  }

  slerp(q: Quat, t: number): this {
    let dot = this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
    let bx = q.x, by = q.y, bz = q.z, bw = q.w;
    if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }

    let s0: number, s1: number;
    if (1.0 - dot > 1e-6) {
      const omega = dacos(dot);
      const sinOmega = dsin(omega);
      s0 = dsin((1 - t) * omega) / sinOmega;
      s1 = dsin(t * omega) / sinOmega;
    } else {
      s0 = 1 - t;
      s1 = t;
    }
    this.x = s0 * this.x + s1 * bx;
    this.y = s0 * this.y + s1 * by;
    this.z = s0 * this.z + s1 * bz;
    this.w = s0 * this.w + s1 * bw;
    return this;
  }

  toEuler(): Vec3 {
    const sinrCosp = 2 * (this.w * this.x + this.y * this.z);
    const cosrCosp = 1 - 2 * (this.x * this.x + this.y * this.y);
    const x = datan2(sinrCosp, cosrCosp);

    const sinp = 2 * (this.w * this.y - this.z * this.x);
    const y = dabs(sinp) >= 1 ? dsign(sinp) * HALF_PI : dasin(sinp);

    const sinyCosp = 2 * (this.w * this.z + this.x * this.y);
    const cosyCosp = 1 - 2 * (this.y * this.y + this.z * this.z);
    const z = datan2(sinyCosp, cosyCosp);

    return new Vec3(x, y, z);
  }

  static fromEuler(x: number, y: number, z: number): Quat {
    const cx = dcos(x * 0.5), sx = dsin(x * 0.5);
    const cy = dcos(y * 0.5), sy = dsin(y * 0.5);
    const cz = dcos(z * 0.5), sz = dsin(z * 0.5);
    return new Quat(
      sx * cy * cz - cx * sy * sz,
      cx * sy * cz + sx * cy * sz,
      cx * cy * sz - sx * sy * cz,
      cx * cy * cz + sx * sy * sz
    );
  }

  static fromAxisAngle(axis: Vec3, angle: number): Quat {
    const half = angle * 0.5;
    const s = dsin(half);
    return new Quat(axis.x * s, axis.y * s, axis.z * s, dcos(half));
  }

  toArray(): [number, number, number, number] {
    return [this.x, this.y, this.z, this.w];
  }
}
