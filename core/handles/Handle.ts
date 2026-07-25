const INDEX_BITS = 20;
const GEN_BITS = 12;
const INDEX_MASK = (1 << INDEX_BITS) - 1;
const GEN_MASK = (1 << GEN_BITS) - 1;
const MAX_ENTITIES = 1 << INDEX_BITS; // 1,048,576

export type Handle = number;

export function handleIndex(h: Handle): number {
  return h & INDEX_MASK;
}

export function handleGeneration(h: Handle): number {
  return (h >>> INDEX_BITS) & GEN_MASK;
}

export function makeHandle(index: number, gen: number): Handle {
  return (index & INDEX_MASK) | ((gen & GEN_MASK) << INDEX_BITS);
}

export const enum ResourceType {
  Unknown = 0,
  Texture = 1,
  Mesh = 2,
  Material = 3,
  Audio = 4,
  AnimClip = 5,
}

export class HandleAllocator {
  private generations: Uint16Array;
  private freeList: number[] = [];
  private count = 0;

  constructor(initialCapacity: number = 1024) {
    this.generations = new Uint16Array(Math.min(initialCapacity, MAX_ENTITIES));
  }

  alloc(): Handle {
    let index: number;
    if (this.freeList.length > 0) {
      index = this.freeList.pop()!;
    } else {
      index = this.count++;
      if (index >= this.generations.length) {
        const newCap = Math.min(this.generations.length * 2, MAX_ENTITIES);
        if (index >= newCap) {
          throw new Error(`[AGEE] HandleAllocator: max capacity ${MAX_ENTITIES} exceeded`);
        }
        const newGens = new Uint16Array(newCap);
        newGens.set(this.generations);
        this.generations = newGens;
      }
    }
    return makeHandle(index, this.generations[index]);
  }

  free(handle: Handle): boolean {
    const index = handleIndex(handle);
    const gen = handleGeneration(handle);
    if (this.generations[index] !== gen) return false;
    this.generations[index] = (gen + 1) & GEN_MASK;
    this.freeList.push(index);
    return true;
  }

  isValid(handle: Handle): boolean {
    const index = handleIndex(handle);
    const gen = handleGeneration(handle);
    return index < this.count && this.generations[index] === gen;
  }

  get activeCount(): number {
    return this.count - this.freeList.length;
  }
}

export interface HandleEntry<T> {
  data: T | null;
  refCount: number;
  resourceType: ResourceType;
  memorySize: number;
  lastAccess: number;
}

export class HandleMap<T> {
  private entries: (HandleEntry<T> | null)[];
  private allocator: HandleAllocator;

  constructor(allocator?: HandleAllocator, initialCapacity: number = 1024) {
    this.allocator = allocator ?? new HandleAllocator(initialCapacity);
    this.entries = new Array(initialCapacity).fill(null);
  }

  alloc(value: T, resourceType: ResourceType = ResourceType.Unknown, memorySize: number = 0): Handle {
    const handle = this.allocator.alloc();
    const index = handleIndex(handle);
    while (index >= this.entries.length) {
      const old = this.entries;
      this.entries = new Array(old.length * 2).fill(null);
      for (let i = 0; i < old.length; i++) this.entries[i] = old[i];
    }
    this.entries[index] = {
      data: value,
      refCount: 1,
      resourceType,
      memorySize,
      lastAccess: performance.now(),
    };
    return handle;
  }

  get(handle: Handle): T | null {
    if (!this.allocator.isValid(handle)) return null;
    const entry = this.entries[handleIndex(handle)];
    if (!entry) return null;
    entry.lastAccess = performance.now();
    return entry.data;
  }

  getEntry(handle: Handle): HandleEntry<T> | null {
    if (!this.allocator.isValid(handle)) return null;
    return this.entries[handleIndex(handle)];
  }

  set(handle: Handle, value: T): boolean {
    if (!this.allocator.isValid(handle)) return false;
    const entry = this.entries[handleIndex(handle)];
    if (!entry) return false;
    entry.data = value;
    entry.lastAccess = performance.now();
    return true;
  }

  retain(handle: Handle): boolean {
    if (!this.allocator.isValid(handle)) return false;
    const entry = this.entries[handleIndex(handle)];
    if (!entry) return false;
    entry.refCount++;
    return true;
  }

  release(handle: Handle): number {
    if (!this.allocator.isValid(handle)) return -1;
    const entry = this.entries[handleIndex(handle)];
    if (!entry) return -1;
    entry.refCount--;
    return entry.refCount;
  }

  getRefCount(handle: Handle): number {
    if (!this.allocator.isValid(handle)) return 0;
    const entry = this.entries[handleIndex(handle)];
    return entry ? entry.refCount : 0;
  }

  free(handle: Handle): T | null {
    if (!this.allocator.isValid(handle)) return null;
    const index = handleIndex(handle);
    const entry = this.entries[index];
    if (!entry) return null;
    const value = entry.data;
    this.entries[index] = null;
    this.allocator.free(handle);
    return value;
  }

  isValid(handle: Handle): boolean {
    return this.allocator.isValid(handle);
  }

  forEach(callback: (value: T, index: number) => void): void {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry && entry.data !== null) callback(entry.data, i);
    }
  }

  forEachEntry(callback: (entry: HandleEntry<T>, index: number) => void): void {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry) callback(entry, i);
    }
  }

  get activeCount(): number {
    return this.allocator.activeCount;
  }

  getTotalMemory(): number {
    let total = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry) total += entry.memorySize;
    }
    return total;
  }
}

export const INVALID_HANDLE: Handle = 0xFFFFFFFF;
