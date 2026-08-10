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

  // AUDIT (documented, not fixed — see review): both getRelevantEntities() and
  // filterSnapshot() below are O(clients x entities) per server tick — every connected
  // client re-scans every replicated entity with no spatial index. That's a real scaling
  // ceiling once MAX_CLIENTS (see NetworkTypes.ts) is actually enforced (NetworkManager/
  // NetworkSendSystem.addClient()) and a scene has a non-trivial entity count. A proper fix is
  // a spatial index (e.g. a uniform grid keyed by relevanceRadius-sized cells, or a quadtree/
  // BVH) built once per tick from replicatedQuery.entities, then queried per client for just
  // the cells within relevanceRadius — turning this into roughly O(entities + clients x
  // local_density) instead of O(clients x entities). That's a larger structural change
  // (rebuild-on-move bookkeeping, cell sizing, correctness across the radius boundary) that's
  // out of scope for this pass; the two micro-optimizations below (skipping the
  // alwaysRelevant Set lookup entirely when it's empty, the overwhelmingly common case) are
  // low-risk, bounded, and don't change the algorithm's complexity class.
  private hasAlwaysRelevant(): boolean {
    return this.alwaysRelevant.size > 0;
  }

  getRelevantEntities(
    clientPos: { x: number; y: number; z: number },
  ): number[] {
    const tx = this.transformStore.getColumn("x") as Float32Array;
    const ty = this.transformStore.getColumn("y") as Float32Array;
    const tz = this.transformStore.getColumn("z") as Float32Array;
    const netIds = this.replicatedStore.getColumn("networkId") as Int32Array;
    const checkAlwaysRelevant = this.hasAlwaysRelevant();

    const result: number[] = [];

    for (const eid of this.replicatedQuery.entities) {
      if (checkAlwaysRelevant && this.alwaysRelevant.has(netIds[eid])) {
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
    const checkAlwaysRelevant = this.hasAlwaysRelevant();

    const filtered: SnapshotEntry[] = [];

    for (const entry of snapshot.entries) {
      if (checkAlwaysRelevant && this.alwaysRelevant.has(entry.networkId)) {
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
