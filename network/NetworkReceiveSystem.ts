import { System, SystemPhase } from "../ecs/System";
import { Query } from "../ecs/Query";
import { ComponentStore } from "../ecs/ComponentStore";
import { Transform } from "../core/Components";
import { Replicated, NetworkOwner, NetworkInterpolated } from "./NetworkComponents";
import { Transport } from "./transport/Transport";
import { SnapshotManager } from "./SnapshotManager";
import { InputBuffer } from "./InputBuffer";
import {
  ComponentRegistry,
  readMessageHeader,
  readConnectAck,
  readSnapshot,
  readDeltaSnapshot,
  readInputAck,
  readInput,
  readPingPong,
  writePong,
} from "./NetworkProtocol";
import { BinaryWriter, BinaryReader } from "../core/serialization/BinaryBuffer";
import {
  MessageType,
  NETWORK_CONSTANTS,
  NetworkRole,
  Snapshot,
  SnapshotEntry,
  InputPayload,
} from "./NetworkTypes";

const INITIAL_INTERP_CAPACITY = 256;
const INTERP_GROWTH_FACTOR = 2;

export class NetworkReceiveSystem extends System {
  priority = 10;
  phase: SystemPhase = "prePhysics";

  static reads = ["Transform", "Replicated", "NetworkOwner", "NetworkInterpolated"];
  static writes = ["Transform", "Replicated", "NetworkOwner", "NetworkInterpolated"];

  private transport!: Transport;
  private snapshotManager!: SnapshotManager;
  private registry!: ComponentRegistry;
  private inputBuffer!: InputBuffer;
  private role: NetworkRole = "client";

  private networkIdToEntity = new Map<number, number>();
  private entityToNetworkId = new Map<number, number>();
  private _localClientId = -1;
  private _lastReceivedTick = 0;
  private serverTickInterval = 1 / NETWORK_CONSTANTS.SERVER_TICK_RATE;

  private transformStore!: ComponentStore;
  private replicatedStore!: ComponentStore;
  private ownerStore!: ComponentStore;
  private interpStore!: ComponentStore;
  private interpQuery!: Query;

  // Interpolation arrays (mirrors PhysicsSystem pattern)
  private prevX = new Float32Array(INITIAL_INTERP_CAPACITY);
  private prevY = new Float32Array(INITIAL_INTERP_CAPACITY);
  private prevZ = new Float32Array(INITIAL_INTERP_CAPACITY);
  private prevRx = new Float32Array(INITIAL_INTERP_CAPACITY);
  private prevRy = new Float32Array(INITIAL_INTERP_CAPACITY);
  private prevRz = new Float32Array(INITIAL_INTERP_CAPACITY);
  private currX = new Float32Array(INITIAL_INTERP_CAPACITY);
  private currY = new Float32Array(INITIAL_INTERP_CAPACITY);
  private currZ = new Float32Array(INITIAL_INTERP_CAPACITY);
  private currRx = new Float32Array(INITIAL_INTERP_CAPACITY);
  private currRy = new Float32Array(INITIAL_INTERP_CAPACITY);
  private currRz = new Float32Array(INITIAL_INTERP_CAPACITY);
  private interpTimer = new Float32Array(INITIAL_INTERP_CAPACITY);
  private interpCapacity = INITIAL_INTERP_CAPACITY;

  private pendingSpawns: SnapshotEntry[] = [];
  private pendingDespawns: number[] = [];

  // Server-mode: received inputs from clients
  private receivedInputs: InputPayload[] = [];

  // Client-mode: callback for prediction replay
  private _onReconcile: ((serverTick: number, inputs: InputPayload[]) => void) | null = null;

  private pongWriter = new BinaryWriter(16);

  configure(
    transport: Transport,
    snapshotManager: SnapshotManager,
    registry: ComponentRegistry,
    inputBuffer: InputBuffer,
    role: NetworkRole,
  ): void {
    this.transport = transport;
    this.snapshotManager = snapshotManager;
    this.registry = registry;
    this.inputBuffer = inputBuffer;
    this.role = role;
  }

  set localClientId(id: number) { this._localClientId = id; }
  get localClientId(): number { return this._localClientId; }
  get lastReceivedTick(): number { return this._lastReceivedTick; }

  set onReconcile(fn: ((serverTick: number, inputs: InputPayload[]) => void) | null) {
    this._onReconcile = fn;
  }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
    this.replicatedStore = this.world.getStore(Replicated);
    this.ownerStore = this.world.getStore(NetworkOwner);
    this.interpStore = this.world.getStore(NetworkInterpolated);
    this.interpQuery = this.world.query(NetworkInterpolated, Transform);

    this.world.onEntityDestroy((eid) => {
      const nid = this.entityToNetworkId.get(eid);
      if (nid !== undefined) {
        this.networkIdToEntity.delete(nid);
        this.entityToNetworkId.delete(eid);
      }
    });
  }

  update(dt: number): void {
    if (!this.transport) return;

    this.receivedInputs.length = 0;

    const events = this.transport.poll();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      switch (ev.type) {
        case "message":
          this.handleMessage(ev.data);
          break;
        case "disconnected":
          console.warn("[Network] Disconnected:", ev.reason);
          break;
        case "error":
          console.error("[Network] Transport error:", ev.error);
          break;
      }
    }

    this.processSpawns();
    this.processDespawns();
    this.updateInterpolation(dt);
  }

  private handleMessage(data: ArrayBuffer): void {
    const reader = new BinaryReader(data);
    const header = readMessageHeader(reader);

    if (header.version !== NETWORK_CONSTANTS.PROTOCOL_VERSION) {
      console.warn("[Network] Protocol version mismatch:", header.version);
      return;
    }

    switch (header.type) {
      case MessageType.ConnectAck: {
        const ack = readConnectAck(reader);
        this._localClientId = ack.clientId;
        this._lastReceivedTick = ack.tick;
        break;
      }

      case MessageType.Snapshot: {
        const snapshot = readSnapshot(reader, this.registry);
        this._lastReceivedTick = snapshot.tick;
        this.snapshotManager.storeSnapshot(snapshot);
        this.processServerSnapshot(snapshot);
        break;
      }

      case MessageType.DeltaSnapshot: {
        const delta = readDeltaSnapshot(reader, this.registry);
        this._lastReceivedTick = delta.tick;
        const baseline = this.snapshotManager.getSnapshot(delta.baseTick);
        const full = baseline
          ? this.snapshotManager.applyDelta(baseline, delta)
          : { tick: delta.tick, entries: [] };
        this.snapshotManager.storeSnapshot(full);
        this.processServerSnapshot(full);
        break;
      }

      case MessageType.InputAck: {
        const ackedTick = readInputAck(reader);
        this.inputBuffer.removeUpTo(ackedTick);
        break;
      }

      case MessageType.Input: {
        const input = readInput(reader);
        this.receivedInputs.push(input);
        break;
      }

      case MessageType.Ping: {
        const timestamp = readPingPong(reader);
        this.pongWriter = new BinaryWriter(16);
        writePong(this.pongWriter, timestamp);
        this.transport.send(this.pongWriter.toArrayBuffer());
        break;
      }

      case MessageType.Pong: {
        readPingPong(reader);
        const ws = this.transport as any;
        if (typeof ws.receivePong === "function") ws.receivePong();
        break;
      }
    }
  }

  private processServerSnapshot(snapshot: Snapshot): void {
    const { spawns, despawns } = this.snapshotManager.applySnapshotToWorld(
      snapshot,
      this.networkIdToEntity,
    );

    for (const entry of spawns) {
      this.pendingSpawns.push(entry);
    }

    for (const networkId of despawns) {
      this.pendingDespawns.push(networkId);
    }

    // Reconciliation for locally predicted entities
    if (this.role === "client") {
      for (const entry of snapshot.entries) {
        const eid = this.networkIdToEntity.get(entry.networkId);
        if (eid === undefined) continue;

        if (this.ownerStore.has(eid) && this.ownerStore.get(eid, "authoritative") === 1) {
          this.reconcile(eid, entry, snapshot.tick);
        } else if (this.interpStore.has(eid)) {
          this.updateInterpTargets(eid, entry);
        }
      }
    }
  }

  private reconcile(eid: number, serverState: SnapshotEntry, serverTick: number): void {
    const transformFields = serverState.components.get("Transform");
    if (!transformFields) return;

    const sx = transformFields.get("x");
    const sy = transformFields.get("y");
    const sz = transformFields.get("z");
    if (sx === undefined || sy === undefined || sz === undefined) return;

    const lx = this.transformStore.get(eid, "x") as number;
    const ly = this.transformStore.get(eid, "y") as number;
    const lz = this.transformStore.get(eid, "z") as number;

    const dx = sx - lx;
    const dy = sy - ly;
    const dz = sz - lz;
    const distSq = dx * dx + dy * dy + dz * dz;

    const threshold = NETWORK_CONSTANTS.POSITION_EPSILON;
    if (distSq > threshold * threshold) {
      // Apply server state
      for (const [compName, fields] of serverState.components) {
        const def = this.registry.registeredDefs.find(d => d.name === compName);
        if (!def) continue;
        const store = this.world.getStore(def);
        if (!store.has(eid)) continue;
        for (const [fieldName, value] of fields) {
          store.set(eid, fieldName, value);
        }
      }

      // Replay buffered inputs
      if (this._onReconcile) {
        const inputs = this.inputBuffer.getRange(serverTick + 1, this.inputBuffer.newestTick);
        this._onReconcile(serverTick, inputs);
      }
    }

    this.replicatedStore.set(eid, "lastSyncTick", serverTick);
  }

  private updateInterpTargets(eid: number, entry: SnapshotEntry): void {
    this.ensureInterpCapacity(eid);

    // Shift current -> previous
    this.prevX[eid] = this.currX[eid];
    this.prevY[eid] = this.currY[eid];
    this.prevZ[eid] = this.currZ[eid];
    this.prevRx[eid] = this.currRx[eid];
    this.prevRy[eid] = this.currRy[eid];
    this.prevRz[eid] = this.currRz[eid];

    const tf = entry.components.get("Transform");
    if (tf) {
      this.currX[eid] = tf.get("x") ?? this.currX[eid];
      this.currY[eid] = tf.get("y") ?? this.currY[eid];
      this.currZ[eid] = tf.get("z") ?? this.currZ[eid];
      this.currRx[eid] = tf.get("rx") ?? this.currRx[eid];
      this.currRy[eid] = tf.get("ry") ?? this.currRy[eid];
      this.currRz[eid] = tf.get("rz") ?? this.currRz[eid];
    }

    this.interpTimer[eid] = 0;
  }

  private updateInterpolation(dt: number): void {
    const tx = this.transformStore.getColumn("x") as Float32Array;
    const ty = this.transformStore.getColumn("y") as Float32Array;
    const tz = this.transformStore.getColumn("z") as Float32Array;
    const trx = this.transformStore.getColumn("rx") as Float32Array;
    const trY = this.transformStore.getColumn("ry") as Float32Array;
    const trz = this.transformStore.getColumn("rz") as Float32Array;
    const tCol = this.interpStore.getColumn("t") as Float32Array;

    for (const eid of this.interpQuery.entities) {
      this.ensureInterpCapacity(eid);
      this.interpTimer[eid] += dt;

      const t = Math.min(this.interpTimer[eid] / this.serverTickInterval, 1);
      tCol[eid] = t;

      tx[eid] = this.prevX[eid] + (this.currX[eid] - this.prevX[eid]) * t;
      ty[eid] = this.prevY[eid] + (this.currY[eid] - this.prevY[eid]) * t;
      tz[eid] = this.prevZ[eid] + (this.currZ[eid] - this.prevZ[eid]) * t;
      trx[eid] = this.prevRx[eid] + (this.currRx[eid] - this.prevRx[eid]) * t;
      trY[eid] = this.prevRy[eid] + (this.currRy[eid] - this.prevRy[eid]) * t;
      trz[eid] = this.prevRz[eid] + (this.currRz[eid] - this.prevRz[eid]) * t;
    }
  }

  private processSpawns(): void {
    for (const entry of this.pendingSpawns) {
      const eid = this.world.createEntity();
      this.networkIdToEntity.set(entry.networkId, eid);
      this.entityToNetworkId.set(eid, entry.networkId);

      this.world.addComponent(eid, Replicated, {
        networkId: entry.networkId,
        owner: NETWORK_CONSTANTS.SERVER_CLIENT_ID,
        priority: 1,
        lastSyncTick: this._lastReceivedTick,
      });

      for (const [compName, fields] of entry.components) {
        const def = this.registry.registeredDefs.find(d => d.name === compName);
        if (!def) continue;

        const data: Record<string, number> = {};
        for (const [fieldName, value] of fields) {
          data[fieldName] = value;
        }
        this.world.addComponent(eid, def, data);
      }

      // Add interpolation for remote entities
      if (this.role === "client") {
        this.world.addComponent(eid, NetworkInterpolated, {
          renderDelay: NETWORK_CONSTANTS.DEFAULT_RENDER_DELAY_MS,
        });
        this.ensureInterpCapacity(eid);
        const tf = entry.components.get("Transform");
        if (tf) {
          const x = tf.get("x") ?? 0;
          const y = tf.get("y") ?? 0;
          const z = tf.get("z") ?? 0;
          const rx = tf.get("rx") ?? 0;
          const ry = tf.get("ry") ?? 0;
          const rz = tf.get("rz") ?? 0;
          this.prevX[eid] = this.currX[eid] = x;
          this.prevY[eid] = this.currY[eid] = y;
          this.prevZ[eid] = this.currZ[eid] = z;
          this.prevRx[eid] = this.currRx[eid] = rx;
          this.prevRy[eid] = this.currRy[eid] = ry;
          this.prevRz[eid] = this.currRz[eid] = rz;
        }
      }
    }
    this.pendingSpawns.length = 0;
  }

  private processDespawns(): void {
    for (const networkId of this.pendingDespawns) {
      const eid = this.networkIdToEntity.get(networkId);
      if (eid !== undefined) {
        this.world.destroyEntity(eid);
      }
    }
    this.pendingDespawns.length = 0;
  }

  private ensureInterpCapacity(eid: number): void {
    if (eid < this.interpCapacity) return;
    let newCap = this.interpCapacity;
    while (newCap <= eid) newCap *= INTERP_GROWTH_FACTOR;

    const grow = (old: Float32Array): Float32Array => {
      const fresh = new Float32Array(newCap);
      fresh.set(old);
      return fresh;
    };

    this.prevX = grow(this.prevX); this.prevY = grow(this.prevY); this.prevZ = grow(this.prevZ);
    this.prevRx = grow(this.prevRx); this.prevRy = grow(this.prevRy); this.prevRz = grow(this.prevRz);
    this.currX = grow(this.currX); this.currY = grow(this.currY); this.currZ = grow(this.currZ);
    this.currRx = grow(this.currRx); this.currRy = grow(this.currRy); this.currRz = grow(this.currRz);
    this.interpTimer = grow(this.interpTimer);
    this.interpCapacity = newCap;
  }

  // Public API
  registerEntity(eid: number, networkId: number): void {
    this.networkIdToEntity.set(networkId, eid);
    this.entityToNetworkId.set(eid, networkId);
  }

  getEntityByNetworkId(networkId: number): number | undefined {
    return this.networkIdToEntity.get(networkId);
  }

  getNetworkId(eid: number): number | undefined {
    return this.entityToNetworkId.get(eid);
  }

  getReceivedInputs(): readonly InputPayload[] {
    return this.receivedInputs;
  }

  get networkIdMap(): ReadonlyMap<number, number> {
    return this.networkIdToEntity;
  }
}
