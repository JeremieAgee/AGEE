import { ConnectionState, NETWORK_CONSTANTS } from "../NetworkTypes";
import { Transport, TransportEvent } from "./Transport";

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private pendingEvents: TransportEvent[] = [];
  private _state: ConnectionState = "disconnected";
  private _rtt = 0;
  private pingTimestamp = 0;

  get state(): ConnectionState { return this._state; }
  get rtt(): number { return this._rtt; }

  connect(url: string): void {
    if (this._state !== "disconnected") return;
    this._state = "connecting";

    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this._state = "connected";
      this.pendingEvents.push({ type: "connected" });
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        // Reject oversized messages before they're ever queued/parsed — without this, an
        // arbitrarily large payload gets fully buffered and handed to BinaryReader regardless
        // of legitimacy, letting a single hostile message force unbounded allocation.
        if (ev.data.byteLength > NETWORK_CONSTANTS.MAX_MESSAGE_BYTES) {
          console.warn(`[Network] Dropping oversized message (${ev.data.byteLength} bytes > ${NETWORK_CONSTANTS.MAX_MESSAGE_BYTES} limit); closing connection`);
          this.ws?.close();
          return;
        }
        this.pendingEvents.push({ type: "message", data: ev.data });
      }
    };

    this.ws.onclose = (ev: CloseEvent) => {
      this._state = "disconnected";
      this.pendingEvents.push({ type: "disconnected", reason: ev.reason || "closed" });
      this.ws = null;
    };

    this.ws.onerror = () => {
      this.pendingEvents.push({ type: "error", error: new Error("WebSocket error") });
    };
  }

  disconnect(): void {
    if (!this.ws) return;
    this._state = "disconnecting";
    this.ws.close();
  }

  send(data: ArrayBuffer): void {
    if (this._state !== "connected" || !this.ws) return;
    this.ws.send(data);
  }

  poll(): TransportEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  sendPing(): void {
    this.pingTimestamp = performance.now();
  }

  receivePong(): void {
    if (this.pingTimestamp > 0) {
      this._rtt = performance.now() - this.pingTimestamp;
      this.pingTimestamp = 0;
    }
  }
}
