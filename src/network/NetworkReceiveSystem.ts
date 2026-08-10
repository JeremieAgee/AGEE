import { System, SystemPhase } from "../ecs/System";
import { Query } from "../ecs/Query";
import { ComponentStore } from "../ecs/ComponentStore";
import { Transform, Velocity } from "../core/Components";
import { Replicated, NetworkOwner, NetworkInterpolated } from "./NetworkComponents";
import { Transport, TransportEvent } from "./transport/Transport";
import { SnapshotManager } from "./SnapshotManager";
import { InputBuffer } from "./InputBuffer";
import {
  ComponentRegistry,
  ActionRegistry,
  readMessageHeader,
  writeConnect,
  readConnect,
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
  private actions!: ActionRegistry;
  private inputBuffer!: InputBuffer;
  private role: NetworkRole = "client";

  // Server-mode: one Transport per connected client, so an inbound message's clientId can be
  // taken from the connection it actually arrived on rather than trusted from the wire (a
  // client can put any clientId it likes in an Input message's payload).
  private clientTransports = new Map<number, Transport>();

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
  private velocityStore!: ComponentStore;

  // Server-mode: entities carrying Replicated, queried each tick to resolve a client's
  // owned entity (Replicated.owner === clientId) for applying that client's received input.
  private replicatedQuery!: Query;

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

  // AUDIT FIX: getReceivedInputs() was populated every tick (validated, rate-limited,
  // replay-protected) but nothing ever drained it -- there was no server-authoritative
  // simulation step that applied a client's input to their owned entity at all. Server-mode:
  // applyReceivedInputs() (called from update()) now drains getReceivedInputs() every tick and
  // applies each validated input to the entity owned by that client (Replicated.owner ===
  // clientId), via this optional host-supplied hook when set. When unset, a generic default
  // (applyInputDefault) writes any action whose name matches a Velocity field (vx/vy/vz/ax/ay/az)
  // straight onto that entity's Velocity component -- the same name-matched field application
  // the rest of this file already does for replicated Snapshot/Delta data, so it requires no
  // game-specific movement logic to close the wiring gap.
  private _onApplyInput: ((eid: number, input: InputPayload) => void) | null = null;

  // Client-mode: token sent in the Connect handshake once the transport reports "connected" —
  // see dispatchEvent()'s "connected" case. Set via NetworkManager.connect(url, token).
  private connectToken = "";
  private connectWriter = new BinaryWriter(64);

  // Server-mode: fired when a Connect message arrives from an already-registered client
  // transport (see addClientTransport/NetworkManager.addClient), so host code can act on the
  // client's self-reported token (e.g. deferred/async auth) beyond whatever addClient() itself
  // already validated synchronously. Not required — a server that only relies on addClient()'s
  // own token check can leave this unset.
  private _onConnectRequest: ((token: string, transport: Transport, clientId: number) => void) | null = null;

  set onConnectRequest(fn: ((token: string, transport: Transport, clientId: number) => void) | null) {
    this._onConnectRequest = fn;
  }

  // Server-mode: notified when a client's transport reports "disconnected", so the owner
  // (NetworkManager) can clean up whatever it tracks for that client (NetworkSendSystem's
  // connectedClients entry, etc). Without this, an ungraceful disconnect only logged a
  // warning — connectedClients/clientTransports leaked that client's entry (and the
  // transport/entity it referenced) indefinitely.
  private _onClientDisconnected: ((clientId: number) => void) | null = null;

  set onClientDisconnected(fn: ((clientId: number) => void) | null) {
    this._onClientDisconnected = fn;
  }

  // Server-mode anti-replay/anti-flood: without this, nothing downstream deduplicated Input
  // messages, so a client could resend (replay) an already-processed tick and have it applied
  // a second time — a classic speed/duplication exploit — or flood the receive loop with input
  // messages for the same client with no cost. lastAcceptedInputTick rejects anything at or
  // below the highest tick already accepted for that client; inputMessageCountThisPoll caps how
  // many Input messages a single client can get accepted per update()/poll cycle.
  private lastAcceptedInputTick = new Map<number, number>();
  private inputMessageCountThisPoll = new Map<number, number>();
  private static readonly MAX_INPUTS_PER_POLL = 8;

  private pongWriter = new BinaryWriter(16);

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

  set localClientId(id: number) { this._localClientId = id; }
  get localClientId(): number { return this._localClientId; }
  get lastReceivedTick(): number { return this._lastReceivedTick; }

  /** Client-mode: the token sent in the Connect handshake once the transport connects. */
  set localConnectToken(token: string) { this.connectToken = token; }

  set onReconcile(fn: ((serverTick: number, inputs: InputPayload[]) => void) | null) {
    this._onReconcile = fn;
  }

  /** Server-mode: overrides how a validated Input is applied to its owning entity each tick
   *  (see applyReceivedInputs()). Pass null to restore the built-in Velocity-field default. */
  set onApplyInput(fn: ((eid: number, input: InputPayload) => void) | null) {
    this._onApplyInput = fn;
  }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
    this.replicatedStore = this.world.getStore(Replicated);
    this.ownerStore = this.world.getStore(NetworkOwner);
    this.interpStore = this.world.getStore(NetworkInterpolated);
    this.interpQuery = this.world.query(NetworkInterpolated, Transform);
    this.velocityStore = this.world.getStore(Velocity);
    this.replicatedQuery = this.world.query(Replicated);

    this.world.onEntityDestroy((eid) => {
      const nid = this.entityToNetworkId.get(eid);
      if (nid !== undefined) {
        this.networkIdToEntity.delete(nid);
        this.entityToNetworkId.delete(eid);
      }
    });
  }

  update(dt: number): void {
    if (!this.transport && this.clientTransports.size === 0) return;

    this.receivedInputs.length = 0;
    this.inputMessageCountThisPoll.clear();

    if (this.transport) {
      const events = this.transport.poll();
      for (let i = 0; i < events.length; i++) {
        this.dispatchEvent(events[i], this.transport, undefined);
      }
    }

    for (const [clientId, transport] of this.clientTransports) {
      const events = transport.poll();
      for (let i = 0; i < events.length; i++) {
        this.dispatchEvent(events[i], transport, clientId);
      }
    }

    if (this.role === "server") {
      this.applyReceivedInputs();
    }

    this.processSpawns();
    this.processDespawns();
    this.updateInterpolation(dt);
  }

  private dispatchEvent(ev: TransportEvent, sourceTransport: Transport, trustedClientId: number | undefined): void {
    switch (ev.type) {
      case "connected":
        // AUDIT FIX: writeConnect() previously had zero call sites anywhere in the engine, so
        // a client's transport reaching "connected" never actually sent the app-level Connect
        // handshake the protocol defines -- only the raw socket opened. This is the client side
        // of that handshake; addClient() (NetworkManager) sends the server's ConnectAck reply.
        if (this.role === "client") {
          this.connectWriter.reset();
          writeConnect(this.connectWriter, this.connectToken);
          sourceTransport.send(this.connectWriter.toArrayBuffer());
        }
        break;
      case "message":
        this.handleMessage(ev.data, sourceTransport, trustedClientId);
        break;
      case "disconnected":
        console.warn("[Network] Disconnected:", ev.reason);
        if (trustedClientId !== undefined) {
          this.removeClientTransport(trustedClientId);
          this._onClientDisconnected?.(trustedClientId);
        }
        break;
      case "error":
        console.error("[Network] Transport error:", ev.error);
        break;
    }
  }

  /**
   * `data` is untrusted input — it may come straight off a WebSocket from a client that has
   * no reason to send a well-formed payload. Every read in here (and everything the registry
   * driven Snapshot/Input decoders do) can throw; a single malformed message must not be able
   * to take down the whole receive loop for every other connection.
   */
  private handleMessage(data: ArrayBuffer, sourceTransport: Transport, trustedClientId: number | undefined): void {
    try {
      const reader = new BinaryReader(data);
      const header = readMessageHeader(reader);

      if (header.version !== NETWORK_CONSTANTS.PROTOCOL_VERSION) {
        console.warn("[Network] Protocol version mismatch:", header.version);
        return;
      }

      // Cheap defense in depth: these message types only ever flow in one direction, so
      // receiving the "wrong" one for our role is either a bug or a hostile peer — either
      // way, don't act on it.
      if (this.role === "server" && (header.type === MessageType.Snapshot || header.type === MessageType.DeltaSnapshot || header.type === MessageType.ConnectAck)) {
        return;
      }
      if (this.role === "client" && (header.type === MessageType.Input || header.type === MessageType.Connect)) {
        return;
      }

      switch (header.type) {
        case MessageType.Connect: {
          const { token } = readConnect(reader);
          // Only meaningful for a transport host code has already registered via
          // addClientTransport/addClient (see NetworkManager.addClient) — an unregistered
          // transport has no clientId yet and there's nothing to acknowledge it as.
          if (trustedClientId !== undefined) {
            this._onConnectRequest?.(token, sourceTransport, trustedClientId);
          }
          break;
        }

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
          const baseline = this.snapshotManager.getSnapshot(delta.baseTick);
          if (!baseline) {
            // We don't have the baseline this delta was computed against (e.g. it aged out
            // of the ring buffer). Synthesizing an empty snapshot here would make every
            // currently-known entity look despawned once fed into applySnapshotToWorld, so
            // instead drop this delta entirely and wait for a fresh full Snapshot (or a
            // later delta based on a baseline we do have) rather than mass-destroying state.
            console.warn(`[Network] Missing baseline snapshot for tick ${delta.baseTick}; dropping delta for tick ${delta.tick}`);
            break;
          }
          this._lastReceivedTick = delta.tick;
          const full = this.snapshotManager.applyDelta(baseline, delta);
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
          const input = readInput(reader, this.actions);
          // Never trust a wire-supplied clientId when we know which connection this
          // message actually arrived on — otherwise any client can claim to be any other
          // client and have their input routed to that player's entity.
          if (trustedClientId !== undefined) {
            input.clientId = trustedClientId;

            const countThisPoll = (this.inputMessageCountThisPoll.get(trustedClientId) ?? 0) + 1;
            this.inputMessageCountThisPoll.set(trustedClientId, countThisPoll);
            if (countThisPoll > NetworkReceiveSystem.MAX_INPUTS_PER_POLL) {
              console.warn(`[Network] Client ${trustedClientId} exceeded the input rate limit (${countThisPoll} messages this poll); dropping`);
              break;
            }

            const lastTick = this.lastAcceptedInputTick.get(trustedClientId) ?? -1;
            if (input.tick <= lastTick) {
              // Duplicate or replayed tick (already processed, or resent) — drop instead of
              // letting the same input get applied a second time.
              break;
            }
            this.lastAcceptedInputTick.set(trustedClientId, input.tick);
          }
          this.receivedInputs.push(input);
          break;
        }

        case MessageType.Ping: {
          const timestamp = readPingPong(reader);
          this.pongWriter.reset();
          writePong(this.pongWriter, timestamp);
          sourceTransport.send(this.pongWriter.toArrayBuffer());
          break;
        }

        case MessageType.Pong: {
          readPingPong(reader);
          const ws = sourceTransport as any;
          if (typeof ws.receivePong === "function") ws.receivePong();
          break;
        }
      }
    } catch (err) {
      console.warn("[Network] Dropping malformed message" + (trustedClientId !== undefined ? ` from client ${trustedClientId}` : "") + ":", err);
    }
  }

  /** Server API: register the Transport a given client's messages arrive on, so Input
   *  messages from them get their clientId bound to this connection instead of trusting
   *  whatever the message payload claims. */
  addClientTransport(clientId: number, transport: Transport): void {
    this.clientTransports.set(clientId, transport);
  }

  removeClientTransport(clientId: number): void {
    this.clientTransports.delete(clientId);
    this.lastAcceptedInputTick.delete(clientId);
    this.inputMessageCountThisPoll.delete(clientId);
  }

  /** Server-mode: the actual simulation-application step for validated client input. Drains
   *  getReceivedInputs() (already validated, rate-limited and replay-protected by
   *  handleMessage's Input case above) and applies each one to the entity that client owns,
   *  resolved via Replicated.owner === clientId -- the same server-side ownership field
   *  SnapshotManager/InterestManager already key off of. */
  private applyReceivedInputs(): void {
    if (this.receivedInputs.length === 0) return;

    const clientIdToEntity = new Map<number, number>();
    for (const eid of this.replicatedQuery.entities) {
      const owner = this.replicatedStore.get(eid, "owner") as number;
      if (owner !== NETWORK_CONSTANTS.SERVER_CLIENT_ID) {
        clientIdToEntity.set(owner, eid);
      }
    }

    for (const input of this.receivedInputs) {
      const eid = clientIdToEntity.get(input.clientId);
      if (eid === undefined) continue;
      this.applyInputToEntity(eid, input);
    }
  }

  private applyInputToEntity(eid: number, input: InputPayload): void {
    if (this._onApplyInput) {
      this._onApplyInput(eid, input);
      return;
    }
    this.applyInputDefault(eid, input);
  }

  // Generic default: writes any action whose name matches a Velocity field directly onto
  // that entity's Velocity component. Requires no game-specific movement semantics -- a game
  // that sends actions named "vx"/"vy"/"vz"/"ax"/"ay"/"az" gets authoritative input application
  // out of the box; anything else should set onApplyInput to its own translation.
  private static readonly VELOCITY_FIELDS = ["vx", "vy", "vz", "ax", "ay", "az"] as const;

  private applyInputDefault(eid: number, input: InputPayload): void {
    if (!this.velocityStore.has(eid)) return;
    for (const field of NetworkReceiveSystem.VELOCITY_FIELDS) {
      const value = input.actions.get(field);
      if (value !== undefined) {
        this.velocityStore.set(eid, field, value);
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
    const renderDelayCol = this.interpStore.getColumn("renderDelay") as Float32Array;

    for (const eid of this.interpQuery.entities) {
      this.ensureInterpCapacity(eid);
      this.interpTimer[eid] += dt;

      // renderDelay is expressed relative to DEFAULT_RENDER_DELAY_MS, the delay a plain
      // single-tick lerp (over serverTickInterval) implicitly assumes. An entity spawned with
      // the default delay therefore interpolates exactly as before (window ===
      // serverTickInterval); a larger renderDelay stretches the window so the entity visibly
      // lags further behind the latest snapshot, and a renderDelay of 0 snaps immediately to
      // the latest target instead of easing toward it.
      const renderDelayMs = renderDelayCol[eid];
      const window = renderDelayMs > 0
        ? this.serverTickInterval * (renderDelayMs / NETWORK_CONSTANTS.DEFAULT_RENDER_DELAY_MS)
        : 0;
      const t = window > 0 ? Math.min(this.interpTimer[eid] / window, 1) : 1;
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

    const grow = (old: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> => {
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
