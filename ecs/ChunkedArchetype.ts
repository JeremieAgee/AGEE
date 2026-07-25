import { ComponentDef, ComponentSchema } from "./Component";
import { Chunk, CHUNK_SIZE } from "./Chunk";

export interface EntityLocation {
  archetypeId: bigint;
  chunkIndex: number;
  row: number;
}

export class ChunkedArchetype {
  readonly id: bigint;
  readonly componentDefs: ComponentDef[];
  readonly componentNames: Set<string>;
  readonly chunks: Chunk[] = [];
  private chunkCapacity: number;

  constructor(id: bigint, componentDefs: ComponentDef[], chunkCapacity: number = CHUNK_SIZE) {
    this.id = id;
    this.componentDefs = componentDefs;
    this.componentNames = new Set(componentDefs.map(d => d.name));
    this.chunkCapacity = chunkCapacity;
  }

  get entityCount(): number {
    let total = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      total += this.chunks[i].count;
    }
    return total;
  }

  addEntity(entityId: number): EntityLocation {
    let chunk = this.findNonFullChunk();
    if (!chunk) {
      chunk = this.allocateChunk();
    }
    const chunkIndex = this.chunks.indexOf(chunk);
    const row = chunk.add(entityId);
    return { archetypeId: this.id, chunkIndex, row };
  }

  removeEntity(chunkIndex: number, row: number): { swappedEntity: number } | null {
    const chunk = this.chunks[chunkIndex];
    if (!chunk) return null;

    const result = chunk.remove(row);

    if (chunk.isEmpty && this.chunks.length > 1) {
      this.chunks.splice(chunkIndex, 1);
    }

    if (result) {
      return { swappedEntity: result.swappedEntity };
    }
    return null;
  }

  private findNonFullChunk(): Chunk | null {
    for (let i = 0; i < this.chunks.length; i++) {
      if (!this.chunks[i].isFull) return this.chunks[i];
    }
    return null;
  }

  private allocateChunk(): Chunk {
    const chunk = new Chunk(this.id, this.componentDefs, this.chunkCapacity);
    this.chunks.push(chunk);
    return chunk;
  }

  hasComponent(name: string): boolean {
    return this.componentNames.has(name);
  }

  matches(queryMask: bigint, componentBits: Map<string, bigint>): boolean {
    return (this.id & queryMask) === queryMask;
  }
}

export class ChunkedArchetypeStorage {
  private archetypes = new Map<bigint, ChunkedArchetype>();
  private entityLocations = new Map<number, EntityLocation>();
  private componentBits = new Map<string, bigint>();
  private componentDefs = new Map<string, ComponentDef>();
  private nextBit = 0n;
  private _version = 0;

  get version(): number { return this._version; }

  registerComponent(def: ComponentDef): bigint {
    let bit = this.componentBits.get(def.name);
    if (bit === undefined) {
      bit = 1n << this.nextBit;
      this.nextBit++;
      this.componentBits.set(def.name, bit);
      this.componentDefs.set(def.name, def);
    }
    return bit;
  }

  getComponentBit(name: string): bigint {
    return this.componentBits.get(name) ?? 0n;
  }

  createEntity(entityId: number): void {
    const emptyArchetype = this.getOrCreateArchetype(0n, []);
    const location = emptyArchetype.addEntity(entityId);
    this.entityLocations.set(entityId, location);
    this._version++;
  }

  destroyEntity(entityId: number): void {
    const loc = this.entityLocations.get(entityId);
    if (!loc) return;

    const archetype = this.archetypes.get(loc.archetypeId);
    if (archetype) {
      const result = archetype.removeEntity(loc.chunkIndex, loc.row);
      if (result) {
        const swappedLoc = this.entityLocations.get(result.swappedEntity);
        if (swappedLoc) {
          swappedLoc.row = loc.row;
        }
      }
    }

    this.entityLocations.delete(entityId);
    this._version++;
  }

  addComponent(entityId: number, def: ComponentDef, data?: Record<string, any>): void {
    this.registerComponent(def);
    const loc = this.entityLocations.get(entityId);
    if (!loc) return;

    const bit = this.componentBits.get(def.name)!;
    const newMask = loc.archetypeId | bit;

    if (newMask === loc.archetypeId) return;

    this.moveEntity(entityId, loc, newMask);

    if (data) {
      const newLoc = this.entityLocations.get(entityId)!;
      const archetype = this.archetypes.get(newLoc.archetypeId)!;
      const chunk = archetype.chunks[newLoc.chunkIndex];
      for (const [field, value] of Object.entries(data)) {
        chunk.setComponentData(def.name, newLoc.row, field, value);
      }
    }

    this._version++;
  }

  removeComponent(entityId: number, def: ComponentDef): void {
    const loc = this.entityLocations.get(entityId);
    if (!loc) return;

    const bit = this.componentBits.get(def.name);
    if (!bit) return;

    const newMask = loc.archetypeId & ~bit;
    if (newMask === loc.archetypeId) return;

    this.moveEntity(entityId, loc, newMask);
    this._version++;
  }

  hasComponent(entityId: number, componentName: string): boolean {
    const loc = this.entityLocations.get(entityId);
    if (!loc) return false;
    const bit = this.componentBits.get(componentName);
    if (!bit) return false;
    return (loc.archetypeId & bit) === bit;
  }

  getComponentData(entityId: number, componentName: string, field: string): any {
    const loc = this.entityLocations.get(entityId);
    if (!loc) return undefined;
    const archetype = this.archetypes.get(loc.archetypeId);
    if (!archetype) return undefined;
    const chunk = archetype.chunks[loc.chunkIndex];
    if (!chunk) return undefined;
    return chunk.getComponentData(componentName, loc.row, field);
  }

  setComponentData(entityId: number, componentName: string, field: string, value: any): void {
    const loc = this.entityLocations.get(entityId);
    if (!loc) return;
    const archetype = this.archetypes.get(loc.archetypeId);
    if (!archetype) return;
    const chunk = archetype.chunks[loc.chunkIndex];
    if (!chunk) return;
    chunk.setComponentData(componentName, loc.row, field, value);
  }

  getLocation(entityId: number): EntityLocation | undefined {
    return this.entityLocations.get(entityId);
  }

  queryChunks(queryMask: bigint): Chunk[] {
    const result: Chunk[] = [];
    for (const archetype of this.archetypes.values()) {
      if ((archetype.id & queryMask) === queryMask) {
        for (const chunk of archetype.chunks) {
          if (chunk.count > 0) {
            result.push(chunk);
          }
        }
      }
    }
    return result;
  }

  getMatchingArchetypes(queryMask: bigint): ChunkedArchetype[] {
    const result: ChunkedArchetype[] = [];
    for (const archetype of this.archetypes.values()) {
      if ((archetype.id & queryMask) === queryMask) {
        result.push(archetype);
      }
    }
    return result;
  }

  private moveEntity(entityId: number, oldLoc: EntityLocation, newMask: bigint): void {
    const oldArchetype = this.archetypes.get(oldLoc.archetypeId);
    if (!oldArchetype) return;

    const defs = this.defsForMask(newMask);
    const newArchetype = this.getOrCreateArchetype(newMask, defs);
    const newLoc = newArchetype.addEntity(entityId);

    const oldChunk = oldArchetype.chunks[oldLoc.chunkIndex];
    const newChunk = newArchetype.chunks[newLoc.chunkIndex];

    for (const def of oldArchetype.componentDefs) {
      if (!newArchetype.hasComponent(def.name)) continue;
      const oldCols = oldChunk.columns.get(def.name);
      const newCols = newChunk.columns.get(def.name);
      if (!oldCols || !newCols) continue;

      for (const [field, oldArr] of oldCols) {
        const newArr = newCols.get(field);
        if (newArr) {
          newArr[newLoc.row] = oldArr[oldLoc.row];
        }
      }
    }

    const result = oldArchetype.removeEntity(oldLoc.chunkIndex, oldLoc.row);
    if (result) {
      const swappedLoc = this.entityLocations.get(result.swappedEntity);
      if (swappedLoc) {
        swappedLoc.row = oldLoc.row;
      }
    }

    this.entityLocations.set(entityId, newLoc);
  }

  private defsForMask(mask: bigint): ComponentDef[] {
    const result: ComponentDef[] = [];
    for (const [name, bit] of this.componentBits) {
      if ((mask & bit) === bit) {
        const def = this.componentDefs.get(name);
        if (def) result.push(def);
      }
    }
    return result;
  }

  private getOrCreateArchetype(mask: bigint, defs: ComponentDef[]): ChunkedArchetype {
    let archetype = this.archetypes.get(mask);
    if (!archetype) {
      archetype = new ChunkedArchetype(mask, defs);
      this.archetypes.set(mask, archetype);
    }
    return archetype;
  }

  getArchetypeCount(): number {
    return this.archetypes.size;
  }

  getEntityCount(): number {
    return this.entityLocations.size;
  }

  clear(): void {
    this.archetypes.clear();
    this.entityLocations.clear();
    this._version++;
  }
}
