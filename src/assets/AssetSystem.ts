import * as THREE from "three";
import { System } from "../ecs";
import { AssetStore } from "./AssetStore";
import { AssetId, AssetType, AssetHandle, LoadStatus, INVALID_ASSET } from "./AssetTypes";
import { EventBus } from "../core/EventBus";

export class AssetSystem extends System {
  priority = -10;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "prePhysics";

  readonly store = new AssetStore();
  private textureLoader = new THREE.TextureLoader();
  private audioLoader = new THREE.AudioLoader();
  private loadQueue: AssetHandle[] = [];
  private maxConcurrent = 4;
  private activeLoads = 0;
  private events: EventBus | null = null;
  private inflight = new Map<AssetHandle, Promise<any>>();

  setEvents(events: EventBus): void {
    this.events = events;
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
    promise.finally(() => this.inflight.delete(handle));
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
