import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";

import { NoiseGenerator, SeededRandom } from "../terrain/NoiseGenerator";
import { TerrainChunk } from "../terrain/TerrainChunk";
import { TerrainSystem } from "../terrain/TerrainSystem";
import { ParticleSystemEngine } from "../particles/ParticleSystem";
import { World } from "../ecs";
import { Transform, ParticleEmitter } from "../core/Components";

// ---------------------------------------------------------------------------
// NoiseGenerator / SeededRandom
// ---------------------------------------------------------------------------

describe("SeededRandom", () => {
  it("next() stays within [0, 1)", () => {
    const rng = new SeededRandom(123);
    for (let i = 0; i < 200; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("range(min, max) stays within [min, max)", () => {
    const rng = new SeededRandom(7);
    for (let i = 0; i < 200; i++) {
      const v = rng.range(-5, 5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(5);
    }
  });

  it("same seed produces the same sequence", () => {
    const a = new SeededRandom(999);
    const b = new SeededRandom(999);
    const seqA = [a.next(), a.next(), a.next()];
    const seqB = [b.next(), b.next(), b.next()];
    expect(seqA).toEqual(seqB);
  });
});

describe("NoiseGenerator", () => {
  it("sample() is deterministic for a given seed", () => {
    const n1 = new NoiseGenerator({ seed: 42 });
    const n2 = new NoiseGenerator({ seed: 42 });
    for (const [x, z] of [[0, 0], [12.3, -45.6], [100, 100], [-7.5, 3.2]]) {
      expect(n1.sample(x, z)).toBe(n2.sample(x, z));
    }
  });

  it("different seeds produce different output", () => {
    const n1 = new NoiseGenerator({ seed: 1 });
    const n2 = new NoiseGenerator({ seed: 2 });
    expect(n1.sample(37.1, 82.4)).not.toBe(n2.sample(37.1, 82.4));
  });

  it("sample() always returns a finite number within a sane bound", () => {
    const noise = new NoiseGenerator({ seed: 5 });
    for (let x = 0; x < 50; x += 3.7) {
      for (let z = 0; z < 50; z += 4.1) {
        const v = noise.sample(x, z);
        expect(Number.isFinite(v)).toBe(true);
        // Generous bound derived from amplitude * sum(persistence^i) * per-octave max gain;
        // this only needs to catch NaN/blow-ups, not pin an exact envelope.
        expect(Math.abs(v)).toBeLessThan(noise.config.amplitude * 6);
      }
    }
  });

  it("fillHeightmap() is deterministic and matches sample() at each grid point", () => {
    const noise = new NoiseGenerator({ seed: 11 });
    const res = 5;
    const size = 20;
    const hmA = new Float32Array(res * res);
    const hmB = new Float32Array(res * res);
    noise.fillHeightmap(hmA, res, 100, 200, size);
    noise.fillHeightmap(hmB, res, 100, 200, size);
    expect(Array.from(hmA)).toEqual(Array.from(hmB));

    const step = size / (res - 1);
    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const expected = noise.sample(100 + x * step, 200 + z * step);
        // heightmap is a Float32Array, so values are truncated to float32
        // precision on write; compare against the equivalent float32 rounding
        // of the float64 sample() result rather than exact float64 equality.
        expect(hmA[z * res + x]).toBe(Math.fround(expected));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// TerrainChunk
// ---------------------------------------------------------------------------

describe("TerrainChunk", () => {
  it("getHeight bilinearly interpolates the heightmap", () => {
    const chunk = new TerrainChunk({ x: 0, z: 0 }, 10, 3);
    // 3x3 heightmap; a single bump of 10 at the center grid point (1,1).
    chunk.heightmap.set([0, 0, 0, 0, 10, 0, 0, 0, 0]);

    expect(chunk.getHeight(5, 5)).toBeCloseTo(10, 5); // exact center grid point
    expect(chunk.getHeight(0, 0)).toBeCloseTo(0, 5); // exact corner grid point

    const mid = chunk.getHeight(2.5, 2.5); // quarter-way toward the center bump
    expect(mid).toBeCloseTo(2.5, 5);
  });

  it("buildMesh() produces a grid matching the configured resolution and copies heightmap Y values", () => {
    const chunk = new TerrainChunk({ x: 2, z: 3 }, 10, 3);
    chunk.heightmap.set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const material = new THREE.MeshBasicMaterial();

    const mesh = chunk.buildMesh(material);

    expect(mesh.geometry.getAttribute("position").count).toBe(9);
    expect(mesh.geometry.getIndex()!.count).toBe((3 - 1) * (3 - 1) * 6);
    expect(mesh.position.x).toBe(20); // coord.x * size
    expect(mesh.position.z).toBe(30); // coord.z * size
    expect(chunk.state).toBe("meshed");
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(true);

    const posAttr = mesh.geometry.getAttribute("position");
    expect(posAttr.getY(4)).toBe(5); // center vertex height == heightmap[4]
  });

  it("dispose() frees the geometry and resets chunk state", () => {
    const chunk = new TerrainChunk({ x: 0, z: 0 }, 10, 3);
    const mesh = chunk.buildMesh(new THREE.MeshBasicMaterial());
    const disposeSpy = vi.spyOn(mesh.geometry, "dispose");

    chunk.dispose();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(chunk.mesh).toBeNull();
    expect(chunk.state).toBe("unloaded");
  });
});

// ---------------------------------------------------------------------------
// TerrainSystem
// ---------------------------------------------------------------------------

describe("TerrainSystem", () => {
  it("getHeightAt() falls back to raw noise sampling when no chunk is loaded at that location", () => {
    const ts = new TerrainSystem({ chunkSize: 8, resolution: 5, noise: { seed: 4 }, colliders: false });
    const expected = (ts as any).noise.sample(1000, 1000);
    expect(ts.getHeightAt(1000, 1000)).toBe(expected);
  });

  it("getHeightAt() reads back from a loaded chunk's heightmap at exact grid points", () => {
    const ts = new TerrainSystem({ chunkSize: 8, resolution: 5, noise: { seed: 4 }, colliders: false });
    ts.setScene(new THREE.Scene());
    ts.init();
    (ts as any).loadChunk(0, 0);

    const hm = (ts as any).chunkHeightmaps[0] as Float32Array;
    expect(ts.getHeightAt(0, 0)).toBeCloseTo(hm[0], 5);
  });

  it("update() streams in chunks around the camera position, respecting maxChunkLoadsPerFrame", () => {
    const ts = new TerrainSystem({
      chunkSize: 8,
      resolution: 5,
      noise: { seed: 2 },
      colliders: false,
      streamRadius: 20,
      maxChunkLoadsPerFrame: 1,
    });
    ts.setScene(new THREE.Scene());
    ts.init();
    ts.setCameraPosition(0, 0);

    ts.update(0.016);
    const afterFirstFrame = ts.getChunkCount();
    expect(afterFirstFrame).toBe(1); // budget of 1 chunk load per frame

    ts.update(0.016);
    const afterSecondFrame = ts.getChunkCount();
    expect(afterSecondFrame).toBeGreaterThan(afterFirstFrame);
  });

  // -------------------------------------------------------------------------
  // AUDIT: TerrainSystem never uses TerrainChunk / has no LOD levels — every
  // chunk is meshed at the same fixed `config.resolution` regardless of
  // distance from the camera, even though ChunkState ("unloaded" | ...
  // "active") implies staged levels were planned. See TerrainSystem.ts:220
  // loadChunk() (which reimplements TerrainChunk.buildMesh()'s logic inline).
  // -------------------------------------------------------------------------
  it("AUDIT: near and far chunks are meshed at identical resolution — no LOD implemented, see TerrainSystem.ts:220", () => {
    const ts = new TerrainSystem({ chunkSize: 8, resolution: 9, noise: { seed: 1 }, colliders: false });
    ts.setScene(new THREE.Scene());
    ts.init();
    (ts as any).loadChunk(0, 0); // "near" chunk
    (ts as any).loadChunk(50, 50); // "far" chunk

    const meshes = (ts as any).chunkMeshes as (THREE.Mesh | null)[];
    const nearVerts = meshes[0]!.geometry.getAttribute("position").count;
    const farVerts = meshes[1]!.geometry.getAttribute("position").count;

    // A real distance-based LOD system would mesh a far-away chunk more coarsely.
    expect(farVerts).toBeLessThan(nearVerts);
  });

  // -------------------------------------------------------------------------
  // AUDIT: chunk normals are computed independently per-chunk with no
  // neighbor blending, so lighting seams appear at chunk boundaries even
  // where the underlying heights match exactly across the shared edge.
  // -------------------------------------------------------------------------
  it("AUDIT: adjacent chunks compute boundary normals independently, causing lighting seams — see TerrainSystem.ts:220 loadChunk()", () => {
    const res = 5;
    const cs = 8;
    const ts = new TerrainSystem({ chunkSize: cs, resolution: res, noise: { seed: 3 }, colliders: false });
    ts.setScene(new THREE.Scene());
    ts.init();
    (ts as any).loadChunk(0, 0);
    (ts as any).loadChunk(1, 0);

    const meshes = (ts as any).chunkMeshes as (THREE.Mesh | null)[];
    const normalsA = meshes[0]!.geometry.getAttribute("normal");
    const normalsB = meshes[1]!.geometry.getAttribute("normal");

    // Chunk A's rightmost column (x = res-1) is the same world-space edge as
    // chunk B's leftmost column (x = 0). Correct neighbor-aware blending would
    // make these match; independently-computed normals generally don't.
    const midRow = 2;
    const idxA = midRow * res + (res - 1);
    const idxB = midRow * res + 0;

    expect(normalsA.getX(idxA)).toBeCloseTo(normalsB.getX(idxB), 4);
    expect(normalsA.getY(idxA)).toBeCloseTo(normalsB.getY(idxB), 4);
    expect(normalsA.getZ(idxA)).toBeCloseTo(normalsB.getZ(idxB), 4);
  });
});

// ---------------------------------------------------------------------------
// ParticleSystemEngine
// ---------------------------------------------------------------------------

describe("ParticleSystemEngine", () => {
  function makeWorldWithEmitter(config: Record<string, any> = {}) {
    const world = new World();
    const ps = new ParticleSystemEngine();
    world.addSystem(ps);
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    const handle = ps.createEmitter(eid, config);
    return { world, ps, eid, handle };
  }

  it("createEmitter() registers a ParticleEmitter component with the configured fields", () => {
    const { world, eid } = makeWorldWithEmitter({ maxParticles: 10, emitRate: 5, lifetime: 2 });
    const store = world.getStore(ParticleEmitter);
    expect(store.get(eid, "maxParticles")).toBe(10);
    expect(store.get(eid, "emitRate")).toBe(5);
    expect(store.get(eid, "lifetime")).toBe(2);
    expect(store.get(eid, "active")).toBe(1);
  });

  it("update() emits particles over time, capped at maxParticles", () => {
    const { ps } = makeWorldWithEmitter({ maxParticles: 5, emitRate: 100, lifetime: 10 });
    ps.update(0.5); // 100/s * 0.5s = 50 possible emissions, capped at 5
    expect(ps.activeParticleCount).toBe(5);
  });

  it("does not emit when the emitter's active flag is false", () => {
    const { world, ps, eid } = makeWorldWithEmitter({ maxParticles: 5, emitRate: 100, lifetime: 10 });
    world.getStore(ParticleEmitter).set(eid, "active", 0);
    ps.update(0.5);
    expect(ps.activeParticleCount).toBe(0);
  });

  it("particles are culled once their lifetime elapses", () => {
    const { world, ps, eid } = makeWorldWithEmitter({ maxParticles: 5, emitRate: 100, lifetime: 1 });
    ps.update(0.5);
    expect(ps.activeParticleCount).toBe(5);

    // Stop further emission so the only thing left to observe is lifetime expiry.
    world.getStore(ParticleEmitter).set(eid, "active", 0);
    ps.update(2.0); // life (1) - 2.0 <= 0 for every existing particle
    expect(ps.activeParticleCount).toBe(0);
  });

  it("dying particles are removed via swap-with-last without corrupting survivors", () => {
    const { ps, handle } = makeWorldWithEmitter({ maxParticles: 3, emitRate: 0, lifetime: 10 });
    const emitter = (ps as any).emitterPool.get(handle);

    // Manually seed 3 particles: index 1 is due to expire, 0 and 2 survive.
    emitter.alive = 3;
    emitter.px.set([10, 20, 30]);
    emitter.life.set([5, 1, 5]);
    emitter.maxLife.set([5, 5, 5]);

    ps.update(2); // life[1] = 1 - 2 = -1 <= 0 -> dies; life[0]=3, life[2]=3 survive

    expect(emitter.alive).toBe(2);
    const survivors = (Array.from(emitter.px.slice(0, emitter.alive)) as number[]).sort((a, b) => a - b);
    expect(survivors).toEqual([10, 30]);
  });

  it("destroy() disposes each emitter's geometry/material and frees its pool handle", () => {
    const { ps, handle } = makeWorldWithEmitter({ maxParticles: 5 });
    const emitter = (ps as any).emitterPool.get(handle);
    const geoSpy = vi.spyOn(emitter.geometry, "dispose");
    const matSpy = vi.spyOn(emitter.material, "dispose");

    ps.destroy();

    expect(geoSpy).toHaveBeenCalledTimes(1);
    expect(matSpy).toHaveBeenCalledTimes(1);
    expect((ps as any).emitterPool.get(handle)).toBeNull();
  });
});
