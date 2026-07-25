import { AssetId, AssetType, LoadStatus, AssetHandle, INVALID_ASSET } from "./AssetTypes";

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

  private count = 0;
  private capacity: number;
  private freeList: number[] = [];
  private idToSlot = new Map<AssetId, number>();
  private pathToId = new Map<string, AssetId>();

  constructor(capacity: number = INITIAL_CAPACITY) {
    this.capacity = capacity;
    this._ids = new Array(capacity).fill("");
    this._types = new Uint8Array(capacity);
    this._status = new Uint8Array(capacity);
    this._refCount = new Uint32Array(capacity);
    this._paths = new Array(capacity).fill("");
    this._data = new Array(capacity).fill(null);
    this._dependencies = new Array(capacity).fill(null).map(() => []);
    this._errors = new Array(capacity).fill(null);
  }

  register(id: AssetId, type: AssetType, path: string): AssetHandle {
    const existing = this.idToSlot.get(id);
    if (existing !== undefined) return existing as AssetHandle;

    const slot = this.allocSlot();
    this._ids[slot] = id;
    this._types[slot] = type;
    this._status[slot] = LoadStatus.Unloaded;
    this._refCount[slot] = 0;
    this._paths[slot] = path;
    this._data[slot] = null;
    this._dependencies[slot] = [];
    this._errors[slot] = null;

    this.idToSlot.set(id, slot);
    this.pathToId.set(path, id);
    return slot as AssetHandle;
  }

  setLoading(handle: AssetHandle): void {
    this._status[handle] = LoadStatus.Loading;
  }

  setLoaded(handle: AssetHandle, data: any): void {
    this._status[handle] = LoadStatus.Loaded;
    this._data[handle] = data;
    this._errors[handle] = null;
  }

  setFailed(handle: AssetHandle, error: string): void {
    this._status[handle] = LoadStatus.Failed;
    this._errors[handle] = error;
  }

  addDependency(handle: AssetHandle, depHandle: AssetHandle): void {
    this._dependencies[handle].push(depHandle);
  }

  retain(handle: AssetHandle): void {
    this._refCount[handle]++;
  }

  release(handle: AssetHandle): boolean {
    if (this._refCount[handle] === 0) return false;
    this._refCount[handle]--;
    if (this._refCount[handle] === 0) {
      return true; // caller should dispose
    }
    return false;
  }

  // ── Getters (SOA column access) ──

  getId(handle: AssetHandle): AssetId { return this._ids[handle]; }
  getType(handle: AssetHandle): AssetType { return this._types[handle]; }
  getStatus(handle: AssetHandle): LoadStatus { return this._status[handle]; }
  getRefCount(handle: AssetHandle): number { return this._refCount[handle]; }
  getPath(handle: AssetHandle): string { return this._paths[handle]; }
  getData<T = any>(handle: AssetHandle): T | null { return this._data[handle]; }
  getError(handle: AssetHandle): string | null { return this._errors[handle]; }
  getDependencies(handle: AssetHandle): number[] { return this._dependencies[handle]; }

  isLoaded(handle: AssetHandle): boolean { return this._status[handle] === LoadStatus.Loaded; }
  isLoading(handle: AssetHandle): boolean { return this._status[handle] === LoadStatus.Loading; }

  getHandleById(id: AssetId): AssetHandle {
    const slot = this.idToSlot.get(id);
    return slot !== undefined ? slot as AssetHandle : INVALID_ASSET;
  }

  getHandleByPath(path: string): AssetHandle {
    const id = this.pathToId.get(path);
    if (!id) return INVALID_ASSET;
    return this.getHandleById(id);
  }

  has(id: AssetId): boolean { return this.idToSlot.has(id); }

  forEachLoaded(callback: (handle: AssetHandle, data: any) => void): void {
    for (let i = 0; i < this.count; i++) {
      if (this._status[i] === LoadStatus.Loaded && this._data[i] !== null) {
        callback(i as AssetHandle, this._data[i]);
      }
    }
  }

  get activeCount(): number { return this.count - this.freeList.length; }

  remove(handle: AssetHandle): any {
    const data = this._data[handle];
    const id = this._ids[handle];
    const path = this._paths[handle];

    this._ids[handle] = "";
    this._types[handle] = 0;
    this._status[handle] = LoadStatus.Unloaded;
    this._refCount[handle] = 0;
    this._paths[handle] = "";
    this._data[handle] = null;
    this._dependencies[handle] = [];
    this._errors[handle] = null;

    this.idToSlot.delete(id);
    this.pathToId.delete(path);
    this.freeList.push(handle);

    return data;
  }

  private allocSlot(): number {
    if (this.freeList.length > 0) return this.freeList.pop()!;
    if (this.count >= this.capacity) this.grow();
    return this.count++;
  }

  private grow(): void {
    const newCap = this.capacity * 2;
    const newTypes = new Uint8Array(newCap); newTypes.set(this._types);
    const newStatus = new Uint8Array(newCap); newStatus.set(this._status);
    const newRef = new Uint32Array(newCap); newRef.set(this._refCount);

    this._types = newTypes;
    this._status = newStatus;
    this._refCount = newRef;
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
