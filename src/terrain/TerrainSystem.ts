import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { System } from "../ecs";
import { NoiseGenerator, NoiseConfig } from "./NoiseGenerator";
import { buildChunkData, ChunkBuildResult } from "./TerrainChunkBuilder";
import { TerrainWorkerClient } from "./TerrainWorkerClient";

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
  // Wall-clock backstop alongside maxChunkLoadsPerFrame: a single chunk (e.g. full-res LOD
  // near the camera, with a trimesh collider) can cost far more than the "average" chunk, so
  // a count-only budget can still blow the frame. Loading stops early once this many
  // milliseconds have elapsed this update() call, even if the count budget isn't exhausted.
  maxChunkLoadMs: number;
}

const DEFAULT_TERRAIN_CONFIG: TerrainConfig = {
  chunkSize: 64,
  resolution: 65,
  streamRadius: 200,
  maxHeight: 50,
  noise: {},
  colliders: true,
  maxChunkLoadsPerFrame: 2,
  maxChunkLoadMs: 4,
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
  // Actual mesh resolution used for each chunk, which may be lower than
  // config.resolution for distant chunks (see computeLODResolution()). Needed
  // by getHeightAt()/createChunkCollider() to interpret each chunk's heightmap
  // with the resolution it was actually generated at.
  private chunkResolutions: number[];
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
  // Coordinates whose build request has been dispatched (to the worker, or run inline) but
  // hasn't resolved into a loaded chunk yet — kept distinct from pendingSet so the recompute in
  // update() doesn't re-queue a chunk that's already in flight.
  private loadingChunks = new Set<string>();
  // Snapshot of `needed` from the last recompute in update(), kept as a field (rather than a
  // local) so an async worker response arriving after the camera has moved away can tell it's
  // no longer wanted and discard its result instead of loading a chunk nobody needs anymore.
  private wantedChunks = new Set<string>();
  private workerClient: TerrainWorkerClient;

  constructor(config: Partial<TerrainConfig> = {}, workerClient?: TerrainWorkerClient) {
    super();
    this.config = { ...DEFAULT_TERRAIN_CONFIG, ...config };
    this.noise = new NoiseGenerator(this.config.noise);
    this.maxChunks = MAX_CHUNKS;
    // Injectable for tests (a fake Worker); production callers just let this feature-detect.
    this.workerClient = workerClient ?? new TerrainWorkerClient();

    this.chunkCX = new Int32Array(this.maxChunks);
    this.chunkCZ = new Int32Array(this.maxChunks);
    this.chunkActive = new Uint8Array(this.maxChunks);
    this.chunkHeightmaps = new Array(this.maxChunks).fill(null);
    this.chunkMeshes = new Array(this.maxChunks).fill(null);
    this.chunkBodies = new Array(this.maxChunks).fill(null);
    this.chunkColliders = new Array(this.maxChunks).fill(null);
    this.chunkResolutions = new Array(this.maxChunks).fill(this.config.resolution);
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
    this.chunkResolutions.length = newMax;
    for (let i = this.maxChunks; i < newMax; i++) {
      this.chunkHeightmaps[i] = null!;
      this.chunkMeshes[i] = null;
      this.chunkBodies[i] = null;
      this.chunkColliders[i] = null;
      this.chunkResolutions[i] = this.config.resolution;
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

    const res = this.chunkResolutions[slot];
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

          if (!this.coordToSlot.has(key) && !this.pendingSet.has(key) && !this.loadingChunks.has(key)) {
            this.pendingSet.add(key);
            this.pendingLoads.push({ cx, cz });
          }
        }
      }

      this.wantedChunks = needed;

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
    const deadline = performance.now() + Math.max(0, this.config.maxChunkLoadMs);
    for (let i = 0; i < budget && this.pendingLoads.length > 0; i++) {
      if (i > 0 && performance.now() >= deadline) break;
      const { cx, cz } = this.pendingLoads.shift()!;
      this.pendingSet.delete(`${cx},${cz}`);
      if (!this.coordToSlot.has(`${cx},${cz}`)) {
        this.beginLoadChunk(cx, cz);
      }
    }
  }

  // Distance-based level of detail: chunks farther from the camera/reference
  // point are meshed at a coarser resolution than nearby ones. Thresholds are
  // expressed as multiples of chunkSize so behavior scales with chunk size.
  private computeLODResolution(distance: number): number {
    const cs = this.config.chunkSize;
    const base = this.config.resolution;

    if (distance < cs * 4) return base;
    if (distance < cs * 16) return Math.max(3, Math.round((base - 1) / 2) + 1);
    return Math.max(2, Math.round((base - 1) / 4) + 1);
  }

  // Dispatches the actual chunk generation (see TerrainChunkBuilder.buildChunkData — noise
  // sampling + vertex/UV/index/normal computation, the real CPU cost) either to the terrain
  // worker when one is active, or inline on the main thread as a synchronous fallback. Either
  // way, the slot isn't allocated and nothing is added to the scene/physics world until
  // finalizeChunk() runs — with the worker path that happens later, asynchronously, once the
  // response arrives; with the inline path it happens synchronously within this same call.
  private beginLoadChunk(cx: number, cz: number): void {
    const key = `${cx},${cz}`;
    this.loadingChunks.add(key);

    const cs = this.config.chunkSize;
    const worldX = cx * cs;
    const worldZ = cz * cs;
    const centerX = worldX + cs / 2;
    const centerZ = worldZ + cs / 2;
    const distance = Math.hypot(centerX - this.cameraX, centerZ - this.cameraZ);
    const res = this.computeLODResolution(distance);

    const request = {
      cx, cz,
      chunkSize: cs,
      resolution: res,
      noise: this.noise.config,
      buildCollider: !!(this.config.colliders && this.rapierWorld),
    };

    if (this.workerClient.active) {
      this.workerClient.build(request)
        .then((result) => this.onChunkBuilt(key, cx, cz, res, result))
        .catch((err) => {
          this.loadingChunks.delete(key);
          console.error(`[AGEE] Terrain worker failed to build chunk (${cx},${cz}):`, err);
        });
    } else {
      const result = buildChunkData(request);
      this.onChunkBuilt(key, cx, cz, res, result);
    }
  }

  private onChunkBuilt(key: string, cx: number, cz: number, res: number, result: ChunkBuildResult): void {
    this.loadingChunks.delete(key);

    // The camera may have moved on (or this exact chunk may already have been loaded via
    // another path) while an async worker build was in flight — discard rather than adding a
    // chunk that's no longer wanted, or double-loading one that already exists.
    if (this.coordToSlot.has(key)) return;
    if (!this.wantedChunks.has(key)) return;

    this.finalizeChunk(cx, cz, res, result);
  }

  private finalizeChunk(cx: number, cz: number, res: number, result: ChunkBuildResult): void {
    const slot = this.allocSlot();
    const cs = this.config.chunkSize;
    const worldX = cx * cs;
    const worldZ = cz * cs;

    this.chunkResolutions[slot] = res;
    this.chunkCX[slot] = cx;
    this.chunkCZ[slot] = cz;
    this.chunkActive[slot] = 1;
    this.chunkHeightmaps[slot] = result.heightmap;

    const geo = new THREE.BufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(result.indices, 1));
    geo.setAttribute("position", new THREE.BufferAttribute(result.positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(result.uvs, 2));
    geo.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(worldX, 0, worldZ);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.chunkMeshes[slot] = mesh;

    if (this.config.colliders && this.rapierWorld && result.colliderVertices && result.colliderIndices) {
      this.createChunkCollider(slot, result.colliderVertices, result.colliderIndices);
    }

    this.coordToSlot.set(`${cx},${cz}`, slot);
  }

  private createChunkCollider(slot: number, vertices: Float32Array, indices: Uint32Array): void {
    if (!this.rapierWorld) return;

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
    this.workerClient.destroy();
  }
}
