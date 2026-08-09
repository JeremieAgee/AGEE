import { AssetId, AssetType, LoadStatus, AssetHandle, INVALID_ASSET } from "./AssetTypes";
import { HandleAllocator, handleIndex } from "../core/handles/Handle";

const INITIAL_CAPACITY = 256;

export class AssetStore {
  // SOA columns
  private _ids: string[];
  private _types: Uint8Array;
  private _status: Uint8Array;
  private _refCount: Uint32Array;
  private _paths: string[];
  private _data: any[];
  private _dependencies: number[][];
  private _errors: (string | null)[];
  private _memorySize: Float64Array;

  private capacity: number;
  // Generational allocator (index + generation packed into the handle) instead of a bare
  // slot-index freeList. Without a generation check, releasing an asset whose load is still
  // in flight (refcount hits 0 before the promise settles) frees its slot for immediate reuse
  // by an unrelated register() call; when the stale load's callback later fires and calls
  // setLoaded(handle, ...), `handle` is just a plain number indistinguishable from the new
  // occupant's handle, so it silently stomps the new asset's data. Every accessor below
  // validates the handle's generation against the slot's current one first, so a stale handle
  // becomes a safe no-op instead of corrupting whatever now lives in that slot.
  private allocator: HandleAllocator;
  private idToHandle = new Map<AssetId, AssetHandle>();
  private pathToId = new Map<string, AssetId>();

  constructor(capacity: number = INITIAL_CAPACITY) {
    this.capacity = capacity;
    this.allocator = new HandleAllocator(capacity);
    this._ids = new Array(capacity).fill("");
    this._types = new Uint8Array(capacity);
    this._status = new Uint8Array(capacity);
    this._refCount = new Uint32Array(capacity);
    this._paths = new Array(capacity).fill("");
    this._data = new Array(capacity).fill(null);
    this._dependencies = new Array(capacity).fill(null).map(() => []);
    this._errors = new Array(capacity).fill(null);
    this._memorySize = new Float64Array(capacity);
  }

  register(id: AssetId, type: AssetType, path: string): AssetHandle {
    const existing = this.idToHandle.get(id);
    if (existing !== undefined) return existing;

    const handle = this.allocator.alloc() as AssetHandle;
    const slot = handleIndex(handle);
    if (slot >= this.capacity) this.grow(slot + 1);

    this._ids[slot] = id;
    this._types[slot] = type;
    this._status[slot] = LoadStatus.Unloaded;
    this._refCount[slot] = 0;
    this._paths[slot] = path;
    this._data[slot] = null;
    this._dependencies[slot] = [];
    this._errors[slot] = null;
    this._memorySize[slot] = 0;

    this.idToHandle.set(id, handle);
    this.pathToId.set(path, id);
    return handle;
  }

  setMemorySize(handle: AssetHandle, bytes: number): void {
    if (!this.isValid(handle)) return;
    this._memorySize[handleIndex(handle)] = bytes;
  }

  getMemorySize(handle: AssetHandle): number {
    return this.isValid(handle) ? this._memorySize[handleIndex(handle)] : 0;
  }

  private isValid(handle: AssetHandle): boolean {
    return handle !== INVALID_ASSET && this.allocator.isValid(handle);
  }

  setLoading(handle: AssetHandle): void {
    if (!this.isValid(handle)) return;
    this._status[handleIndex(handle)] = LoadStatus.Loading;
  }

  setLoaded(handle: AssetHandle, data: any): void {
    if (!this.isValid(handle)) return;
    const slot = handleIndex(handle);
    this._status[slot] = LoadStatus.Loaded;
    this._data[slot] = data;
    this._errors[slot] = null;
  }

  setFailed(handle: AssetHandle, error: string): void {
    if (!this.isValid(handle)) return;
    const slot = handleIndex(handle);
    this._status[slot] = LoadStatus.Failed;
    this._errors[slot] = error;
  }

  addDependency(handle: AssetHandle, depHandle: AssetHandle): void {
    if (!this.isValid(handle)) return;
    const slot = handleIndex(handle);
    // Guards against double-registering the same dependency (e.g. a caller re-running a
    // load pass for an id that's already registered) — without this, release() would walk
    // the duplicate entry and release depHandle an extra time it was never actually
    // retained for, over-releasing it out from under whatever still legitimately holds it.
    if (this._dependencies[slot].includes(depHandle)) return;
    this._dependencies[slot].push(depHandle);
  }

  retain(handle: AssetHandle): void {
    if (!this.isValid(handle)) return;
    this._refCount[handleIndex(handle)]++;
  }

  release(handle: AssetHandle): boolean {
    if (!this.isValid(handle)) return false;
    const slot = handleIndex(handle);
    if (this._refCount[slot] === 0) return false;
    this._refCount[slot]--;
    if (this._refCount[slot] === 0) {
      return true; // caller should dispose
    }
    return false;
  }

  // ── Getters (SOA column access) ──

  getId(handle: AssetHandle): AssetId { return this.isValid(handle) ? this._ids[handleIndex(handle)] : ""; }
  getType(handle: AssetHandle): AssetType { return this.isValid(handle) ? this._types[handleIndex(handle)] : AssetType.Texture; }
  getStatus(handle: AssetHandle): LoadStatus { return this.isValid(handle) ? this._status[handleIndex(handle)] : LoadStatus.Unloaded; }
  getRefCount(handle: AssetHandle): number { return this.isValid(handle) ? this._refCount[handleIndex(handle)] : 0; }
  getPath(handle: AssetHandle): string { return this.isValid(handle) ? this._paths[handleIndex(handle)] : ""; }
  getData<T = any>(handle: AssetHandle): T | null { return this.isValid(handle) ? this._data[handleIndex(handle)] : null; }
  getError(handle: AssetHandle): string | null { return this.isValid(handle) ? this._errors[handleIndex(handle)] : null; }
  getDependencies(handle: AssetHandle): number[] { return this.isValid(handle) ? this._dependencies[handleIndex(handle)] : []; }

  isLoaded(handle: AssetHandle): boolean { return this.isValid(handle) && this._status[handleIndex(handle)] === LoadStatus.Loaded; }
  isLoading(handle: AssetHandle): boolean { return this.isValid(handle) && this._status[handleIndex(handle)] === LoadStatus.Loading; }

  getHandleById(id: AssetId): AssetHandle {
    const handle = this.idToHandle.get(id);
    return handle !== undefined ? handle : INVALID_ASSET;
  }

  getHandleByPath(path: string): AssetHandle {
    const id = this.pathToId.get(path);
    if (!id) return INVALID_ASSET;
    return this.getHandleById(id);
  }

  has(id: AssetId): boolean { return this.idToHandle.has(id); }

  forEachLoaded(callback: (handle: AssetHandle, data: any) => void): void {
    this.idToHandle.forEach((handle) => {
      const slot = handleIndex(handle);
      if (this._status[slot] === LoadStatus.Loaded && this._data[slot] !== null) {
        callback(handle, this._data[slot]);
      }
    });
  }

  get activeCount(): number { return this.allocator.activeCount; }

  remove(handle: AssetHandle): any {
    if (!this.isValid(handle)) return null;
    const slot = handleIndex(handle);
    const data = this._data[slot];
    const id = this._ids[slot];
    const path = this._paths[slot];

    this._ids[slot] = "";
    this._types[slot] = 0;
    this._status[slot] = LoadStatus.Unloaded;
    this._refCount[slot] = 0;
    this._paths[slot] = "";
    this._data[slot] = null;
    this._dependencies[slot] = [];
    this._errors[slot] = null;
    this._memorySize[slot] = 0;

    this.idToHandle.delete(id);
    this.pathToId.delete(path);
    // Bumps this slot's generation so any handle copy still held elsewhere (e.g. an in-flight
    // load's closure) fails isValid() from here on, rather than aliasing whatever gets
    // allocated into this slot next.
    this.allocator.free(handle);

    return data;
  }

  private grow(minCapacity: number): void {
    let newCap = this.capacity * 2;
    while (newCap < minCapacity) newCap *= 2;

    const newTypes = new Uint8Array(newCap); newTypes.set(this._types);
    const newStatus = new Uint8Array(newCap); newStatus.set(this._status);
    const newRef = new Uint32Array(newCap); newRef.set(this._refCount);
    const newMemorySize = new Float64Array(newCap); newMemorySize.set(this._memorySize);

    this._types = newTypes;
    this._status = newStatus;
    this._refCount = newRef;
    this._memorySize = newMemorySize;
    this._ids.length = newCap;
    this._paths.length = newCap;
    this._data.length = newCap;
    this._dependencies.length = newCap;
    this._errors.length = newCap;

    for (let i = this.capacity; i < newCap; i++) {
      this._ids[i] = "";
      this._paths[i] = "";
      this._data[i] = null;
      this._dependencies[i] = [];
      this._errors[i] = null;
    }
    this.capacity = newCap;
  }
}
