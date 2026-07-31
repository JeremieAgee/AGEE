export type NetworkRole = "client" | "server" | "none";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "disconnecting";

// Entity spawn/despawn is carried by DeltaEntry.spawned/despawned flags inside a
// DeltaSnapshot message (see NetworkProtocol's writeDeltaSnapshot/readDeltaSnapshot and
// SnapshotManager.applySnapshotToWorld), not as standalone messages — there is deliberately
// no MessageType.Spawn/Despawn.
export const enum MessageType {
  Connect = 1,
  ConnectAck = 2,
  Disconnect = 3,
  Snapshot = 4,
  DeltaSnapshot = 5,
  Input = 6,
  InputAck = 7,
  Ping = 10,
  Pong = 11,
}

export const NETWORK_CONSTANTS = {
  MAX_CLIENTS: 32,
  SNAPSHOT_BUFFER_SIZE: 64,
  INPUT_BUFFER_SIZE: 128,
  SERVER_TICK_RATE: 20,
  PROTOCOL_VERSION: 1,
  INVALID_NETWORK_ID: 0,
  SERVER_CLIENT_ID: -1,
  // Used both to decide whether a replicated field changed enough to include in a delta
  // (SnapshotManager.createDelta) and how far a client's predicted position may diverge from
  // the server's before reconciling (NetworkReceiveSystem.reconcile). Quantized wire fields
  // (see NetworkProtocol's QUANTIZE_SCALE=100) have a step size of 0.01 world units and up to
  // ~0.005 units of rounding error — the previous value here (1e-4) sat well *below* that noise
  // floor, so quantization rounding alone could exceed it and trigger spurious reconciliation
  // (or spurious "changed" deltas) on an entity that hadn't actually moved. This sits safely
  // above the rounding error while still catching any motion large enough to actually round to
  // a different quantized value.
  POSITION_EPSILON: 0.02,
  DEFAULT_RELEVANCE_RADIUS: 200,
  DEFAULT_RENDER_DELAY_MS: 100,
  // Generous enough for a full Snapshot of a large scene, but bounded — without a cap, an
  // arbitrarily large inbound ArrayBuffer gets fully queued and handed to BinaryReader before
  // any validation runs, letting a single hostile message allocate as much memory as it likes.
  MAX_MESSAGE_BYTES: 262144, // 256 KiB
} as const;

export interface InputPayload {
  tick: number;
  clientId: number;
  actions: Map<string, number>;
}

export interface SnapshotEntry {
  networkId: number;
  components: Map<string, Map<string, number>>;
}

export interface Snapshot {
  tick: number;
  entries: SnapshotEntry[];
}

export interface DeltaEntry {
  networkId: number;
  spawned: boolean;
  despawned: boolean;
  components: Map<string, Map<string, number>>;
}

export interface DeltaSnapshot {
  baseTick: number;
  tick: number;
  entries: DeltaEntry[];
}
