// SOA object pool: flat typed array backing for pooled entities
// Tracks active/available state without allocating per instance

import { Handle, makeHandle, handleIndex, handleGeneration } from "../core/handles/Handle";

// AUDIT fix: release(slot) used to take a bare slot number, so it couldn't distinguish "the
// caller who acquired this slot" from a later, different owner of the same slot — a classic
// ABA double-release (acquire -> release -> slot reacquired by someone else -> a stale caller
// calls release() again with the old slot number and silently deactivates the new owner
// mid-use). acquire() now also returns a generation-tagged Handle (reusing the same
// index/generation packing HandleAllocator/HandleMap use elsewhere in the engine, for
// consistency — see src/core/handles/Handle.ts) and release() takes that handle, no-oping
// with a warning if the generation doesn't match the slot's current occupant. There are no
// callers of ObjectPool outside this file's own tests, so widening acquire()'s return type
// is not a cross-module breaking change.
export interface PoolHandle {
  slot: number;
  eid: number;
  handle: Handle;
}

export class ObjectPool {
  // SOA columns
  private active: Uint8Array;
  private entityIds: Int32Array;
  private generations: Uint16Array;
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
    this.generations = new Uint16Array(capacity);
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

  acquire(): PoolHandle | null {
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
    const handle = makeHandle(slot, this.generations[slot]);
    return { slot, eid, handle };
  }

  /** Releases a slot previously returned by acquire(). Takes the same Handle acquire() gave
   *  out (not a bare slot number) so a stale/delayed release from a caller that no longer
   *  owns the slot can't silently deactivate whatever now occupies it — see the ABA note
   *  above the PoolHandle interface. */
  release(handle: Handle): void {
    const slot = handleIndex(handle);
    if (slot < 0 || slot >= this.capacity) return;
    if (this.active[slot] === 0) return; // already inactive — matches prior no-op semantics
    if (handleGeneration(handle) !== this.generations[slot]) {
      console.warn(`[AGEE] ObjectPool: stale release for slot ${slot} ignored (generation mismatch)`);
      return;
    }
    this.active[slot] = 0;
    this.activeCount--;
    this.onRelease(slot, this.entityIds[slot]);
    // Bump the generation so any handle still held for this occupancy becomes stale the
    // moment the slot is reused by a future acquire().
    this.generations[slot] = (this.generations[slot] + 1) & 0xFFFF;
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
      if (this.active[i]) this.release(makeHandle(i, this.generations[i]));
    }
  }
}
