export type NetworkRole = "client" | "server" | "none";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "disconnecting";

export const enum MessageType {
  Connect = 1,
  ConnectAck = 2,
  Disconnect = 3,
  Snapshot = 4,
  DeltaSnapshot = 5,
  Input = 6,
  InputAck = 7,
  Spawn = 8,
  Despawn = 9,
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
  POSITION_EPSILON: 1e-4,
  DEFAULT_RELEVANCE_RADIUS: 200,
  DEFAULT_RENDER_DELAY_MS: 100,
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
