import { ArchetypeIndex } from "./ArchetypeIndex";
import { Mask } from "./ComponentMask";

export class Query {
  private archetypes: ArchetypeIndex;
  private mask: Mask;
  private cachedEntities: number[] = [];
  private cachedVersion = -1;
  private snapshot: number[] = [];
  private snapshotVersion = -1;

  constructor(archetypes: ArchetypeIndex, mask: Mask) {
    this.archetypes = archetypes;
    this.mask = mask;
  }

  markDirty(): void {
    this.cachedVersion = -1;
  }

  // Returns a defensive copy -- a caller that sorts/splices/otherwise mutates this array in
  // place would, with the raw cache returned directly, silently corrupt what every other
  // caller of this same Query sees on every subsequent frame until the archetype version next
  // changes. The copy is only rebuilt when the underlying archetype match set actually changes
  // (same version gate as rebuild() below), not on every access, so repeated reads within one
  // frame don't each allocate.
  get entities(): number[] {
    this.ensureFresh();
    if (this.snapshotVersion !== this.cachedVersion) {
      this.snapshot = this.cachedEntities.slice();
      this.snapshotVersion = this.cachedVersion;
    }
    return this.snapshot;
  }

  // Live, mutable reference to the internal cache -- for hot paths that iterate every frame
  // and are known not to mutate the result. Any in-place mutation here is visible to every
  // other reader of this Query (including `.entities` above, until the next rebuild).
  get entitiesUnsafe(): number[] {
    this.ensureFresh();
    return this.cachedEntities;
  }

  private ensureFresh(): void {
    if (this.cachedVersion !== this.archetypes.version) {
      this.rebuild();
      this.cachedVersion = this.archetypes.version;
    }
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
