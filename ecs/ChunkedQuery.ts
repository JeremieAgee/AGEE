import { Chunk } from "./Chunk";
import { ChunkedArchetypeStorage, ChunkedArchetype } from "./ChunkedArchetype";
import { ComponentDef } from "./Component";

export interface ChunkIterationContext {
  chunk: Chunk;
  count: number;
  entityIds: Int32Array;
}

export class ChunkedQuery {
  private storage: ChunkedArchetypeStorage;
  private mask: bigint;
  private componentNames: string[];
  private cachedArchetypes: ChunkedArchetype[] = [];
  private cachedVersion = -1;

  constructor(storage: ChunkedArchetypeStorage, mask: bigint, componentNames: string[]) {
    this.storage = storage;
    this.mask = mask;
    this.componentNames = componentNames;
  }

  get archetypes(): ChunkedArchetype[] {
    if (this.cachedVersion !== this.storage.version) {
      this.cachedArchetypes = this.storage.getMatchingArchetypes(this.mask);
      this.cachedVersion = this.storage.version;
    }
    return this.cachedArchetypes;
  }

  forEach(callback: (ctx: ChunkIterationContext) => void): void {
    const archetypes = this.archetypes;
    for (let a = 0; a < archetypes.length; a++) {
      const chunks = archetypes[a].chunks;
      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        if (chunk.count === 0) continue;
        callback({
          chunk,
          count: chunk.count,
          entityIds: chunk.entityIds,
        });
      }
    }
  }

  forEachEntity(callback: (entityId: number, chunk: Chunk, row: number) => void): void {
    const archetypes = this.archetypes;
    for (let a = 0; a < archetypes.length; a++) {
      const chunks = archetypes[a].chunks;
      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        const count = chunk.count;
        const ids = chunk.entityIds;
        for (let r = 0; r < count; r++) {
          callback(ids[r], chunk, r);
        }
      }
    }
  }

  get entityCount(): number {
    let total = 0;
    const archetypes = this.archetypes;
    for (let a = 0; a < archetypes.length; a++) {
      total += archetypes[a].entityCount;
    }
    return total;
  }

  collectEntityIds(): number[] {
    const result: number[] = [];
    this.forEachEntity((eid) => result.push(eid));
    return result;
  }
}
