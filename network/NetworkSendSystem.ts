import { System, SystemPhase } from "../ecs/System";
import { ComponentStore } from "../ecs/ComponentStore";
import { Transform } from "../core/Components";
import { Replicated } from "./NetworkComponents";
import { Transport } from "./transport/Transport";
import { SnapshotManager } from "./SnapshotManager";
import { InputBuffer } from "./InputBuffer";
import { InterestManager } from "./InterestManager";
import {
  ComponentRegistry,
  writeInput,
  writeSnapshot,
  writeDeltaSnapshot,
  writeInputAck,
  writePing,
} from "./NetworkProtocol";
import { BinaryWriter } from "../core/serialization/BinaryBuffer";
import {
  NetworkRole,
  NETWORK_CONSTANTS,
  InputPayload,
} from "./NetworkTypes";

interface ConnectedClient {
  transport: Transport;
  lastAckedTick: number;
  position: { x: number; y: number; z: number };
}

export class NetworkSendSystem extends System {
  priority = 950;
  phase: SystemPhase = "postPhysics";

  static reads = ["Transform", "Replicated"];
  static writes: string[] = [];

  private transport!: Transport;
  private snapshotManager!: SnapshotManager;
  private registry!: ComponentRegistry;
  private inputBuffer!: InputBuffer;
  private interestManager: InterestManager | null = null;
  private role: NetworkRole = "client";

  private _currentTick = 0;
  private tickAccumulator = 0;
  private _tickRate = NETWORK_CONSTANTS.SERVER_TICK_RATE;
  private tickInterval = 1 / NETWORK_CONSTANTS.SERVER_TICK_RATE;

  private connectedClients = new Map<number, ConnectedClient>();
  private inputCollector: (() => InputPayload) | null = null;

  private writer = new BinaryWriter(4096);
  private pingAccumulator = 0;
  private pingInterval = 1;

  private transformStore!: ComponentStore;
  private replicatedStore!: ComponentStore;

  // Network ID to entity mapping (shared reference from receive system)
  private networkIdToEntity: ReadonlyMap<number, number> = new Map();

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

  setInterestManager(manager: InterestManager): void {
    this.interestManager = manager;
  }

  setInputCollector(collector: () => InputPayload): void {
    this.inputCollector = collector;
  }

  setNetworkIdMap(map: ReadonlyMap<number, number>): void {
    this.networkIdToEntity = map;
  }

  set tickRate(rate: number) {
    this._tickRate = rate;
    this.tickInterval = 1 / rate;
  }

  get tickRate(): number { return this._tickRate; }
  get currentTick(): number { return this._currentTick; }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
    this.replicatedStore = this.world.getStore(Replicated);
  }

  update(dt: number): void {
    if (!this.transport) return;

    this.tickAccumulator += dt;

    while (this.tickAccumulator >= this.tickInterval) {
      this._currentTick++;
      this.tickAccumulator -= this.tickInterval;

      if (this.role === "client") {
        this.sendClientInput();
      } else if (this.role === "server") {
        this.sendServerSnapshots();
      }
    }

    // Periodic ping (client only)
    if (this.role === "client" && this.transport.state === "connected") {
      this.pingAccumulator += dt;
      if (this.pingAccumulator >= this.pingInterval) {
        this.pingAccumulator -= this.pingInterval;
        this.writer = new BinaryWriter(16);
        writePing(this.writer, performance.now());
        this.transport.send(this.writer.toArrayBuffer());
      }
    }
  }

  private sendClientInput(): void {
    if (!this.inputCollector || this.transport.state !== "connected") return;

    const input = this.inputCollector();
    input.tick = this._currentTick;
    this.inputBuffer.push(input);

    this.writer = new BinaryWriter(256);
    writeInput(this.writer, input);
    this.transport.send(this.writer.toArrayBuffer());
  }

  private sendServerSnapshots(): void {
    const fullSnapshot = this.snapshotManager.captureSnapshot(this._currentTick);
    this.snapshotManager.storeSnapshot(fullSnapshot);

    for (const [clientId, client] of this.connectedClients) {
      let snapshot = fullSnapshot;

      if (this.interestManager) {
        snapshot = this.interestManager.filterSnapshot(
          snapshot,
          client.position,
          this.networkIdToEntity as Map<number, number>,
        );
      }

      this.writer = new BinaryWriter(4096);

      const baseline = this.snapshotManager.getSnapshot(client.lastAckedTick);
      if (baseline) {
        const delta = this.snapshotManager.createDelta(snapshot, baseline);
        writeDeltaSnapshot(this.writer, delta, this.registry);
      } else {
        writeSnapshot(this.writer, snapshot, this.registry);
      }

      client.transport.send(this.writer.toArrayBuffer());
    }
  }

  // Server API

  addClient(clientId: number, clientTransport: Transport): void {
    this.connectedClients.set(clientId, {
      transport: clientTransport,
      lastAckedTick: 0,
      position: { x: 0, y: 0, z: 0 },
    });
  }

  removeClient(clientId: number): void {
    this.connectedClients.delete(clientId);
  }

  updateClientPosition(clientId: number, pos: { x: number; y: number; z: number }): void {
    const client = this.connectedClients.get(clientId);
    if (client) {
      client.position.x = pos.x;
      client.position.y = pos.y;
      client.position.z = pos.z;
    }
  }

  ackClient(clientId: number, tick: number): void {
    const client = this.connectedClients.get(clientId);
    if (client) {
      client.lastAckedTick = tick;
    }
  }

  sendInputAck(clientTransport: Transport, tick: number): void {
    this.writer = new BinaryWriter(16);
    writeInputAck(this.writer, tick);
    clientTransport.send(this.writer.toArrayBuffer());
  }
}
