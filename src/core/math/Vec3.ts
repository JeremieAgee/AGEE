export class Vec3 {
  constructor(public x = 0, public y = 0, public z = 0) {}

  set(x: number, y: number, z: number): this {
    this.x = x; this.y = y; this.z = z;
    return this;
  }

  copy(v: Vec3): this {
    this.x = v.x; this.y = v.y; this.z = v.z;
    return this;
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  add(v: Vec3): this {
    this.x += v.x; this.y += v.y; this.z += v.z;
    return this;
  }

  sub(v: Vec3): this {
    this.x -= v.x; this.y -= v.y; this.z -= v.z;
    return this;
  }

  scale(s: number): this {
    this.x *= s; this.y *= s; this.z *= s;
    return this;
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v: Vec3): Vec3 {
    return new Vec3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x
    );
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  normalize(): this {
    const len = this.length();
    if (len > 1e-8) this.scale(1 / len);
    return this;
  }

  distanceTo(v: Vec3): number {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  distanceToSq(v: Vec3): number {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  lerp(v: Vec3, t: number): this {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }

  equals(v: Vec3, epsilon = 1e-6): boolean {
    return Math.abs(this.x - v.x) < epsilon &&
           Math.abs(this.y - v.y) < epsilon &&
           Math.abs(this.z - v.z) < epsilon;
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  static fromArray(a: ArrayLike<number>, offset = 0): Vec3 {
    return new Vec3(a[offset], a[offset + 1], a[offset + 2]);
  }

  static readonly ZERO: Readonly<Vec3> = Object.freeze(new Vec3(0, 0, 0));
  static readonly ONE: Readonly<Vec3> = Object.freeze(new Vec3(1, 1, 1));
  static readonly UP: Readonly<Vec3> = Object.freeze(new Vec3(0, 1, 0));
  static readonly FORWARD: Readonly<Vec3> = Object.freeze(new Vec3(0, 0, -1));
  static readonly RIGHT: Readonly<Vec3> = Object.freeze(new Vec3(1, 0, 0));
}
