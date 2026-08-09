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
  ActionRegistry,
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
  Snapshot,
} from "./NetworkTypes";

interface ConnectedClient {
  transport: Transport;
  lastAckedTick: number;
  position: { x: number; y: number; z: number };
  // The interest-filtered snapshot this client was actually last sent (not looked up from
  // the shared ring buffer by tick). Diffing against this — rather than a globally shared
  // unfiltered snapshot — is what lets a newly-relevant entity be recognized as a spawn
  // even if none of its fields changed since the client's last acked tick.
  lastSentSnapshot: Snapshot | null;
}

export class NetworkSendSystem extends System {
  priority = 950;
  phase: SystemPhase = "postPhysics";

  static reads = ["Transform", "Replicated"];
  static writes: string[] = [];

  private transport!: Transport;
  private snapshotManager!: SnapshotManager;
  private registry!: ComponentRegistry;
  private actions!: ActionRegistry;
  private inputBuffer!: InputBuffer;
  private interestManager: InterestManager | null = null;
  private role: NetworkRole = "client";

  private _currentTick = 0;
  private tickAccumulator = 0;
  private _tickRate: number = NETWORK_CONSTANTS.SERVER_TICK_RATE;
  private tickInterval = 1 / NETWORK_CONSTANTS.SERVER_TICK_RATE;

  private connectedClients = new Map<number, ConnectedClient>();
  private inputCollector: (() => InputPayload) | null = null;

  private writer = new BinaryWriter(4096);
  private pingAccumulator = 0;
  private pingInterval = 1;

  private transformStore!: ComponentStore;
  private replicatedStore!: ComponentStore;

  // A congested client (slow network, stalled reader) otherwise gets a snapshot queued every
  // server tick regardless of whether it's draining them, so its transport's outbound buffer
  // grows without bound. 64 KiB is a few snapshots' worth of backlog — enough slack to absorb a
  // brief stall without skipping sends, small enough to catch sustained congestion quickly.
  private static readonly CONGESTION_THRESHOLD_BYTES = 64 * 1024;

  // Network ID to entity mapping (shared reference from receive system)
  private networkIdToEntity: ReadonlyMap<number, number> = new Map();

  configure(
    transport: Transport,
    snapshotManager: SnapshotManager,
    registry: ComponentRegistry,
    inputBuffer: InputBuffer,
    role: NetworkRole,
    actions: ActionRegistry,
  ): void {
    this.transport = transport;
    this.snapshotManager = snapshotManager;
    this.registry = registry;
    this.inputBuffer = inputBuffer;
    this.role = role;
    this.actions = actions;
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
        const timestamp = performance.now();
        // Record the send timestamp on the transport itself (WebSocketTransport.sendPing())
        // so receivePong() has something to measure RTT against — writing the raw Ping
        // message alone never fed that timestamp into the transport's own RTT tracking.
        const transportWithPing = this.transport as unknown as { sendPing?: () => void };
        if (typeof transportWithPing.sendPing === "function") {
          transportWithPing.sendPing();
        }
        this.writer.reset();
        writePing(this.writer, timestamp);
        this.transport.send(this.writer.toArrayBuffer());
      }
    }
  }

  private sendClientInput(): void {
    if (!this.inputCollector || this.transport.state !== "connected") return;

    const input = this.inputCollector();
    input.tick = this._currentTick;
    this.inputBuffer.push(input);

    this.writer.reset();
    writeInput(this.writer, input, this.actions);
    this.transport.send(this.writer.toArrayBuffer());
  }

  private sendServerSnapshots(): void {
    const fullSnapshot = this.snapshotManager.captureSnapshot(this._currentTick);
    this.snapshotManager.storeSnapshot(fullSnapshot);

    for (const [clientId, client] of this.connectedClients) {
      // Skip this client's send entirely when its transport reports a large amount of
      // already-queued, unsent data — sending more would just pile onto the backlog. The
      // client's lastSentSnapshot is left as-is, so once it drains, the next successful send
      // diffs against the same baseline and simply carries the accumulated changes.
      const transportWithBuffer = client.transport as unknown as { bufferedAmount?: number };
      if (
        typeof transportWithBuffer.bufferedAmount === "number" &&
        transportWithBuffer.bufferedAmount > NetworkSendSystem.CONGESTION_THRESHOLD_BYTES
      ) {
        continue;
      }

      let snapshot = fullSnapshot;

      if (this.interestManager) {
        snapshot = this.interestManager.filterSnapshot(
          snapshot,
          client.position,
          this.networkIdToEntity as Map<number, number>,
        );
      }

      this.writer.reset();

      // Diff against what this client's own last filtered view actually was, not a shared
      // unfiltered snapshot looked up by tick — otherwise an entity that only just entered
      // this client's interest radius, without any of its fields changing since that tick,
      // looks "unchanged" in the diff and is silently never sent as a spawn.
      if (client.lastSentSnapshot) {
        const delta = this.snapshotManager.createDelta(snapshot, client.lastSentSnapshot);
        writeDeltaSnapshot(this.writer, delta, this.registry);
      } else {
        writeSnapshot(this.writer, snapshot, this.registry);
      }

      client.transport.send(this.writer.toArrayBuffer());
      client.lastSentSnapshot = snapshot;
    }
  }

  // Server API

  addClient(clientId: number, clientTransport: Transport): void {
    this.connectedClients.set(clientId, {
      transport: clientTransport,
      lastAckedTick: 0,
      position: { x: 0, y: 0, z: 0 },
      lastSentSnapshot: null,
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

  // Not consulted for delta-baseline selection (see lastSentSnapshot above) — kept for API
  // compatibility and for callers that want to track client ack progress themselves.
  ackClient(clientId: number, tick: number): void {
    const client = this.connectedClients.get(clientId);
    if (client) {
      client.lastAckedTick = tick;
    }
  }

  sendInputAck(clientTransport: Transport, tick: number): void {
    this.writer.reset();
    writeInputAck(this.writer, tick);
    clientTransport.send(this.writer.toArrayBuffer());
  }
}
