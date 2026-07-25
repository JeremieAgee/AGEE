import { ArchetypeIndex } from "./ArchetypeIndex";

export class Query {
  private archetypes: ArchetypeIndex;
  private mask: bigint;
  private cachedEntities: number[] = [];
  private cachedVersion = -1;

  constructor(archetypes: ArchetypeIndex, mask: bigint) {
    this.archetypes = archetypes;
    this.mask = mask;
  }

  markDirty(): void {
    this.cachedVersion = -1;
  }

  get entities(): number[] {
    if (this.cachedVersion !== this.archetypes.version) {
      this.rebuild();
      this.cachedVersion = this.archetypes.version;
    }
    return this.cachedEntities;
  }

  private rebuild(): void {
    this.cachedEntities.length = 0;
    const matches = this.archetypes.matching(this.mask);
    for (let i = 0; i < matches.length; i++) {
      const entities = matches[i].entities;
      for (let j = 0; j < entities.length; j++) {
        this.cachedEntities.push(entities[j]);
      }
    }
  }
}
