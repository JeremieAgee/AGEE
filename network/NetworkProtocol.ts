import { BinaryWriter, BinaryReader } from "../core/serialization/BinaryBuffer";
import { ComponentDef, ComponentSchema } from "../ecs/Component";
import {
  MessageType,
  NETWORK_CONSTANTS,
  InputPayload,
  Snapshot,
  SnapshotEntry,
  DeltaSnapshot,
  DeltaEntry,
} from "./NetworkTypes";

export class ComponentRegistry {
  private defs: ComponentDef[] = [];
  private nameToIndex = new Map<string, number>();

  register(...defs: ComponentDef[]): void {
    for (const def of defs) {
      if (this.nameToIndex.has(def.name)) continue;
      const idx = this.defs.length;
      this.defs.push(def);
      this.nameToIndex.set(def.name, idx);
    }
  }

  getIndex(name: string): number {
    const idx = this.nameToIndex.get(name);
    if (idx === undefined) return -1;
    return idx;
  }

  getDef(index: number): ComponentDef | undefined {
    return this.defs[index];
  }

  get registeredDefs(): readonly ComponentDef[] {
    return this.defs;
  }

  getSerializableFields(def: ComponentDef): string[] {
    const fields: string[] = [];
    for (const [field, type] of Object.entries(def.schema)) {
      if (type !== "ref") fields.push(field);
    }
    return fields;
  }
}

function writeFieldValue(w: BinaryWriter, type: string, value: number): void {
  switch (type) {
    case "f32": w.writeF32(value); break;
    case "f64": w.writeF64(value); break;
    case "i32": w.writeI32(value); break;
    case "u8": case "bool": w.writeU8(value); break;
  }
}

function readFieldValue(r: BinaryReader, type: string): number {
  switch (type) {
    case "f32": return r.readF32();
    case "f64": return r.readF64();
    case "i32": return r.readI32();
    case "u8": case "bool": return r.readU8();
    default: return 0;
  }
}

export function writeMessageHeader(w: BinaryWriter, type: MessageType): void {
  w.writeU8(NETWORK_CONSTANTS.PROTOCOL_VERSION);
  w.writeU8(type);
}

export function readMessageHeader(r: BinaryReader): { version: number; type: MessageType } {
  return { version: r.readU8(), type: r.readU8() as MessageType };
}

// --- Connect / Ack ---

export function writeConnect(w: BinaryWriter): void {
  writeMessageHeader(w, MessageType.Connect);
}

export function writeConnectAck(w: BinaryWriter, clientId: number, tick: number): void {
  writeMessageHeader(w, MessageType.ConnectAck);
  w.writeI32(clientId);
  w.writeU32(tick);
}

export function readConnectAck(r: BinaryReader): { clientId: number; tick: number } {
  return { clientId: r.readI32(), tick: r.readU32() };
}

export function writeDisconnect(w: BinaryWriter): void {
  writeMessageHeader(w, MessageType.Disconnect);
}

// --- Ping / Pong ---

export function writePing(w: BinaryWriter, timestamp: number): void {
  writeMessageHeader(w, MessageType.Ping);
  w.writeF64(timestamp);
}

export function writePong(w: BinaryWriter, echoTimestamp: number): void {
  writeMessageHeader(w, MessageType.Pong);
  w.writeF64(echoTimestamp);
}

export function readPingPong(r: BinaryReader): number {
  return r.readF64();
}

// --- Input ---

export function writeInput(w: BinaryWriter, input: InputPayload): void {
  writeMessageHeader(w, MessageType.Input);
  w.writeU32(input.tick);
  w.writeI32(input.clientId);
  w.writeU16(input.actions.size);
  for (const [name, value] of input.actions) {
    w.writeString(name);
    w.writeF32(value);
  }
}

export function readInput(r: BinaryReader): InputPayload {
  const tick = r.readU32();
  const clientId = r.readI32();
  const count = r.readU16();
  const actions = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    actions.set(r.readString(), r.readF32());
  }
  return { tick, clientId, actions };
}

export function writeInputAck(w: BinaryWriter, tick: number): void {
  writeMessageHeader(w, MessageType.InputAck);
  w.writeU32(tick);
}

export function readInputAck(r: BinaryReader): number {
  return r.readU32();
}

// --- Full Snapshot ---

export function writeSnapshot(
  w: BinaryWriter,
  snapshot: Snapshot,
  registry: ComponentRegistry,
): void {
  writeMessageHeader(w, MessageType.Snapshot);
  w.writeU32(snapshot.tick);
  w.writeU16(snapshot.entries.length);

  for (const entry of snapshot.entries) {
    w.writeI32(entry.networkId);
    w.writeU8(entry.components.size);
    for (const [compName, fields] of entry.components) {
      const compIdx = registry.getIndex(compName);
      if (compIdx < 0) continue;
      const def = registry.getDef(compIdx)!;
      w.writeU8(compIdx);
      w.writeU8(fields.size);
      for (const [fieldName, value] of fields) {
        const type = def.schema[fieldName];
        if (!type || type === "ref") continue;
        w.writeString(fieldName);
        writeFieldValue(w, type, value);
      }
    }
  }
}

export function readSnapshot(r: BinaryReader, registry: ComponentRegistry): Snapshot {
  const tick = r.readU32();
  const entryCount = r.readU16();
  const entries: SnapshotEntry[] = [];

  for (let e = 0; e < entryCount; e++) {
    const networkId = r.readI32();
    const compCount = r.readU8();
    const components = new Map<string, Map<string, number>>();

    for (let c = 0; c < compCount; c++) {
      const compIdx = r.readU8();
      const fieldCount = r.readU8();
      const def = registry.getDef(compIdx);
      const fields = new Map<string, number>();

      for (let f = 0; f < fieldCount; f++) {
        const fieldName = r.readString();
        const type = def ? def.schema[fieldName] : "f32";
        fields.set(fieldName, readFieldValue(r, type || "f32"));
      }

      if (def) {
        components.set(def.name, fields);
      }
    }

    entries.push({ networkId, components });
  }

  return { tick, entries };
}

// --- Delta Snapshot ---

const DELTA_FLAG_SPAWNED = 1;
const DELTA_FLAG_DESPAWNED = 2;

export function writeDeltaSnapshot(
  w: BinaryWriter,
  delta: DeltaSnapshot,
  registry: ComponentRegistry,
): void {
  writeMessageHeader(w, MessageType.DeltaSnapshot);
  w.writeU32(delta.baseTick);
  w.writeU32(delta.tick);
  w.writeU16(delta.entries.length);

  for (const entry of delta.entries) {
    w.writeI32(entry.networkId);
    let flags = 0;
    if (entry.spawned) flags |= DELTA_FLAG_SPAWNED;
    if (entry.despawned) flags |= DELTA_FLAG_DESPAWNED;
    w.writeU8(flags);

    if (entry.despawned) continue;

    w.writeU8(entry.components.size);
    for (const [compName, fields] of entry.components) {
      const compIdx = registry.getIndex(compName);
      if (compIdx < 0) continue;
      const def = registry.getDef(compIdx)!;
      w.writeU8(compIdx);
      w.writeU8(fields.size);
      for (const [fieldName, value] of fields) {
        const type = def.schema[fieldName];
        if (!type || type === "ref") continue;
        w.writeString(fieldName);
        writeFieldValue(w, type, value);
      }
    }
  }
}

export function readDeltaSnapshot(r: BinaryReader, registry: ComponentRegistry): DeltaSnapshot {
  const baseTick = r.readU32();
  const tick = r.readU32();
  const entryCount = r.readU16();
  const entries: DeltaEntry[] = [];

  for (let e = 0; e < entryCount; e++) {
    const networkId = r.readI32();
    const flags = r.readU8();
    const spawned = (flags & DELTA_FLAG_SPAWNED) !== 0;
    const despawned = (flags & DELTA_FLAG_DESPAWNED) !== 0;
    const components = new Map<string, Map<string, number>>();

    if (!despawned) {
      const compCount = r.readU8();
      for (let c = 0; c < compCount; c++) {
        const compIdx = r.readU8();
        const fieldCount = r.readU8();
        const def = registry.getDef(compIdx);
        const fields = new Map<string, number>();

        for (let f = 0; f < fieldCount; f++) {
          const fieldName = r.readString();
          const type = def ? def.schema[fieldName] : "f32";
          fields.set(fieldName, readFieldValue(r, type || "f32"));
        }

        if (def) {
          components.set(def.name, fields);
        }
      }
    }

    entries.push({ networkId, spawned, despawned, components });
  }

  return { baseTick, tick, entries };
}
