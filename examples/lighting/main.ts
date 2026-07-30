import * as THREE from "three";
import { AGEE, Transform, MeshRenderer, Light } from "../../src/index";
import { createOrbitCamera } from "../shared/orbitCamera";
import { createHUD } from "../shared/hud";

async function main(): Promise<void> {
  const engine = new AGEE({ renderBackend: "webgpu", profiler: true });
  await engine.init();

  createOrbitCamera(engine, { target: { x: 0, y: 1.5, z: 0 }, distance: 16, height: 6 });

  const lightStore = engine.world.getStore(Light);

  const ambientEid = engine.lighting.addAmbientLight(0x223344, 0.35);
  const dirEid = engine.lighting.addDirectionalLight(0xfff2d0, 1.2, { x: 8, y: 12, z: 6 }, true);
  const pointEid = engine.lighting.addPointLight(0xff5533, 2.5, 25, { x: -6, y: 3, z: 1 }, false);
  const spotEid = engine.lighting.addSpotLight(0x55aaff, 4, 30, Math.PI / 7, 0.4, { x: 0, y: 10, z: -3 }, true);

  // Ground plane
  const groundEid = engine.world.createEntity();
  const groundMesh = new THREE.Mesh(
    new THREE.BoxGeometry(30, 0.5, 30),
    new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.9, metalness: 0.05 })
  );
  groundMesh.receiveShadow = true;
  engine.render.scene.add(groundMesh);
  engine.world.addComponent(groundEid, Transform, { x: 0, y: -0.25, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
  engine.world.addComponent(groundEid, MeshRenderer, { meshRef: groundMesh, visible: 1, castShadow: 0, receiveShadow: 1 });

  // Showcase shapes with varying PBR params, so each light type reads differently on each
  const shapes: Array<{ geo: THREE.BufferGeometry; x: number; metalness: number; roughness: number }> = [
    { geo: new THREE.SphereGeometry(1, 32, 32), x: -4, metalness: 0.9, roughness: 0.15 },
    { geo: new THREE.TorusKnotGeometry(0.8, 0.28, 128, 16), x: 0, metalness: 0.1, roughness: 0.4 },
    { geo: new THREE.BoxGeometry(1.6, 1.6, 1.6), x: 4, metalness: 0.0, roughness: 0.85 },
  ];
  const spinEids: number[] = [];
  for (const s of shapes) {
    const eid = engine.world.createEntity();
    const mesh = new THREE.Mesh(s.geo, new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: s.metalness, roughness: s.roughness }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    engine.render.scene.add(mesh);
    engine.world.addComponent(eid, Transform, { x: s.x, y: 1.5, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    engine.world.addComponent(eid, MeshRenderer, { meshRef: mesh, visible: 1, castShadow: 1, receiveShadow: 1 });
    spinEids.push(eid);
  }

  const transformStore = engine.world.getStore(Transform);
  engine.events.on("preUpdate", (dt: number) => {
    for (const eid of spinEids) {
      transformStore.set(eid, "ry", (transformStore.get(eid, "ry") as number) + dt * 0.6);
    }
  });

  const hud = createHUD("Lighting", [
    "Drag to orbit, scroll to zoom",
    "Toggle each light on/off below",
    "I = inspector, F3 = perf, ` = console",
  ]);

  const lights: Array<{ name: string; eid: number; intensity: number }> = [
    { name: "Ambient", eid: ambientEid, intensity: 0.35 },
    { name: "Directional (sun)", eid: dirEid, intensity: 1.2 },
    { name: "Point (red)", eid: pointEid, intensity: 2.5 },
    { name: "Spot (blue)", eid: spotEid, intensity: 4 },
  ];

  for (const l of lights) {
    const row = document.createElement("label");
    row.className = "agee-row";

    const span = document.createElement("span");
    span.textContent = l.name;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.addEventListener("change", () => {
      const lightObj = lightStore.get(l.eid, "lightRef") as THREE.Light;
      const nextIntensity = checkbox.checked ? l.intensity : 0;
      lightObj.intensity = nextIntensity;
      lightStore.set(l.eid, "intensity", nextIntensity);
    });

    row.appendChild(span);
    row.appendChild(checkbox);
    hud.root.appendChild(row);
  }
}

main().catch((err) => {
  console.error("[lighting example] failed to start:", err);
  document.body.innerHTML = `<pre style="color:#f66;padding:16px;white-space:pre-wrap">${String(err?.stack ?? err)}</pre>`;
});
