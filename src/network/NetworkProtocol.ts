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

// Mirrors ComponentRegistry's name<->index scheme, but for input action names. Input messages
// are the highest-frequency message in the protocol (sent every client tick), and previously
// re-sent each action's full name as a length-prefixed string every single time — this maps
// each name to a small integer once (register() at connect/setup time on both ends) so the
// wire only ever carries a 1-byte index per action instead of "move" (4 chars = 8 bytes with
// its length prefix) or longer names.
export class ActionRegistry {
  private names: string[] = [];
  private nameToIndex = new Map<string, number>();

  register(...names: string[]): void {
    for (const name of names) {
      if (this.nameToIndex.has(name)) continue;
      this.nameToIndex.set(name, this.names.length);
      this.names.push(name);
    }
  }

  getIndex(name: string): number {
    return this.nameToIndex.get(name) ?? -1;
  }

  getName(index: number): string | undefined {
    return this.names[index];
  }
}

export class ComponentRegistry {
  private defs: ComponentDef[] = [];
  private nameToIndex = new Map<string, number>();

  // AUDIT FIX (allocation pressure in the decode hot path): getSerializableFields() only
  // depends on `def` (fixed once a component is registered), but was previously recomputed --
  // allocating a fresh array -- on every single call, including once per component per entity
  // for every Snapshot/DeltaSnapshot read and write. Under a sustained stream of dense messages
  // that's a lot of steady-state garbage for a value that never changes after registration.
  // Cached by def reference (a WeakMap costs nothing extra once defs are GC'd, and avoids ever
  // returning a stale array for a def that gets re-registered under the same name). The
  // returned array is never mutated by callers (only read via indexOf/index access), so sharing
  // one instance across calls is safe.
  private serializableFieldsCache = new WeakMap<ComponentDef, string[]>();

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
    const cached = this.serializableFieldsCache.get(def);
    if (cached) return cached;

    const fields: string[] = [];
    for (const [field, type] of Object.entries(def.schema)) {
      if (type !== "ref") fields.push(field);
    }
    this.serializableFieldsCache.set(def, fields);
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

// Fields quantized to a fixed-point 16-bit representation on the wire, both in a full Snapshot
// and in a DeltaSnapshot (positions/rotations dominate bandwidth in both — deltas only carry
// *changed* fields, but those changed fields are still overwhelmingly position/rotation on
// every moving entity, so they were in practice the main steady-state traffic this quantization
// was meant to reduce; carrying them at full f32 precision left that saving mostly unused).
const QUANTIZED_FIELD_NAMES = new Set(["x", "y", "z", "rx", "ry", "rz"]);
const QUANTIZE_SCALE = 100; // fixed-point precision: 1/100 of a unit per step
const QUANTIZE_MIN = -32768;
const QUANTIZE_MAX = 32767;

// Fires at most once per process: a quantized field silently clamping to ±327.67 world units
// is a real, hard-to-diagnose corruption (an entity's replicated position visibly stuck at the
// world's edge) — this at least surfaces it once instead of leaving it invisible.
let quantizeClampWarned = false;

function quantize(value: number): number {
  const q = Math.round(value * QUANTIZE_SCALE);
  if ((q < QUANTIZE_MIN || q > QUANTIZE_MAX) && !quantizeClampWarned) {
    quantizeClampWarned = true;
    console.warn(
      `[Network] Quantized field value ${value} is outside the representable range ` +
      `(±${QUANTIZE_MAX / QUANTIZE_SCALE} world units) and is being clamped — positions this ` +
      `far out will replicate incorrectly. This warning only fires once per process.`
    );
  }
  return Math.max(QUANTIZE_MIN, Math.min(QUANTIZE_MAX, q));
}

function writeQuantizedField(w: BinaryWriter, value: number): void {
  const q = quantize(value);
  w.writeU16(q < 0 ? q + 0x10000 : q);
}

function readQuantizedField(r: BinaryReader): number {
  let v = r.readU16();
  if (v & 0x8000) v -= 0x10000;
  return v / QUANTIZE_SCALE;
}

export function writeMessageHeader(w: BinaryWriter, type: MessageType): void {
  w.writeU8(NETWORK_CONSTANTS.PROTOCOL_VERSION);
  w.writeU8(type);
}

export function readMessageHeader(r: BinaryReader): { version: number; type: MessageType } {
  return { version: r.readU8(), type: r.readU8() as MessageType };
}

// --- Connect / Ack ---

// `token` carries whatever credential the host game wants to authenticate a connecting
// client with (session token, signed JWT, etc) — the wire format is opaque UTF-8 text; AGEE
// itself doesn't interpret it, it just gets it from client to server so NetworkManager's
// auth validator hook (see setAuthValidator()) has something to check.
export function writeConnect(w: BinaryWriter, token: string = ""): void {
  writeMessageHeader(w, MessageType.Connect);
  w.writeString(token);
}

export function readConnect(r: BinaryReader): { token: string } {
  return { token: r.readString() };
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

export function writeInput(w: BinaryWriter, input: InputPayload, actions: ActionRegistry): void {
  writeMessageHeader(w, MessageType.Input);
  w.writeU32(input.tick);
  w.writeI32(input.clientId);

  // Unregistered action names can't be represented as an index — drop them (with a warning)
  // rather than silently corrupting the wire format for every action after them.
  const writable: Array<[number, number]> = [];
  for (const [name, value] of input.actions) {
    const idx = actions.getIndex(name);
    if (idx < 0) {
      console.warn(`[Network] Input action "${name}" is not registered with ActionRegistry; dropping it from this message`);
      continue;
    }
    writable.push([idx, value]);
  }

  w.writeU16(writable.length);
  for (const [idx, value] of writable) {
    w.writeU8(idx);
    w.writeF32(value);
  }
}

export function readInput(r: BinaryReader, actions: ActionRegistry): InputPayload {
  const tick = r.readU32();
  const clientId = r.readI32();
  const count = r.readU16();
  const parsed = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const idx = r.readU8();
    const value = r.readF32();
    const name = actions.getName(idx);
    if (name) parsed.set(name, value);
  }
  return { tick, clientId, actions: parsed };
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
      const fieldOrder = registry.getSerializableFields(def);
      w.writeU8(compIdx);
      w.writeU8(fields.size);
      for (const [fieldName, value] of fields) {
        const type = def.schema[fieldName];
        if (!type || type === "ref") continue;
        const fieldIdx = fieldOrder.indexOf(fieldName);
        w.writeU8(fieldIdx);
        if (QUANTIZED_FIELD_NAMES.has(fieldName)) {
          writeQuantizedField(w, value);
        } else {
          writeFieldValue(w, type, value);
        }
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
      const fieldOrder = def ? registry.getSerializableFields(def) : [];
      const fields = new Map<string, number>();

      for (let f = 0; f < fieldCount; f++) {
        const fieldIdx = r.readU8();
        const fieldName = fieldOrder[fieldIdx];
        if (fieldName && QUANTIZED_FIELD_NAMES.has(fieldName)) {
          const value = readQuantizedField(r);
          fields.set(fieldName, value);
        } else {
          const type = fieldName && def ? def.schema[fieldName] : "f32";
          const value = readFieldValue(r, type || "f32");
          if (fieldName) fields.set(fieldName, value);
        }
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
      const fieldOrder = registry.getSerializableFields(def);
      w.writeU8(compIdx);
      w.writeU8(fields.size);
      for (const [fieldName, value] of fields) {
        const type = def.schema[fieldName];
        if (!type || type === "ref") continue;
        const fieldIdx = fieldOrder.indexOf(fieldName);
        w.writeU8(fieldIdx);
        if (QUANTIZED_FIELD_NAMES.has(fieldName)) {
          writeQuantizedField(w, value);
        } else {
          writeFieldValue(w, type, value);
        }
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
        const fieldOrder = def ? registry.getSerializableFields(def) : [];
        const fields = new Map<string, number>();

        for (let f = 0; f < fieldCount; f++) {
          const fieldIdx = r.readU8();
          const fieldName = fieldOrder[fieldIdx];
          if (fieldName && QUANTIZED_FIELD_NAMES.has(fieldName)) {
            fields.set(fieldName, readQuantizedField(r));
          } else {
            const type = fieldName && def ? def.schema[fieldName] : "f32";
            const value = readFieldValue(r, type || "f32");
            if (fieldName) fields.set(fieldName, value);
          }
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
