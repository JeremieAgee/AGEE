import { World } from "../ecs";
import { Query } from "../ecs/Query";
import { ComponentStore } from "../ecs/ComponentStore";
import { Transform } from "../core/Components";
import { Replicated } from "./NetworkComponents";
import { NETWORK_CONSTANTS, Snapshot, SnapshotEntry } from "./NetworkTypes";

export class InterestManager {
  private world: World;
  private transformStore!: ComponentStore;
  private replicatedStore!: ComponentStore;
  private replicatedQuery!: Query;
  private _relevanceRadius: number;
  private _relevanceRadiusSq: number;
  private alwaysRelevant = new Set<number>();

  constructor(world: World, relevanceRadius: number = NETWORK_CONSTANTS.DEFAULT_RELEVANCE_RADIUS) {
    this.world = world;
    this._relevanceRadius = relevanceRadius;
    this._relevanceRadiusSq = relevanceRadius * relevanceRadius;
  }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
    this.replicatedStore = this.world.getStore(Replicated);
    this.replicatedQuery = this.world.query(Replicated, Transform);
  }

  set relevanceRadius(r: number) {
    this._relevanceRadius = r;
    this._relevanceRadiusSq = r * r;
  }

  get relevanceRadius(): number { return this._relevanceRadius; }

  addAlwaysRelevant(networkId: number): void {
    this.alwaysRelevant.add(networkId);
  }

  removeAlwaysRelevant(networkId: number): void {
    this.alwaysRelevant.delete(networkId);
  }

  getRelevantEntities(
    clientPos: { x: number; y: number; z: number },
  ): number[] {
    const tx = this.transformStore.getColumn("x") as Float32Array;
    const ty = this.transformStore.getColumn("y") as Float32Array;
    const tz = this.transformStore.getColumn("z") as Float32Array;
    const netIds = this.replicatedStore.getColumn("networkId") as Int32Array;

    const result: number[] = [];

    for (const eid of this.replicatedQuery.entities) {
      const nid = netIds[eid];
      if (this.alwaysRelevant.has(nid)) {
        result.push(eid);
        continue;
      }

      const dx = tx[eid] - clientPos.x;
      const dy = ty[eid] - clientPos.y;
      const dz = tz[eid] - clientPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq <= this._relevanceRadiusSq) {
        result.push(eid);
      }
    }

    return result;
  }

  filterSnapshot(
    snapshot: Snapshot,
    clientPos: { x: number; y: number; z: number },
    networkIdToEntity: Map<number, number>,
  ): Snapshot {
    const tx = this.transformStore.getColumn("x") as Float32Array;
    const ty = this.transformStore.getColumn("y") as Float32Array;
    const tz = this.transformStore.getColumn("z") as Float32Array;

    const filtered: SnapshotEntry[] = [];

    for (const entry of snapshot.entries) {
      if (this.alwaysRelevant.has(entry.networkId)) {
        filtered.push(entry);
        continue;
      }

      const eid = networkIdToEntity.get(entry.networkId);
      if (eid === undefined) continue;

      const dx = tx[eid] - clientPos.x;
      const dy = ty[eid] - clientPos.y;
      const dz = tz[eid] - clientPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq <= this._relevanceRadiusSq) {
        filtered.push(entry);
      }
    }

    return { tick: snapshot.tick, entries: filtered };
  }
}
