import { NoiseGenerator, NoiseConfig } from "./NoiseGenerator";

export interface ChunkBuildRequest {
  cx: number;
  cz: number;
  chunkSize: number;
  resolution: number;
  noise: NoiseConfig;
  buildCollider: boolean;
}

export interface ChunkBuildResult {
  heightmap: Float32Array;
  positions: Float32Array;
  uvs: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  colliderVertices: Float32Array | null;
  colliderIndices: Uint32Array | null;
}

// Pure CPU-bound terrain chunk math (noise sampling, vertex/UV/index/normal generation) with no
// THREE.js or Rapier dependency, shared between TerrainSystem's synchronous main-thread fallback
// (used when the Worker API isn't available — headless/Node, or a browser that failed to spin
// one up) and terrain.worker.ts's off-main-thread path. THREE.Mesh/Rapier bodies can't be
// created off the main thread, so this only produces the plain typed arrays TerrainSystem later
// turns into those — that main-thread-only assembly step is deliberately NOT here.
export function buildChunkData(req: ChunkBuildRequest): ChunkBuildResult {
  const { cx, cz, chunkSize, resolution: res, noise: noiseConfig, buildCollider } = req;
  const noise = new NoiseGenerator(noiseConfig);
  const worldX = cx * chunkSize;
  const worldZ = cz * chunkSize;

  const heightmap = new Float32Array(res * res);
  noise.fillHeightmap(heightmap, res, worldX, worldZ, chunkSize);

  const step = chunkSize / (res - 1);
  const positions = new Float32Array(res * res * 3);
  const uvs = new Float32Array(res * res * 2);
  for (let z = 0; z < res; z++) {
    for (let x = 0; x < res; x++) {
      const i = z * res + x;
      positions[i * 3] = x * step;
      positions[i * 3 + 1] = heightmap[i];
      positions[i * 3 + 2] = z * step;
      uvs[i * 2] = x / (res - 1);
      uvs[i * 2 + 1] = z / (res - 1);
    }
  }

  // Shared by both the visual mesh and the physics trimesh (when requested) — the collider is
  // built from "the exact same geometry as the visual mesh" (see below), so there's no reason
  // to triangulate it twice.
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

  const normals = computeHeightFieldNormals(noise, heightmap, res, worldX, worldZ, step);

  let colliderVertices: Float32Array | null = null;
  let colliderIndices: Uint32Array | null = null;
  if (buildCollider) {
    // Collider vertices are in world space (the visual mesh's positions are chunk-local and
    // get placed via mesh.position.set(worldX, 0, worldZ) on the main thread instead).
    colliderVertices = new Float32Array(res * res * 3);
    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const i = z * res + x;
        colliderVertices[i * 3] = worldX + x * step;
        colliderVertices[i * 3 + 1] = heightmap[i];
        colliderVertices[i * 3 + 2] = worldZ + z * step;
      }
    }
    colliderIndices = indices;
  }

  return { heightmap, positions, uvs, normals, indices, colliderVertices, colliderIndices };
}

// Computes per-vertex normals from the height field analytically (central differences of
// world-space height samples) instead of averaging face normals of the local mesh only. Any
// sample that falls outside this chunk's own heightmap is pulled from the shared noise function
// at that exact world position rather than from the neighboring chunk's heightmap array, so two
// adjacent chunks evaluate identical world-space height samples on either side of their shared
// edge and therefore produce matching (seamless) normals at the boundary, even though each
// chunk builds its geometry independently.
function computeHeightFieldNormals(
  noise: NoiseGenerator,
  hm: Float32Array,
  res: number,
  worldX: number,
  worldZ: number,
  step: number
): Float32Array {
  const normals = new Float32Array(res * res * 3);

  for (let z = 0; z < res; z++) {
    for (let x = 0; x < res; x++) {
      const hL = x > 0 ? hm[z * res + (x - 1)] : noise.sample(worldX + (x - 1) * step, worldZ + z * step);
      const hR = x < res - 1 ? hm[z * res + (x + 1)] : noise.sample(worldX + (x + 1) * step, worldZ + z * step);
      const hD = z > 0 ? hm[(z - 1) * res + x] : noise.sample(worldX + x * step, worldZ + (z - 1) * step);
      const hU = z < res - 1 ? hm[(z + 1) * res + x] : noise.sample(worldX + x * step, worldZ + (z + 1) * step);

      const dhdx = (hR - hL) / (2 * step);
      const dhdz = (hU - hD) / (2 * step);

      const nx = -dhdx;
      const ny = 1;
      const nz = -dhdz;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

      const i = (z * res + x) * 3;
      normals[i] = nx / len;
      normals[i + 1] = ny / len;
      normals[i + 2] = nz / len;
    }
  }

  return normals;
}
