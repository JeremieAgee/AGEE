import { describe, it, expect, vi, beforeAll } from "vitest";
import * as THREE from "three";
import fs from "node:fs";
import path from "node:path";

import { Mat4 } from "../core/math/Mat4";
import { Vec3 } from "../core/math/Vec3";
import { Quat } from "../core/math/Quat";
import { AABB } from "../core/math/AABB";
import { Frustum } from "../core/math/Frustum";
import { HandleMap } from "../core/handles/Handle";

import { World } from "../ecs/World";
import { Transform, MeshRenderer, GPUMeshRenderer } from "../core/Components";

import { CullingSystem } from "../systems/CullingSystem";
// RenderSystem itself is imported dynamically (see beforeAll below) — its module
// pulls in "three/webgpu", which touches the `self` global at import time. That
// only exists once our polyfills below have run, so a static top-level import
// here would crash before any test even starts.
import { InstancingSystem, InstancedTag } from "../systems/InstancingSystem";
import { LODSystem, LODGroup, type LODLevel } from "../systems/LODSystem";
import { CameraSystem, CameraData, CameraMode } from "../camera/CameraSystem";

import { GPUMesh } from "../gpu/GPUMesh";
import { GPUMaterialPool } from "../gpu/GPUMaterialPool";
import { createFrameLayouts } from "../gpu/BindGroupLayouts";
import { GPUContext } from "../gpu/GPUContext";
import { GPURenderSystem } from "../gpu/GPURenderSystem";
import { extractGeometry } from "../gpu/ThreeGeometryAdapter";

// ---------------------------------------------------------------------------
// WebGPU is not implemented in Node. The production code references the
// browser-supplied global bitflag objects (GPUBufferUsage / GPUShaderStage /
// GPUTextureUsage) at call time, so we polyfill just those numeric constants
// (real WebGPU spec values) plus a couple of DOM globals RenderSystem/GPUContext
// touch. No actual GPU/canvas/WebGPU behavior is emulated beyond this.
// ---------------------------------------------------------------------------
if (typeof (globalThis as any).GPUBufferUsage === "undefined") {
  (globalThis as any).GPUBufferUsage = {
    MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008,
    INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080,
    INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
  };
}
if (typeof (globalThis as any).GPUShaderStage === "undefined") {
  (globalThis as any).GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
}
if (typeof (globalThis as any).GPUTextureUsage === "undefined") {
  (globalThis as any).GPUTextureUsage = {
    COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
  };
}
if (typeof (globalThis as any).window === "undefined") {
  (globalThis as any).window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
}
if (typeof (globalThis as any).self === "undefined") {
  (globalThis as any).self = globalThis;
}

function approx(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) < eps;
}

/** Minimal hand-rolled fake GPUDevice covering only what GPUMesh / GPUMaterialPool /
 * BindGroupLayouts / GPUContext actually call. `callOrder` lets tests assert relative
 * ordering (e.g. "was a fence awaited before destroy?"). */
function makeFakeDevice() {
  const callOrder: string[] = [];
  const device: any = {
    queue: {
      writeBuffer: vi.fn(),
      onSubmittedWorkDone: vi.fn(() => {
        callOrder.push("queue.onSubmittedWorkDone");
        return Promise.resolve();
      }),
    },
    createBuffer: vi.fn((desc: any) => {
      const ab = new ArrayBuffer(desc.size);
      return {
        size: desc.size,
        destroy: vi.fn(() => callOrder.push("buffer.destroy")),
        getMappedRange: () => ab,
        unmap: vi.fn(),
      };
    }),
    createTexture: vi.fn((_desc: any) => ({
      destroy: vi.fn(() => callOrder.push("texture.destroy")),
      createView: () => ({}),
    })),
    createBindGroupLayout: vi.fn((desc: any) => ({ __label: desc.label, entries: desc.entries })),
    createBindGroup: vi.fn((desc: any) => ({ __label: desc.label, entries: desc.entries })),
    createPipelineLayout: vi.fn((desc: any) => ({ __label: desc.label })),
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({})),
    destroy: vi.fn(() => callOrder.push("device.destroy")),
  };
  return { device, callOrder };
}

// ===========================================================================
// Frustum vs AABB culling decisions (real Mat4/Frustum/AABB math, built the
// same way GPURenderSystem builds its view-projection matrix)
// ===========================================================================

describe("Culling: Frustum-vs-AABB decisions", () => {
  // Camera at (0,0,5) looking at the origin, 90 deg vertical FOV, aspect 1, near .1 far 100.
  // Forward is -Z. At world z=0 (distance 5 from eye) the view half-width/half-height is
  // exactly 5 (tan(45deg)=1), which makes the expected in/out cases easy to reason about.
  function buildFrustum(): Frustum {
    const eye = new Vec3(0, 0, 5);
    const target = new Vec3(0, 0, 0);
    const up = new Vec3(0, 1, 0);
    const view = new Mat4().lookAt(eye, target, up);
    const proj = new Mat4().perspective((90 * Math.PI) / 180, 1, 0.1, 100);
    const viewProj = new Mat4().copy(proj).multiply(view);
    return new Frustum().setFromProjectionMatrix(viewProj.elements);
  }

  it("AABB fully inside the frustum intersects", () => {
    const frustum = buildFrustum();
    const aabb = new AABB(new Vec3(-0.5, -0.5, -0.5), new Vec3(0.5, 0.5, 0.5));
    expect(frustum.intersectsAABB(aabb)).toBe(true);
  });

  it("AABB fully outside the frustum (off to the side) does not intersect", () => {
    const frustum = buildFrustum();
    // At z=0 the visible half-width is 5; this box sits entirely past x=49..51.
    const aabb = new AABB(new Vec3(49, -1, -1), new Vec3(51, 1, 1));
    expect(frustum.intersectsAABB(aabb)).toBe(false);
  });

  it("AABB fully outside the frustum (behind the camera) does not intersect", () => {
    const frustum = buildFrustum();
    // Eye is at z=5 looking toward -Z; z=19..21 is behind the eye entirely.
    const aabb = new AABB(new Vec3(-1, -1, 19), new Vec3(1, 1, 21));
    expect(frustum.intersectsAABB(aabb)).toBe(false);
  });

  it("AABB straddling the right frustum plane intersects (partial overlap counts as visible)", () => {
    const frustum = buildFrustum();
    // At z=0 the right plane is at x=5. This box spans x=3..7, straddling that plane.
    const aabb = new AABB(new Vec3(3, -1, -1), new Vec3(7, 1, 1));
    expect(frustum.intersectsAABB(aabb)).toBe(true);
  });

  it("AABB straddling the near plane intersects", () => {
    const frustum = buildFrustum();
    // Near plane sits at world z = 5 - 0.1 = 4.9. This box spans z=4..6, straddling it.
    const aabb = new AABB(new Vec3(-0.2, -0.2, 4), new Vec3(0.2, 0.2, 6));
    expect(frustum.intersectsAABB(aabb)).toBe(true);
  });
});

// ===========================================================================
// CullingSystem: real frustum-culled visibility using the ECS + THREE together
// ===========================================================================

describe("CullingSystem: visibility decisions", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let RenderSystem: any;
  beforeAll(async () => {
    RenderSystem = (await import("../systems/RenderSystem")).RenderSystem;
  });

  function makeWorldWithMesh(x: number, y: number, z: number) {
    const world = new World();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x, y, z, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });

    const geo = new THREE.SphereGeometry(1, 6, 6);
    const mat = new THREE.MeshBasicMaterial();
    const meshObj = new THREE.Mesh(geo, mat);

    world.addComponent(eid, MeshRenderer, { meshRef: meshObj, visible: 1, castShadow: 0, receiveShadow: 0 });
    world.addComponent(eid, GPUMeshRenderer, { meshHandle: 0, materialHandle: 0, visible: 1, castShadow: 0, receiveShadow: 0 });

    return { world, eid, meshObj };
  }

  function makeCamera(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    return camera;
  }

  it("marks an in-view entity visible on both the THREE mesh and GPUMeshRenderer", () => {
    const { world, eid, meshObj } = makeWorldWithMesh(0, 0, 0);
    const culling = new CullingSystem();
    culling.world = world;
    culling.init();
    culling.setCamera(makeCamera());
    culling.update(1 / 60);

    expect(meshObj.visible).toBe(true);
    expect(world.getStore(GPUMeshRenderer).get(eid, "visible")).toBe(1);
    expect(culling.visibleCount).toBe(1);
  });

  it("marks a far-outside-frustum entity invisible on both the THREE mesh and GPUMeshRenderer", () => {
    const { world, eid, meshObj } = makeWorldWithMesh(100000, 0, 0);
    const culling = new CullingSystem();
    culling.world = world;
    culling.init();
    culling.setCamera(makeCamera());
    culling.update(1 / 60);

    expect(meshObj.visible).toBe(false);
    expect(world.getStore(GPUMeshRenderer).get(eid, "visible")).toBe(0);
    expect(culling.visibleCount).toBe(0);
  });

  it("respects the raw MeshRenderer.visible=0 flag regardless of frustum position", () => {
    const { world, eid, meshObj } = makeWorldWithMesh(0, 0, 0);
    world.getStore(MeshRenderer).set(eid, "visible", 0);
    const culling = new CullingSystem();
    culling.world = world;
    culling.init();
    culling.setCamera(makeCamera());
    culling.update(1 / 60);

    expect(meshObj.visible).toBe(false);
    expect(world.getStore(GPUMeshRenderer).get(eid, "visible")).toBe(0);
  });

  // -------------------------------------------------------------------------
  // AUDIT BUG #1: CullingSystem computes correct frustum-culling visibility and
  // sets mesh.visible / GPUMeshRenderer.visible, but RenderSystem.update() runs
  // afterward (both are phase="render"; RenderSystem priority=900 > CullingSystem
  // priority=800) and unconditionally does `mesh.visible = visibleCol[eid] !== 0`
  // straight from the raw MeshRenderer.visible ECS flag — discarding whatever
  // CullingSystem just decided. See src/systems/RenderSystem.ts:127 and
  // src/systems/CullingSystem.ts:109-110.
  //
  // RenderSystem's own constructor requires real browser globals (window,
  // navigator, an actual WebGL/WebGPU-capable canvas) that don't exist in this
  // Node test environment, so we can't `new RenderSystem(...)`. Instead we call
  // its real, unmodified `update()` method via Function.prototype.call against a
  // minimal object exposing exactly the fields that method reads — this runs the
  // exact production logic without needing the constructor.
  // -------------------------------------------------------------------------
  it("AUDIT: a culled entity's mesh.visible should remain false after RenderSystem runs — see src/systems/RenderSystem.ts:127", () => {
    const { world, eid, meshObj } = makeWorldWithMesh(100000, 0, 0);
    const culling = new CullingSystem();
    culling.world = world;
    culling.init();
    culling.setCamera(makeCamera());
    culling.update(1 / 60);

    // Sanity: CullingSystem did its job correctly before RenderSystem runs.
    expect(meshObj.visible).toBe(false);

    const fakeRenderSystemThis = {
      transformStore: world.getStore(Transform),
      meshStore: world.getStore(MeshRenderer),
      query: { entities: [eid] },
      active: true,
      postProcessActive: false,
      renderer: { render: vi.fn() },
    };
    (RenderSystem.prototype as any).update.call(fakeRenderSystemThis, 1 / 60);

    // MeshRenderer.visible was never touched by CullingSystem (it only ever
    // touches mesh.visible / GPUMeshRenderer.visible), so it's still the raw "1"
    // set at creation time. RenderSystem blindly re-applies that raw flag,
    // reverting the culling decision every single frame.
    expect(meshObj.visible).toBe(false);
  });
});

// ===========================================================================
// LODSystem: level selection thresholds + hysteresis
// ===========================================================================

describe("LODSystem: distance-threshold level selection", () => {
  function makeLevels(): LODLevel[] {
    // Mirrors what LODSystem.createLOD() does before handing levels to the
    // system: every level starts hidden except the initial (level 0).
    const levels = [
      { mesh: new THREE.Object3D(), distance: 10 },
      { mesh: new THREE.Object3D(), distance: 50 },
      { mesh: new THREE.Object3D(), distance: 200 },
    ];
    for (const l of levels) l.mesh.visible = false;
    levels[0].mesh.visible = true;
    return levels;
  }

  function setup(levels: LODLevel[], camZ: number) {
    const world = new World();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    world.addComponent(eid, LODGroup, { levelsRef: levels, currentLevel: 0 });

    const lod = new LODSystem();
    lod.world = world;
    lod.init();
    const camera: any = { position: { x: 0, y: 0, z: camZ } };
    lod.setCamera(camera);
    return { world, eid, lod, camera };
  }

  it("selects the highest-detail level (0) when close", () => {
    const levels = makeLevels();
    const { world, eid, lod } = setup(levels, 5); // dist = 5
    lod.update(1 / 60);
    expect(world.getStore(LODGroup).get(eid, "currentLevel")).toBe(0);
    expect(levels[0].mesh.visible).toBe(true);
    expect(levels[1].mesh.visible).toBe(false);
  });

  it("switches to a lower-detail level once past its distance threshold", () => {
    const levels = makeLevels();
    const { world, eid, lod, camera } = setup(levels, 0);
    camera.position.z = 30; // dist = 30 -> past level0's threshold(10), within level1's(50)
    lod.update(1 / 60);
    expect(world.getStore(LODGroup).get(eid, "currentLevel")).toBe(1);
    expect(levels[1].mesh.visible).toBe(true);
  });

  it("falls back to the lowest-detail (last) level when beyond every threshold", () => {
    const levels = makeLevels();
    const { world, eid, lod, camera } = setup(levels, 0);
    camera.position.z = 1000; // dist = 1000, beyond even the last threshold (200)
    lod.update(1 / 60);
    expect(world.getStore(LODGroup).get(eid, "currentLevel")).toBe(2);
    expect(levels[2].mesh.visible).toBe(true);
  });

  it("hysteresis: does not switch back to higher detail until past the *tightened* threshold, not the raw one", () => {
    const levels = makeLevels();
    const { world, eid, lod, camera } = setup(levels, 0);

    camera.position.z = 30; // -> level1
    lod.update(1 / 60);
    expect(world.getStore(LODGroup).get(eid, "currentLevel")).toBe(1);

    // Move to dist=9.5: this is under the raw level0 threshold (10) but NOT under
    // the hysteresis-tightened one (10 * (1 - 0.1) = 9), so it should stay on level1.
    camera.position.z = 9.5;
    lod.update(1 / 60);
    expect(world.getStore(LODGroup).get(eid, "currentLevel")).toBe(1);

    // Move to dist=8, safely under the tightened threshold of 9 -> now it switches.
    camera.position.z = 8;
    lod.update(1 / 60);
    expect(world.getStore(LODGroup).get(eid, "currentLevel")).toBe(0);
  });
});

// ===========================================================================
// InstancingSystem: batch grouping bookkeeping (same group vs different groups)
// ===========================================================================

describe("InstancingSystem: batch grouping", () => {
  function makeInstSystem() {
    const world = new World();
    const scene = new THREE.Scene();
    const inst = new InstancingSystem();
    inst.world = world;
    inst.setScene(scene);
    inst.init();
    return { world, scene, inst };
  }

  it("entities added to the same group share one InstancedMesh and its count grows", () => {
    const { world, scene, inst } = makeInstSystem();
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshBasicMaterial();
    const groupId = inst.createGroup(geo, mat, 4);

    const e1 = world.createEntity();
    const e2 = world.createEntity();
    world.addComponent(e1, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    world.addComponent(e2, Transform, { x: 1, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });

    inst.addToGroup(e1, groupId);
    inst.addToGroup(e2, groupId);

    expect(world.hasComponent(e1, InstancedTag)).toBe(true);
    expect(world.getStore(InstancedTag).get(e1, "groupId")).toBe(groupId);
    expect(world.getStore(InstancedTag).get(e2, "groupId")).toBe(groupId);

    const mesh = (inst as any).groupMeshes[groupId] as THREE.InstancedMesh;
    expect(mesh.count).toBe(2);
    expect(scene.children).toContain(mesh);
  });

  it("different mesh/material combos get separate groups that don't affect each other", () => {
    const { world, inst } = makeInstSystem();
    const geoA = new THREE.BoxGeometry();
    const matA = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const geoB = new THREE.SphereGeometry();
    const matB = new THREE.MeshBasicMaterial({ color: 0x00ff00 });

    const groupA = inst.createGroup(geoA, matA, 4);
    const groupB = inst.createGroup(geoB, matB, 4);
    expect(groupA).not.toBe(groupB);

    const e1 = world.createEntity();
    const e2 = world.createEntity();
    world.addComponent(e1, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    world.addComponent(e2, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });

    inst.addToGroup(e1, groupA);
    inst.addToGroup(e2, groupB);

    const meshA = (inst as any).groupMeshes[groupA] as THREE.InstancedMesh;
    const meshB = (inst as any).groupMeshes[groupB] as THREE.InstancedMesh;
    expect(meshA).not.toBe(meshB);
    expect(meshA.count).toBe(1);
    expect(meshB.count).toBe(1);
    expect((inst as any).groupGeometries[groupA]).toBe(geoA);
    expect((inst as any).groupGeometries[groupB]).toBe(geoB);
  });

  it("growGroup doubles capacity once entity count exceeds it, preserving membership", () => {
    const { world, inst } = makeInstSystem();
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshBasicMaterial();
    const groupId = inst.createGroup(geo, mat, 2);

    const ids = [0, 1, 2].map(() => {
      const e = world.createEntity();
      world.addComponent(e, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
      return e;
    });
    ids.forEach((e) => inst.addToGroup(e, groupId));

    // Capacity started at 2; a 3rd entity must have triggered growGroup() (doubling to 4).
    expect((inst as any).groupCapacities[groupId]).toBe(4);
    expect((inst as any).groupEntities[groupId].length).toBe(3);
    const mesh = (inst as any).groupMeshes[groupId] as THREE.InstancedMesh;
    expect(mesh.count).toBe(3);
  });

  it("removeFromGroup drops membership via swap-remove without leaving stale entries", () => {
    const { world, inst } = makeInstSystem();
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshBasicMaterial();
    const groupId = inst.createGroup(geo, mat, 10);

    const e1 = world.createEntity();
    const e2 = world.createEntity();
    const e3 = world.createEntity();
    for (const e of [e1, e2, e3]) {
      world.addComponent(e, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
      inst.addToGroup(e, groupId);
    }

    inst.removeFromGroup(e2, groupId);
    const entities = (inst as any).groupEntities[groupId] as number[];
    expect(entities.length).toBe(2);
    expect(entities).toContain(e1);
    expect(entities).toContain(e3);
    expect(entities).not.toContain(e2);

    const mesh = (inst as any).groupMeshes[groupId] as THREE.InstancedMesh;
    expect(mesh.count).toBe(2);
  });

  it("update() writes a matrix per member entity into the InstancedMesh on full rebuild", () => {
    const { world, inst } = makeInstSystem();
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshBasicMaterial();
    const groupId = inst.createGroup(geo, mat, 10);

    const e1 = world.createEntity();
    world.addComponent(e1, Transform, { x: 7, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    inst.addToGroup(e1, groupId);

    inst.update(1 / 60);

    const mesh = (inst as any).groupMeshes[groupId] as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    const pos = new THREE.Vector3();
    m.decompose(pos, new THREE.Quaternion(), new THREE.Vector3());
    expect(pos.x).toBeCloseTo(7, 5);
  });
});

// ===========================================================================
// CameraSystem: view/projection matrix updates against known inputs
// ===========================================================================

describe("CameraSystem: native matrix updates", () => {
  function setup() {
    const world = new World();
    const camSys = new CameraSystem();
    camSys.world = world;
    camSys.init();
    const threeCam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camSys.setCamera(threeCam);
    return { world, camSys, threeCam };
  }

  it("Free mode: nativeCameraPos exactly matches the entity's Transform (no smoothing)", () => {
    const { world, camSys } = setup();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 3, y: 4, z: 5, sx: 1, sy: 1, sz: 1 });
    camSys.createCamera(eid, CameraMode.Free, { fov: 60, near: 0.1, far: 1000 });

    camSys.update(1 / 60);

    expect(approx(camSys.nativeCameraPos.x, 3)).toBe(true);
    expect(approx(camSys.nativeCameraPos.y, 4)).toBe(true);
    expect(approx(camSys.nativeCameraPos.z, 5)).toBe(true);
  });

  it("nativeProjMatrix matches an independently-computed Mat4.perspective for the same fov/aspect/near/far", () => {
    const { world, camSys, threeCam } = setup();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    camSys.createCamera(eid, CameraMode.Free, { fov: 75, near: 0.5, far: 250 });

    camSys.update(1 / 60);

    const expected = new Mat4().perspective((75 * Math.PI) / 180, threeCam.aspect, 0.5, 250);
    for (let i = 0; i < 16; i++) {
      expect(approx(camSys.nativeProjMatrix.elements[i], expected.elements[i])).toBe(true);
    }
  });

  it("nativeViewMatrix matches an independently-computed Mat4.lookAt for Free mode", () => {
    const { world, camSys } = setup();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 10, sx: 1, sy: 1, sz: 1 });
    camSys.createCamera(eid, CameraMode.Free, { fov: 60, near: 0.1, far: 1000 });
    camSys.rotate(eid, 0, 0); // yaw=0, pitch=0 (defaults set by createCamera: yaw=0, pitch=0.3)
    // Force pitch to 0 for a clean, easily-reproduced lookAt target.
    world.getStore(CameraData); // ensure store exists
    (camSys as any).camStore.set(eid, "pitch", 0);

    camSys.update(1 / 60);

    // Free mode: lookAtPos = pos - (sin(yaw), sin(pitch), cos(yaw)) with yaw=pitch=0
    // -> lookAt target = (0,0,9), eye = (0,0,10).
    const expected = new Mat4().lookAt(new Vec3(0, 0, 10), new Vec3(0, 0, 9), new Vec3(0, 1, 0));
    for (let i = 0; i < 16; i++) {
      expect(approx(camSys.nativeViewMatrix.elements[i], expected.elements[i])).toBe(true);
    }
  });

  it("setPrimary + fallback: the designated primary camera wins even if created first", () => {
    const { world, camSys } = setup();
    const e1 = world.createEntity();
    const e2 = world.createEntity();
    world.addComponent(e1, Transform, { x: 1, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    world.addComponent(e2, Transform, { x: 2, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    camSys.createCamera(e1, CameraMode.Free, {});
    camSys.createCamera(e2, CameraMode.Free, {});
    camSys.setPrimary(e2);

    camSys.update(1 / 60);
    expect(camSys.getActiveCameraEid()).toBe(e2);
  });

  it("rotate() clamps pitch to [-1.2, 1.2]", () => {
    const { world, camSys } = setup();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    camSys.createCamera(eid, CameraMode.Free, {});
    camSys.rotate(eid, 0, 10); // huge upward delta
    expect(camSys.rotate(eid, 0, 0) ?? camSys.getYaw(eid)).toBeDefined();
    // Read back via internal store since there's no getter for pitch. The value
    // is stored as f32, so allow for float32 rounding above the 1.2 clamp target.
    const pitch = (camSys as any).camStore.get(eid, "pitch");
    expect(pitch).toBeLessThanOrEqual(1.2 + 1e-4);
  });
});

// ===========================================================================
// GPUMesh + GPUMaterialPool: handle allocation / reuse / generation checks,
// bookkeeping logic (bounding-sphere centroid/radius), via a fake GPUDevice
// ===========================================================================

describe("GPUMesh: bookkeeping (fake device, no real GPU)", () => {
  it("computes the actual centroid and radius for off-origin geometry (not defaulting to origin)", () => {
    const { device } = makeFakeDevice();
    const ctx: any = { device };

    // A unit cube centered at (10, 0, 0): centroid should be (10,0,0), radius sqrt(3)/2 * ~ (half-diagonal).
    const positions = new Float32Array([
      9.5, -0.5, -0.5,   10.5, -0.5, -0.5,   10.5, 0.5, -0.5,   9.5, 0.5, -0.5,
      9.5, -0.5, 0.5,    10.5, -0.5, 0.5,    10.5, 0.5, 0.5,    9.5, 0.5, 0.5,
    ]);
    const mesh = GPUMesh.create(ctx, { positions });

    expect(approx(mesh.boundingSphereCenter[0], 10)).toBe(true);
    expect(approx(mesh.boundingSphereCenter[1], 0)).toBe(true);
    expect(approx(mesh.boundingSphereCenter[2], 0)).toBe(true);
    const expectedRadius = Math.sqrt(0.5 ** 2 + 0.5 ** 2 + 0.5 ** 2);
    expect(approx(mesh.boundingSphereRadius, expectedRadius)).toBe(true);
    expect(mesh.vertexCount).toBe(8);
  });

  it("builds an index buffer with the correct format for Uint32Array indices", () => {
    const { device } = makeFakeDevice();
    const ctx: any = { device };
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const mesh = GPUMesh.create(ctx, { positions, indices });
    expect(mesh.indexFormat).toBe("uint32");
    expect(mesh.indexCount).toBe(3);
  });

  it("destroy() calls buffer.destroy() on both vertex and index buffers", () => {
    const { device } = makeFakeDevice();
    const ctx: any = { device };
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const mesh = GPUMesh.create(ctx, { positions, indices });

    const vbDestroy = mesh.vertexBuffer.destroy as any;
    const ibDestroy = mesh.indexBuffer!.destroy as any;
    mesh.destroy();
    expect(vbDestroy).toHaveBeenCalledTimes(1);
    expect(ibDestroy).toHaveBeenCalledTimes(1);
  });
});

describe("GPUMaterialPool: Handle allocation / reuse / generation checks (fake device)", () => {
  function makePool() {
    const { device } = makeFakeDevice();
    const ctx: any = { device };
    const layout: any = { __fakeLayout: true };
    const pool = new GPUMaterialPool(ctx, layout);
    return { pool, device };
  }

  it("create() returns distinct valid handles with working bind groups", () => {
    const { pool } = makePool();
    const h1 = pool.create({ r: 1, g: 0, b: 0 });
    const h2 = pool.create({ r: 0, g: 1, b: 0 });
    expect(h1).not.toBe(h2);
    expect(pool.getBindGroup(h1)).not.toBeNull();
    expect(pool.getBindGroup(h2)).not.toBeNull();
    expect(pool.getBindGroup(h1)).not.toBe(pool.getBindGroup(h2));
  });

  it("free() invalidates a handle; a stale handle from before free never aliases a later reused slot", () => {
    const { pool } = makePool();
    const h1 = pool.create({ r: 1, g: 0, b: 0 });
    expect(pool.getBindGroup(h1)).not.toBeNull();

    pool.free(h1);
    expect(pool.getBindGroup(h1)).toBeNull();

    // Allocate more entries; if the freed slot is reused, its generation must have
    // incremented so the old (now-stale) h1 handle still never resolves.
    const h2 = pool.create({ r: 0, g: 0, b: 1 });
    const h3 = pool.create({ r: 0, g: 1, b: 1 });
    expect(pool.getBindGroup(h1)).toBeNull();
    expect([h2, h3]).not.toContain(h1);
  });

  it("update() rewrites material data via device.queue.writeBuffer", () => {
    const { pool, device } = makePool();
    const h = pool.create({ r: 1, g: 1, b: 1 });
    (device.queue.writeBuffer as any).mockClear();
    pool.update(h, { r: 0.2 });
    expect(device.queue.writeBuffer).toHaveBeenCalledTimes(1);
  });

  it("default material handle always resolves to a valid bind group", () => {
    const { pool } = makePool();
    expect(pool.getBindGroup(pool.defaultMaterialHandle)).not.toBeNull();
    expect(pool.defaultBindGroup).not.toBeNull();
  });
});

describe("HandleMap: generic pool used for GPUMesh handles (allocation/reuse/generation)", () => {
  it("a freed mesh handle becomes invalid even if its slot index is reused", () => {
    const pool = new HandleMap<{ id: number }>();
    const h1 = pool.alloc({ id: 1 });
    pool.free(h1);
    const h2 = pool.alloc({ id: 2 });

    expect(pool.get(h1)).toBeNull();
    expect(pool.get(h2)).toEqual({ id: 2 });
    expect(pool.isValid(h1)).toBe(false);
    expect(pool.isValid(h2)).toBe(true);
  });
});

// ===========================================================================
// BindGroupLayouts + ThreeGeometryAdapter: pure bookkeeping / pure conversion
// ===========================================================================

describe("BindGroupLayouts: creates the expected 3-group pipeline layout", () => {
  it("calls createBindGroupLayout for each of the 3 groups and createPipelineLayout once", () => {
    const { device } = makeFakeDevice();
    const ctx: any = { device };
    const layouts = createFrameLayouts(ctx);

    expect(device.createBindGroupLayout).toHaveBeenCalledTimes(3);
    expect(device.createPipelineLayout).toHaveBeenCalledTimes(1);
    expect(layouts.perFrame).toBeDefined();
    expect(layouts.perMaterial).toBeDefined();
    expect(layouts.perObject).toBeDefined();
    expect(layouts.pipelineLayout).toBeDefined();
  });
});

describe("ThreeGeometryAdapter: extractGeometry", () => {
  it("extracts positions/normals/uvs/indices from a real THREE.BufferGeometry", () => {
    const geo = new THREE.BoxGeometry(2, 2, 2);
    const desc = extractGeometry(geo);
    expect(desc.positions.length).toBeGreaterThan(0);
    expect(desc.normals).toBeDefined();
    expect(desc.uvs).toBeDefined();
    expect(desc.indices).toBeDefined();
    expect(desc.boundingSphereRadius).toBeGreaterThan(0);
  });

  it("computes vertex normals when the geometry has none", () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geo.setIndex([0, 1, 2]);
    const desc = extractGeometry(geo);
    expect(desc.normals).toBeDefined();
    expect(desc.normals!.length).toBe(9);
  });

  it("throws when the geometry has no position attribute", () => {
    const geo = new THREE.BufferGeometry();
    expect(() => extractGeometry(geo)).toThrow();
  });

  it("uses Uint32Array indices once vertex count exceeds 65535", () => {
    const geo = new THREE.BufferGeometry();
    const count = 65536;
    const positions = new Float32Array(count * 3);
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(new Uint32Array([0, 1, 2]), 1));
    const desc = extractGeometry(geo);
    expect(desc.indices).toBeInstanceOf(Uint32Array);
  });
});

// ===========================================================================
// GPUContext: resize/destroy resource fencing (AUDIT BUG #3)
// ===========================================================================

describe("GPUContext: depth texture lifecycle", () => {
  // GPUContext's constructor is `private` in the source (enforced only at TS
  // compile time). We bypass it with an `as any` cast to construct an instance
  // directly with fake adapter/device/canvas/context, since the real
  // `GPUContext.create()` factory requires `navigator.gpu` which does not exist
  // in Node. This exercises the real, unmodified resize()/destroy() methods.
  function makeCtx() {
    const { device, callOrder } = makeFakeDevice();
    const canvas: any = { width: 0, height: 0, parentNode: null, style: {} };
    const ctx: GPUContext = new (GPUContext as any)(
      /* adapter */ {}, device, canvas, /* canvasContext */ {}, /* format */ "bgra8unorm",
    );
    return { ctx, device, callOrder };
  }

  it("resize() creates a depth texture sized to the requested dimensions", () => {
    const { ctx, device } = makeCtx();
    ctx.resize(640, 480);
    expect(device.createTexture).toHaveBeenCalledWith(
      expect.objectContaining({ size: [640, 480], format: "depth24plus" }),
    );
    expect(ctx.width).toBe(640);
    expect(ctx.height).toBe(480);
  });

  // -------------------------------------------------------------------------
  // AUDIT BUG #3: resize() destroys the previous depth texture synchronously
  // and destroy() destroys the device/depth texture synchronously, with no
  // fence/wait against command buffers that might still be in flight and
  // referencing them (e.g. via device.queue.onSubmittedWorkDone()). GPUMesh /
  // GPUMaterialPool have the identical pattern for vertex/index/material
  // buffers. This is the best proxy we can assert in a Node test without a
  // real GPUDevice: the resource-safety *contract* (fence-before-destroy)
  // simply isn't implemented. What we CANNOT verify here: actual driver-level
  // use-after-free, timing/race conditions, or validation errors a real
  // WebGPU implementation would raise — none of that is observable without a
  // real GPU backend.
  // -------------------------------------------------------------------------
  it("AUDIT: resize() should fence (e.g. await queue.onSubmittedWorkDone) before destroying the old depth texture — see src/gpu/GPUContext.ts:100", () => {
    const { ctx, device, callOrder } = makeCtx();
    ctx.resize(100, 100); // first depth texture, nothing to destroy yet
    ctx.resize(200, 200); // destroys the first texture synchronously

    expect(device.queue.onSubmittedWorkDone).toHaveBeenCalled();
    // If it were called, it should happen before the old texture is torn down.
    const fenceIdx = callOrder.indexOf("queue.onSubmittedWorkDone");
    const destroyIdx = callOrder.indexOf("texture.destroy");
    expect(fenceIdx).toBeGreaterThanOrEqual(0);
    expect(fenceIdx).toBeLessThan(destroyIdx);
  });

  it("AUDIT: destroy() should fence before destroying the device/depth texture — see src/gpu/GPUContext.ts:129-138", () => {
    const { ctx, device } = makeCtx();
    ctx.resize(64, 64);
    ctx.destroy();
    expect(device.queue.onSubmittedWorkDone).toHaveBeenCalled();
  });
});

describe("Resource fencing on GPUMesh/GPUMaterialPool (AUDIT BUG #3, best-effort proxy)", () => {
  it("AUDIT: GPUMesh.destroy() should fence before destroying its buffers — see src/gpu/GPUMesh.ts:153", () => {
    const { device } = makeFakeDevice();
    const ctx: any = { device };
    const mesh = GPUMesh.create(ctx, { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
    mesh.destroy();
    expect(device.queue.onSubmittedWorkDone).toHaveBeenCalled();
  });

  it("AUDIT: GPUMaterialPool.free() should fence before destroying the material buffer — see src/gpu/GPUMaterialPool.ts:106", () => {
    const { device } = makeFakeDevice();
    const ctx: any = { device };
    const pool = new GPUMaterialPool(ctx, {} as any);
    const h = pool.create({ r: 1, g: 1, b: 1 });
    pool.free(h);
    expect(device.queue.onSubmittedWorkDone).toHaveBeenCalled();
  });
});

// ===========================================================================
// GPURenderSystem: bugs #2 (zero-draw frame skips present), #4 (per-entity
// fromEuler allocation), #5 (light count hardcoded to 1 / no ECS caller),
// and #6 (priority collides with RenderSystem)
// ===========================================================================

describe("GPURenderSystem: zero-draw-frame / lighting / allocation behavior", () => {
  // GPURenderSystem has no custom constructor (all fields are either plain
  // class-field initializers or set via init()/setters), so `new
  // GPURenderSystem()` is safe to call directly without touching any GPU API.
  // We skip calling `init()` (which would need a real GPUDevice to compile a
  // shader module/pipeline) and instead poke the handful of private fields
  // `update()` actually reads, using hand-rolled fakes for each.
  function makeSystem(entityIds: number[], opts: { visible?: boolean; withMesh?: boolean } = {}) {
    const { visible = true, withMesh = true } = opts;
    const sys = new GPURenderSystem();

    const { device, callOrder } = makeFakeDevice();
    const beginFrame = vi.fn(() => ({ encoder: fakeEncoder(), colorView: {} }));
    const endFrame = vi.fn();
    const gpuCtx: any = {
      device,
      canvas: { style: { display: "block" } },
      depthView: {},
      beginFrame,
      endFrame,
    };

    function fakeEncoder() {
      return {
        beginRenderPass: vi.fn(() => ({
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          setVertexBuffer: vi.fn(),
          setIndexBuffer: vi.fn(),
          draw: vi.fn(),
          drawIndexed: vi.fn(),
          end: vi.fn(),
        })),
      };
    }

    const maxEid = Math.max(0, ...entityIds) + 1;
    const zeros = () => new Float32Array(maxEid);
    const transformStore = {
      getColumn: (name: string) => zeros(),
    };

    const meshPool = new HandleMap<any>();
    const meshHandleArr = new Int32Array(maxEid);
    const matHandleArr = new Int32Array(maxEid);
    const visibleArr = new Uint8Array(maxEid);
    for (const eid of entityIds) {
      visibleArr[eid] = visible ? 1 : 0;
      if (withMesh) {
        const h = meshPool.alloc({
          vertexBuffer: {},
          indexBuffer: null,
          vertexCount: 3,
          indexCount: 0,
          indexFormat: "uint16",
        });
        meshHandleArr[eid] = h as unknown as number;
      } else {
        meshHandleArr[eid] = 0xdead; // no such handle -> mesh lookup fails
      }
    }
    const meshRendererStore = {
      getColumn: (name: string) => {
        if (name === "meshHandle") return meshHandleArr;
        if (name === "materialHandle") return matHandleArr;
        if (name === "visible") return visibleArr;
        return zeros();
      },
    };

    const materialPool = new GPUMaterialPool(gpuCtx, {} as any);

    Object.assign(sys as any, {
      gpuCtx,
      meshPool,
      _materialPool: materialPool,
      transformStore,
      meshRendererStore,
      query: { entities: entityIds },
      pipeline: {},
      cameraBuffer: {},
      lightBuffer: {},
      lightInfoBuffer: {},
      modelBuffer: {},
      modelData: new Float32Array(entityIds.length * 64 + 64),
      perFrameBindGroup: {},
      perObjectBindGroup: {},
    });

    return { sys, gpuCtx, beginFrame, endFrame, device };
  }

  // -------------------------------------------------------------------------
  // AUDIT BUG #2
  // -------------------------------------------------------------------------
  it("AUDIT: should still present/clear when there are no entities at all — see src/gpu/GPURenderSystem.ts:196-197", () => {
    const { sys, beginFrame, endFrame } = makeSystem([]);
    sys.update(1 / 60);
    expect(beginFrame).toHaveBeenCalled();
    expect(endFrame).toHaveBeenCalled();
  });

  it("AUDIT: should still present/clear on a zero-draw frame (entities exist but none are visible) — see src/gpu/GPURenderSystem.ts:275", () => {
    const { sys, beginFrame, endFrame } = makeSystem([1, 2, 3], { visible: false });
    sys.update(1 / 60);
    expect(beginFrame).toHaveBeenCalled();
    expect(endFrame).toHaveBeenCalled();
  });

  it("sanity: a normal frame with visible drawable entities does present/clear", () => {
    const { sys, beginFrame, endFrame } = makeSystem([1, 2, 3], { visible: true, withMesh: true });
    sys.update(1 / 60);
    expect(beginFrame).toHaveBeenCalled();
    expect(endFrame).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // AUDIT BUG #4
  // -------------------------------------------------------------------------
  it("AUDIT: should not allocate a new Quat per visible entity per frame via Quat.fromEuler — see src/gpu/GPURenderSystem.ts:243", () => {
    const entityIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const { sys } = makeSystem(entityIds, { visible: true, withMesh: true });
    const fromEulerSpy = vi.spyOn(Quat, "fromEuler");

    sys.update(1 / 60);

    // Other per-entity temporaries in this same loop (_pos, _quat, _scale, _modelMat,
    // _normalMat) are pre-allocated once and reused every frame. A correctly pooled
    // Euler->quaternion conversion would do the same, so the call count should not
    // scale with the number of visible entities.
    expect(fromEulerSpy.mock.calls.length).toBeLessThan(entityIds.length);
    fromEulerSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // AUDIT BUG #5
  // -------------------------------------------------------------------------
  it("AUDIT: setDirectionalLight should accumulate light count, not hard-code it to 1 — see src/gpu/GPURenderSystem.ts:183", () => {
    const { sys } = makeSystem([]);
    sys.setDirectionalLight(0, -1, 0, 1, 1, 1, 1);
    sys.setDirectionalLight(1, 0, 0, 1, 1, 1, 0.5);
    // MAX_LIGHTS=64 storage buffer exists to support multiple lights; a second
    // light should raise the count, not leave it pinned at 1.
    expect((sys as any)._lightCount).toBe(2);
  });

  it("AUDIT: an ECS Light component should be able to reach GPURenderSystem — no caller of setDirectionalLight exists anywhere in src/ — see src/gpu/GPURenderSystem.ts:178", () => {
    const gpuDir = path.resolve(__dirname, "..");
    const callers: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "tests") continue; // don't count this test file itself
          walk(full);
        } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && full !== path.resolve(__dirname, "../gpu/GPURenderSystem.ts")) {
          const text = fs.readFileSync(full, "utf8");
          if (text.includes(".setDirectionalLight(")) callers.push(full);
        }
      }
    }
    walk(gpuDir);

    expect(callers.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// AUDIT BUG #6: RenderSystem and GPURenderSystem share the same priority
// ===========================================================================

describe("System ordering contract (AUDIT BUG #6)", () => {
  it("AUDIT: GPURenderSystem instance priority should not collide with RenderSystem's — see src/gpu/GPURenderSystem.ts:31 and src/systems/RenderSystem.ts:11", () => {
    const gpuSys = new GPURenderSystem();

    // RenderSystem can't be instantiated in Node (its constructor needs a real
    // browser window/canvas/WebGL-or-WebGPU context), so its priority is read
    // directly from source rather than from a live instance. This is exactly
    // the `priority = 900;` class-field declaration compiled into its
    // constructor; reading the source text is equivalent to reading the value
    // an instance would have.
    const renderSystemSrc = fs.readFileSync(
      path.resolve(__dirname, "../systems/RenderSystem.ts"),
      "utf8",
    );
    const match = renderSystemSrc.match(/priority\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    const renderSystemPriority = Number(match![1]);

    expect(gpuSys.priority).not.toBe(renderSystemPriority);
  });
});
