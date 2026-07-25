import { System } from "../../ecs";

interface ProfilerLike {
  isEnabled(): boolean;
  getLatest(): {
    frameTime: number;
    fps: number;
    systemTimes: Map<string, number>;
    entityCount: number;
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
  } | null;
  getHistory(): readonly { frameTime: number }[];
}

function formatK(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function fpsColor(fps: number): string {
  if (fps > 55) return "#0f0";
  if (fps > 30) return "#ff0";
  return "#f00";
}

export class DebugOverlay extends System {
  priority = 999;
  phase = "render" as const;

  private container!: HTMLDivElement;
  private graphCanvas!: HTMLCanvasElement;
  private graphCtx!: CanvasRenderingContext2D;
  private statsEl!: HTMLPreElement;
  private profiler: ProfilerLike | null = null;
  private visible = false;
  private updateInterval = 0.1;
  private accumulator = 0;

  setProfiler(profiler: ProfilerLike): void {
    this.profiler = profiler;
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  show(): void {
    this.visible = true;
    if (this.container) {
      this.container.style.display = "block";
    }
  }

  hide(): void {
    this.visible = false;
    if (this.container) {
      this.container.style.display = "none";
    }
  }

  init(): void {
    this.container = document.createElement("div");
    this.container.id = "debug-overlay";
    Object.assign(this.container.style, {
      position: "fixed",
      top: "0",
      left: "0",
      zIndex: "99999",
      pointerEvents: "none",
      padding: "8px",
      backgroundColor: "rgba(0,0,0,0.8)",
      color: "#fff",
      fontFamily: "monospace",
      fontSize: "12px",
      lineHeight: "1.4",
      display: this.visible ? "block" : "none",
    });

    this.statsEl = document.createElement("pre");
    Object.assign(this.statsEl.style, {
      margin: "0",
      padding: "0",
      fontFamily: "inherit",
      fontSize: "inherit",
      color: "inherit",
      whiteSpace: "pre",
    });

    this.graphCanvas = document.createElement("canvas");
    this.graphCanvas.width = 120;
    this.graphCanvas.height = 40;
    Object.assign(this.graphCanvas.style, {
      display: "block",
      marginTop: "4px",
      imageRendering: "pixelated",
    });
    this.graphCtx = this.graphCanvas.getContext("2d")!;

    this.container.appendChild(this.statsEl);
    this.container.appendChild(this.graphCanvas);
    document.body.appendChild(this.container);
  }

  update(dt: number): void {
    if (!this.visible || !this.profiler || !this.profiler.isEnabled()) return;

    this.accumulator += dt;
    if (this.accumulator < this.updateInterval) return;
    this.accumulator = 0;

    const stats = this.profiler.getLatest();
    if (!stats) return;

    this.updateStats(stats);
    this.drawGraph();
  }

  private updateStats(stats: NonNullable<ReturnType<ProfilerLike["getLatest"]>>): void {
    const lines: string[] = [];

    const fpsStr = `FPS: <span style="color:${fpsColor(stats.fps)}">${stats.fps.toFixed(0)}</span>`;
    lines.push(fpsStr);
    lines.push(`Frame: ${stats.frameTime.toFixed(1)}ms`);
    lines.push(`Entities: ${formatK(stats.entityCount)}`);
    lines.push(`Visible/Culled: ${formatK(stats.visibleCount)} / ${formatK(stats.culledCount)}`);
    lines.push(`Draws/Tris: ${formatK(stats.drawCalls)} / ${formatK(stats.triangles)}`);
    lines.push(`Physics: ${formatK(stats.physicsBodyCount)}`);
    lines.push(`Particles: ${formatK(stats.activeParticles)}`);
    lines.push(`Tex/Geo: ${stats.textureCount} / ${stats.geometryCount}`);
    lines.push(`Assets: ${stats.assetCount}`);
    lines.push(`VRAM: ${stats.vramEstimate.toFixed(1)}MB`);

    // System timing breakdown: top 5 slowest
    if (stats.systemTimes.size > 0) {
      const sorted = Array.from(stats.systemTimes.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      lines.push("--- Systems ---");
      for (const [name, time] of sorted) {
        const ms = time.toFixed(2);
        const padded = ms.padStart(6);
        lines.push(`${padded}ms ${name}`);
      }
    }

    this.statsEl.innerHTML = lines.join("\n");
  }

  private drawGraph(): void {
    const history = this.profiler!.getHistory();
    const ctx = this.graphCtx;
    const w = this.graphCanvas.width;
    const h = this.graphCanvas.height;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(0, 0, w, h);

    if (history.length === 0) return;

    // Take the last 60 frames
    const count = 60;
    const frames = history.length > count
      ? history.slice(history.length - count)
      : history;

    // Determine Y scale: max of 33ms or actual max frame time
    let maxTime = 33;
    for (const frame of frames) {
      if (frame.frameTime > maxTime) {
        maxTime = frame.frameTime;
      }
    }

    const targetMs = 16.67;

    // Draw 60fps target line (red)
    const targetY = h - (targetMs / maxTime) * h;
    ctx.strokeStyle = "#f00";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(0, targetY);
    ctx.lineTo(w, targetY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw frame time line (green)
    ctx.strokeStyle = "#0f0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = w / (count - 1);
    for (let i = 0; i < frames.length; i++) {
      const x = i * step;
      const y = h - (frames[i].frameTime / maxTime) * h;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  destroy(): void {
    this.container?.remove();
  }
}
