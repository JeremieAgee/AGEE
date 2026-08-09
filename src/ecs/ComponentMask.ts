// Packed component-mask representation used by ArchetypeIndex/Query/World instead of bigint.
// BigInt AND/OR/compare plus Map<bigint, ...> lookups sit on the hottest path in the ECS
// (every addComponent/removeComponent, every archetype match); V8 runs BigInt ops roughly an
// order of magnitude slower than plain 32-bit number bitwise ops. A single `number` mask caps
// out at 32 component types, so this uses a fixed-width Uint32Array instead — WORD_COUNT * 32
// component types of headroom at native int32 bitwise speed.
export const MASK_WORD_COUNT = 4; // 128 component types
export type Mask = Uint32Array;

export function createMask(): Mask {
  return new Uint32Array(MASK_WORD_COUNT);
}

export function maskClone(mask: Mask): Mask {
  return mask.slice() as Mask;
}

export function maskCopy(out: Mask, src: Mask): Mask {
  out.set(src);
  return out;
}

export function maskSetBit(mask: Mask, bit: number): void {
  mask[bit >>> 5] |= 1 << (bit & 31);
}

export function maskClearBit(mask: Mask, bit: number): void {
  mask[bit >>> 5] &= ~(1 << (bit & 31));
}

export function maskIsZero(mask: Mask): boolean {
  for (let i = 0; i < MASK_WORD_COUNT; i++) {
    if (mask[i] !== 0) return false;
  }
  return true;
}

export function maskEquals(a: Mask, b: Mask): boolean {
  for (let i = 0; i < MASK_WORD_COUNT; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// True when `mask` contains every bit set in `query` (archetype-satisfies-query test).
export function maskContainsAll(mask: Mask, query: Mask): boolean {
  for (let i = 0; i < MASK_WORD_COUNT; i++) {
    if ((mask[i] & query[i]) !== query[i]) return false;
  }
  return true;
}

// True when the two masks share at least one set bit.
export function maskIntersects(a: Mask, b: Mask): boolean {
  for (let i = 0; i < MASK_WORD_COUNT; i++) {
    if ((a[i] & b[i]) !== 0) return true;
  }
  return false;
}

// Stable string key for use as a Map key (archetype registry, query-match cache) since typed
// arrays don't hash/compare by value.
export function maskKey(mask: Mask): string {
  let key = "";
  for (let i = 0; i < MASK_WORD_COUNT; i++) {
    key += mask[i].toString(36);
    if (i < MASK_WORD_COUNT - 1) key += "|";
  }
  return key;
}

export function maskOrBit(mask: Mask, bit: number, out: Mask): Mask {
  out.set(mask);
  maskSetBit(out, bit);
  return out;
}

export function maskAndNotBit(mask: Mask, bit: number, out: Mask): Mask {
  out.set(mask);
  maskClearBit(out, bit);
  return out;
}

// Test-only convenience: builds a Mask from a list of bit indices, e.g. maskFromBits(0, 1).
export function maskFromBits(...bits: number[]): Mask {
  const mask = createMask();
  for (const bit of bits) maskSetBit(mask, bit);
  return mask;
}
