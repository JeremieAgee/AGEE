export interface FrameStats {
  frameTime: number;
  fps: number;
  systemTimes: Map<string, number>;
  entityCount: number;
  componentStoreCount: number;
  queryCount: number;
  visibleCount: number;
  culledCount: number;
  drawCalls: number;
  triangles: number;
  textureCount: number;
  geometryCount: number;
  physicsBodyCount: number;
  activeParticles: number;
  assetCount: number;
  vramEstimate: number;
}

export interface ProfilerConfig {
  enabled: boolean;
  historyLength: number;
  trackSystems: boolean;
  trackMemory: boolean;
  trackRendering: boolean;
}

const DEFAULT_CONFIG: ProfilerConfig = {
  enabled: true,
  historyLength: 120,
  trackSystems: true,
  trackMemory: true,
  trackRendering: true,
};

function createEmptyFrameStats(): FrameStats {
  return {
    frameTime: 0,
    fps: 0,
    systemTimes: new Map(),
    entityCount: 0,
    componentStoreCount: 0,
    queryCount: 0,
    visibleCount: 0,
    culledCount: 0,
    drawCalls: 0,
    triangles: 0,
    textureCount: 0,
    geometryCount: 0,
    physicsBodyCount: 0,
    activeParticles: 0,
    assetCount: 0,
    vramEstimate: 0,
  };
}

export class EngineProfiler {
  private config: ProfilerConfig;
  private history: FrameStats[];
  private historyIndex: number;
  private historyCount: number;
  private currentFrame: FrameStats;
  private frameStartTime: number;
  private systemTimers: Map<string, number>;

  constructor(config?: Partial<ProfilerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.historyIndex = 0;
    this.historyCount = 0;
    this.frameStartTime = 0;
    this.systemTimers = new Map();
    this.currentFrame = createEmptyFrameStats();

    // Pre-allocate the circular buffer
    this.history = new Array(this.config.historyLength);
    for (let i = 0; i < this.config.historyLength; i++) {
      this.history[i] = createEmptyFrameStats();
    }
  }

  // -- Frame lifecycle --

  beginFrame(): void {
    if (!this.config.enabled) return;
    this.frameStartTime = performance.now();
    // Reset mutable fields on currentFrame without reallocating
    const f = this.currentFrame;
    f.frameTime = 0;
    f.fps = 0;
    f.systemTimes.clear();
    f.entityCount = 0;
    f.componentStoreCount = 0;
    f.queryCount = 0;
    f.visibleCount = 0;
    f.culledCount = 0;
    f.drawCalls = 0;
    f.triangles = 0;
    f.textureCount = 0;
    f.geometryCount = 0;
    f.physicsBodyCount = 0;
    f.activeParticles = 0;
    f.assetCount = 0;
    f.vramEstimate = 0;
    this.systemTimers.clear();
  }

  endFrame(): void {
    if (!this.config.enabled) return;
    const now = performance.now();
    const elapsed = now - this.frameStartTime;
    this.currentFrame.frameTime = elapsed;
    this.currentFrame.fps = elapsed > 0 ? 1000 / elapsed : 0;

    // Copy currentFrame into the circular buffer slot (no allocation)
    const slot = this.history[this.historyIndex];
    slot.frameTime = this.currentFrame.frameTime;
    slot.fps = this.currentFrame.fps;
    slot.entityCount = this.currentFrame.entityCount;
    slot.componentStoreCount = this.currentFrame.componentStoreCount;
    slot.queryCount = this.currentFrame.queryCount;
    slot.visibleCount = this.currentFrame.visibleCount;
    slot.culledCount = this.currentFrame.culledCount;
    slot.drawCalls = this.currentFrame.drawCalls;
    slot.triangles = this.currentFrame.triangles;
    slot.textureCount = this.currentFrame.textureCount;
    slot.geometryCount = this.currentFrame.geometryCount;
    slot.physicsBodyCount = this.currentFrame.physicsBodyCount;
    slot.activeParticles = this.currentFrame.activeParticles;
    slot.assetCount = this.currentFrame.assetCount;
    slot.vramEstimate = this.currentFrame.vramEstimate;

    // Copy system times map
    slot.systemTimes.clear();
    this.currentFrame.systemTimes.forEach((value, key) => {
      slot.systemTimes.set(key, value);
    });

    this.historyIndex = (this.historyIndex + 1) % this.config.historyLength;
    if (this.historyCount < this.config.historyLength) {
      this.historyCount++;
    }
  }

  // -- System timing --

  beginSystem(name: string): void {
    if (!this.config.enabled || !this.config.trackSystems) return;
    this.systemTimers.set(name, performance.now());
  }

  endSystem(name: string): void {
    if (!this.config.enabled || !this.config.trackSystems) return;
    const start = this.systemTimers.get(name);
    if (start === undefined) return;
    const elapsed = performance.now() - start;
    const existing = this.currentFrame.systemTimes.get(name) ?? 0;
    this.currentFrame.systemTimes.set(name, existing + elapsed);
  }

  // -- Manual stat setters --

  setEntityCount(count: number): void {
    if (!this.config.enabled) return;
    this.currentFrame.entityCount = count;
  }

  setVisibleCount(visible: number, culled: number): void {
    if (!this.config.enabled || !this.config.trackRendering) return;
    this.currentFrame.visibleCount = visible;
    this.currentFrame.culledCount = culled;
  }

  setRenderStats(drawCalls: number, triangles: number): void {
    if (!this.config.enabled || !this.config.trackRendering) return;
    this.currentFrame.drawCalls = drawCalls;
    this.currentFrame.triangles = triangles;
  }

  setTextureCount(count: number): void {
    if (!this.config.enabled || !this.config.trackRendering) return;
    this.currentFrame.textureCount = count;
  }

  setGeometryCount(count: number): void {
    if (!this.config.enabled || !this.config.trackRendering) return;
    this.currentFrame.geometryCount = count;
  }

  setPhysicsBodyCount(count: number): void {
    if (!this.config.enabled) return;
    this.currentFrame.physicsBodyCount = count;
  }

  setActiveParticles(count: number): void {
    if (!this.config.enabled) return;
    this.currentFrame.activeParticles = count;
  }

  setAssetCount(count: number): void {
    if (!this.config.enabled || !this.config.trackMemory) return;
    this.currentFrame.assetCount = count;
  }

  setVRAMEstimate(bytes: number): void {
    if (!this.config.enabled || !this.config.trackMemory) return;
    this.currentFrame.vramEstimate = bytes;
  }

  setComponentStoreCount(count: number): void {
    if (!this.config.enabled) return;
    this.currentFrame.componentStoreCount = count;
  }

  setQueryCount(count: number): void {
    if (!this.config.enabled) return;
    this.currentFrame.queryCount = count;
  }

  // -- Query --

  getLatest(): FrameStats | null {
    if (this.historyCount === 0) return null;
    // The most recent entry is one slot behind the write cursor
    const idx =
      (this.historyIndex - 1 + this.config.historyLength) %
      this.config.historyLength;
    return this.history[idx];
  }

  getHistory(): readonly FrameStats[] {
    if (this.historyCount === 0) return [];
    // Return frames in chronological order (oldest first)
    const result: FrameStats[] = new Array(this.historyCount);
    const start =
      this.historyCount < this.config.historyLength
        ? 0
        : this.historyIndex; // oldest slot when buffer is full
    for (let i = 0; i < this.historyCount; i++) {
      result[i] = this.history[(start + i) % this.config.historyLength];
    }
    return result;
  }

  getAverageFPS(frames?: number): number {
    const count = Math.min(frames ?? this.historyCount, this.historyCount);
    if (count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const idx =
        (this.historyIndex - 1 - i + this.config.historyLength * 2) %
        this.config.historyLength;
      sum += this.history[idx].fps;
    }
    return sum / count;
  }

  getAverageFrameTime(frames?: number): number {
    const count = Math.min(frames ?? this.historyCount, this.historyCount);
    if (count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const idx =
        (this.historyIndex - 1 - i + this.config.historyLength * 2) %
        this.config.historyLength;
      sum += this.history[idx].frameTime;
    }
    return sum / count;
  }

  getSlowestSystem(): { name: string; time: number } | null {
    const latest = this.getLatest();
    if (!latest || latest.systemTimes.size === 0) return null;
    let slowestName = '';
    let slowestTime = -1;
    latest.systemTimes.forEach((time, name) => {
      if (time > slowestTime) {
        slowestTime = time;
        slowestName = name;
      }
    });
    return { name: slowestName, time: slowestTime };
  }

  // -- Control --

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  reset(): void {
    this.historyIndex = 0;
    this.historyCount = 0;
    this.frameStartTime = 0;
    this.systemTimers.clear();
    this.currentFrame.systemTimes.clear();
    for (let i = 0; i < this.config.historyLength; i++) {
      const slot = this.history[i];
      slot.frameTime = 0;
      slot.fps = 0;
      slot.systemTimes.clear();
      slot.entityCount = 0;
      slot.componentStoreCount = 0;
      slot.queryCount = 0;
      slot.visibleCount = 0;
      slot.culledCount = 0;
      slot.drawCalls = 0;
      slot.triangles = 0;
      slot.textureCount = 0;
      slot.geometryCount = 0;
      slot.physicsBodyCount = 0;
      slot.activeParticles = 0;
      slot.assetCount = 0;
      slot.vramEstimate = 0;
    }
  }
}
