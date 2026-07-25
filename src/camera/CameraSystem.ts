import * as THREE from "three";
import { System, World, ComponentStore, defineComponent } from "../ecs";
import { Transform } from "../core/Components";
import { Mat4 } from "../core/math/Mat4";
import { Vec3 } from "../core/math/Vec3";

export const enum CameraMode {
  Free = 0,
  Follow = 1,
  Orbit = 2,
  FPS = 3,
  Cinematic = 4,
}

export const CameraData = defineComponent("CameraData", {
  mode: "u8",
  targetEntity: "i32",
  distance: "f32",
  height: "f32",
  fov: "f32",
  near: "f32",
  far: "f32",
  yaw: "f32",
  pitch: "f32",
  smoothing: "f32",
  shakeIntensity: "f32",
  shakeDecay: "f32",
  offsetX: "f32",
  offsetY: "f32",
  offsetZ: "f32",
  active: "bool",
  primary: "bool",
});

export class CameraSystem extends System {
  priority = 55;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "postPhysics";

  static reads = ["Transform", "CameraData"];
  static writes: string[] = [];

  private camStore!: ComponentStore;
  private transformStore!: ComponentStore;
  private query!: ReturnType<World["query"]>;
  private camera!: THREE.PerspectiveCamera;

  private currentPos = new THREE.Vector3();
  private targetPos = new THREE.Vector3();
  private lookAtPos = new THREE.Vector3();
  private terrainHeightFn: ((x: number, z: number) => number) | null = null;
  private terrainClearance = 2.0;

  private activeCameraEid = -1;

  // Native matrices for GPU render pipeline (no Three.js dependency)
  readonly nativeViewMatrix = new Mat4();
  readonly nativeProjMatrix = new Mat4();
  readonly nativeCameraPos = new Vec3();
  private readonly _eyeVec = new Vec3();
  private readonly _targetVec = new Vec3();
  private readonly _upVec = new Vec3(0, 1, 0);

  setCamera(camera: THREE.PerspectiveCamera): void {
    this.camera = camera;
  }

  getActiveCameraEid(): number {
    return this.activeCameraEid;
  }

  setTerrainHeightFn(fn: (x: number, z: number) => number, clearance: number = 2.0): void {
    this.terrainHeightFn = fn;
    this.terrainClearance = clearance;
  }

  init(): void {
    this.camStore = this.world.getStore(CameraData);
    this.transformStore = this.world.getStore(Transform);
    this.query = this.world.query(CameraData);
  }

  createCamera(
    eid: number,
    mode: CameraMode,
    config: {
      targetEntity?: number;
      distance?: number;
      height?: number;
      fov?: number;
      near?: number;
      far?: number;
      smoothing?: number;
      offsetX?: number;
      offsetY?: number;
      offsetZ?: number;
      primary?: boolean;
    } = {}
  ): void {
    this.world.addComponent(eid, CameraData, {
      mode,
      targetEntity: config.targetEntity ?? -1,
      distance: config.distance ?? 10,
      height: config.height ?? 5,
      fov: config.fov ?? 60,
      near: config.near ?? 0.1,
      far: config.far ?? 1000,
      yaw: 0,
      pitch: 0.3,
      smoothing: config.smoothing ?? 5,
      shakeIntensity: 0,
      shakeDecay: 5,
      offsetX: config.offsetX ?? 0,
      offsetY: config.offsetY ?? 0,
      offsetZ: config.offsetZ ?? 0,
      active: 1,
      primary: config.primary ? 1 : 0,
    });
  }

  setPrimary(eid: number): void {
    const entities = this.query.entities;
    for (let i = 0; i < entities.length; i++) {
      this.camStore.set(entities[i], "primary", 0);
    }
    this.camStore.set(eid, "primary", 1);
  }

  setTarget(eid: number, targetEntity: number): void {
    this.camStore.set(eid, "targetEntity", targetEntity);
  }

  setMode(eid: number, mode: CameraMode): void {
    this.camStore.set(eid, "mode", mode);
  }

  shake(eid: number, intensity: number): void {
    this.camStore.set(eid, "shakeIntensity", intensity);
  }

  rotate(eid: number, dyaw: number, dpitch: number): void {
    const yaw = (this.camStore.get(eid, "yaw") as number) + dyaw;
    const pitch = Math.max(-1.2, Math.min(1.2, (this.camStore.get(eid, "pitch") as number) + dpitch));
    this.camStore.set(eid, "yaw", yaw);
    this.camStore.set(eid, "pitch", pitch);
  }

  getYaw(eid: number): number {
    return this.camStore.get(eid, "yaw") as number;
  }

  update(dt: number): void {
    if (!this.camera) return;

    const entities = this.query.entities;
    const modes = this.camStore.getColumn("mode");
    const targets = this.camStore.getColumn("targetEntity");
    const distances = this.camStore.getColumn("distance");
    const heights = this.camStore.getColumn("height");
    const fovs = this.camStore.getColumn("fov");
    const nears = this.camStore.getColumn("near");
    const fars = this.camStore.getColumn("far");
    const yaws = this.camStore.getColumn("yaw");
    const pitches = this.camStore.getColumn("pitch");
    const smoothings = this.camStore.getColumn("smoothing");
    const shakes = this.camStore.getColumn("shakeIntensity");
    const shakeDecays = this.camStore.getColumn("shakeDecay");
    const actives = this.camStore.getColumn("active");
    const primaries = this.camStore.getColumn("primary");
    const offX = this.camStore.getColumn("offsetX");
    const offY = this.camStore.getColumn("offsetY");
    const offZ = this.camStore.getColumn("offsetZ");

    const tx = this.transformStore.getColumn("x");
    const ty = this.transformStore.getColumn("y");
    const tz = this.transformStore.getColumn("z");

    // Find primary camera (first primary active, or fallback to first active)
    let primaryEid = -1;
    let fallbackEid = -1;
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (actives[eid] === 0) continue;
      if (fallbackEid < 0) fallbackEid = eid;
      if (primaries[eid] !== 0) {
        primaryEid = eid;
        break;
      }
    }
    const activeEid = primaryEid >= 0 ? primaryEid : fallbackEid;
    if (activeEid < 0) return;
    this.activeCameraEid = activeEid;

    const eid = activeEid;
    const mode = modes[eid] as CameraMode;
    const targetEid = targets[eid];
    const dist = distances[eid];
    const height = heights[eid];
    const yaw = yaws[eid];
    const pitch = pitches[eid];
    const smooth = smoothings[eid];

    // Sync camera projection from component data
    const fov = fovs[eid];
    const near = nears[eid];
    const far = fars[eid];
    if (fov > 0 && fov !== this.camera.fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    if (near > 0 && near !== this.camera.near) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    if (far > 0 && far !== this.camera.far) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }

    if (targetEid >= 0 && this.transformStore.has(targetEid)) {
      this.targetPos.set(tx[targetEid], ty[targetEid], tz[targetEid]);
    }

    switch (mode) {
      case CameraMode.Follow:
      case CameraMode.Orbit: {
        const cosPitch = Math.cos(pitch);
        const goalX = this.targetPos.x + Math.sin(yaw) * dist * cosPitch + offX[eid];
        const goalY = this.targetPos.y + height + Math.sin(pitch) * dist + offY[eid];
        const goalZ = this.targetPos.z + Math.cos(yaw) * dist * cosPitch + offZ[eid];

        const lerpFactor = 1 - Math.exp(-smooth * dt);
        this.currentPos.x += (goalX - this.currentPos.x) * lerpFactor;
        this.currentPos.y += (goalY - this.currentPos.y) * lerpFactor;
        this.currentPos.z += (goalZ - this.currentPos.z) * lerpFactor;

        this.lookAtPos.copy(this.targetPos);
        this.lookAtPos.y += 1.2;
        break;
      }
      case CameraMode.FPS: {
        this.currentPos.set(
          this.targetPos.x + offX[eid],
          this.targetPos.y + height + offY[eid],
          this.targetPos.z + offZ[eid]
        );
        const lookDist = 10;
        this.lookAtPos.set(
          this.currentPos.x - Math.sin(yaw) * lookDist * Math.cos(pitch),
          this.currentPos.y - Math.sin(pitch) * lookDist,
          this.currentPos.z - Math.cos(yaw) * lookDist * Math.cos(pitch)
        );
        break;
      }
      case CameraMode.Free: {
        this.currentPos.set(tx[eid], ty[eid], tz[eid]);
        this.lookAtPos.set(
          this.currentPos.x - Math.sin(yaw),
          this.currentPos.y - Math.sin(pitch),
          this.currentPos.z - Math.cos(yaw)
        );
        break;
      }
    }

    // Frame-rate independent screen shake via dt-scaled exponential decay
    if (shakes[eid] > 0.01) {
      this.currentPos.x += (Math.random() - 0.5) * shakes[eid];
      this.currentPos.y += (Math.random() - 0.5) * shakes[eid];
      shakes[eid] *= Math.exp(-shakeDecays[eid] * dt);
    } else {
      shakes[eid] = 0;
    }

    if (this.terrainHeightFn) {
      const terrainY = this.terrainHeightFn(this.currentPos.x, this.currentPos.z) + this.terrainClearance;
      if (this.currentPos.y < terrainY) {
        this.currentPos.y = terrainY;
      }
    }

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.lookAtPos);

    // Compute native matrices for GPU render pipeline
    this._eyeVec.set(this.currentPos.x, this.currentPos.y, this.currentPos.z);
    this._targetVec.set(this.lookAtPos.x, this.lookAtPos.y, this.lookAtPos.z);
    this.nativeViewMatrix.lookAt(this._eyeVec, this._targetVec, this._upVec);
    this.nativeProjMatrix.perspective(
      fov * Math.PI / 180,
      this.camera.aspect,
      near,
      far,
    );
    this.nativeCameraPos.copy(this._eyeVec);
  }
}
