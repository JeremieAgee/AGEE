import { ConnectionState, NETWORK_CONSTANTS } from "../NetworkTypes";
import { Transport, TransportEvent } from "./Transport";

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private pendingEvents: TransportEvent[] = [];
  private _state: ConnectionState = "disconnected";
  private _rtt = 0;
  private pingTimestamp = 0;

  // Messages handed to send() while the socket hasn't reached OPEN yet (right after connect(),
  // or while a reconnect attempt is in flight) are held here and flushed in order once onopen
  // fires, instead of being silently dropped.
  private sendQueue: ArrayBuffer[] = [];
  private url: string | null = null;
  private intentionalDisconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  // Exponential backoff (1s, 2s, 4s, 8s, 16s) capped so a prolonged outage neither hammers the
  // server with reconnect attempts nor leaves the client waiting unreasonably long between tries.
  private static readonly RECONNECT_BASE_DELAY_MS = 1000;
  private static readonly RECONNECT_MAX_DELAY_MS = 16000;

  get state(): ConnectionState { return this._state; }
  get rtt(): number { return this._rtt; }

  // Not part of the Transport interface (mirrors the existing sendPing()/receivePong() pattern
  // already duck-typed by NetworkSendSystem) — lets callers check outbound congestion without
  // reaching into the raw WebSocket themselves.
  get bufferedAmount(): number {
    return this.ws ? this.ws.bufferedAmount : 0;
  }

  connect(url: string): void {
    if (this._state !== "disconnected") return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.url = url;
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;
    this.openSocket(url);
  }

  private openSocket(url: string): void {
    this._state = "connecting";

    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this._state = "connected";
      this.reconnectAttempts = 0;
      this.pendingEvents.push({ type: "connected" });
      this.flushQueue();
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
      const wasIntentional = this.intentionalDisconnect;
      this._state = "disconnected";
      this.pendingEvents.push({ type: "disconnected", reason: ev.reason || "closed" });
      this.ws = null;

      if (!wasIntentional && this.url) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.pendingEvents.push({ type: "error", error: new Error("WebSocket error") });
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= WebSocketTransport.MAX_RECONNECT_ATTEMPTS) return;
    const attempt = this.reconnectAttempts++;
    const delay = Math.min(
      WebSocketTransport.RECONNECT_BASE_DELAY_MS * 2 ** attempt,
      WebSocketTransport.RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.url) this.openSocket(this.url);
    }, delay);
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.ws) return;
    this._state = "disconnecting";
    this.ws.close();
  }

  send(data: ArrayBuffer): void {
    if (this._state === "connected" && this.ws) {
      this.ws.send(data);
      return;
    }
    if (this._state === "connecting") {
      this.sendQueue.push(data);
    }
  }

  private flushQueue(): void {
    if (!this.ws || this.sendQueue.length === 0) return;
    const queued = this.sendQueue;
    this.sendQueue = [];
    for (const data of queued) {
      this.ws.send(data);
    }
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
