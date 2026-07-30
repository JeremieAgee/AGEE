import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { World } from "../ecs/World";
import { defineComponent } from "../ecs/Component";
import { Transform, Velocity } from "../core/Components";
import { BinaryWriter, BinaryReader } from "../core/serialization/BinaryBuffer";

import { Replicated, NetworkOwner, NetworkInterpolated } from "../network/NetworkComponents";
import {
  ComponentRegistry,
  writeMessageHeader,
  readMessageHeader,
  writeConnectAck,
  readConnectAck,
  writePing,
  writePong,
  readPingPong,
  writeInput,
  readInput,
  writeInputAck,
  readInputAck,
  writeSnapshot,
  readSnapshot,
  writeDeltaSnapshot,
  readDeltaSnapshot,
} from "../network/NetworkProtocol";
import {
  MessageType,
  NETWORK_CONSTANTS,
  ConnectionState,
  InputPayload,
  Snapshot,
  DeltaSnapshot,
} from "../network/NetworkTypes";
import { SnapshotManager } from "../network/SnapshotManager";
import { InterestManager } from "../network/InterestManager";
import { InputBuffer } from "../network/InputBuffer";
import { Transport, TransportEvent } from "../network/transport/Transport";
import { LoopbackTransport } from "../network/transport/LoopbackTransport";
import { WebSocketTransport } from "../network/transport/WebSocketTransport";
import { NetworkSendSystem } from "../network/NetworkSendSystem";
import { NetworkReceiveSystem } from "../network/NetworkReceiveSystem";
import { NetworkManager } from "../network/NetworkManager";

// ---------------------------------------------------------------------------
// ComponentRegistry
// ---------------------------------------------------------------------------

describe("ComponentRegistry", () => {
  it("registers defs and returns stable indices", () => {
    const registry = new ComponentRegistry();
    registry.register(Transform, Velocity);
    expect(registry.getIndex("Transform")).toBe(0);
    expect(registry.getIndex("Velocity")).toBe(1);
    expect(registry.getDef(0)).toBe(Transform);
    expect(registry.getDef(1)).toBe(Velocity);
  });

  it("ignores duplicate registrations of the same component name", () => {
    const registry = new ComponentRegistry();
    registry.register(Transform);
    registry.register(Transform);
    expect(registry.registeredDefs.length).toBe(1);
  });

  it("getIndex returns -1 for an unregistered component", () => {
    const registry = new ComponentRegistry();
    expect(registry.getIndex("DoesNotExist")).toBe(-1);
  });

  it("getSerializableFields excludes ref-typed fields", () => {
    const registry = new ComponentRegistry();
    const WithRef = defineComponent("WithRef_Net", { x: "f32", parent: "ref" });
    const fields = registry.getSerializableFields(WithRef);
    expect(fields).toEqual(["x"]);
  });
});

// ---------------------------------------------------------------------------
// NetworkProtocol — encode/decode round trips
// ---------------------------------------------------------------------------

describe("NetworkProtocol — round trips", () => {
  it("message header round trip", () => {
    const w = new BinaryWriter(8);
    writeMessageHeader(w, MessageType.Ping);
    const r = new BinaryReader(w.toArrayBuffer());
    const header = readMessageHeader(r);
    expect(header.version).toBe(NETWORK_CONSTANTS.PROTOCOL_VERSION);
    expect(header.type).toBe(MessageType.Ping);
  });

  it("ConnectAck round trip", () => {
    const w = new BinaryWriter(16);
    writeConnectAck(w, 7, 123);
    const r = new BinaryReader(w.toArrayBuffer());
    readMessageHeader(r);
    const ack = readConnectAck(r);
    expect(ack.clientId).toBe(7);
    expect(ack.tick).toBe(123);
  });

  it("Ping/Pong timestamp round trip", () => {
    const w1 = new BinaryWriter(16);
    writePing(w1, 555.5);
    const r1 = new BinaryReader(w1.toArrayBuffer());
    readMessageHeader(r1);
    expect(readPingPong(r1)).toBeCloseTo(555.5);

    const w2 = new BinaryWriter(16);
    writePong(w2, 555.5);
    const r2 = new BinaryReader(w2.toArrayBuffer());
    readMessageHeader(r2);
    expect(readPingPong(r2)).toBeCloseTo(555.5);
  });

  it("Input message round trip preserves tick, clientId and action map", () => {
    const actions = new Map<string, number>([["moveX", 0.75], ["jump", 1]]);
    const input: InputPayload = { tick: 42, clientId: 3, actions };

    const w = new BinaryWriter(64);
    writeInput(w, input);
    const r = new BinaryReader(w.toArrayBuffer());
    readMessageHeader(r);
    const decoded = readInput(r);

    expect(decoded.tick).toBe(42);
    expect(decoded.clientId).toBe(3);
    expect(decoded.actions.get("moveX")).toBeCloseTo(0.75);
    expect(decoded.actions.get("jump")).toBe(1);
  });

  it("InputAck round trip", () => {
    const w = new BinaryWriter(16);
    writeInputAck(w, 88);
    const r = new BinaryReader(w.toArrayBuffer());
    readMessageHeader(r);
    expect(readInputAck(r)).toBe(88);
  });

  it("Snapshot round trip preserves entries and component fields", () => {
    const registry = new ComponentRegistry();
    registry.register(Transform, Replicated);

    const snapshot: Snapshot = {
      tick: 10,
      entries: [
        {
          networkId: 5,
          components: new Map([
            ["Transform", new Map<string, number>([["x", 1.5], ["y", -2.25], ["z", 0]])],
          ]),
        },
      ],
    };

    const w = new BinaryWriter(256);
    writeSnapshot(w, snapshot, registry);
    const r = new BinaryReader(w.toArrayBuffer());
    readMessageHeader(r);
    const decoded = readSnapshot(r, registry);

    expect(decoded.tick).toBe(10);
    expect(decoded.entries.length).toBe(1);
    expect(decoded.entries[0].networkId).toBe(5);
    const tf = decoded.entries[0].components.get("Transform")!;
    expect(tf.get("x")).toBeCloseTo(1.5);
    expect(tf.get("y")).toBeCloseTo(-2.25);
  });

  it("DeltaSnapshot round trip preserves spawn, despawn and changed-field entries", () => {
    const registry = new ComponentRegistry();
    registry.register(Transform, Replicated);

    const delta: DeltaSnapshot = {
      baseTick: 1,
      tick: 2,
      entries: [
        { networkId: 1, spawned: true, despawned: false, components: new Map([["Transform", new Map([["x", 5]])]]) },
        { networkId: 2, spawned: false, despawned: true, components: new Map() },
        { networkId: 3, spawned: false, despawned: false, components: new Map([["Transform", new Map([["y", 9]])]]) },
      ],
    };

    const w = new BinaryWriter(256);
    writeDeltaSnapshot(w, delta, registry);
    const r = new BinaryReader(w.toArrayBuffer());
    readMessageHeader(r);
    const decoded = readDeltaSnapshot(r, registry);

    expect(decoded.baseTick).toBe(1);
    expect(decoded.tick).toBe(2);
    expect(decoded.entries.length).toBe(3);
    expect(decoded.entries[0].spawned).toBe(true);
    expect(decoded.entries[1].despawned).toBe(true);
    expect(decoded.entries[2].components.get("Transform")!.get("y")).toBeCloseTo(9);
  });

  // AUDIT: the wire format re-sends the full field name as a length-prefixed string for every
  // changed field on every tick instead of a fixed per-component field index, wasting bandwidth
  // proportional to the number of fields changed per tick — see NetworkProtocol.ts:240-244
  // (writeDeltaSnapshot) and NetworkProtocol.ts:166-170 (writeSnapshot).
  it("delta snapshot should encode a changed field using a fixed per-component index, not its full name", () => {
    const registry = new ComponentRegistry();
    registry.register(Transform, Replicated);

    const delta: DeltaSnapshot = {
      baseTick: 0,
      tick: 1,
      entries: [
        { networkId: 1, spawned: false, despawned: false, components: new Map([["Transform", new Map([["x", 1]])]]) },
      ],
    };

    const w = new BinaryWriter(64);
    writeDeltaSnapshot(w, delta, registry);

    // Correct/expected wire cost for one changed f32 field:
    // header(2) + baseTick(4) + tick(4) + entryCount(2) + networkId(4) + flags(1) +
    // compCount(1) + compIdx(1) + fieldCount(1) + fieldIndex(1, fixed index) + value(4) = 25.
    // Actual encoding instead spends 4-byte length prefix + 1 char ("x") = 5 bytes on the
    // field *name* where a fixed 1-byte index would do, inflating this to 29 bytes.
    expect(w.size).toBe(25);
  });

  // AUDIT: positions/rotations are sent as raw 32-bit floats with no quantization at all —
  // see NetworkProtocol.ts:49-56 (writeFieldValue always writes f32 as 4 raw bytes).
  it("position fields should be quantized rather than sent as raw 32-bit floats", () => {
    const registry = new ComponentRegistry();
    registry.register(Transform, Replicated);

    const snapshot: Snapshot = {
      tick: 0,
      entries: [
        {
          networkId: 1,
          components: new Map([
            ["Transform", new Map<string, number>([["x", 100], ["y", 200], ["z", 300]])],
          ]),
        },
      ],
    };

    const w = new BinaryWriter(128);
    writeSnapshot(w, snapshot, registry);

    // Fixed per-message overhead up to (but excluding) the field payloads:
    // header(2)+tick(4)+entryCount(2)+networkId(4)+compCount(1)+compIdx(1)+fieldCount(1) = 15.
    const fixedOverhead = 15;
    // Correct/expected per-field cost with a fixed index + 16-bit quantized value: 1 + 2 = 3
    // bytes, for 3 fields = 9 bytes total => ideal message size of 24 bytes.
    const idealFieldBytes = 3 * (1 + 2);
    expect(w.size).toBe(fixedOverhead + idealFieldBytes);
  });
});

// ---------------------------------------------------------------------------
// SnapshotManager
// ---------------------------------------------------------------------------

describe("SnapshotManager", () => {
  it("captureSnapshot includes only entities with a valid (non-zero) networkId", () => {
    const world = new World();
    const registry = new ComponentRegistry();
    registry.register(Transform, Replicated);
    const snapshotManager = new SnapshotManager(world, registry);
    snapshotManager.registerReplicatedComponents(Transform);

    const valid = world.createEntity();
    world.addComponent(valid, Replicated, { networkId: 1, owner: -1, priority: 1, lastSyncTick: 0 });
    world.addComponent(valid, Transform, { x: 1, y: 2, z: 3 });

    const invalid = world.createEntity();
    world.addComponent(invalid, Replicated, { networkId: 0, owner: -1, priority: 1, lastSyncTick: 0 });
    world.addComponent(invalid, Transform, { x: 9, y: 9, z: 9 });

    const snapshot = snapshotManager.captureSnapshot(5);
    expect(snapshot.tick).toBe(5);
    expect(snapshot.entries.length).toBe(1);
    expect(snapshot.entries[0].networkId).toBe(1);
    expect(snapshot.entries[0].components.get("Transform")!.get("x")).toBe(1);
  });

  it("storeSnapshot/getSnapshot round trip by tick, unknown tick returns null", () => {
    const world = new World();
    const registry = new ComponentRegistry();
    const snapshotManager = new SnapshotManager(world, registry);
    const snap: Snapshot = { tick: 42, entries: [] };
    snapshotManager.storeSnapshot(snap);
    expect(snapshotManager.getSnapshot(42)).toBe(snap);
    expect(snapshotManager.getSnapshot(999)).toBeNull();
  });

  it("createDelta + applyDelta round trip reproduces spawns, despawns and field changes", () => {
    const base: Snapshot = {
      tick: 1,
      entries: [
        { networkId: 1, components: new Map([["Transform", new Map([["x", 0]])]]) },
        { networkId: 2, components: new Map([["Transform", new Map([["x", 50]])]]) },
      ],
    };
    const current: Snapshot = {
      tick: 2,
      entries: [
        { networkId: 1, components: new Map([["Transform", new Map([["x", 10]])]]) }, // moved
        { networkId: 3, components: new Map([["Transform", new Map([["x", 99]])]]) }, // spawned
        // networkId 2 is absent from `current` -> should be despawned
      ],
    };

    const world = new World();
    const registry = new ComponentRegistry();
    const snapshotManager = new SnapshotManager(world, registry);

    const delta = snapshotManager.createDelta(current, base);
    const rebuilt = snapshotManager.applyDelta(base, delta);
    const byId = new Map(rebuilt.entries.map((e) => [e.networkId, e]));

    expect(byId.has(2)).toBe(false);
    expect(byId.get(1)!.components.get("Transform")!.get("x")).toBe(10);
    expect(byId.get(3)!.components.get("Transform")!.get("x")).toBe(99);
  });

  it("applySnapshotToWorld detects spawns and despawns under normal (non-lossy) conditions", () => {
    const world = new World();
    const registry = new ComponentRegistry();
    registry.register(Transform, Replicated);
    const snapshotManager = new SnapshotManager(world, registry);
    snapshotManager.registerReplicatedComponents(Transform);

    const networkIdToEntity = new Map<number, number>([[1, 100], [2, 101]]);
    const snapshot: Snapshot = {
      tick: 1,
      entries: [
        { networkId: 1, components: new Map() }, // known -> stays
        { networkId: 3, components: new Map() }, // unknown -> spawn
        // networkId 2 missing -> despawn
      ],
    };

    const { spawns, despawns } = snapshotManager.applySnapshotToWorld(snapshot, networkIdToEntity);
    expect(spawns.map((s) => s.networkId)).toEqual([3]);
    expect(despawns).toEqual([2]);
  });

  // AUDIT: NetworkReceiveSystem falls back to an empty snapshot (`{ tick, entries: [] }`) when
  // it can't find the baseline a delta references (snapshotManager.getSnapshot(delta.baseTick)
  // misses) — see NetworkReceiveSystem.ts:211-214. That empty snapshot is then fed into
  // applySnapshotToWorld below, whose despawn logic treats "not present in this snapshot" as
  // "despawned", so a single missed baseline mass-destroys every entity the client currently
  // knows about, with no NACK/resync message type available to recover gracefully.
  // See SnapshotManager.ts:240-245.
  it("an empty fallback snapshot should not despawn every currently-known entity", () => {
    const world = new World();
    const registry = new ComponentRegistry();
    const snapshotManager = new SnapshotManager(world, registry);

    const networkIdToEntity = new Map<number, number>([[1, 100], [2, 101], [3, 102]]);
    const emptyFallbackSnapshot: Snapshot = { tick: 99, entries: [] };

    const { despawns } = snapshotManager.applySnapshotToWorld(emptyFallbackSnapshot, networkIdToEntity);

    // Correct/expected behavior: not knowing what changed is not proof that everything
    // disappeared — nothing should be despawned when the snapshot is empty because of a
    // decoding fallback rather than genuine server-authoritative state.
    expect(despawns.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// InterestManager — radius boundary behavior
// ---------------------------------------------------------------------------

describe("InterestManager", () => {
  function setup(radius: number) {
    const world = new World();
    const im = new InterestManager(world, radius);
    im.init();
    return { world, im };
  }

  it("includes an entity exactly at the boundary radius (inclusive)", () => {
    const { world, im } = setup(10);
    const eid = world.createEntity();
    world.addComponent(eid, Replicated, { networkId: 1, owner: -1, priority: 1, lastSyncTick: 0 });
    world.addComponent(eid, Transform, { x: 10, y: 0, z: 0 });

    const relevant = im.getRelevantEntities({ x: 0, y: 0, z: 0 });
    expect(relevant).toContain(eid);
  });

  it("excludes an entity just outside the boundary radius", () => {
    const { world, im } = setup(10);
    const eid = world.createEntity();
    world.addComponent(eid, Replicated, { networkId: 1, owner: -1, priority: 1, lastSyncTick: 0 });
    world.addComponent(eid, Transform, { x: 10.01, y: 0, z: 0 });

    const relevant = im.getRelevantEntities({ x: 0, y: 0, z: 0 });
    expect(relevant).not.toContain(eid);
  });

  it("always-relevant entities are included regardless of distance", () => {
    const { world, im } = setup(5);
    const eid = world.createEntity();
    world.addComponent(eid, Replicated, { networkId: 99, owner: -1, priority: 1, lastSyncTick: 0 });
    world.addComponent(eid, Transform, { x: 1000, y: 0, z: 0 });
    im.addAlwaysRelevant(99);

    const relevant = im.getRelevantEntities({ x: 0, y: 0, z: 0 });
    expect(relevant).toContain(eid);

    im.removeAlwaysRelevant(99);
    expect(im.getRelevantEntities({ x: 0, y: 0, z: 0 })).not.toContain(eid);
  });

  it("filterSnapshot mirrors getRelevantEntities against a Snapshot payload", () => {
    const { world, im } = setup(10);
    const near = world.createEntity();
    world.addComponent(near, Replicated, { networkId: 1, owner: -1, priority: 1, lastSyncTick: 0 });
    world.addComponent(near, Transform, { x: 5, y: 0, z: 0 });

    const far = world.createEntity();
    world.addComponent(far, Replicated, { networkId: 2, owner: -1, priority: 1, lastSyncTick: 0 });
    world.addComponent(far, Transform, { x: 500, y: 0, z: 0 });

    const networkIdToEntity = new Map([[1, near], [2, far]]);
    const snapshot: Snapshot = {
      tick: 1,
      entries: [
        { networkId: 1, components: new Map() },
        { networkId: 2, components: new Map() },
      ],
    };

    const filtered = im.filterSnapshot(snapshot, { x: 0, y: 0, z: 0 }, networkIdToEntity);
    expect(filtered.entries.map((e) => e.networkId)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// InputBuffer
// ---------------------------------------------------------------------------

describe("InputBuffer", () => {
  it("push/get round trip", () => {
    const buf = new InputBuffer(8);
    const input: InputPayload = { tick: 3, clientId: 1, actions: new Map([["fire", 1]]) };
    buf.push(input);
    expect(buf.get(3)).toBe(input);
    expect(buf.get(4)).toBeNull();
  });

  it("getRange returns only present ticks, in tick order", () => {
    const buf = new InputBuffer(16);
    buf.push({ tick: 1, clientId: 0, actions: new Map() });
    buf.push({ tick: 3, clientId: 0, actions: new Map() });
    const range = buf.getRange(1, 3);
    expect(range.map((i) => i.tick)).toEqual([1, 3]);
  });

  it("removeUpTo clears acked entries and advances oldestTick", () => {
    const buf = new InputBuffer(16);
    buf.push({ tick: 1, clientId: 0, actions: new Map() });
    buf.push({ tick: 2, clientId: 0, actions: new Map() });
    buf.removeUpTo(1);
    expect(buf.get(1)).toBeNull();
    expect(buf.get(2)).not.toBeNull();
    expect(buf.oldestTick).toBe(2);
  });

  it("count reflects the number of occupied slots", () => {
    const buf = new InputBuffer(8);
    expect(buf.count).toBe(0);
    buf.push({ tick: 1, clientId: 0, actions: new Map() });
    buf.push({ tick: 2, clientId: 0, actions: new Map() });
    expect(buf.count).toBe(2);
  });

  // AUDIT: push() silently overwrites a ring-buffer slot on tick-modulo collision with no
  // overflow signal. If InputAck messages stop arriving (stalled connection, packet loss),
  // an unacknowledged input that reconciliation still needs for replay is destroyed with no
  // warning, error, or return value indicating loss. See InputBuffer.ts:12-17.
  it("push should not silently discard an unacknowledged input on ring-buffer wraparound", () => {
    const buf = new InputBuffer(4);
    const first: InputPayload = { tick: 1, clientId: 0, actions: new Map([["fwd", 1]]) };
    const collidingLater: InputPayload = { tick: 5, clientId: 0, actions: new Map([["fwd", 0]]) }; // 5 % 4 === 1 % 4

    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };

    buf.push(first);
    buf.push(collidingLater); // `first` (tick 1) was never acked via removeUpTo()

    console.warn = originalWarn;

    // Correct/expected behavior: silently destroying an unacknowledged input should at least
    // be signaled so a stalled-ack scenario is observable.
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LoopbackTransport — in-memory send/receive symmetry
// ---------------------------------------------------------------------------

describe("LoopbackTransport", () => {
  it("createPair starts both ends disconnected", () => {
    const { client, server } = LoopbackTransport.createPair();
    expect(client.state).toBe("disconnected");
    expect(server.state).toBe("disconnected");
  });

  it("connect() on one end brings both ends to connected and emits 'connected' events", () => {
    const { client, server } = LoopbackTransport.createPair();
    client.connect("loopback://test");

    expect(client.state).toBe("connected");
    expect(server.state).toBe("connected");

    const clientEvents = client.poll();
    const serverEvents = server.poll();
    expect(clientEvents.some((e) => e.type === "connected")).toBe(true);
    expect(serverEvents.some((e) => e.type === "connected")).toBe(true);
  });

  it("send/poll symmetry delivers a byte-for-byte defensive copy to the peer", () => {
    const { client, server } = LoopbackTransport.createPair();
    client.connect("x");
    client.poll();
    server.poll();

    const payload = new Uint8Array([1, 2, 3, 4]).buffer;
    client.send(payload);

    const events = server.poll();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("message");
    const received = new Uint8Array((events[0] as { data: ArrayBuffer }).data);
    expect(Array.from(received)).toEqual([1, 2, 3, 4]);
    expect((events[0] as { data: ArrayBuffer }).data).not.toBe(payload);
  });

  it("disconnect() cascades to the peer", () => {
    const { client, server } = LoopbackTransport.createPair();
    client.connect("x");
    client.poll();
    server.poll();

    client.disconnect();
    expect(client.state).toBe("disconnected");
    expect(server.state).toBe("disconnected");
    expect(server.poll().some((e) => e.type === "disconnected")).toBe(true);
  });

  it("send() while disconnected is silently dropped, never delivered", () => {
    const { client, server } = LoopbackTransport.createPair();
    client.send(new Uint8Array([9]).buffer);
    expect(server.poll().length).toBe(0);
  });

  it("poll() drains the event queue", () => {
    const { client } = LoopbackTransport.createPair();
    client.connect("x");
    expect(client.poll().length).toBeGreaterThan(0);
    expect(client.poll().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WebSocketTransport — construction/state only, no real socket is opened
// ---------------------------------------------------------------------------

describe("WebSocketTransport (construction/state, no real socket)", () => {
  let OriginalWebSocket: unknown;

  beforeAll(() => {
    OriginalWebSocket = (globalThis as any).WebSocket;
    // Minimal stand-in: enough surface for `new WebSocket(url)` + handler assignment to not
    // throw. It never calls onopen/onmessage, so no connection is ever actually established.
    (globalThis as any).WebSocket = class {
      binaryType = "";
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: ((ev: { reason?: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {}
      send(_data: unknown): void {}
      close(): void {}
    };
  });

  afterAll(() => {
    (globalThis as any).WebSocket = OriginalWebSocket;
  });

  it("starts disconnected with zero rtt", () => {
    const t = new WebSocketTransport();
    expect(t.state).toBe("disconnected");
    expect(t.rtt).toBe(0);
  });

  it("connect() transitions to 'connecting' without an open socket", () => {
    const t = new WebSocketTransport();
    t.connect("ws://example.test");
    expect(t.state).toBe("connecting");
  });

  it("disconnect() before connect() is a no-op and does not throw", () => {
    const t = new WebSocketTransport();
    expect(() => t.disconnect()).not.toThrow();
    expect(t.state).toBe("disconnected");
  });

  it("send() while not connected does not throw and is silently dropped", () => {
    const t = new WebSocketTransport();
    const writer = new BinaryWriter(8);
    writer.writeU8(1);
    expect(() => t.send(writer.toArrayBuffer())).not.toThrow();
  });

  it("poll() returns an empty array when nothing has arrived", () => {
    const t = new WebSocketTransport();
    expect(t.poll()).toEqual([]);
  });

  it("sendPing()/receivePong() compute a non-negative rtt when called directly", () => {
    const t = new WebSocketTransport();
    t.sendPing();
    t.receivePong();
    expect(t.rtt).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// NetworkManager — wiring
// ---------------------------------------------------------------------------

describe("NetworkManager", () => {
  it("client role does not create an InterestManager and exposes connection state", () => {
    const world = new World();
    const transport = new LoopbackTransport();
    const manager = new NetworkManager(world, { role: "client", transport, tickRate: 30 });
    manager.init();

    expect(manager.role).toBe("client");
    expect(manager.interestManager).toBeNull();
    expect(manager.isConnected).toBe(false);
    expect(manager.currentTick).toBe(0);
    expect(manager.rtt).toBe(0);

    manager.connect("test://loopback");
    expect(manager.isConnected).toBe(true);

    manager.destroy();
  });

  it("server role creates an InterestManager sized from config and supports client add/remove", () => {
    const world = new World();
    const transport = new LoopbackTransport();
    const manager = new NetworkManager(world, { role: "server", transport, relevanceRadius: 50 });
    manager.init();

    expect(manager.interestManager).not.toBeNull();
    expect(manager.interestManager!.relevanceRadius).toBe(50);

    const { server: clientSideTransport } = LoopbackTransport.createPair();
    manager.addClient(1, clientSideTransport);
    expect(() => manager.updateClientPosition(1, { x: 1, y: 2, z: 3 })).not.toThrow();
    expect(() => manager.ackClient(1, 5)).not.toThrow();
    manager.removeClient(1);

    manager.destroy();
  });

  it("registerEntity / getEntityByNetworkId / getNetworkId round trip", () => {
    const world = new World();
    const transport = new LoopbackTransport();
    const manager = new NetworkManager(world, { role: "client", transport });
    manager.init();

    const eid = world.createEntity();
    manager.registerEntity(eid, 42);

    expect(manager.getEntityByNetworkId(42)).toBe(eid);
    expect(manager.getNetworkId(eid)).toBe(42);

    manager.destroy();
  });
});

// ---------------------------------------------------------------------------
// NetworkReceiveSystem — server-side input path (context for AUDIT #1)
// ---------------------------------------------------------------------------

describe("NetworkReceiveSystem — server input path", () => {
  it("getReceivedInputs() returns correctly-shaped input records, with clientId trusted from the connection", () => {
    const world = new World();
    const registry = new ComponentRegistry();
    registry.register(Transform, Velocity, Replicated);
    const snapshotManager = new SnapshotManager(world, registry);
    const inputBuffer = new InputBuffer();

    const receiveSystem = new NetworkReceiveSystem();
    receiveSystem.configure(undefined as unknown as Transport, snapshotManager, registry, inputBuffer, "server");
    world.addSystem(receiveSystem);

    const { client, server } = LoopbackTransport.createPair();
    client.connect("test");
    receiveSystem.addClientTransport(7, server);

    const writer = new BinaryWriter(64);
    writeInput(writer, { tick: 3, clientId: 999 /* client lies about its own id */, actions: new Map([["move", 1]]) });
    client.send(writer.toArrayBuffer());

    receiveSystem.update(1 / 20);

    const inputs = receiveSystem.getReceivedInputs();
    expect(inputs.length).toBe(1);
    expect(inputs[0].tick).toBe(3);
    expect(inputs[0].clientId).toBe(7); // trusted from the connection, not the wire-claimed 999
    expect(inputs[0].actions.get("move")).toBe(1);

    // AUDIT: getReceivedInputs() is populated correctly every tick, but nothing ever consumes
    // it — a repo-wide search finds no reference to getReceivedInputs() outside of its own
    // definition. There is currently no server-side system that applies received client input
    // to movement/physics, so there is no authoritative validation of client input at all.
    // See NetworkReceiveSystem.ts:481.
  });
});

// ---------------------------------------------------------------------------
// NetworkSendSystem + NetworkReceiveSystem integration (LoopbackTransport)
// ---------------------------------------------------------------------------

describe("NetworkSendSystem + NetworkReceiveSystem integration", () => {
  function makeSide(role: "client" | "server", transport: Transport) {
    const world = new World();
    const registry = new ComponentRegistry();
    registry.register(Transform, Velocity, Replicated);
    const snapshotManager = new SnapshotManager(world, registry);
    snapshotManager.registerReplicatedComponents(Transform, Velocity);
    const inputBuffer = new InputBuffer();

    const receiveSystem = new NetworkReceiveSystem();
    receiveSystem.configure(transport, snapshotManager, registry, inputBuffer, role);

    const sendSystem = new NetworkSendSystem();
    sendSystem.configure(transport, snapshotManager, registry, inputBuffer, role);
    sendSystem.tickRate = 20;
    sendSystem.setNetworkIdMap(receiveSystem.networkIdMap);

    world.addSystem(receiveSystem);
    world.addSystem(sendSystem);

    return { world, registry, snapshotManager, inputBuffer, receiveSystem, sendSystem };
  }

  it("replicates a spawn via full snapshot, then an update via delta snapshot (no packet loss)", () => {
    const { client: clientTransport, server: serverTransport } = LoopbackTransport.createPair();
    clientTransport.connect("test");

    const server = makeSide("server", serverTransport);
    const client = makeSide("client", clientTransport);
    server.sendSystem.addClient(1, serverTransport);

    const eid = server.world.createEntity();
    server.world.addComponent(eid, Replicated, { networkId: 1, owner: -1, priority: 1, lastSyncTick: 0 });
    server.world.addComponent(eid, Transform, { x: 10, y: 0, z: 0 });

    const tickDt = 1 / 20;

    // Tick 1: first send to this client is a full snapshot (no lastSentSnapshot yet).
    server.sendSystem.update(tickDt);
    client.receiveSystem.update(tickDt);

    const clientEid = client.receiveSystem.getEntityByNetworkId(1);
    expect(clientEid).toBeDefined();
    expect(client.world.getStore(Transform).get(clientEid!, "x")).toBeCloseTo(10);

    // Tick 2: move the server entity; client should receive a delta snapshot updating it.
    server.world.getStore(Transform).set(eid, "x", 55);
    server.sendSystem.update(tickDt);
    client.receiveSystem.update(tickDt);

    expect(client.world.getStore(Transform).get(clientEid!, "x")).toBeCloseTo(55);
  });

  // AUDIT: NetworkSendSystem's periodic client ping bypasses WebSocketTransport.sendPing() —
  // it writes a raw Ping message via transport.send() instead (NetworkSendSystem.ts:128-130),
  // so the ping timestamp used for RTT is never recorded. When the Pong echo comes back,
  // NetworkReceiveSystem reads and discards the echoed timestamp and calls
  // transport.receivePong() with no arguments (NetworkReceiveSystem.ts:246-250). Because
  // receivePong() guards on "was sendPing() ever called", RTT reports 0 forever.
  it("a full ping/pong round trip should produce a measurable, non-zero RTT", () => {
    const clientT = new RttCapableLoopback();
    const serverT = new RttCapableLoopback();
    clientT.peer = serverT;
    serverT.peer = clientT;
    clientT.connect("test"); // cascades to serverT too

    const clientWorld = new World();
    const registry = new ComponentRegistry();
    registry.register(Transform, Replicated);
    const snapshotManager = new SnapshotManager(clientWorld, registry);
    const inputBuffer = new InputBuffer();

    const clientSend = new NetworkSendSystem();
    clientSend.configure(clientT, snapshotManager, registry, inputBuffer, "client");
    clientWorld.addSystem(clientSend);

    const clientReceive = new NetworkReceiveSystem();
    clientReceive.configure(clientT, snapshotManager, registry, inputBuffer, "client");
    clientWorld.addSystem(clientReceive);

    const serverWorld = new World();
    const serverRegistry = new ComponentRegistry();
    serverRegistry.register(Transform, Replicated);
    const serverSnapshotManager = new SnapshotManager(serverWorld, serverRegistry);
    const serverInputBuffer = new InputBuffer();
    const serverReceive = new NetworkReceiveSystem();
    serverReceive.configure(serverT, serverSnapshotManager, serverRegistry, serverInputBuffer, "server");
    serverWorld.addSystem(serverReceive);

    // Drive a full second so the client's 1s ping accumulator fires exactly once.
    clientSend.update(1.0);
    serverReceive.update(1 / 20); // server receives Ping, replies with Pong
    clientReceive.update(1 / 20); // client receives Pong

    // Correct/expected behavior: a completed ping -> pong round trip should yield rtt > 0.
    expect(clientT.rtt).toBeGreaterThan(0);
  });

  // AUDIT: NetworkInterpolated.renderDelay is written at spawn time (always to the same
  // DEFAULT_RENDER_DELAY_MS constant — NetworkReceiveSystem.ts:414-416) but
  // updateInterpolation() never reads it: it always lerps over a fixed serverTickInterval with
  // no jitter/timestamp-driven buffering (NetworkReceiveSystem.ts:363-386). Two entities with
  // wildly different renderDelay values interpolate identically.
  // See also NetworkComponents.ts:21 (the unread field).
  it("entities with different renderDelay should interpolate at different rates", () => {
    const { client: clientTransport, server: serverTransport } = LoopbackTransport.createPair();
    clientTransport.connect("test");

    const world = new World();
    const registry = new ComponentRegistry();
    registry.register(Transform, Replicated);
    const snapshotManager = new SnapshotManager(world, registry);
    const inputBuffer = new InputBuffer();

    const receiveSystem = new NetworkReceiveSystem();
    receiveSystem.configure(clientTransport, snapshotManager, registry, inputBuffer, "client");
    world.addSystem(receiveSystem);

    function sendFullSnapshot(snapshot: Snapshot): void {
      const w = new BinaryWriter(256);
      writeSnapshot(w, snapshot, registry);
      serverTransport.send(w.toArrayBuffer());
    }

    // Spawn two remote entities at the same starting position.
    sendFullSnapshot({
      tick: 1,
      entries: [
        { networkId: 1, components: new Map([["Transform", new Map([["x", 0], ["y", 0], ["z", 0]])]]) },
        { networkId: 2, components: new Map([["Transform", new Map([["x", 0], ["y", 0], ["z", 0]])]]) },
      ],
    });
    receiveSystem.update(1 / 20);

    const eidA = receiveSystem.getEntityByNetworkId(1)!;
    const eidB = receiveSystem.getEntityByNetworkId(2)!;

    const interpStore = world.getStore(NetworkInterpolated);
    interpStore.set(eidA, "renderDelay", 0);
    interpStore.set(eidB, "renderDelay", 1000);

    // Move both entities to the same new target on the next tick.
    sendFullSnapshot({
      tick: 2,
      entries: [
        { networkId: 1, components: new Map([["Transform", new Map([["x", 100], ["y", 0], ["z", 0]])]]) },
        { networkId: 2, components: new Map([["Transform", new Map([["x", 100], ["y", 0], ["z", 0]])]]) },
      ],
    });
    receiveSystem.update(1 / 60);

    const transformStore = world.getStore(Transform);
    const xA = transformStore.get(eidA, "x") as number;
    const xB = transformStore.get(eidB, "x") as number;

    // Correct/expected behavior: with renderDelay 0ms vs 1000ms, entity A should have
    // progressed noticeably further toward the new target than entity B on the same frame.
    expect(xA).not.toBeCloseTo(xB, 5);
  });
});

/**
 * Minimal Transport used only to reproduce the ping/RTT bug (AUDIT #3) in isolation. It mirrors
 * WebSocketTransport's real sendPing()/receivePong() semantics (record a timestamp on send,
 * compute rtt on the matching pong) on top of an in-memory peer link, so the test doesn't need
 * to mock the global WebSocket for an async open handshake.
 */
class RttCapableLoopback implements Transport {
  peer: RttCapableLoopback | null = null;
  private pendingEvents: TransportEvent[] = [];
  private _state: ConnectionState = "disconnected";
  private pingTimestamp = 0;
  private _rtt = 0;

  get state(): ConnectionState { return this._state; }
  get rtt(): number { return this._rtt; }

  connect(_url: string): void {
    this._state = "connected";
    this.pendingEvents.push({ type: "connected" });
    if (this.peer && this.peer.state === "disconnected") {
      this.peer.connect(_url);
    }
  }

  disconnect(): void {
    this._state = "disconnected";
    this.pendingEvents.push({ type: "disconnected", reason: "local disconnect" });
  }

  send(data: ArrayBuffer): void {
    if (this._state !== "connected" || !this.peer) return;
    this.peer.pendingEvents.push({ type: "message", data: data.slice(0) });
  }

  poll(): TransportEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  sendPing(): void {
    this.pingTimestamp = performance.now();
  }

  receivePong(): void {
    if (this.pingTimestamp > 0) {
      this._rtt = performance.now() - this.pingTimestamp || 0.001; // ensure > 0 even on fast CI clocks
      this.pingTimestamp = 0;
    }
  }
}
