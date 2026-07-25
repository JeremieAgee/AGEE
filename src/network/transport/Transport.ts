import { ConnectionState } from "../NetworkTypes";

export type TransportEvent =
  | { type: "connected" }
  | { type: "disconnected"; reason: string }
  | { type: "message"; data: ArrayBuffer }
  | { type: "error"; error: Error };

export interface Transport {
  connect(url: string): void;
  disconnect(): void;
  send(data: ArrayBuffer): void;
  poll(): TransportEvent[];
  readonly state: ConnectionState;
  readonly rtt: number;
}
