import { ChunkBuildRequest, ChunkBuildResult } from "./TerrainChunkBuilder";
import type { TerrainWorkerRequest, TerrainWorkerResponse } from "./terrain.worker";

// Feature-detects the Worker API and, when available, spins up a single terrain.worker.ts
// instance to offload chunk generation off the main thread. In environments without Worker
// (headless/Node, tests, or a browser build that failed to start one) `active` stays false and
// TerrainSystem falls back to calling buildChunkData() inline on the main thread instead —
// same output, just synchronous and not offloaded.
export class TerrainWorkerClient {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, { resolve: (r: ChunkBuildResult) => void; reject: (e: unknown) => void }>();

  constructor() {
    if (typeof Worker === "undefined") return;

    try {
      this.worker = new Worker(new URL("./terrain.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<TerrainWorkerResponse>) => this.handleMessage(e.data);
      this.worker.onerror = (e: ErrorEvent) => this.handleError(e);
    } catch (err) {
      // Some environments expose a `Worker` global but can't actually construct one (e.g. no
      // module-worker support, or the worker script fails to resolve) — treat that the same as
      // Worker being unavailable rather than throwing out of TerrainSystem's constructor.
      console.warn("[AGEE] Failed to start terrain worker, falling back to main-thread chunk generation:", err);
      this.worker = null;
    }
  }

  get active(): boolean {
    return this.worker !== null;
  }

  build(req: ChunkBuildRequest): Promise<ChunkBuildResult> {
    if (!this.worker) return Promise.reject(new Error("[AGEE] TerrainWorkerClient: no worker active"));

    const requestId = this.nextRequestId++;
    const message: TerrainWorkerRequest = { ...req, requestId };
    return new Promise<ChunkBuildResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker!.postMessage(message);
    });
  }

  private handleMessage(data: TerrainWorkerResponse): void {
    const entry = this.pending.get(data.requestId);
    if (!entry) return; // stale/unknown response (e.g. already settled) — ignore
    this.pending.delete(data.requestId);
    const { requestId: _requestId, ...result } = data;
    entry.resolve(result);
  }

  private handleError(e: ErrorEvent): void {
    // A worker script error doesn't identify which in-flight request caused it, so reject
    // everything currently outstanding rather than leaving those promises hanging forever.
    for (const { reject } of this.pending.values()) reject(e);
    this.pending.clear();
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
