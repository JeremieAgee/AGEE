import * as THREE from "three";
import { System, World, ComponentStore } from "../ecs";
import { Transform, ParticleEmitter } from "../core/Components";
import { Handle, HandleMap } from "../core/handles/Handle";

interface EmitterData {
  maxParticles: number;
  alive: number;
  accumulator: number;
  emitRate: number;
  lifetime: number;
  speed: number;
  spread: number;
  startSize: number;
  endSize: number;
  startColor: number;
  endColor: number;
  gravity: number;
  drag: number;

  // SOA particle columns
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  size: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;

  // Three.js rendering objects
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  points: THREE.Points;
  posAttr: THREE.BufferAttribute;
  sizeAttr: THREE.BufferAttribute;
  colorAttr: THREE.BufferAttribute;
}

function unpackColor(c: number): [number, number, number] {
  return [
    ((c >> 16) & 0xFF) / 255,
    ((c >> 8) & 0xFF) / 255,
    (c & 0xFF) / 255,
  ];
}

export class ParticleSystemEngine extends System {
  priority = 700;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  static reads = ["Transform", "ParticleEmitter"];
  static writes: string[] = [];

  private transformStore!: ComponentStore;
  private emitterStore!: ComponentStore;
  private query!: ReturnType<World["query"]>;
  private emitterPool = new HandleMap<EmitterData>();
  private scene!: THREE.Scene;
  private _activeParticleCount = 0;

  get activeParticleCount(): number { return this._activeParticleCount; }

  setScene(scene: THREE.Scene): void {
    this.scene = scene;
  }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
    this.emitterStore = this.world.getStore(ParticleEmitter);
    this.query = this.world.query(Transform, ParticleEmitter);
  }

  createEmitter(
    eid: number,
    config: {
      maxParticles?: number;
      emitRate?: number;
      lifetime?: number;
      speed?: number;
      spread?: number;
      startSize?: number;
      endSize?: number;
      startColor?: number;
      endColor?: number;
      gravity?: number;
      drag?: number;
    } = {}
  ): Handle {
    const maxP = config.maxParticles ?? 200;

    const geometry = new THREE.BufferGeometry();
    const posArr = new Float32Array(maxP * 3);
    const sizeArr = new Float32Array(maxP);
    const colorArr = new Float32Array(maxP * 3);
    const posAttr = new THREE.BufferAttribute(posArr, 3);
    const sizeAttr = new THREE.BufferAttribute(sizeArr, 1);
    const colorAttr = new THREE.BufferAttribute(colorArr, 3);
    geometry.setAttribute("position", posAttr);
    geometry.setAttribute("size", sizeAttr);
    geometry.setAttribute("color", colorAttr);

    const material = new THREE.PointsMaterial({
      size: config.startSize ?? 0.3,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      vertexColors: true,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    if (this.scene) this.scene.add(points);

    const emitter: EmitterData = {
      maxParticles: maxP,
      alive: 0,
      accumulator: 0,
      emitRate: config.emitRate ?? 30,
      lifetime: config.lifetime ?? 2,
      speed: config.speed ?? 3,
      spread: config.spread ?? 2,
      startSize: config.startSize ?? 0.3,
      endSize: config.endSize ?? 0.05,
      startColor: config.startColor ?? 0xff6600,
      endColor: config.endColor ?? 0xffcc00,
      gravity: config.gravity ?? -9.81,
      drag: config.drag ?? 0,

      px: new Float32Array(maxP),
      py: new Float32Array(maxP),
      pz: new Float32Array(maxP),
      vx: new Float32Array(maxP),
      vy: new Float32Array(maxP),
      vz: new Float32Array(maxP),
      life: new Float32Array(maxP),
      maxLife: new Float32Array(maxP),
      size: new Float32Array(maxP),
      r: new Float32Array(maxP),
      g: new Float32Array(maxP),
      b: new Float32Array(maxP),

      geometry, material, points, posAttr, sizeAttr, colorAttr,
    };

    const handle = this.emitterPool.alloc(emitter);

    this.world.addComponent(eid, ParticleEmitter, {
      systemRef: handle,
      maxParticles: maxP,
      emitRate: emitter.emitRate,
      lifetime: emitter.lifetime,
      speed: emitter.speed,
      spread: emitter.spread,
      startSize: emitter.startSize,
      endSize: emitter.endSize,
      startColor: emitter.startColor,
      endColor: emitter.endColor,
      active: 1,
    });

    return handle;
  }

  update(dt: number): void {
    const entities = this.query.entities;
    const tx = this.transformStore.getColumn("x");
    const ty = this.transformStore.getColumn("y");
    const tz = this.transformStore.getColumn("z");
    let totalParticles = 0;

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const handle = this.emitterStore.get(eid, "systemRef") as Handle;
      const e = this.emitterPool.get(handle);
      if (!e) continue;

      const active = this.emitterStore.get(eid, "active") !== 0;
      const ox = tx[eid];
      const oy = ty[eid];
      const oz = tz[eid];

      const [sr, sg, sb] = unpackColor(e.startColor);
      const [er, eg, eb] = unpackColor(e.endColor);

      let alive = e.alive;
      for (let p = 0; p < alive; p++) {
        e.life[p] -= dt;
        if (e.life[p] <= 0) {
          alive--;
          e.px[p] = e.px[alive]; e.py[p] = e.py[alive]; e.pz[p] = e.pz[alive];
          e.vx[p] = e.vx[alive]; e.vy[p] = e.vy[alive]; e.vz[p] = e.vz[alive];
          e.life[p] = e.life[alive]; e.maxLife[p] = e.maxLife[alive];
          e.size[p] = e.size[alive];
          e.r[p] = e.r[alive]; e.g[p] = e.g[alive]; e.b[p] = e.b[alive];
          p--;
          continue;
        }

        // Apply gravity
        e.vy[p] += e.gravity * dt;

        // Apply drag
        if (e.drag > 0) {
          const factor = 1 - e.drag * dt;
          e.vx[p] *= factor;
          e.vy[p] *= factor;
          e.vz[p] *= factor;
        }

        e.px[p] += e.vx[p] * dt;
        e.py[p] += e.vy[p] * dt;
        e.pz[p] += e.vz[p] * dt;

        const t = 1 - e.life[p] / e.maxLife[p];
        e.size[p] = e.startSize + (e.endSize - e.startSize) * t;

        // Color interpolation
        e.r[p] = sr + (er - sr) * t;
        e.g[p] = sg + (eg - sg) * t;
        e.b[p] = sb + (eb - sb) * t;
      }
      e.alive = alive;

      // Emit new particles
      if (active) {
        e.accumulator += dt;
        const interval = 1 / e.emitRate;
        while (e.accumulator >= interval && e.alive < e.maxParticles) {
          const idx = e.alive;
          e.px[idx] = ox;
          e.py[idx] = oy;
          e.pz[idx] = oz;
          e.vx[idx] = (Math.random() - 0.5) * e.spread;
          e.vy[idx] = Math.random() * e.speed;
          e.vz[idx] = (Math.random() - 0.5) * e.spread;
          e.life[idx] = e.lifetime;
          e.maxLife[idx] = e.lifetime;
          e.size[idx] = e.startSize;
          e.r[idx] = sr; e.g[idx] = sg; e.b[idx] = sb;
          e.alive++;
          e.accumulator -= interval;
        }
      }

      // Write SOA data into GPU buffers
      const posArr = e.posAttr.array as Float32Array;
      const sizeArr = e.sizeAttr.array as Float32Array;
      const colorArr = e.colorAttr.array as Float32Array;
      for (let p = 0; p < e.alive; p++) {
        posArr[p * 3] = e.px[p];
        posArr[p * 3 + 1] = e.py[p];
        posArr[p * 3 + 2] = e.pz[p];
        sizeArr[p] = e.size[p];
        colorArr[p * 3] = e.r[p];
        colorArr[p * 3 + 1] = e.g[p];
        colorArr[p * 3 + 2] = e.b[p];
      }
      for (let p = e.alive; p < e.maxParticles; p++) {
        sizeArr[p] = 0;
      }
      e.posAttr.needsUpdate = true;
      e.sizeAttr.needsUpdate = true;
      e.colorAttr.needsUpdate = true;
      e.geometry.setDrawRange(0, e.alive);

      totalParticles += e.alive;
    }
    this._activeParticleCount = totalParticles;
  }

  destroy(): void {
    const entities = this.query?.entities ?? [];
    for (const eid of entities) {
      const handle = this.emitterStore.get(eid, "systemRef") as Handle;
      const e = this.emitterPool.get(handle);
      if (e) {
        e.geometry.dispose();
        e.material.dispose();
        if (this.scene) this.scene.remove(e.points);
        this.emitterPool.free(handle);
      }
    }
  }
}
