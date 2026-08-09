import { System, World } from "../ecs";
import { SceneSerializer, SerializedScene } from "../core/serialization/SceneSerializer";
import { EventBus } from "../core/EventBus";

export type SceneState = "unloaded" | "loading" | "active" | "unloading";

export interface SceneHandle {
  name: string;
  state: SceneState;
  entityIds: number[];
  persistent: boolean;
}

export class SceneManager extends System {
  priority = 240;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "postPhysics";

  private scenes = new Map<string, SceneHandle>();
  private pendingLoads = new Map<string, Promise<SceneHandle>>();
  private serializer!: SceneSerializer;
  private events!: EventBus;
  private loadFn?: (name: string) => Promise<SerializedScene>;

  setSerializer(serializer: SceneSerializer): void {
    this.serializer = serializer;
  }

  setEvents(events: EventBus): void {
    this.events = events;
  }

  setLoader(fn: (name: string) => Promise<SerializedScene>): void {
    this.loadFn = fn;
  }

  async loadScene(name: string, persistent: boolean = false): Promise<SceneHandle> {
    if (this.scenes.has(name)) return this.scenes.get(name)!;

    // Deduplicate concurrent loads of the same scene
    const pending = this.pendingLoads.get(name);
    if (pending) return pending;

    const promise = this.doLoadScene(name, persistent);
    this.pendingLoads.set(name, promise);

    try {
      return await promise;
    } finally {
      this.pendingLoads.delete(name);
    }
  }

  private async doLoadScene(name: string, persistent: boolean): Promise<SceneHandle> {
    const handle: SceneHandle = { name, state: "loading", entityIds: [], persistent };
    this.scenes.set(name, handle);
    this.events?.emit("scene:loading", name);

    if (this.loadFn) {
      const data = await this.loadFn(name);
      handle.entityIds = this.serializer.deserialize(this.world, data);
    }

    if (this.scenes.get(name) !== handle) {
      // unloadScene() ran while this load was in flight and dropped our handle from
      // this.scenes; the entities just deserialized would otherwise be orphaned.
      for (const eid of handle.entityIds) {
        this.world.destroyEntity(eid);
      }
      handle.entityIds.length = 0;
      return handle;
    }

    handle.state = "active";
    this.events?.emit("scene:loaded", name);
    return handle;
  }

  loadSceneFromData(name: string, data: SerializedScene, persistent: boolean = false): SceneHandle {
    if (this.scenes.has(name)) this.unloadScene(name);

    const handle: SceneHandle = { name, state: "active", entityIds: [], persistent };
    handle.entityIds = this.serializer.deserialize(this.world, data);
    this.scenes.set(name, handle);
    this.events?.emit("scene:loaded", name);
    return handle;
  }

  unloadScene(name: string): void {
    const handle = this.scenes.get(name);
    if (!handle || handle.persistent) return;

    handle.state = "unloading";
    this.events?.emit("scene:unloading", name);

    for (const eid of handle.entityIds) {
      this.world.destroyEntity(eid);
    }

    handle.entityIds.length = 0;
    handle.state = "unloaded";
    this.scenes.delete(name);
    this.events?.emit("scene:unloaded", name);
  }

  async transition(from: string, to: string): Promise<void> {
    this.events?.emit("scene:transition:start", from, to);
    const toHandle = await this.loadScene(to);
    this.unloadScene(from);
    this.events?.emit("scene:transition:end", from, to);
  }

  getScene(name: string): SceneHandle | undefined {
    return this.scenes.get(name);
  }

  getActiveScenes(): string[] {
    const result: string[] = [];
    for (const [name, handle] of this.scenes) {
      if (handle.state === "active") result.push(name);
    }
    return result;
  }

  saveScene(name: string): SerializedScene | null {
    const handle = this.scenes.get(name);
    if (!handle) return null;
    return this.serializer.serialize(this.world, name);
  }

  update(_dt: number): void {
    // Streaming logic would go here for SubScene loading based on camera position
  }

  destroy(): void {
    for (const [name, handle] of this.scenes) {
      if (!handle.persistent) this.unloadScene(name);
    }
  }
}
