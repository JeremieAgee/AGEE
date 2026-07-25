import { World } from "../ecs";
import { ComponentDef } from "../ecs/Component";
import { ComponentStore } from "../ecs/ComponentStore";
import { ComponentRegistry } from "./NetworkProtocol";
import { Replicated } from "./NetworkComponents";
import {
  NETWORK_CONSTANTS,
  Snapshot,
  SnapshotEntry,
  DeltaSnapshot,
  DeltaEntry,
} from "./NetworkTypes";

export class SnapshotManager {
  private world: World;
  private registry: ComponentRegistry;
  private buffer: (Snapshot | null)[];
  private bufferHead = 0;
  private replicatedDefs: ComponentDef[] = [];

  constructor(world: World, registry: ComponentRegistry) {
    this.world = world;
    this.registry = registry;
    this.buffer = new Array(NETWORK_CONSTANTS.SNAPSHOT_BUFFER_SIZE).fill(null);
  }

  registerReplicatedComponents(...defs: ComponentDef[]): void {
    for (const def of defs) {
      if (!this.replicatedDefs.find(d => d.name === def.name)) {
        this.replicatedDefs.push(def);
        this.registry.register(def);
      }
    }
  }

  captureSnapshot(tick: number): Snapshot {
    const replStore = this.world.getStore(Replicated);
    const entries: SnapshotEntry[] = [];
    const replEntities = replStore.entities;

    const words = replEntities.rawWords;
    const wordCount = replEntities.rawWordCount;

    for (let w = 0; w < wordCount; w++) {
      let word = words[w];
      while (word !== 0) {
        const lsb = word & (-word);
        const bitIndex = 31 - Math.clz32(lsb);
        const eid = (w << 5) + bitIndex;
        word &= word - 1;

        const networkId = replStore.get(eid, "networkId") as number;
        if (networkId === NETWORK_CONSTANTS.INVALID_NETWORK_ID) continue;

        const components = new Map<string, Map<string, number>>();

        for (const def of this.replicatedDefs) {
          const store = this.world.getStore(def);
          if (!store.has(eid)) continue;

          const fields = new Map<string, number>();
          for (const [fieldName, fieldType] of Object.entries(def.schema)) {
            if (fieldType === "ref") continue;
            fields.set(fieldName, store.get(eid, fieldName) as number);
          }
          if (fields.size > 0) {
            components.set(def.name, fields);
          }
        }

        entries.push({ networkId, components });
      }
    }

    return { tick, entries };
  }

  storeSnapshot(snapshot: Snapshot): void {
    this.buffer[this.bufferHead] = snapshot;
    this.bufferHead = (this.bufferHead + 1) % this.buffer.length;
  }

  getSnapshot(tick: number): Snapshot | null {
    for (let i = 0; i < this.buffer.length; i++) {
      const s = this.buffer[i];
      if (s && s.tick === tick) return s;
    }
    return null;
  }

  getLatestSnapshot(): Snapshot | null {
    let latest: Snapshot | null = null;
    for (let i = 0; i < this.buffer.length; i++) {
      const s = this.buffer[i];
      if (s && (latest === null || s.tick > latest.tick)) {
        latest = s;
      }
    }
    return latest;
  }

  createDelta(current: Snapshot, baseline: Snapshot): DeltaSnapshot {
    const baseMap = new Map<number, SnapshotEntry>();
    for (const entry of baseline.entries) {
      baseMap.set(entry.networkId, entry);
    }

    const entries: DeltaEntry[] = [];

    for (const curr of current.entries) {
      const base = baseMap.get(curr.networkId);

      if (!base) {
        entries.push({
          networkId: curr.networkId,
          spawned: true,
          despawned: false,
          components: curr.components,
        });
        continue;
      }

      const changedComponents = new Map<string, Map<string, number>>();
      let hasChanges = false;

      for (const [compName, currFields] of curr.components) {
        const baseFields = base.components.get(compName);
        const changed = new Map<string, number>();

        for (const [fieldName, currVal] of currFields) {
          const baseVal = baseFields?.get(fieldName);
          if (baseVal === undefined || Math.abs(currVal - baseVal) > NETWORK_CONSTANTS.POSITION_EPSILON) {
            changed.set(fieldName, currVal);
          }
        }

        if (changed.size > 0) {
          changedComponents.set(compName, changed);
          hasChanges = true;
        }
      }

      if (hasChanges) {
        entries.push({
          networkId: curr.networkId,
          spawned: false,
          despawned: false,
          components: changedComponents,
        });
      }

      baseMap.delete(curr.networkId);
    }

    for (const [networkId] of baseMap) {
      entries.push({
        networkId,
        spawned: false,
        despawned: true,
        components: new Map(),
      });
    }

    return { baseTick: baseline.tick, tick: current.tick, entries };
  }

  applyDelta(base: Snapshot, delta: DeltaSnapshot): Snapshot {
    const entryMap = new Map<number, SnapshotEntry>();
    for (const entry of base.entries) {
      entryMap.set(entry.networkId, {
        networkId: entry.networkId,
        components: new Map(
          Array.from(entry.components.entries()).map(
            ([k, v]) => [k, new Map(v)] as [string, Map<string, number>]
          )
        ),
      });
    }

    for (const de of delta.entries) {
      if (de.despawned) {
        entryMap.delete(de.networkId);
        continue;
      }

      if (de.spawned) {
        entryMap.set(de.networkId, {
          networkId: de.networkId,
          components: de.components,
        });
        continue;
      }

      const existing = entryMap.get(de.networkId);
      if (!existing) continue;

      for (const [compName, deltaFields] of de.components) {
        let fields = existing.components.get(compName);
        if (!fields) {
          fields = new Map();
          existing.components.set(compName, fields);
        }
        for (const [fieldName, value] of deltaFields) {
          fields.set(fieldName, value);
        }
      }
    }

    return { tick: delta.tick, entries: Array.from(entryMap.values()) };
  }

  applySnapshotToWorld(
    snapshot: Snapshot,
    networkIdToEntity: Map<number, number>,
  ): { spawns: SnapshotEntry[]; despawns: number[] } {
    const spawns: SnapshotEntry[] = [];
    const seenIds = new Set<number>();

    for (const entry of snapshot.entries) {
      seenIds.add(entry.networkId);
      const eid = networkIdToEntity.get(entry.networkId);

      if (eid === undefined) {
        spawns.push(entry);
        continue;
      }

      for (const [compName, fields] of entry.components) {
        const def = this.replicatedDefs.find(d => d.name === compName);
        if (!def) continue;
        const store = this.world.getStore(def);
        if (!store.has(eid)) continue;

        for (const [fieldName, value] of fields) {
          store.set(eid, fieldName, value);
        }
      }
    }

    const despawns: number[] = [];
    for (const [networkId] of networkIdToEntity) {
      if (!seenIds.has(networkId)) {
        despawns.push(networkId);
      }
    }

    return { spawns, despawns };
  }
}
