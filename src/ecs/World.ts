import { ComponentDef, ComponentSchema } from "./Component";
import { ComponentStore } from "./ComponentStore";
import { BitSet } from "./BitSet";
import { Query } from "./Query";
import { System, SystemPhase } from "./System";
import { ArchetypeIndex } from "./ArchetypeIndex";
import { SystemScheduler, ExecutionPlan, SystemConstraint } from "./SystemScheduler";
import type { EngineProfiler } from "../core/EngineProfiler";
import { Parent } from "../core/HierarchyComponents";
import { createMask, maskOrBit, maskAndNotBit, MASK_WORD_COUNT } from "./ComponentMask";

const MAX_COMPONENT_TYPES = MASK_WORD_COUNT * 32;

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
  private componentBits = new Map<string, number>();
  private nextComponentBit = 0;
  private archetypes = new ArchetypeIndex();
  private systems: System[] = [];
  private phaseOrder: SystemPhase[] = ["prePhysics", "physics", "postPhysics", "render"];
  private queries: Query[] = [];
  private queriesBySystem = new Map<System, Query[]>();
  private initializingSystem: System | null = null;
  private recycled: number[] = [];

  private scheduler = new SystemScheduler();
  private cachedPlan: ExecutionPlan | null = null;
  private systemsDirty = true;

  private generations: Uint32Array;
  private flags: Uint32Array;
  private _alive = new BitSet();
  private destroyCallbacks: EntityCallback[] = [];
  private readonly initialCapacity: number;

  // Reverse index (parent eid -> child eids) kept in sync via the Parent store's onAdd/onRemove
  // hooks, so destroyEntity's dangling-Parent cleanup doesn't have to linear-scan every entity
  // with a Parent component on every single destroy (that scan was O(N) per destroy, O(N^2) for
  // a mass hierarchy teardown like a level unload).
  private childrenByParent = new Map<number, Set<number>>();

  constructor(initialCapacity = 1024) {
    this.initialCapacity = initialCapacity;
    this.generations = new Uint32Array(initialCapacity);
    this.flags = new Uint32Array(initialCapacity);

    this.attachParentIndexHooks();

    // Parent.entity is a raw, recycled entity id with no built-in staleness check. Without
    // this, destroying a parent leaves any child's Parent component silently pointing at a
    // since-recycled id once that id is handed back out to a brand-new entity. Clear/remove
    // the Parent component of anything pointing at an entity as it's destroyed, mirroring how
    // Engine.ts hooks onEntityDestroy for MeshRenderer/Light cleanup.
    this.onEntityDestroy((eid) => this.cleanupDanglingParentRefs(eid));
  }

  // Wires childrenByParent up to whatever ComponentStore currently backs Parent. Must be
  // re-run after clear() recreates the store map, or the new Parent store would silently
  // stop feeding the reverse index.
  private attachParentIndexHooks(): void {
    const parentStore = this.getStore(Parent);
    parentStore.onAdd((eid) => {
      const parentEid = parentStore.get(eid, "entity") as number;
      let children = this.childrenByParent.get(parentEid);
      if (!children) {
        children = new Set();
        this.childrenByParent.set(parentEid, children);
      }
      children.add(eid);
    });
    parentStore.onRemove((eid) => {
      const parentEid = parentStore.get(eid, "entity") as number;
      const children = this.childrenByParent.get(parentEid);
      if (!children) return;
      children.delete(eid);
      if (children.size === 0) this.childrenByParent.delete(parentEid);
    });
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
    // Without this, a stale eid held past destroyEntity() + recycle can silently mutate
    // whichever new entity has since been handed that same recycled id — mirrors the
    // isAlive() guard addComponent() already applies.
    if (!this._alive.has(eid)) return;

    const store = this.getStore(def);
    if (!store.has(eid)) return;

    store.remove(eid);
    this.removeComponentBit(eid, def.name);
  }

  hasComponent(eid: number, def: ComponentDef): boolean {
    if (!this._alive.has(eid)) return false;
    return this.getStore(def).has(eid);
  }

  query(...defs: ComponentDef[]): Query {
    const mask = createMask();
    for (const def of defs) {
      this.getStore(def);
      maskOrBit(mask, this.getComponentBit(def.name), mask);
    }

    const q = new Query(this.archetypes, mask);
    this.queries.push(q);
    if (this.initializingSystem) {
      let owned = this.queriesBySystem.get(this.initializingSystem);
      if (!owned) {
        owned = [];
        this.queriesBySystem.set(this.initializingSystem, owned);
      }
      owned.push(q);
    }
    return q;
  }

  // Explicit unregister for queries created outside a System's init() (ad-hoc/editor/test
  // usage) that would otherwise sit in `queries` forever — see removeSystem() for the
  // automatic path covering queries a System created during its own init().
  removeQuery(query: Query): void {
    const idx = this.queries.indexOf(query);
    if (idx !== -1) this.queries.splice(idx, 1);
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

    const prevInitializing = this.initializingSystem;
    this.initializingSystem = system;
    try {
      system.init?.();
    } finally {
      this.initializingSystem = prevInitializing;
    }
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

    const owned = this.queriesBySystem.get(system);
    if (owned) {
      for (const q of owned) this.removeQuery(q);
      this.queriesBySystem.delete(system);
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
    this.nextComponentBit = 0;
    this.archetypes.clear();
    this.queries.length = 0;
    this.queriesBySystem.clear();
    this.initializingSystem = null;
    this.nextEntityId = 0;
    this.recycled.length = 0;
    this._alive.clear();
    this.generations = new Uint32Array(this.initialCapacity);
    this.flags = new Uint32Array(this.initialCapacity);
    this.destroyCallbacks.length = 0;
    this.childrenByParent.clear();
    this.systemsDirty = true;
    this.cachedPlan = null;

    this.attachParentIndexHooks();
    this.onEntityDestroy((eid) => this.cleanupDanglingParentRefs(eid));
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

  private getComponentBit(name: string): number {
    let bit = this.componentBits.get(name);
    if (bit === undefined) {
      // Mask is a fixed-width Uint32Array (see ComponentMask.ts) — a bit index past its
      // capacity would silently no-op on every mask write instead of throwing, making that
      // component type invisible to every query with no diagnostic. Fail loudly instead.
      if (this.nextComponentBit >= MAX_COMPONENT_TYPES) {
        throw new Error(
          `[AGEE] Component type limit exceeded: cannot register "${name}" as component type ` +
          `#${this.nextComponentBit + 1} (limit is ${MAX_COMPONENT_TYPES}). Increase ` +
          `MASK_WORD_COUNT in src/ecs/ComponentMask.ts.`
        );
      }
      bit = this.nextComponentBit;
      this.nextComponentBit++;
      this.componentBits.set(name, bit);
    }
    return bit;
  }

  private addComponentBit(eid: number, name: string): void {
    const nextMask = maskOrBit(this.archetypes.getMask(eid), this.getComponentBit(name), createMask());
    this.archetypes.setMask(eid, nextMask);
    this.flags[eid] |= EntityFlags.ComponentAdded | EntityFlags.ArchetypeChanged;
  }

  private removeComponentBit(eid: number, name: string): void {
    const nextMask = maskAndNotBit(this.archetypes.getMask(eid), this.getComponentBit(name), createMask());
    this.archetypes.setMask(eid, nextMask);
    this.flags[eid] |= EntityFlags.ComponentRemoved | EntityFlags.ArchetypeChanged;
  }

  // Removes the Parent component from any entity whose Parent.entity still points at the
  // entity that's being destroyed, so it can't silently alias whatever new entity eventually
  // gets that recycled id. Looks the affected children up in childrenByParent (kept current by
  // attachParentIndexHooks) instead of scanning every entity with a Parent component.
  private cleanupDanglingParentRefs(destroyedEid: number): void {
    const children = this.childrenByParent.get(destroyedEid);
    if (!children || children.size === 0) return;

    // Snapshot first: removeComponent(childEid, Parent) below mutates this same Set via the
    // onRemove hook, and iterating a Set while deleting from it is unsafe.
    for (const childEid of Array.from(children)) {
      this.removeComponent(childEid, Parent);
    }
  }
}
