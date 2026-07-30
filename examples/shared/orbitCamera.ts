import type { AGEE } from "../../src/core/Engine";
import { CameraMode, CameraData } from "../../src/camera/CameraSystem";
import { Transform } from "../../src/core/Components";

export interface OrbitCameraOptions {
  target?: { x: number; y: number; z: number };
  distance?: number;
  minDistance?: number;
  maxDistance?: number;
  height?: number;
  fov?: number;
}

export interface OrbitCameraHandle {
  targetEid: number;
  cameraEid: number;
  dispose(): void;
}

// Mouse-drag-to-orbit / wheel-to-zoom rig built on top of CameraSystem's Orbit mode. Shared
// across examples since every scene needs some way to look around; keeps main.ts focused on
// the thing the example is actually demonstrating.
export function createOrbitCamera(engine: AGEE, opts: OrbitCameraOptions = {}): OrbitCameraHandle {
  const targetPos = opts.target ?? { x: 0, y: 0, z: 0 };
  const targetEid = engine.world.createEntity();
  engine.world.addComponent(targetEid, Transform, {
    x: targetPos.x, y: targetPos.y, z: targetPos.z,
    rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
  });

  const minDistance = opts.minDistance ?? 3;
  const maxDistance = opts.maxDistance ?? 60;
  let distance = opts.distance ?? 12;

  const cameraEid = engine.world.createEntity();
  engine.world.addComponent(cameraEid, Transform, { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
  engine.camera.createCamera(cameraEid, CameraMode.Orbit, {
    targetEntity: targetEid,
    distance,
    height: opts.height ?? 4,
    fov: opts.fov ?? 60,
    smoothing: 6,
    primary: true,
  });
  engine.camera.setPrimary(cameraEid);

  const cameraStore = engine.world.getStore(CameraData);
  let dragging = false;

  const onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) dragging = true;
  };
  const onMouseUp = (): void => {
    dragging = false;
  };
  const onWheel = (e: WheelEvent): void => {
    distance = Math.max(minDistance, Math.min(maxDistance, distance + e.deltaY * 0.01));
    cameraStore.set(cameraEid, "distance", distance);
  };

  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("wheel", onWheel, { passive: true });

  const offPreUpdate = engine.events.on("preUpdate", () => {
    if (dragging) {
      engine.camera.rotate(cameraEid, -engine.input.mouse.dx * 0.005, -engine.input.mouse.dy * 0.005);
    }
  });

  return {
    targetEid,
    cameraEid,
    dispose(): void {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("wheel", onWheel);
      offPreUpdate();
    },
  };
}
