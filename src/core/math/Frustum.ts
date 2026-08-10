import { Vec3 } from "./Vec3";
import { AABB } from "./AABB";

class Plane {
  constructor(public normal: Vec3 = new Vec3(0, 1, 0), public d: number = 0) {}

  distanceToPoint(p: Vec3): number {
    return this.normal.dot(p) + this.d;
  }
}

export class Frustum {
  readonly planes: Plane[] = [];

  constructor() {
    for (let i = 0; i < 6; i++) this.planes.push(new Plane());
  }

  // `ndcZRange` selects which clip-space z convention `m` was built with:
  //  - "-1..1" (OpenGL-style; THREE's PerspectiveCamera/OrthographicCamera.projectionMatrix,
  //    which is what every current caller of this method feeds in): near plane = row4+row3.
  //  - "0..1" (D3D/WebGPU-style; this engine's own native Mat4.perspective()/orthographic(),
  //    see core/math/Mat4.ts): near plane = row3 alone -- adding row4 there would extract the
  //    wrong plane and silently misclassify near-plane culling for any WebGPU-range matrix.
  // The far plane formula (row4-row3) is identical in both conventions, so only near differs.
  // Defaults to "-1..1" to preserve exact existing behavior for every current caller.
  setFromProjectionMatrix(m: Float32Array | number[], ndcZRange: "-1..1" | "0..1" = "-1..1"): this {
    const me = m;
    const p = this.planes;

    // Left
    p[0].normal.set(me[3] + me[0], me[7] + me[4], me[11] + me[8]);
    p[0].d = me[15] + me[12];
    // Right
    p[1].normal.set(me[3] - me[0], me[7] - me[4], me[11] - me[8]);
    p[1].d = me[15] - me[12];
    // Bottom
    p[2].normal.set(me[3] + me[1], me[7] + me[5], me[11] + me[9]);
    p[2].d = me[15] + me[13];
    // Top
    p[3].normal.set(me[3] - me[1], me[7] - me[5], me[11] - me[9]);
    p[3].d = me[15] - me[13];
    // Near
    if (ndcZRange === "0..1") {
      p[4].normal.set(me[2], me[6], me[10]);
      p[4].d = me[14];
    } else {
      p[4].normal.set(me[3] + me[2], me[7] + me[6], me[11] + me[10]);
      p[4].d = me[15] + me[14];
    }
    // Far
    p[5].normal.set(me[3] - me[2], me[7] - me[6], me[11] - me[10]);
    p[5].d = me[15] - me[14];

    for (let i = 0; i < 6; i++) {
      const len = p[i].normal.length();
      if (len > 0) {
        p[i].normal.scale(1 / len);
        p[i].d /= len;
      }
    }
    return this;
  }

  containsPoint(p: Vec3): boolean {
    for (let i = 0; i < 6; i++) {
      if (this.planes[i].distanceToPoint(p) < 0) return false;
    }
    return true;
  }

  private readonly _pv = new Vec3();

  intersectsAABB(aabb: AABB): boolean {
    const pv = this._pv;
    for (let i = 0; i < 6; i++) {
      const n = this.planes[i].normal;
      pv.x = n.x > 0 ? aabb.max.x : aabb.min.x;
      pv.y = n.y > 0 ? aabb.max.y : aabb.min.y;
      pv.z = n.z > 0 ? aabb.max.z : aabb.min.z;
      if (this.planes[i].distanceToPoint(pv) < 0) return false;
    }
    return true;
  }

  intersectsSphere(center: Vec3, radius: number): boolean {
    for (let i = 0; i < 6; i++) {
      if (this.planes[i].distanceToPoint(center) < -radius) return false;
    }
    return true;
  }
}
