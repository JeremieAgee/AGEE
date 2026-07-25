import { World } from "../ecs";
import { ComponentDef } from "../ecs/Component";
import { Transform, Velocity } from "../core/Components";
import { Transport } from "./transport/Transport";
import { WebSocketTransport } from "./transport/WebSocketTransport";
import { ComponentRegistry } from "./NetworkProtocol";
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
}

export class NetworkManager {
  readonly role: NetworkRole;
  readonly registry: ComponentRegistry;
  readonly snapshotManager: SnapshotManager;
  readonly inputBuffer: InputBuffer;
  readonly interestManager: InterestManager | null;
  readonly receiveSystem: NetworkReceiveSystem;
  readonly sendSystem: NetworkSendSystem;

  private transport: Transport;
  private world: World;

  constructor(world: World, config: NetworkConfig) {
    this.world = world;
    this.role = config.role;

    this.registry = new ComponentRegistry();
    this.registry.register(Transform, Velocity, Replicated);

    if (config.replicatedComponents) {
      this.registry.register(...config.replicatedComponents);
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
    );

    this.sendSystem = new NetworkSendSystem();
    this.sendSystem.configure(
      this.transport,
      this.snapshotManager,
      this.registry,
      this.inputBuffer,
      config.role,
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

  connect(url: string): void {
    this.transport.connect(url);
  }

  disconnect(): void {
    this.transport.disconnect();
  }

  registerReplicatedComponent(...defs: ComponentDef[]): void {
    this.registry.register(...defs);
    this.snapshotManager.registerReplicatedComponents(...defs);
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

  addClient(clientId: number, clientTransport: Transport): void {
    this.sendSystem.addClient(clientId, clientTransport);
    this.receiveSystem.addClientTransport(clientId, clientTransport);
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
