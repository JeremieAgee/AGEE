import * as THREE from "three";
import { AGEE, Transform, MeshRenderer } from "../../src/index";
import { createOrbitCamera } from "../shared/orbitCamera";
import { createHUD } from "../shared/hud";

// The smallest useful AGEE program: one entity, one light, one camera. Everything else on
// screen (grid, axes) is raw Three.js scene dressing added directly to engine.render.scene,
// not part of the ECS — so it doesn't count against "one entity".
async function main(): Promise<void> {
  const engine = new AGEE({ renderBackend: "webgpu" });
  await engine.init();

  createOrbitCamera(engine, { target: { x: 0, y: 0.5, z: 0 }, distance: 6, height: 3 });

  engine.lighting.addDirectionalLight(0xffffff, 1.4, { x: 4, y: 6, z: 3 }, true);

  engine.render.scene.add(new THREE.GridHelper(10, 10, 0x2a2d34, 0x1a1c22));
  engine.render.scene.add(new THREE.AxesHelper(1.5));

  const eid = engine.world.createEntity();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x4af, roughness: 0.4, metalness: 0.1 })
  );
  mesh.castShadow = true;
  engine.render.scene.add(mesh);
  engine.world.addComponent(eid, Transform, { x: 0, y: 0.5, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
  engine.world.addComponent(eid, MeshRenderer, { meshRef: mesh, visible: 1, castShadow: 1, receiveShadow: 0 });

  const transformStore = engine.world.getStore(Transform);
  engine.events.on("preUpdate", (dt: number) => {
    transformStore.set(eid, "ry", (transformStore.get(eid, "ry") as number) + dt * 0.5);
  });

  createHUD("Basic Scene", [
    "Drag to orbit, scroll to zoom",
    "One entity, one light, one camera — the minimal AGEE bring-up",
    "` = dev console (F3/I need EDITOR=true)",
  ]);

  engine.start();
}

main().catch((err) => {
  console.error("[basic-scene example] failed to start:", err);
  document.body.innerHTML = `<pre style="color:#f66;padding:16px;white-space:pre-wrap">${String(err?.stack ?? err)}</pre>`;
});
