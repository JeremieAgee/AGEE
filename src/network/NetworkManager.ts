import { World } from "../ecs";
import { ComponentDef } from "../ecs/Component";
import { Transform, Velocity } from "../core/Components";
import { Transport } from "./transport/Transport";
import { WebSocketTransport } from "./transport/WebSocketTransport";
import { ComponentRegistry, ActionRegistry, writeConnectAck } from "./NetworkProtocol";
import { BinaryWriter } from "../core/serialization/BinaryBuffer";
import { SnapshotManager } from "./SnapshotManager";
import { InputBuffer } from "./InputBuffer";
import { InterestManager } from "./InterestManager";
import { NetworkReceiveSystem } from "./NetworkReceiveSystem";
import { NetworkSendSystem } from "./NetworkSendSystem";
import { Replicated, NetworkOwner, NetworkInterpolated } from "./NetworkComponents";
import { NetworkRole, InputPayload, NETWORK_CONSTANTS } from "./NetworkTypes";

export interface NetworkConfig {
  role: NetworkRole;
  tickRate?: number;
  relevanceRadius?: number;
  replicatedComponents?: ComponentDef[];
  transport?: Transport;
  /** Input action names this game sends, registered once up front so Input messages can carry
   *  a 1-byte index per action instead of resending the full name every client tick. Both the
   *  client and server NetworkManager must register the same names in the same order (or just
   *  pass the same array on both sides). */
  actions?: string[];
}

export class NetworkManager {
  readonly role: NetworkRole;
  readonly registry: ComponentRegistry;
  readonly actions: ActionRegistry;
  readonly snapshotManager: SnapshotManager;
  readonly inputBuffer: InputBuffer;
  readonly interestManager: InterestManager | null;
  readonly receiveSystem: NetworkReceiveSystem;
  readonly sendSystem: NetworkSendSystem;

  private transport: Transport;
  private world: World;

  // Server-mode auth hook: without this, addClient() accepted any transport handed to it with
  // zero credential check — a raw ConnectAck with the next clientId, no validation at all. When
  // set, addClient() rejects (disconnects, never registers) any client whose token fails this
  // check instead of trusting the caller unconditionally. NetworkProtocol's writeConnect/
  // readConnect carry the token over the wire; the host game's own connection-accept code is
  // expected to read it off the first message on a new transport and pass it into addClient().
  private authValidator: ((clientId: number, token: string) => boolean) | null = null;
  private connectAckWriter = new BinaryWriter(16);

  constructor(world: World, config: NetworkConfig) {
    this.world = world;
    this.role = config.role;

    this.registry = new ComponentRegistry();
    this.registry.register(Transform, Velocity, Replicated);

    if (config.replicatedComponents) {
      this.registry.register(...config.replicatedComponents);
    }

    this.actions = new ActionRegistry();
    if (config.actions) {
      this.actions.register(...config.actions);
    }

    this.snapshotManager = new SnapshotManager(world, this.registry);
    this.snapshotManager.registerReplicatedComponents(Transform, Velocity);
    if (config.replicatedComponents) {
      this.snapshotManager.registerReplicatedComponents(...config.replicatedComponents);
    }

    this.inputBuffer = new InputBuffer();
    this.transport = config.transport ?? new WebSocketTransport();

    const tickRate = config.tickRate ?? NETWORK_CONSTANTS.SERVER_TICK_RATE;

    this.receiveSystem = new NetworkReceiveSystem();
    this.receiveSystem.configure(
      this.transport,
      this.snapshotManager,
      this.registry,
      this.inputBuffer,
      config.role,
      this.actions,
    );

    this.sendSystem = new NetworkSendSystem();
    this.sendSystem.configure(
      this.transport,
      this.snapshotManager,
      this.registry,
      this.inputBuffer,
      config.role,
      this.actions,
    );
    this.sendSystem.tickRate = tickRate;
    this.sendSystem.setNetworkIdMap(this.receiveSystem.networkIdMap);

    if (config.role === "server") {
      this.interestManager = new InterestManager(
        world,
        config.relevanceRadius ?? NETWORK_CONSTANTS.DEFAULT_RELEVANCE_RADIUS,
      );
      this.sendSystem.setInterestManager(this.interestManager);
    } else {
      this.interestManager = null;
    }

    // An ungraceful client disconnect (dropped connection, closed tab, etc.) only surfaced as
    // a log line before — nothing removed the client from NetworkSendSystem's connectedClients
    // map, so it kept getting sent snapshots on a dead transport forever. Route it through the
    // same removeClient() path addClient()'s counterpart already uses.
    this.receiveSystem.onClientDisconnected = (clientId) => this.removeClient(clientId);

    // AUDIT FIX: the wire-level Connect handshake (writeConnect/readConnect) previously had no
    // server-side handler at all -- a client's self-reported token never reached auth here, and
    // ConnectAck (which sets the client's localClientId) was never sent by anything. This runs
    // the same authValidator addClient() uses, but against the token the client actually sent
    // over the wire rather than one host code had to intercept and pass into addClient() itself.
    this.receiveSystem.onConnectRequest = (token, transport, clientId) => {
      if (this.authValidator && !this.authValidator(clientId, token)) {
        console.warn(`[Network] Rejecting client ${clientId}: auth validator declined the connection`);
        transport.disconnect();
        this.removeClient(clientId);
        return;
      }
      this.sendConnectAck(clientId, transport);
    };
  }

  private sendConnectAck(clientId: number, transport: Transport): void {
    this.connectAckWriter.reset();
    writeConnectAck(this.connectAckWriter, clientId, this.sendSystem.currentTick);
    transport.send(this.connectAckWriter.toArrayBuffer());
  }

  init(): void {
    this.world.getStore(Replicated);
    this.world.getStore(NetworkOwner);
    this.world.getStore(NetworkInterpolated);

    this.world.addSystem(this.receiveSystem);
    this.world.addSystem(this.sendSystem);

    if (this.interestManager) {
      this.interestManager.init();
    }
  }

  /** `token` is sent as part of the Connect handshake once the transport connects (see
   *  NetworkReceiveSystem's "connected" dispatch) — the server-side counterpart of
   *  setAuthValidator()/addClient()'s token check. */
  connect(url: string, token: string = ""): void {
    this.receiveSystem.localConnectToken = token;
    this.transport.connect(url);
  }

  disconnect(): void {
    this.transport.disconnect();
  }

  registerReplicatedComponent(...defs: ComponentDef[]): void {
    this.registry.register(...defs);
    this.snapshotManager.registerReplicatedComponents(...defs);
  }

  /** Registers additional input action names. Must be called identically (same names, same
   *  order) on both the client and server NetworkManager before any Input messages using
   *  them are sent — see NetworkConfig.actions for registering them all up front instead. */
  registerAction(...names: string[]): void {
    this.actions.register(...names);
  }

  setInputCollector(collector: () => InputPayload): void {
    this.sendSystem.setInputCollector(collector);
  }

  setReconcileCallback(fn: (serverTick: number, inputs: InputPayload[]) => void): void {
    this.receiveSystem.onReconcile = fn;
  }

  registerEntity(eid: number, networkId: number): void {
    this.receiveSystem.registerEntity(eid, networkId);
  }

  // Server API

  /** Registers an auth check consulted by addClient() before a client is trusted. Return
   *  true to accept the connection, false to reject it (the transport is disconnected and
   *  never registered — no snapshots/inputs flow to or from it). */
  setAuthValidator(fn: ((clientId: number, token: string) => boolean) | null): void {
    this.authValidator = fn;
  }

  /** Registers a server-side client connection. Returns false (and disconnects the
   *  transport without registering it anywhere) if an auth validator is configured and
   *  rejects `token` — otherwise the client is accepted exactly as before. `token` defaults
   *  to "" for callers that don't do wire-level auth (matches pre-existing behavior when no
   *  validator is set). */
  addClient(clientId: number, clientTransport: Transport, token: string = ""): boolean {
    if (this.authValidator && !this.authValidator(clientId, token)) {
      console.warn(`[Network] Rejecting client ${clientId}: auth validator declined the connection`);
      clientTransport.disconnect();
      return false;
    }
    this.sendSystem.addClient(clientId, clientTransport);
    this.receiveSystem.addClientTransport(clientId, clientTransport);
    // AUDIT FIX: writeConnectAck() previously had zero call sites -- a client's localClientId
    // (set by NetworkReceiveSystem's ConnectAck handler) stayed -1 forever unless a game bypassed
    // this layer entirely to send its own. Sending it here means host code accepting a connection
    // and calling addClient() with a token it already validated out-of-band doesn't also have to
    // wait for the wire-level Connect message (see onConnectRequest above) to get acknowledged.
    this.sendConnectAck(clientId, clientTransport);
    return true;
  }

  removeClient(clientId: number): void {
    this.sendSystem.removeClient(clientId);
    this.receiveSystem.removeClientTransport(clientId);
  }

  updateClientPosition(clientId: number, pos: { x: number; y: number; z: number }): void {
    this.sendSystem.updateClientPosition(clientId, pos);
  }

  ackClient(clientId: number, tick: number): void {
    this.sendSystem.ackClient(clientId, tick);
  }

  // Queries

  getEntityByNetworkId(networkId: number): number | undefined {
    return this.receiveSystem.getEntityByNetworkId(networkId);
  }

  getNetworkId(eid: number): number | undefined {
    return this.receiveSystem.getNetworkId(eid);
  }

  get isConnected(): boolean {
    return this.transport.state === "connected";
  }

  get localClientId(): number {
    return this.receiveSystem.localClientId;
  }

  get currentTick(): number {
    return this.sendSystem.currentTick;
  }

  get rtt(): number {
    return this.transport.rtt;
  }

  get lastReceivedTick(): number {
    return this.receiveSystem.lastReceivedTick;
  }

  destroy(): void {
    this.disconnect();
    this.world.removeSystem(this.receiveSystem);
    this.world.removeSystem(this.sendSystem);
  }
}
