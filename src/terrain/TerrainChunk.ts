import * as THREE from "three";

export interface ChunkCoord {
  x: number;
  z: number;
}

export type ChunkState = "unloaded" | "generating" | "ready" | "meshed" | "active";

export class TerrainChunk {
  readonly coord: ChunkCoord;
  readonly size: number;
  readonly resolution: number;
  state: ChunkState = "unloaded";
  heightmap: Float32Array;
  mesh: THREE.Mesh | null = null;

  constructor(coord: ChunkCoord, size: number, resolution: number) {
    this.coord = coord;
    this.size = size;
    this.resolution = resolution;
    this.heightmap = new Float32Array(resolution * resolution);
  }

  get worldX(): number { return this.coord.x * this.size; }
  get worldZ(): number { return this.coord.z * this.size; }

  getHeight(localX: number, localZ: number): number {
    const fx = (localX / this.size) * (this.resolution - 1);
    const fz = (localZ / this.size) * (this.resolution - 1);

    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;

    const ix1 = Math.min(ix + 1, this.resolution - 1);
    const iz1 = Math.min(iz + 1, this.resolution - 1);

    const h00 = this.heightmap[iz * this.resolution + ix];
    const h10 = this.heightmap[iz * this.resolution + ix1];
    const h01 = this.heightmap[iz1 * this.resolution + ix];
    const h11 = this.heightmap[iz1 * this.resolution + ix1];

    return (h00 * (1 - tx) * (1 - tz)) + (h10 * tx * (1 - tz)) +
           (h01 * (1 - tx) * tz) + (h11 * tx * tz);
  }

  buildMesh(material: THREE.Material): THREE.Mesh {
    const geo = new THREE.BufferGeometry();
    const res = this.resolution;
    const step = this.size / (res - 1);

    const positions = new Float32Array(res * res * 3);
    const normals = new Float32Array(res * res * 3);
    const uvs = new Float32Array(res * res * 2);

    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const i = z * res + x;
        positions[i * 3] = x * step;
        positions[i * 3 + 1] = this.heightmap[i];
        positions[i * 3 + 2] = z * step;
        uvs[i * 2] = x / (res - 1);
        uvs[i * 2 + 1] = z / (res - 1);
      }
    }

    const indices: number[] = [];
    for (let z = 0; z < res - 1; z++) {
      for (let x = 0; x < res - 1; x++) {
        const tl = z * res + x;
        const tr = tl + 1;
        const bl = (z + 1) * res + x;
        const br = bl + 1;
        indices.push(tl, bl, tr);
        indices.push(tr, bl, br);
      }
    }

    geo.setIndex(indices);
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.computeVertexNormals();

    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.position.set(this.worldX, 0, this.worldZ);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.state = "meshed";
    return this.mesh;
  }

  dispose(): void {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.state = "unloaded";
  }
}
