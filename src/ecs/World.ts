import { ComponentDef, ComponentSchema } from "./Component";
import { ComponentStore } from "./ComponentStore";
import { BitSet } from "./BitSet";
import { Query } from "./Query";
import { System, SystemPhase } from "./System";
import { ArchetypeIndex } from "./ArchetypeIndex";
import { SystemScheduler, ExecutionPlan, SystemConstraint } from "./SystemScheduler";
import type { EngineProfiler } from "../core/EngineProfiler";
import { Parent } from "../core/HierarchyComponents";

type EntityCallback = (eid: number) => void;

export const enum EntityFlags {
  None = 0,
  Alive = 1 << 0,
  Created = 1 << 1,
  DestroyPending = 1 << 2,
  Destroyed = 1 << 3,
  ComponentAdded = 1 << 4,
  ComponentRemoved = 1 << 5,
  ArchetypeChanged = 1 << 6,
}

export class World {
  private nextEntityId = 0;
  private stores = new Map<string, ComponentStore>();
  private componentBits = new Map<string, bigint>();
  private nextComponentBit = 0n;
  private archetypes = new ArchetypeIndex();
  private systems: System[] = [];
  private phaseOrder: SystemPhase[] = ["prePhysics", "physics", "postPhysics", "render"];
  private queries: Query[] = [];
  private recycled: number[] = [];

  private scheduler = new SystemScheduler();
  private cachedPlan: ExecutionPlan | null = null;
  private systemsDirty = true;

  private generations: Uint32Array;
  private flags: Uint32Array;
  private _alive = new BitSet();
  private destroyCallbacks: EntityCallback[] = [];

  constructor(initialCapacity = 1024) {
    this.generations = new Uint32Array(initialCapacity);
    this.flags = new Uint32Array(initialCapacity);

    // Parent.entity is a raw, recycled entity id with no built-in staleness check. Without
    // this, destroying a parent leaves any child's Parent component silently pointing at a
    // since-recycled id once that id is handed back out to a brand-new entity. Clear/remove
    // the Parent component of anything pointing at an entity as it's destroyed, mirroring how
    // Engine.ts hooks onEntityDestroy for MeshRenderer/Light cleanup.
    this.onEntityDestroy((eid) => this.cleanupDanglingParentRefs(eid));
  }

  createEntity(): number {
    let eid: number;
    if (this.recycled.length > 0) {
      eid = this.recycled.pop()!;
    } else {
      eid = this.nextEntityId++;
    }
    if (eid >= this.generations.length) {
      this.growEntityArrays(eid + 1);
    }
    this._alive.add(eid);
    this.flags[eid] = EntityFlags.Alive | EntityFlags.Created | EntityFlags.ArchetypeChanged;
    this.archetypes.addEntity(eid);
    return eid;
  }

  destroyEntity(eid: number): void {
    if (!this._alive.has(eid)) return;
    this.flags[eid] |= EntityFlags.DestroyPending;

    for (let i = 0; i < this.destroyCallbacks.length; i++) {
      try {
        this.destroyCallbacks[i](eid);
      } catch (e) {
        console.error(`[AGEE] Entity destroy callback threw for entity ${eid}:`, e);
      }
    }

    for (const [name, store] of this.stores) {
      if (store.has(eid)) {
        store.remove(eid);
        this.removeComponentBit(eid, name);
      }
    }

    this._alive.remove(eid);
    this.archetypes.removeEntity(eid);
    this.generations[eid]++;
    this.flags[eid] = EntityFlags.Destroyed | EntityFlags.ArchetypeChanged;
    this.recycled.push(eid);
  }

  isAlive(eid: number): boolean {
    return this._alive.has(eid);
  }

  get entityCount(): number {
    return this.nextEntityId - this.recycled.length;
  }

  get storeCount(): number {
    return this.stores.size;
  }

  get queryCount(): number {
    return this.queries.length;
  }

  generation(eid: number): number {
    return eid < this.generations.length ? this.generations[eid] : 0;
  }

  getFlags(eid: number): EntityFlags {
    return eid < this.flags.length ? this.flags[eid] : EntityFlags.None;
  }

  setFlags(eid: number, flags: EntityFlags): void {
    if (eid >= this.flags.length) this.growEntityArrays(eid + 1);
    this.flags[eid] = flags;
  }

  addFlags(eid: number, flags: EntityFlags): void {
    if (eid >= this.flags.length) this.growEntityArrays(eid + 1);
    this.flags[eid] |= flags;
  }

  clearFrameFlags(): void {
    const words = this._alive.rawWords;
    const wordCount = this._alive.rawWordCount;
    const flags = this.flags;
    for (let w = 0; w < wordCount; w++) {
      let word = words[w];
      while (word !== 0) {
        const lsb = word & (-word);
        const bitIndex = 31 - Math.clz32(lsb);
        const eid = (w << 5) + bitIndex;
        flags[eid] = EntityFlags.Alive;
        word &= word - 1;
      }
    }
  }

  onEntityDestroy(callback: EntityCallback): () => void {
    this.destroyCallbacks.push(callback);
    return () => {
      const idx = this.destroyCallbacks.indexOf(callback);
      if (idx !== -1) this.destroyCallbacks.splice(idx, 1);
    };
  }

  registerComponent<S extends ComponentSchema>(def: ComponentDef<S>): ComponentStore<S> {
    this.getComponentBit(def.name);
    if (this.stores.has(def.name)) {
      return this.stores.get(def.name) as ComponentStore<S>;
    }
    const store = new ComponentStore(def);
    this.stores.set(def.name, store as ComponentStore);
    return store as ComponentStore<S>;
  }

  getStore<S extends ComponentSchema>(def: ComponentDef<S>): ComponentStore<S> {
    this.getComponentBit(def.name);
    let store = this.stores.get(def.name);
    if (!store) {
      store = new ComponentStore(def) as ComponentStore;
      this.stores.set(def.name, store);
    }
    return store as ComponentStore<S>;
  }

  addComponent<S extends ComponentSchema>(
    eid: number,
    def: ComponentDef<S>,
    data?: Partial<Record<keyof S, number | boolean | any>>
  ): void {
    if (!this._alive.has(eid)) return;

    const store = this.getStore(def);
    const hadComponent = store.has(eid);
    store.add(eid, data);
    if (!hadComponent) {
      this.addComponentBit(eid, def.name);
    }
  }

  removeComponent(eid: number, def: ComponentDef): void {
    const store = this.getStore(def);
    if (!store.has(eid)) return;

    store.remove(eid);
    this.removeComponentBit(eid, def.name);
  }

  hasComponent(eid: number, def: ComponentDef): boolean {
    return this.getStore(def).has(eid);
  }

  query(...defs: ComponentDef[]): Query {
    let mask = 0n;
    for (const def of defs) {
      this.getStore(def);
      mask |= this.getComponentBit(def.name);
    }

    const q = new Query(this.archetypes, mask);
    this.queries.push(q);
    return q;
  }

  setProfiler(profiler: EngineProfiler): void {
    this.scheduler.setProfiler(profiler);
  }

  addSystemConstraint(constraint: SystemConstraint): void {
    this.scheduler.addConstraint(constraint);
    this.systemsDirty = true;
  }

  addSystem(system: System): void {
    system.world = this;
    this.systems.push(system);
    this.systems.sort((a, b) => a.priority - b.priority);
    this.systemsDirty = true;
    system.init?.();
  }

  getSystems(): readonly System[] {
    return this.systems;
  }

  removeSystem(system: System): void {
    const idx = this.systems.indexOf(system);
    if (idx !== -1) {
      system.destroy?.();
      this.systems.splice(idx, 1);
      this.systemsDirty = true;
    }
  }

  update(dt: number): void {
    if (this.systemsDirty) {
      this.cachedPlan = this.scheduler.buildPlan(this.systems, this.phaseOrder);
      this.systemsDirty = false;
    }
    this.scheduler.execute(this.cachedPlan!, dt);
  }

  clear(): void {
    for (const system of this.systems) {
      system.destroy?.();
    }
    this.systems.length = 0;
    this.stores.clear();
    this.componentBits.clear();
    this.nextComponentBit = 0n;
    this.archetypes.clear();
    this.queries.length = 0;
    this.nextEntityId = 0;
    this.recycled.length = 0;
    this._alive.clear();
    this.generations = new Uint32Array(1024);
    this.flags = new Uint32Array(1024);
    this.destroyCallbacks.length = 0;
    this.systemsDirty = true;
    this.cachedPlan = null;
  }

  private growEntityArrays(requiredCapacity: number): void {
    let nextCapacity = this.generations.length;
    while (nextCapacity < requiredCapacity) nextCapacity *= 2;

    const freshGenerations = new Uint32Array(nextCapacity);
    freshGenerations.set(this.generations);
    this.generations = freshGenerations;

    const freshFlags = new Uint32Array(nextCapacity);
    freshFlags.set(this.flags);
    this.flags = freshFlags;
  }

  private getComponentBit(name: string): bigint {
    let bit = this.componentBits.get(name);
    if (bit === undefined) {
      bit = 1n << this.nextComponentBit;
      this.nextComponentBit++;
      this.componentBits.set(name, bit);
    }
    return bit;
  }

  private addComponentBit(eid: number, name: string): void {
    const nextMask = this.archetypes.getMask(eid) | this.getComponentBit(name);
    this.archetypes.setMask(eid, nextMask);
    this.flags[eid] |= EntityFlags.ComponentAdded | EntityFlags.ArchetypeChanged;
  }

  private removeComponentBit(eid: number, name: string): void {
    const nextMask = this.archetypes.getMask(eid) & ~this.getComponentBit(name);
    this.archetypes.setMask(eid, nextMask);
    this.flags[eid] |= EntityFlags.ComponentRemoved | EntityFlags.ArchetypeChanged;
  }

  // Scans the Parent store (if it has ever been used) for any entity whose Parent.entity
  // still points at the entity that's being destroyed, and removes their Parent component so
  // it can't silently alias whatever new entity eventually gets that recycled id. Only looks
  // at the store if one was actually created, so worlds that never touch hierarchy components
  // pay no cost.
  private cleanupDanglingParentRefs(destroyedEid: number): void {
    const store = this.stores.get(Parent.name);
    if (!store) return;

    const entityColumn = store.getColumn("entity");
    const staleChildren: number[] = [];
    for (const childEid of store.entities) {
      if (entityColumn[childEid] === destroyedEid) {
        staleChildren.push(childEid);
      }
    }

    for (const childEid of staleChildren) {
      this.removeComponent(childEid, Parent);
    }
  }
}
