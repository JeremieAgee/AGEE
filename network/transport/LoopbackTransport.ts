import { ConnectionState } from "../NetworkTypes";
import { Transport, TransportEvent } from "./Transport";

export class LoopbackTransport implements Transport {
  private peer: LoopbackTransport | null = null;
  private pendingEvents: TransportEvent[] = [];
  private _state: ConnectionState = "disconnected";

  get state(): ConnectionState { return this._state; }
  get rtt(): number { return 0; }

  connect(_url: string): void {
    this._state = "connected";
    this.pendingEvents.push({ type: "connected" });
    if (this.peer && this.peer._state === "disconnected") {
      this.peer._state = "connected";
      this.peer.pendingEvents.push({ type: "connected" });
    }
  }

  disconnect(): void {
    this._state = "disconnected";
    this.pendingEvents.push({ type: "disconnected", reason: "local disconnect" });
    if (this.peer && this.peer._state === "connected") {
      this.peer._state = "disconnected";
      this.peer.pendingEvents.push({ type: "disconnected", reason: "peer disconnected" });
    }
  }

  send(data: ArrayBuffer): void {
    if (this._state !== "connected" || !this.peer) return;
    const copy = data.slice(0);
    this.peer.pendingEvents.push({ type: "message", data: copy });
  }

  poll(): TransportEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  static createPair(): { client: LoopbackTransport; server: LoopbackTransport } {
    const client = new LoopbackTransport();
    const server = new LoopbackTransport();
    client.peer = server;
    server.peer = client;
    return { client, server };
  }
}
