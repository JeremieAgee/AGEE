import { Handle, ResourceType } from "./handles/Handle";

export interface BudgetConfig {
  textures: number;
  meshes: number;
  audio: number;
  total: number;
}

export interface EvictionCandidate {
  handle: Handle;
  resourceType: ResourceType;
  memorySize: number;
  lastAccess: number;
  refCount: number;
}

// Structural, not the concrete HandleMap<T> class, so a resource pool that isn't backed by a
// HandleMap (e.g. AssetStore, which uses its own SOA + HandleAllocator) can still be evicted
// through evictLRU() below without evictLRU needing to know its internal representation.
export interface EvictionEntry {
  resourceType: ResourceType;
  refCount: number;
  memorySize: number;
  lastAccess: number;
}

export interface EvictionSource {
  forEachEntry(callback: (entry: EvictionEntry, index: number) => void): void;
  handleAt(index: number): Handle | null;
}

export class MemoryBudget {
  private budgets: Map<ResourceType, number> = new Map();
  private totalBudget = Infinity;
  private usage: Map<ResourceType, number> = new Map();
  private _totalUsage = 0;
  private evictionCallbacks: ((handle: Handle) => void)[] = [];

  constructor(config?: Partial<BudgetConfig>) {
    if (config?.textures) this.budgets.set(ResourceType.Texture, config.textures);
    if (config?.meshes) this.budgets.set(ResourceType.Mesh, config.meshes);
    if (config?.audio) this.budgets.set(ResourceType.Audio, config.audio);
    if (config?.total) this.totalBudget = config.total;

    for (const type of [ResourceType.Texture, ResourceType.Mesh, ResourceType.Material, ResourceType.Audio, ResourceType.AnimClip]) {
      this.usage.set(type, 0);
    }
  }

  setBudget(type: ResourceType, bytes: number): void {
    this.budgets.set(type, bytes);
  }

  setTotalBudget(bytes: number): void {
    this.totalBudget = bytes;
  }

  onEviction(callback: (handle: Handle) => void): () => void {
    this.evictionCallbacks.push(callback);
    return () => {
      const idx = this.evictionCallbacks.indexOf(callback);
      if (idx !== -1) this.evictionCallbacks.splice(idx, 1);
    };
  }

  trackAllocation(type: ResourceType, bytes: number): void {
    const current = this.usage.get(type) ?? 0;
    this.usage.set(type, current + bytes);
    this._totalUsage += bytes;
  }

  trackDeallocation(type: ResourceType, bytes: number): void {
    const current = this.usage.get(type) ?? 0;
    this.usage.set(type, Math.max(0, current - bytes));
    this._totalUsage = Math.max(0, this._totalUsage - bytes);
  }

  isOverBudget(type?: ResourceType): boolean {
    if (this._totalUsage > this.totalBudget) return true;
    if (type !== undefined) {
      const budget = this.budgets.get(type);
      if (budget !== undefined) {
        return (this.usage.get(type) ?? 0) > budget;
      }
    }
    return false;
  }

  getUsage(type: ResourceType): number {
    return this.usage.get(type) ?? 0;
  }

  get totalUsage(): number {
    return this._totalUsage;
  }

  getBudget(type: ResourceType): number {
    return this.budgets.get(type) ?? Infinity;
  }

  evictLRU(resources: EvictionSource, type: ResourceType, targetFreeBytes: number): Handle[] {
    const candidates: EvictionCandidate[] = [];

    resources.forEachEntry((entry, index) => {
      if (entry.resourceType !== type) return;
      if (entry.refCount > 1) return;
      // Reconstruct the real handle (index + current generation) rather than casting the
      // raw index — a bare index is only a valid Handle by coincidence (generation 0), and
      // using it to evict/free later can target the wrong slot or be silently rejected.
      const handle = resources.handleAt(index);
      if (handle === null) return;
      candidates.push({
        handle,
        resourceType: entry.resourceType,
        memorySize: entry.memorySize,
        lastAccess: entry.lastAccess,
        refCount: entry.refCount,
      });
    });

    candidates.sort((a, b) => a.lastAccess - b.lastAccess);

    const evicted: Handle[] = [];
    let freed = 0;

    for (const candidate of candidates) {
      if (freed >= targetFreeBytes) break;

      for (const cb of this.evictionCallbacks) {
        try { cb(candidate.handle); } catch (e) {
          console.error("[AGEE] Eviction callback threw:", e);
        }
      }

      evicted.push(candidate.handle);
      freed += candidate.memorySize;
      this.trackDeallocation(candidate.resourceType, candidate.memorySize);
    }

    return evicted;
  }

  getStats(): { type: string; usage: number; budget: number; utilization: number }[] {
    const result: { type: string; usage: number; budget: number; utilization: number }[] = [];
    const typeNames = ["Unknown", "Texture", "Mesh", "Material", "Audio", "AnimClip"];

    for (const [type, usage] of this.usage) {
      const budget = this.budgets.get(type) ?? Infinity;
      result.push({
        type: typeNames[type] ?? "Unknown",
        usage,
        budget,
        utilization: budget === Infinity ? 0 : usage / budget,
      });
    }

    return result;
  }

  reset(): void {
    for (const key of this.usage.keys()) {
      this.usage.set(key, 0);
    }
    this._totalUsage = 0;
  }
}
