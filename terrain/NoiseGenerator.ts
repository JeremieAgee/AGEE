// Deterministic simplex-like noise using xoshiro256 PRNG seeding
// Suitable for procedural terrain generation

export class SeededRandom {
  private s: Uint32Array;

  constructor(seed: number) {
    this.s = new Uint32Array(4);
    this.s[0] = seed ^ 0x12345678;
    this.s[1] = seed ^ 0x9ABCDEF0;
    this.s[2] = seed ^ 0xFEDCBA98;
    this.s[3] = seed ^ 0x76543210;
    for (let i = 0; i < 20; i++) this.next();
  }

  next(): number {
    const t = this.s[1] << 9;
    this.s[2] ^= this.s[0];
    this.s[3] ^= this.s[1];
    this.s[1] ^= this.s[2];
    this.s[0] ^= this.s[3];
    this.s[2] ^= t;
    this.s[3] = (this.s[3] << 11) | (this.s[3] >>> 21);
    return (this.s[0] >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

export interface NoiseConfig {
  octaves: number;
  frequency: number;
  amplitude: number;
  lacunarity: number;
  persistence: number;
  seed: number;
}

const DEFAULT_CONFIG: NoiseConfig = {
  octaves: 6,
  frequency: 0.01,
  amplitude: 30,
  lacunarity: 2.0,
  persistence: 0.5,
  seed: 42,
};

// Permutation table for gradient noise
const PERM_SIZE = 512;

function buildPermTable(seed: number): Uint8Array {
  const rng = new SeededRandom(seed);
  const p = new Uint8Array(PERM_SIZE);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  for (let i = 0; i < 256; i++) p[256 + i] = p[i];
  return p;
}

const GRAD3 = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
];

function grad2d(hash: number, x: number, y: number): number {
  const h = hash & 7;
  const u = h < 4 ? x : y;
  const v = h < 4 ? y : x;
  return ((h & 1) ? -u : u) + ((h & 2) ? -2 * v : 2 * v);
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

export class NoiseGenerator {
  private perm: Uint8Array;
  readonly config: NoiseConfig;

  constructor(config: Partial<NoiseConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.perm = buildPermTable(this.config.seed);
  }

  private noise2d(x: number, y: number): number {
    const p = this.perm;
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);

    const a = p[X] + Y;
    const b = p[X + 1] + Y;

    return lerp(
      lerp(grad2d(p[a], xf, yf), grad2d(p[b], xf - 1, yf), u),
      lerp(grad2d(p[a + 1], xf, yf - 1), grad2d(p[b + 1], xf - 1, yf - 1), u),
      v
    );
  }

  sample(x: number, z: number): number {
    const c = this.config;
    let value = 0;
    let freq = c.frequency;
    let amp = c.amplitude;

    for (let o = 0; o < c.octaves; o++) {
      value += this.noise2d(x * freq, z * freq) * amp;
      freq *= c.lacunarity;
      amp *= c.persistence;
    }

    return value;
  }

  fillHeightmap(
    heightmap: Float32Array,
    resolution: number,
    worldX: number,
    worldZ: number,
    chunkSize: number
  ): void {
    const step = chunkSize / (resolution - 1);
    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const wx = worldX + x * step;
        const wz = worldZ + z * step;
        heightmap[z * resolution + x] = this.sample(wx, wz);
      }
    }
  }
}
