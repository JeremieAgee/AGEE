import * as THREE from "three";
import { System } from "../ecs";
import { AssetStore } from "./AssetStore";
import { AssetId, AssetType, AssetHandle, LoadStatus, INVALID_ASSET } from "./AssetTypes";
import { EventBus } from "../core/EventBus";
import { MemoryBudget, type EvictionSource } from "../core/MemoryBudget";
import { ResourceType, handleIndex } from "../core/handles/Handle";
import { estimateTextureBytes } from "./MemoryEstimates";

// AssetType and ResourceType are separate enums with different numeric values for the same
// concepts (see AssetTypes.ts / core/handles/Handle.ts) -- this is the only place that needs
// to translate between them, for feeding load-time byte estimates into MemoryBudget.
function toResourceType(type: AssetType): ResourceType | null {
  switch (type) {
    case AssetType.Texture: return ResourceType.Texture;
    case AssetType.Mesh: return ResourceType.Mesh;
    case AssetType.Material: return ResourceType.Material;
    case AssetType.Audio: return ResourceType.Audio;
    case AssetType.AnimationClip: return ResourceType.AnimClip;
    default: return null; // GLTF/Prefab/Scene are containers, not GPU resources themselves
  }
}

function estimateAudioBytes(buf: AudioBuffer): number {
  return buf.length * buf.numberOfChannels * 4;
}

export class AssetSystem extends System {
  priority = -10;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "prePhysics";

  readonly store = new AssetStore();
  // AUDIT FIX: trackAllocation/trackDeallocation previously had no caller anywhere outside
  // tests -- the real streaming path (load()/release() below) never fed it, so isOverBudget()
  // could never actually fire and nothing enforced a memory ceiling during streaming.
  readonly memoryBudget = new MemoryBudget();
  private textureLoader = new THREE.TextureLoader();
  private audioLoader = new THREE.AudioLoader();
  private loadQueue: AssetHandle[] = [];
  private maxConcurrent = 4;
  private activeLoads = 0;
  private events: EventBus | null = null;
  private inflight = new Map<AssetHandle, Promise<any>>();

  constructor() {
    super();
    // The only place evictLRU()'s picks actually get disposed -- evictLRU itself only tracks
    // the deallocation and returns the handles, it doesn't know how to free a Texture/AudioBuffer
    // or remove the slot from AssetStore.
    this.memoryBudget.onEviction((handle) => this.disposeEvicted(handle as AssetHandle));
  }

  setEvents(events: EventBus): void {
    this.events = events;
  }

  private disposeEvicted(handle: AssetHandle): void {
    const data = this.store.getData(handle);
    if (data?.dispose) data.dispose();
    this.store.remove(handle);
    this.events?.emit("asset:evicted", handle);
  }

  // AUDIT FIX: previously isOverBudget() only produced a console.warn -- the configured budget
  // was a diagnostic, not a ceiling, since nothing ever called evictLRU(). Evicts the
  // least-recently-used *other* loaded assets of this type to make room, not the asset that was
  // just loaded (which is why this runs before that asset's own retain in the caller established
  // it as "in use" -- eviction only ever targets assets with refCount <= 1, i.e. not held by a
  // second independent owner beyond the original loader).
  private evictIfOverBudget(type: ResourceType, typeName: string, path: string, justLoaded: AssetHandle): void {
    if (!this.memoryBudget.isOverBudget(type)) return;
    const overage = this.memoryBudget.getUsage(type) - this.memoryBudget.getBudget(type);
    // Exclude the asset that was just loaded from its own eviction pass -- otherwise a single
    // asset whose size alone exceeds the budget (or the only loaded asset of this type) would
    // be sorted as its own oldest/only LRU candidate and evict itself before load()'s promise
    // even resolves, handing the caller a disposed, store-removed handle.
    const excludeIndex = handleIndex(justLoaded);
    const source: EvictionSource = {
      // AssetStore speaks AssetType (its own vocabulary); evictLRU expects ResourceType (a
      // separate enum with different numeric values for the same concepts -- see
      // toResourceType above) so each entry's type is translated on the way through.
      forEachEntry: (callback) => this.store.forEachEntry((entry, index) => {
        if (index === excludeIndex) return;
        const resourceType = toResourceType(entry.resourceType);
        if (resourceType === null) return;
        callback({ ...entry, resourceType }, index);
      }),
      handleAt: (index) => this.store.handleAt(index),
    };
    const evicted = this.memoryBudget.evictLRU(source, type, overage);
    if (evicted.length === 0) {
      // Nothing evictable (every loaded asset of this type is retained by 2+ owners) -- still
      // surface that the budget is exceeded and staying that way.
      console.warn(`[AGEE] ${typeName} memory budget exceeded after loading "${path}" (${(this.memoryBudget.getUsage(type) / 1024 / 1024).toFixed(1)}MB used) and nothing was evictable.`);
    }
  }

  // ── Register + Load ──

  registerTexture(id: AssetId, path: string): AssetHandle {
    return this.store.register(id, AssetType.Texture, path);
  }

  registerMesh(id: AssetId, path: string): AssetHandle {
    return this.store.register(id, AssetType.Mesh, path);
  }

  registerAudio(id: AssetId, path: string): AssetHandle {
    return this.store.register(id, AssetType.Audio, path);
  }

  registerGLTF(id: AssetId, path: string): AssetHandle {
    return this.store.register(id, AssetType.GLTF, path);
  }

  load(handle: AssetHandle): Promise<any> {
    if (this.store.isLoaded(handle)) {
      // Cache-hit path: this caller is a distinct owner of the reference and
      // must retain just like a cold load does, or its later release() would
      // over-release an asset another owner still holds.
      this.store.retain(handle);
      return Promise.resolve(this.store.getData(handle));
    }

    const existing = this.inflight.get(handle);
    if (existing) {
      // Another caller's load is already in flight; this caller becomes a
      // second owner of the same eventual result and must retain too.
      this.store.retain(handle);
      return existing;
    }

    this.store.setLoading(handle);
    this.store.retain(handle);

    const type = this.store.getType(handle);
    const path = this.store.getPath(handle);

    let promise: Promise<any>;
    switch (type) {
      case AssetType.Texture: promise = this.loadTexture(handle, path); break;
      case AssetType.Audio: promise = this.loadAudio(handle, path); break;
      case AssetType.GLTF:
        // GLTF assets carry their own dependency graph (meshes/materials/animations) and
        // must be loaded through GLTFPipeline.load(), which registers those dependencies.
        // Falling through to loadGeneric() would fetch the file as raw JSON instead of a
        // parsed THREE.Group scene graph.
        promise = Promise.reject(new Error(
          `[AssetSystem] GLTF asset "${path}" must be loaded via GLTFPipeline.load(), not AssetSystem.load()`
        ));
        this.store.setFailed(handle, "GLTF assets must be loaded via GLTFPipeline.load()");
        break;
      default: promise = this.loadGeneric(handle, path);
    }

    this.inflight.set(handle, promise);
    // Not `promise.finally(...)`: its return value is a *new* derived promise that rejects
    // whenever `promise` does, and since nothing here holds onto or catches that derived
    // promise, a failed load (e.g. the GLTF-type rejection above, or any texture/audio/generic
    // load failure) surfaces as an extra, uncatchable "unhandled rejection" regardless of
    // whether the caller awaits/catches load()'s own return value. `.then(cleanup, cleanup)`
    // handles both branches itself, so its derived promise always resolves and there's nothing
    // left unhandled.
    promise.then(
      () => this.inflight.delete(handle),
      () => this.inflight.delete(handle)
    );
    return promise;
  }

  loadById(id: AssetId): Promise<any> {
    const handle = this.store.getHandleById(id);
    if (handle === INVALID_ASSET) return Promise.reject(`Asset "${id}" not registered`);
    return this.load(handle);
  }

  loadByPath(path: string): Promise<any> {
    const handle = this.store.getHandleByPath(path);
    if (handle === INVALID_ASSET) return Promise.reject(`Asset at "${path}" not registered`);
    return this.load(handle);
  }

  // ── Immediate access ──

  get<T = any>(handle: AssetHandle): T | null {
    return this.store.getData<T>(handle);
  }

  getById<T = any>(id: AssetId): T | null {
    const handle = this.store.getHandleById(id);
    if (handle === INVALID_ASSET) return null;
    return this.store.getData<T>(handle);
  }

  isReady(handle: AssetHandle): boolean {
    return this.store.isLoaded(handle);
  }

  // ── Release ──

  release(handle: AssetHandle): void {
    const shouldDispose = this.store.release(handle);
    if (shouldDispose) {
      const data = this.store.getData(handle);
      if (data?.dispose) data.dispose();

      // Read type/size before remove() clears them below.
      const resourceType = toResourceType(this.store.getType(handle));
      const bytes = this.store.getMemorySize(handle);
      if (resourceType !== null && bytes > 0) {
        this.memoryBudget.trackDeallocation(resourceType, bytes);
      }

      // Dependencies (e.g. a GLTF's registered meshes/materials/animations) were each
      // retained once when this asset was loaded — release them symmetrically so their own
      // refcounts can drop to zero and they get disposed too, instead of leaking forever.
      const dependencies = this.store.getDependencies(handle);
      for (const dep of dependencies) {
        this.release(dep as AssetHandle);
      }
      this.store.remove(handle);
      this.events?.emit("asset:disposed", handle);
    }
  }

  // ── Batch loading ──

  async loadAll(handles: AssetHandle[]): Promise<void> {
    await Promise.all(handles.map((h) => this.load(h)));
  }

  // ── Internal loaders ──

  private loadTexture(handle: AssetHandle, path: string): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
      this.textureLoader.load(
        path,
        (tex) => {
          this.store.setLoaded(handle, tex);
          const bytes = estimateTextureBytes(tex);
          this.store.setMemorySize(handle, bytes);
          this.memoryBudget.trackAllocation(ResourceType.Texture, bytes);
          this.evictIfOverBudget(ResourceType.Texture, "Texture", path, handle);
          this.events?.emit("asset:loaded", handle);
          resolve(tex);
        },
        undefined,
        (err) => {
          this.store.setFailed(handle, `Failed to load texture: ${path}`);
          this.events?.emit("asset:failed", handle);
          reject(err);
        }
      );
    });
  }

  private loadAudio(handle: AssetHandle, path: string): Promise<AudioBuffer> {
    return new Promise((resolve, reject) => {
      this.audioLoader.load(
        path,
        (buf) => {
          this.store.setLoaded(handle, buf);
          const bytes = estimateAudioBytes(buf);
          this.store.setMemorySize(handle, bytes);
          this.memoryBudget.trackAllocation(ResourceType.Audio, bytes);
          this.evictIfOverBudget(ResourceType.Audio, "Audio", path, handle);
          this.events?.emit("asset:loaded", handle);
          resolve(buf);
        },
        undefined,
        (err) => {
          this.store.setFailed(handle, `Failed to load audio: ${path}`);
          this.events?.emit("asset:failed", handle);
          reject(err);
        }
      );
    });
  }

  private async loadGeneric(handle: AssetHandle, path: string): Promise<any> {
    try {
      const resp = await fetch(path);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      this.store.setLoaded(handle, data);
      this.events?.emit("asset:loaded", handle);
      return data;
    } catch (err: any) {
      this.store.setFailed(handle, err.message);
      this.events?.emit("asset:failed", handle);
      throw err;
    }
  }

  update(_dt: number): void {
    // Process load queue (rate-limited)
    while (this.loadQueue.length > 0 && this.activeLoads < this.maxConcurrent) {
      const handle = this.loadQueue.shift()!;
      this.activeLoads++;
      this.load(handle).finally(() => this.activeLoads--);
    }
  }

  enqueue(handle: AssetHandle): void {
    if (!this.store.isLoaded(handle) && !this.store.isLoading(handle)) {
      this.loadQueue.push(handle);
    }
  }

  destroy(): void {
    this.store.forEachLoaded((handle, data) => {
      if (data?.dispose) data.dispose();
    });
  }
}
