export const PI = 3.14159265358979323846;
export const TWO_PI = 6.28318530717958647692;
export const HALF_PI = 1.57079632679489661923;
export const INV_PI = 0.31830988618379067154;

const SIN_TABLE_SIZE = 4096;
const SIN_TABLE_MASK = SIN_TABLE_SIZE - 1;
const SIN_SCALE = SIN_TABLE_SIZE / TWO_PI;

const sinTable = new Float64Array(SIN_TABLE_SIZE);
for (let i = 0; i < SIN_TABLE_SIZE; i++) {
  sinTable[i] = Math.sin((i / SIN_TABLE_SIZE) * TWO_PI);
}

function normalizeAngle(a: number): number {
  a = a % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a;
}

export function dsin(x: number): number {
  x = normalizeAngle(x);
  const idx = (x * SIN_SCALE) | 0;
  const frac = x * SIN_SCALE - idx;
  const a = sinTable[idx & SIN_TABLE_MASK];
  const b = sinTable[(idx + 1) & SIN_TABLE_MASK];
  return a + (b - a) * frac;
}

export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}

export function dtan(x: number): number {
  const c = dcos(x);
  if (c === 0) return c > 0 ? 1e15 : -1e15;
  return dsin(x) / c;
}

export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;

  const absX = x < 0 ? -x : x;
  const absY = y < 0 ? -y : y;

  let a: number;
  if (absX > absY) {
    const r = absY / absX;
    a = atanApprox(r);
  } else {
    const r = absX / absY;
    a = HALF_PI - atanApprox(r);
  }

  if (x < 0) a = PI - a;
  if (y < 0) a = -a;
  return a;
}

const QUARTER_PI = PI / 4;
// tan(pi/8), the half-angle reduction threshold below.
const TAN_PI_8 = 0.4142135623730951;

// atanApprox only needs to be accurate on [0, 1] (datan2 always calls it with a ratio in that
// range). A single minimax polynomial over the full [0, 1] domain tops out around 6.6e-2 rad
// error near x=1 — good enough to make DeterministicMath's angle a rough guess, not good enough
// to round-trip a quaternion through toEuler/fromEuler. Halving the domain via the standard
// atan(x) = pi/4 + atan((x-1)/(x+1)) identity for x > tan(pi/8) keeps the polynomial's input in
// [-tan(pi/8), tan(pi/8)], where the same-degree polynomial is accurate to ~1.2e-5 rad.
function atanPoly(x: number): number {
  const x2 = x * x;
  return x * (0.9998660 + x2 * (-0.3302995 + x2 * (0.1801410 + x2 * (-0.0851330 + x2 * 0.0208351))));
}

function atanApprox(x: number): number {
  if (x > TAN_PI_8) return QUARTER_PI + atanPoly((x - 1) / (x + 1));
  return atanPoly(x);
}

export function dasin(x: number): number {
  if (x <= -1) return -HALF_PI;
  if (x >= 1) return HALF_PI;
  return datan2(x, dsqrt(1 - x * x));
}

export function dacos(x: number): number {
  return HALF_PI - dasin(x);
}

export function dsqrt(x: number): number {
  if (x <= 0) return 0;
  let guess = x;
  for (let i = 0; i < 8; i++) {
    guess = 0.5 * (guess + x / guess);
  }
  return guess;
}

export function dabs(x: number): number {
  return x < 0 ? -x : x;
}

export function dmin(a: number, b: number): number {
  return a < b ? a : b;
}

export function dmax(a: number, b: number): number {
  return a > b ? a : b;
}

export function dclamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export function dlerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dfloor(x: number): number {
  const i = x | 0;
  return x < i ? i - 1 : i;
}

export function dceil(x: number): number {
  const i = x | 0;
  return x > i ? i + 1 : i;
}

export function dround(x: number): number {
  return dfloor(x + 0.5);
}

export function dfrac(x: number): number {
  return x - dfloor(x);
}

export function dsign(x: number): number {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

export function dquaternionToEuler(
  qx: number, qy: number, qz: number, qw: number,
  out: Float32Array
): void {
  const sinrCosp = 2 * (qw * qx + qy * qz);
  const cosrCosp = 1 - 2 * (qx * qx + qy * qy);
  out[0] = datan2(sinrCosp, cosrCosp);

  const sinp = 2 * (qw * qy - qz * qx);
  out[1] = dabs(sinp) >= 1 ? dsign(sinp) * HALF_PI : dasin(sinp);

  const sinyCosp = 2 * (qw * qz + qx * qy);
  const cosyCosp = 1 - 2 * (qy * qy + qz * qz);
  out[2] = datan2(sinyCosp, cosyCosp);
}

export function deulerToQuaternion(
  rx: number, ry: number, rz: number
): { x: number; y: number; z: number; w: number } {
  const cx = dcos(rx * 0.5), sx = dsin(rx * 0.5);
  const cy = dcos(ry * 0.5), sy = dsin(ry * 0.5);
  const cz = dcos(rz * 0.5), sz = dsin(rz * 0.5);
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}

export class SeededRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 1;
  }

  next(): number {
    this.state ^= this.state << 13;
    this.state ^= this.state >> 17;
    this.state ^= this.state << 5;
    this.state = this.state >>> 0;
    return this.state / 4294967296;
  }

  nextRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  nextInt(min: number, max: number): number {
    return dfloor(min + this.next() * (max - min));
  }

  get seed(): number {
    return this.state;
  }
}

export const DeterministicMath = {
  PI, TWO_PI, HALF_PI, INV_PI,
  sin: dsin, cos: dcos, tan: dtan,
  atan2: datan2, asin: dasin, acos: dacos,
  sqrt: dsqrt, abs: dabs,
  min: dmin, max: dmax, clamp: dclamp,
  lerp: dlerp,
  floor: dfloor, ceil: dceil, round: dround,
  frac: dfrac, sign: dsign,
  quaternionToEuler: dquaternionToEuler,
  eulerToQuaternion: deulerToQuaternion,
};
