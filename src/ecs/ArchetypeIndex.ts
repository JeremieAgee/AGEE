import { Mask, createMask, maskClone, maskContainsAll, maskEquals, maskKey } from "./ComponentMask";

export interface Archetype {
  readonly mask: Mask;
  readonly entities: number[];
}

export class ArchetypeIndex {
  private archetypes = new Map<string, Archetype>();
  private entityMasks: (Mask | undefined)[] = [];
  private entityPositions: number[] = [];
  private _version = 0;

  constructor() {
    this.archetypes.set(maskKey(createMask()), { mask: createMask(), entities: [] });
  }

  get version(): number {
    return this._version;
  }

  getMask(entityId: number): Mask {
    return this.entityMasks[entityId] ?? createMask();
  }

  setMask(entityId: number, nextMask: Mask): void {
    const currentMask = this.getMask(entityId);
    if (maskEquals(currentMask, nextMask)) return;

    this.removeFromArchetype(entityId, currentMask);
    this.addToArchetype(entityId, nextMask);
    this.entityMasks[entityId] = nextMask;
    this.bumpIfRelevant(currentMask, nextMask);
  }

  addEntity(entityId: number): void {
    if (this.entityMasks[entityId] !== undefined) return;

    const zero = createMask();
    this.addToArchetype(entityId, zero);
    this.entityMasks[entityId] = zero;
    this.bumpIfRelevant(zero, zero);
  }

  removeEntity(entityId: number): void {
    if (this.entityMasks[entityId] === undefined) return;

    const oldMask = this.entityMasks[entityId]!;
    this.removeFromArchetype(entityId, oldMask);
    this.entityMasks[entityId] = undefined;
    this.entityPositions[entityId] = -1;
    // An entity vanishing is always relevant to a zero ("matches everything") query mask, and
    // to any registered mask the entity used to satisfy.
    this.bumpIfRelevant(oldMask, createMask());
  }

  private matchCache = new Map<string, { version: number; result: Archetype[]; mask: Mask }>();

  // Only bump the shared version counter when the archetype transition (oldMask -> newMask)
  // could actually change the result of a query whose mask has been looked up before (i.e. is
  // present as a key in matchCache). Previously `_version` was bumped unconditionally on every
  // structural change anywhere, forcing every live query to rebuild its full match list even
  // when the churn had nothing to do with that query's component mask. A query mask `m` is
  // affected by this transition iff the entity was (or now is) part of an archetype that
  // satisfies `m` — i.e. (oldMask & m) === m or (newMask & m) === m.
  private bumpIfRelevant(oldMask: Mask, newMask: Mask): void {
    for (const entry of this.matchCache.values()) {
      if (maskContainsAll(oldMask, entry.mask) || maskContainsAll(newMask, entry.mask)) {
        this._version++;
        return;
      }
    }
  }

  matching(queryMask: Mask): Archetype[] {
    const key = maskKey(queryMask);
    const cached = this.matchCache.get(key);
    if (cached && cached.version === this._version) {
      return cached.result;
    }

    const result: Archetype[] = [];
    for (const archetype of this.archetypes.values()) {
      if (maskContainsAll(archetype.mask, queryMask)) {
        result.push(archetype);
      }
    }

    if (cached) {
      cached.version = this._version;
      cached.result = result;
    } else {
      this.matchCache.set(key, { version: this._version, result, mask: maskClone(queryMask) });
    }
    return result;
  }

  clear(): void {
    this.archetypes.clear();
    this.archetypes.set(maskKey(createMask()), { mask: createMask(), entities: [] });
    this.entityMasks.length = 0;
    this.entityPositions.length = 0;
    this.matchCache.clear();
    this._version++;
  }

  private getOrCreate(mask: Mask): Archetype {
    const key = maskKey(mask);
    let archetype = this.archetypes.get(key);
    if (!archetype) {
      archetype = { mask: maskClone(mask), entities: [] };
      this.archetypes.set(key, archetype);
    }
    return archetype;
  }

  private addToArchetype(entityId: number, mask: Mask): void {
    const archetype = this.getOrCreate(mask);
    this.entityPositions[entityId] = archetype.entities.length;
    archetype.entities.push(entityId);
  }

  private removeFromArchetype(entityId: number, mask: Mask): void {
    const archetype = this.archetypes.get(maskKey(mask));
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
