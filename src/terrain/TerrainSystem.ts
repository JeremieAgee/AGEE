import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { System } from "../ecs";
import { NoiseGenerator, NoiseConfig } from "./NoiseGenerator";

export interface TerrainConfig {
  chunkSize: number;
  resolution: number;
  streamRadius: number;
  maxHeight: number;
  noise: Partial<NoiseConfig>;
  material?: THREE.Material;
  colliders?: boolean;
  // Chunk (re)loading (noise generation + mesh build) is synchronous work; crossing a chunk
  // boundary or teleporting can otherwise require the whole new ring in a single frame. This
  // caps how many chunks load() actually does per update() call, spreading the rest across
  // subsequent frames (closest chunks first).
  maxChunkLoadsPerFrame: number;
}

const DEFAULT_TERRAIN_CONFIG: TerrainConfig = {
  chunkSize: 64,
  resolution: 65,
  streamRadius: 200,
  maxHeight: 50,
  noise: {},
  colliders: true,
  maxChunkLoadsPerFrame: 2,
};

const MAX_CHUNKS = 512;

export class TerrainSystem extends System {
  priority = 230;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "postPhysics";

  private config: TerrainConfig;
  private noise: NoiseGenerator;
  private scene!: THREE.Scene;
  private material!: THREE.Material;
  private rapierWorld: RAPIER.World | null = null;

  // SOA chunk columns
  private chunkCX: Int32Array;
  private chunkCZ: Int32Array;
  private chunkActive: Uint8Array;
  private chunkHeightmaps: Float32Array[];
  private chunkMeshes: (THREE.Mesh | null)[];
  private chunkBodies: (RAPIER.RigidBody | null)[];
  private chunkColliders: (RAPIER.Collider | null)[];
  private maxChunks: number;
  private chunkCount = 0;
  private freeSlots: number[] = [];

  private coordToSlot = new Map<string, number>();

  private cameraX = 0;
  private cameraZ = 0;
  private lastCamCX = Infinity;
  private lastCamCZ = Infinity;

  // Chunks known to be needed but not yet loaded, nearest-first; drained a few at a time
  // per update() call instead of all at once.
  private pendingLoads: { cx: number; cz: number }[] = [];
  private pendingSet = new Set<string>();

  constructor(config: Partial<TerrainConfig> = {}) {
    super();
    this.config = { ...DEFAULT_TERRAIN_CONFIG, ...config };
    this.noise = new NoiseGenerator(this.config.noise);
    this.maxChunks = MAX_CHUNKS;

    this.chunkCX = new Int32Array(this.maxChunks);
    this.chunkCZ = new Int32Array(this.maxChunks);
    this.chunkActive = new Uint8Array(this.maxChunks);
    this.chunkHeightmaps = new Array(this.maxChunks).fill(null);
    this.chunkMeshes = new Array(this.maxChunks).fill(null);
    this.chunkBodies = new Array(this.maxChunks).fill(null);
    this.chunkColliders = new Array(this.maxChunks).fill(null);
  }

  setScene(scene: THREE.Scene): void { this.scene = scene; }
  setMaterial(material: THREE.Material): void { this.material = material; }

  setPhysicsWorld(rapierWorld: RAPIER.World): void {
    this.rapierWorld = rapierWorld;
  }

  init(): void {
    if (!this.material) {
      this.material = new THREE.MeshStandardMaterial({ color: 0x558844, roughness: 0.9 });
    }
  }

  setCameraPosition(x: number, z: number): void {
    this.cameraX = x;
    this.cameraZ = z;
  }

  private allocSlot(): number {
    if (this.freeSlots.length > 0) return this.freeSlots.pop()!;
    if (this.chunkCount >= this.maxChunks) this.grow();
    return this.chunkCount++;
  }

  private grow(): void {
    const newMax = this.maxChunks * 2;
    const newCX = new Int32Array(newMax); newCX.set(this.chunkCX);
    const newCZ = new Int32Array(newMax); newCZ.set(this.chunkCZ);
    const newActive = new Uint8Array(newMax); newActive.set(this.chunkActive);
    this.chunkCX = newCX;
    this.chunkCZ = newCZ;
    this.chunkActive = newActive;
    this.chunkHeightmaps.length = newMax;
    this.chunkMeshes.length = newMax;
    this.chunkBodies.length = newMax;
    this.chunkColliders.length = newMax;
    for (let i = this.maxChunks; i < newMax; i++) {
      this.chunkHeightmaps[i] = null!;
      this.chunkMeshes[i] = null;
      this.chunkBodies[i] = null;
      this.chunkColliders[i] = null;
    }
    this.maxChunks = newMax;
  }

  getHeightAt(worldX: number, worldZ: number): number {
    const cs = this.config.chunkSize;
    const cx = Math.floor(worldX / cs);
    const cz = Math.floor(worldZ / cs);
    const key = `${cx},${cz}`;
    const slot = this.coordToSlot.get(key);

    if (slot === undefined) return this.noise.sample(worldX, worldZ);

    const hm = this.chunkHeightmaps[slot];
    if (!hm) return this.noise.sample(worldX, worldZ);

    const res = this.config.resolution;
    const localX = worldX - cx * cs;
    const localZ = worldZ - cz * cs;
    const fx = (localX / cs) * (res - 1);
    const fz = (localZ / cs) * (res - 1);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const ix1 = Math.min(ix + 1, res - 1);
    const iz1 = Math.min(iz + 1, res - 1);

    const h00 = hm[iz * res + ix];
    const h10 = hm[iz * res + ix1];
    const h01 = hm[iz1 * res + ix];
    const h11 = hm[iz1 * res + ix1];

    return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) +
           h01 * (1 - tx) * tz + h11 * tx * tz;
  }

  update(_dt: number): void {
    if (!this.scene) return;

    const cs = this.config.chunkSize;
    const camCX = Math.floor(this.cameraX / cs);
    const camCZ = Math.floor(this.cameraZ / cs);

    if (camCX !== this.lastCamCX || camCZ !== this.lastCamCZ) {
      this.lastCamCX = camCX;
      this.lastCamCZ = camCZ;

      const radius = Math.ceil(this.config.streamRadius / cs);
      const needed = new Set<string>();

      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.sqrt(dx * dx + dz * dz) * cs > this.config.streamRadius) continue;
          const cx = camCX + dx;
          const cz = camCZ + dz;
          const key = `${cx},${cz}`;
          needed.add(key);

          if (!this.coordToSlot.has(key) && !this.pendingSet.has(key)) {
            this.pendingSet.add(key);
            this.pendingLoads.push({ cx, cz });
          }
        }
      }

      // Nearest chunks load first, and any chunk that's fallen out of range while still
      // queued (e.g. the camera moved past it before it loaded) is dropped rather than
      // loaded just to be unloaded again next frame.
      this.pendingLoads = this.pendingLoads.filter(({ cx, cz }) => {
        const key = `${cx},${cz}`;
        if (!needed.has(key)) { this.pendingSet.delete(key); return false; }
        return true;
      });
      this.pendingLoads.sort((a, b) => {
        const da = (a.cx - camCX) ** 2 + (a.cz - camCZ) ** 2;
        const db = (b.cx - camCX) ** 2 + (b.cz - camCZ) ** 2;
        return da - db;
      });

      for (const [key, slot] of this.coordToSlot) {
        if (!needed.has(key)) {
          this.unloadChunk(slot, key);
        }
      }
    }

    const budget = Math.max(1, this.config.maxChunkLoadsPerFrame);
    for (let i = 0; i < budget && this.pendingLoads.length > 0; i++) {
      const { cx, cz } = this.pendingLoads.shift()!;
      this.pendingSet.delete(`${cx},${cz}`);
      if (!this.coordToSlot.has(`${cx},${cz}`)) {
        this.loadChunk(cx, cz);
      }
    }
  }

  private loadChunk(cx: number, cz: number): void {
    const slot = this.allocSlot();
    const cs = this.config.chunkSize;
    const res = this.config.resolution;
    const worldX = cx * cs;
    const worldZ = cz * cs;

    this.chunkCX[slot] = cx;
    this.chunkCZ[slot] = cz;
    this.chunkActive[slot] = 1;

    const hm = new Float32Array(res * res);
    this.noise.fillHeightmap(hm, res, worldX, worldZ, cs);
    this.chunkHeightmaps[slot] = hm;

    // Build mesh
    const geo = new THREE.BufferGeometry();
    const step = cs / (res - 1);
    const positions = new Float32Array(res * res * 3);
    const uvs = new Float32Array(res * res * 2);

    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const i = z * res + x;
        positions[i * 3] = x * step;
        positions[i * 3 + 1] = hm[i];
        positions[i * 3 + 2] = z * step;
        uvs[i * 2] = x / (res - 1);
        uvs[i * 2 + 1] = z / (res - 1);
      }
    }

    const indices: number[] = [];
    for (let z = 0; z < res - 1; z++) {
      for (let x = 0; x < res - 1; x++) {
        const tl = z * res + x;
        indices.push(tl, (z + 1) * res + x, tl + 1);
        indices.push(tl + 1, (z + 1) * res + x, (z + 1) * res + x + 1);
      }
    }

    geo.setIndex(indices);
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(worldX, 0, worldZ);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.chunkMeshes[slot] = mesh;

    // Build physics collider
    if (this.config.colliders && this.rapierWorld) {
      this.createChunkCollider(slot, cx, cz, hm);
    }

    this.coordToSlot.set(`${cx},${cz}`, slot);
  }

  private createChunkCollider(slot: number, cx: number, cz: number, hm: Float32Array): void {
    if (!this.rapierWorld) return;

    const cs = this.config.chunkSize;
    const res = this.config.resolution;
    const step = cs / (res - 1);
    const worldX = cx * cs;
    const worldZ = cz * cs;

    // Build trimesh from exact same geometry as the visual mesh
    // Guarantees physics surface matches visual surface exactly
    const vertices = new Float32Array(res * res * 3);
    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const i = z * res + x;
        vertices[i * 3] = worldX + x * step;
        vertices[i * 3 + 1] = hm[i];
        vertices[i * 3 + 2] = worldZ + z * step;
      }
    }

    const indices = new Uint32Array((res - 1) * (res - 1) * 6);
    let idx = 0;
    for (let z = 0; z < res - 1; z++) {
      for (let x = 0; x < res - 1; x++) {
        const tl = z * res + x;
        indices[idx++] = tl;
        indices[idx++] = (z + 1) * res + x;
        indices[idx++] = tl + 1;
        indices[idx++] = tl + 1;
        indices[idx++] = (z + 1) * res + x;
        indices[idx++] = (z + 1) * res + x + 1;
      }
    }

    const bodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(0, 0, 0);
    const body = this.rapierWorld.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.trimesh(vertices, indices);
    colliderDesc.setFriction(0.8);

    const collider = this.rapierWorld.createCollider(colliderDesc, body);

    this.chunkBodies[slot] = body;
    this.chunkColliders[slot] = collider;
  }

  private removeChunkCollider(slot: number): void {
    if (!this.rapierWorld) return;

    const body = this.chunkBodies[slot];
    if (body) {
      this.rapierWorld.removeRigidBody(body);
    }
    this.chunkBodies[slot] = null;
    this.chunkColliders[slot] = null;
  }

  private unloadChunk(slot: number, key: string): void {
    const mesh = this.chunkMeshes[slot];
    if (mesh) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.removeChunkCollider(slot);
    this.chunkMeshes[slot] = null;
    this.chunkHeightmaps[slot] = null!;
    this.chunkActive[slot] = 0;
    this.coordToSlot.delete(key);
    this.freeSlots.push(slot);
  }

  getChunkCount(): number {
    return this.coordToSlot.size;
  }

  destroy(): void {
    for (const [key, slot] of this.coordToSlot) {
      this.unloadChunk(slot, key);
    }
  }
}
