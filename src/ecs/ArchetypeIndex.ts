export interface Archetype {
  readonly mask: bigint;
  readonly entities: number[];
}

export class ArchetypeIndex {
  private archetypes = new Map<bigint, Archetype>();
  private entityMasks: bigint[] = [];
  private entityPositions: number[] = [];
  private _version = 0;

  constructor() {
    this.archetypes.set(0n, { mask: 0n, entities: [] });
  }

  get version(): number {
    return this._version;
  }

  getMask(entityId: number): bigint {
    return this.entityMasks[entityId] ?? 0n;
  }

  setMask(entityId: number, nextMask: bigint): void {
    const currentMask = this.getMask(entityId);
    if (currentMask === nextMask) return;

    this.removeFromArchetype(entityId, currentMask);
    this.addToArchetype(entityId, nextMask);
    this.entityMasks[entityId] = nextMask;
    this.bumpIfRelevant(currentMask, nextMask);
  }

  addEntity(entityId: number): void {
    if (this.entityMasks[entityId] !== undefined) return;

    this.addToArchetype(entityId, 0n);
    this.entityMasks[entityId] = 0n;
    this.bumpIfRelevant(0n, 0n);
  }

  removeEntity(entityId: number): void {
    if (this.entityMasks[entityId] === undefined) return;

    const oldMask = this.entityMasks[entityId];
    this.removeFromArchetype(entityId, oldMask);
    this.entityMasks[entityId] = undefined as any;
    this.entityPositions[entityId] = -1;
    // An entity vanishing is always relevant to a 0n ("matches everything") query mask, and
    // to any registered mask the entity used to satisfy.
    this.bumpIfRelevant(oldMask, 0n);
  }

  private matchCache = new Map<bigint, { version: number; result: Archetype[] }>();

  // Only bump the shared version counter when the archetype transition (oldMask -> newMask)
  // could actually change the result of a query whose mask has been looked up before (i.e. is
  // present as a key in matchCache). Previously `_version` was bumped unconditionally on every
  // structural change anywhere, forcing every live query to rebuild its full match list even
  // when the churn had nothing to do with that query's component mask. A query mask `m` is
  // affected by this transition iff the entity was (or now is) part of an archetype that
  // satisfies `m` — i.e. (oldMask & m) === m or (newMask & m) === m.
  private bumpIfRelevant(oldMask: bigint, newMask: bigint): void {
    for (const queryMask of this.matchCache.keys()) {
      if ((oldMask & queryMask) === queryMask || (newMask & queryMask) === queryMask) {
        this._version++;
        return;
      }
    }
  }

  matching(queryMask: bigint): Archetype[] {
    const cached = this.matchCache.get(queryMask);
    if (cached && cached.version === this._version) {
      return cached.result;
    }

    const result: Archetype[] = [];
    for (const archetype of this.archetypes.values()) {
      if ((archetype.mask & queryMask) === queryMask) {
        result.push(archetype);
      }
    }

    if (cached) {
      cached.version = this._version;
      cached.result = result;
    } else {
      this.matchCache.set(queryMask, { version: this._version, result });
    }
    return result;
  }

  clear(): void {
    this.archetypes.clear();
    this.archetypes.set(0n, { mask: 0n, entities: [] });
    this.entityMasks.length = 0;
    this.entityPositions.length = 0;
    this.matchCache.clear();
    this._version++;
  }

  private getOrCreate(mask: bigint): Archetype {
    let archetype = this.archetypes.get(mask);
    if (!archetype) {
      archetype = { mask, entities: [] };
      this.archetypes.set(mask, archetype);
    }
    return archetype;
  }

  private addToArchetype(entityId: number, mask: bigint): void {
    const archetype = this.getOrCreate(mask);
    this.entityPositions[entityId] = archetype.entities.length;
    archetype.entities.push(entityId);
  }

  private removeFromArchetype(entityId: number, mask: bigint): void {
    const archetype = this.archetypes.get(mask);
    if (!archetype) return;

    const position = this.entityPositions[entityId];
    if (position === undefined || position < 0 || position >= archetype.entities.length) return;

    const last = archetype.entities.pop()!;
    if (last !== entityId) {
      archetype.entities[position] = last;
      this.entityPositions[last] = position;
    }
    this.entityPositions[entityId] = -1;
  }
}
