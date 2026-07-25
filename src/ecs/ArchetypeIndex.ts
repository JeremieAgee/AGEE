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
    this._version++;
  }

  addEntity(entityId: number): void {
    if (this.entityMasks[entityId] !== undefined) return;

    this.addToArchetype(entityId, 0n);
    this.entityMasks[entityId] = 0n;
    this._version++;
  }

  removeEntity(entityId: number): void {
    if (this.entityMasks[entityId] === undefined) return;

    this.removeFromArchetype(entityId, this.entityMasks[entityId]);
    this.entityMasks[entityId] = undefined as any;
    this.entityPositions[entityId] = -1;
    this._version++;
  }

  private matchCache = new Map<bigint, { version: number; result: Archetype[] }>();

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
