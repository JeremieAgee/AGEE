import { Vec3 } from "./Vec3";

export class AABB {
  constructor(
    public min: Vec3 = new Vec3(Infinity, Infinity, Infinity),
    public max: Vec3 = new Vec3(-Infinity, -Infinity, -Infinity)
  ) {}

  reset(): this {
    this.min.set(Infinity, Infinity, Infinity);
    this.max.set(-Infinity, -Infinity, -Infinity);
    return this;
  }

  expandByPoint(p: Vec3): this {
    this.min.x = Math.min(this.min.x, p.x);
    this.min.y = Math.min(this.min.y, p.y);
    this.min.z = Math.min(this.min.z, p.z);
    this.max.x = Math.max(this.max.x, p.x);
    this.max.y = Math.max(this.max.y, p.y);
    this.max.z = Math.max(this.max.z, p.z);
    return this;
  }

  expandByAABB(other: AABB): this {
    this.expandByPoint(other.min);
    this.expandByPoint(other.max);
    return this;
  }

  containsPoint(p: Vec3): boolean {
    return p.x >= this.min.x && p.x <= this.max.x &&
           p.y >= this.min.y && p.y <= this.max.y &&
           p.z >= this.min.z && p.z <= this.max.z;
  }

  intersectsAABB(other: AABB): boolean {
    return this.max.x >= other.min.x && this.min.x <= other.max.x &&
           this.max.y >= other.min.y && this.min.y <= other.max.y &&
           this.max.z >= other.min.z && this.min.z <= other.max.z;
  }

  intersectsSphere(center: Vec3, radius: number): boolean {
    let dSq = 0;
    if (center.x < this.min.x) dSq += (this.min.x - center.x) ** 2;
    else if (center.x > this.max.x) dSq += (center.x - this.max.x) ** 2;
    if (center.y < this.min.y) dSq += (this.min.y - center.y) ** 2;
    else if (center.y > this.max.y) dSq += (center.y - this.max.y) ** 2;
    if (center.z < this.min.z) dSq += (this.min.z - center.z) ** 2;
    else if (center.z > this.max.z) dSq += (center.z - this.max.z) ** 2;
    return dSq <= radius * radius;
  }

  center(): Vec3 {
    return new Vec3(
      (this.min.x + this.max.x) * 0.5,
      (this.min.y + this.max.y) * 0.5,
      (this.min.z + this.max.z) * 0.5
    );
  }

  size(): Vec3 {
    return new Vec3(
      this.max.x - this.min.x,
      this.max.y - this.min.y,
      this.max.z - this.min.z
    );
  }

  clone(): AABB {
    return new AABB(this.min.clone(), this.max.clone());
  }
}
