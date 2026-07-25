// SOA object pool: flat typed array backing for pooled entities
// Tracks active/available state without allocating per instance

export class ObjectPool {
  // SOA columns
  private active: Uint8Array;
  private entityIds: Int32Array;
  private capacity: number;
  private activeCount = 0;
  private freeStack: number[] = [];

  private onCreate: (slot: number) => number;
  private onAcquire: (slot: number, eid: number) => void;
  private onRelease: (slot: number, eid: number) => void;

  constructor(
    capacity: number,
    callbacks: {
      onCreate: (slot: number) => number;
      onAcquire: (slot: number, eid: number) => void;
      onRelease: (slot: number, eid: number) => void;
    }
  ) {
    this.capacity = capacity;
    this.active = new Uint8Array(capacity);
    this.entityIds = new Int32Array(capacity).fill(-1);
    this.onCreate = callbacks.onCreate;
    this.onAcquire = callbacks.onAcquire;
    this.onRelease = callbacks.onRelease;
  }

  prewarm(count: number): void {
    for (let i = 0; i < count && this.activeCount + this.freeStack.length < this.capacity; i++) {
      const slot = this.activeCount + this.freeStack.length;
      if (slot >= this.capacity) break;
      const eid = this.onCreate(slot);
      this.entityIds[slot] = eid;
      this.freeStack.push(slot);
    }
  }

  acquire(): { slot: number; eid: number } | null {
    let slot: number;

    if (this.freeStack.length > 0) {
      slot = this.freeStack.pop()!;
    } else if (this.activeCount < this.capacity) {
      slot = this.activeCount;
      const eid = this.onCreate(slot);
      this.entityIds[slot] = eid;
    } else {
      return null; // pool exhausted
    }

    this.active[slot] = 1;
    this.activeCount++;
    const eid = this.entityIds[slot];
    this.onAcquire(slot, eid);
    return { slot, eid };
  }

  release(slot: number): void {
    if (this.active[slot] === 0) return;
    this.active[slot] = 0;
    this.activeCount--;
    this.onRelease(slot, this.entityIds[slot]);
    this.freeStack.push(slot);
  }

  isActive(slot: number): boolean {
    return this.active[slot] === 1;
  }

  getEntityId(slot: number): number {
    return this.entityIds[slot];
  }

  get count(): number {
    return this.activeCount;
  }

  get available(): number {
    return this.capacity - this.activeCount;
  }

  forEachActive(fn: (slot: number, eid: number) => void): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.active[i]) fn(i, this.entityIds[i]);
    }
  }

  releaseAll(): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.active[i]) this.release(i);
    }
  }
}
