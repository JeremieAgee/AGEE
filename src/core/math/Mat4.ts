import { Vec3 } from "./Vec3";
import { Quat } from "./Quat";
import { dsqrt, dtan, dabs } from "../DeterministicMath";

export class Mat4 {
  readonly elements: Float32Array;

  constructor() {
    this.elements = new Float32Array(16);
    this.elements[0] = 1; this.elements[5] = 1; this.elements[10] = 1; this.elements[15] = 1;
  }

  identity(): this {
    this.elements.fill(0);
    this.elements[0] = 1; this.elements[5] = 1; this.elements[10] = 1; this.elements[15] = 1;
    return this;
  }

  copy(m: Mat4): this {
    this.elements.set(m.elements);
    return this;
  }

  clone(): Mat4 {
    const m = new Mat4();
    m.elements.set(this.elements);
    return m;
  }

  compose(position: Vec3, rotation: Quat, scale: Vec3): this {
    const e = this.elements;
    const x = rotation.x, y = rotation.y, z = rotation.z, w = rotation.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    const sx = scale.x, sy = scale.y, sz = scale.z;

    e[0] = (1 - (yy + zz)) * sx;
    e[1] = (xy + wz) * sx;
    e[2] = (xz - wy) * sx;
    e[3] = 0;
    e[4] = (xy - wz) * sy;
    e[5] = (1 - (xx + zz)) * sy;
    e[6] = (yz + wx) * sy;
    e[7] = 0;
    e[8] = (xz + wy) * sz;
    e[9] = (yz - wx) * sz;
    e[10] = (1 - (xx + yy)) * sz;
    e[11] = 0;
    e[12] = position.x;
    e[13] = position.y;
    e[14] = position.z;
    e[15] = 1;
    return this;
  }

  decompose(position: Vec3, rotation: Quat, scale: Vec3): this {
    const e = this.elements;
    let sx = dsqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
    const sy = dsqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
    const sz = dsqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);

    // Detect mirrored transforms via 3x3 determinant
    const det = e[0] * (e[5] * e[10] - e[6] * e[9])
              - e[4] * (e[1] * e[10] - e[2] * e[9])
              + e[8] * (e[1] * e[6] - e[2] * e[5]);
    if (det < 0) sx = -sx;

    scale.set(sx, sy, sz);
    position.set(e[12], e[13], e[14]);

    const isx = 1 / sx, isy = 1 / sy, isz = 1 / sz;
    const m11 = e[0] * isx, m12 = e[4] * isy, m13 = e[8] * isz;
    const m21 = e[1] * isx, m22 = e[5] * isy, m23 = e[9] * isz;
    const m31 = e[2] * isx, m32 = e[6] * isy, m33 = e[10] * isz;

    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / dsqrt(trace + 1);
      rotation.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
    } else if (m11 > m22 && m11 > m33) {
      const s = 2 * dsqrt(1 + m11 - m22 - m33);
      rotation.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
    } else if (m22 > m33) {
      const s = 2 * dsqrt(1 + m22 - m11 - m33);
      rotation.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
    } else {
      const s = 2 * dsqrt(1 + m33 - m11 - m22);
      rotation.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
    }
    return this;
  }

  multiply(m: Mat4): this {
    const a = this.elements, b = m.elements;
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = b[0], b01 = b[1], b02 = b[2], b03 = b[3];
    const b10 = b[4], b11 = b[5], b12 = b[6], b13 = b[7];
    const b20 = b[8], b21 = b[9], b22 = b[10], b23 = b[11];
    const b30 = b[12], b31 = b[13], b32 = b[14], b33 = b[15];
    a[0]  = a00*b00 + a10*b01 + a20*b02 + a30*b03;
    a[1]  = a01*b00 + a11*b01 + a21*b02 + a31*b03;
    a[2]  = a02*b00 + a12*b01 + a22*b02 + a32*b03;
    a[3]  = a03*b00 + a13*b01 + a23*b02 + a33*b03;
    a[4]  = a00*b10 + a10*b11 + a20*b12 + a30*b13;
    a[5]  = a01*b10 + a11*b11 + a21*b12 + a31*b13;
    a[6]  = a02*b10 + a12*b11 + a22*b12 + a32*b13;
    a[7]  = a03*b10 + a13*b11 + a23*b12 + a33*b13;
    a[8]  = a00*b20 + a10*b21 + a20*b22 + a30*b23;
    a[9]  = a01*b20 + a11*b21 + a21*b22 + a31*b23;
    a[10] = a02*b20 + a12*b21 + a22*b22 + a32*b23;
    a[11] = a03*b20 + a13*b21 + a23*b22 + a33*b23;
    a[12] = a00*b30 + a10*b31 + a20*b32 + a30*b33;
    a[13] = a01*b30 + a11*b31 + a21*b32 + a31*b33;
    a[14] = a02*b30 + a12*b31 + a22*b32 + a32*b33;
    a[15] = a03*b30 + a13*b31 + a23*b32 + a33*b33;
    return this;
  }

  transformPoint(v: Vec3): Vec3 {
    const e = this.elements;
    return new Vec3(
      e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12],
      e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13],
      e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14]
    );
  }

  getTranslation(): Vec3 {
    return new Vec3(this.elements[12], this.elements[13], this.elements[14]);
  }

  perspective(fovRadians: number, aspect: number, near: number, far: number): this {
    const e = this.elements;
    const f = 1.0 / dtan(fovRadians * 0.5);
    const rangeInv = 1.0 / (near - far);

    e.fill(0);
    e[0] = f / aspect;
    e[5] = f;
    e[10] = far * rangeInv;
    e[11] = -1;
    e[14] = near * far * rangeInv;
    return this;
  }

  orthographic(left: number, right: number, bottom: number, top: number, near: number, far: number): this {
    const e = this.elements;
    const rangeInv = 1.0 / (near - far);

    e.fill(0);
    e[0] = 2 / (right - left);
    e[5] = 2 / (top - bottom);
    e[10] = rangeInv;
    e[12] = -(left + right) / (right - left);
    e[13] = -(bottom + top) / (top - bottom);
    e[14] = near * rangeInv;
    e[15] = 1;
    return this;
  }

  lookAt(eye: Vec3, target: Vec3, up: Vec3): this {
    const e = this.elements;
    let zx = eye.x - target.x, zy = eye.y - target.y, zz = eye.z - target.z;
    let len = dsqrt(zx * zx + zy * zy + zz * zz);
    if (len > 1e-8) { zx /= len; zy /= len; zz /= len; }

    let xx = up.y * zz - up.z * zy;
    let xy = up.z * zx - up.x * zz;
    let xz = up.x * zy - up.y * zx;
    len = dsqrt(xx * xx + xy * xy + xz * xz);
    if (len > 1e-8) { xx /= len; xy /= len; xz /= len; }

    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    e[0] = xx;  e[1] = yx;  e[2]  = zx;  e[3]  = 0;
    e[4] = xy;  e[5] = yy;  e[6]  = zy;  e[7]  = 0;
    e[8] = xz;  e[9] = yz;  e[10] = zz;  e[11] = 0;
    e[12] = -(xx * eye.x + xy * eye.y + xz * eye.z);
    e[13] = -(yx * eye.x + yy * eye.y + yz * eye.z);
    e[14] = -(zx * eye.x + zy * eye.y + zz * eye.z);
    e[15] = 1;
    return this;
  }

  invert(): this {
    const e = this.elements;
    const a00 = e[0], a01 = e[1], a02 = e[2], a03 = e[3];
    const a10 = e[4], a11 = e[5], a12 = e[6], a13 = e[7];
    const a20 = e[8], a21 = e[9], a22 = e[10], a23 = e[11];
    const a30 = e[12], a31 = e[13], a32 = e[14], a33 = e[15];

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (dabs(det) < 1e-12) return this;
    det = 1.0 / det;

    e[0]  = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    e[1]  = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    e[2]  = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    e[3]  = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    e[4]  = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    e[5]  = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    e[6]  = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    e[7]  = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    e[8]  = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    e[9]  = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    e[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    e[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    e[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    e[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    e[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    e[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return this;
  }
}
