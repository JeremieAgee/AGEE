import * as THREE from "three";
import {
  AGEE, Transform, MeshRenderer, RigidBody,
  createHumanoid, animateHumanoidWalk, startHumanoidRagdoll, updateHumanoidRagdoll, cleanupHumanoid,
} from "../../src/index";
import type { HumanoidData, HumanoidMaterials } from "../../src/index";
import { createOrbitCamera } from "../shared/orbitCamera";
import { createHUD } from "../shared/hud";

const SPAWN = { x: 0, y: 0, z: 0 };

async function main(): Promise<void> {
  const engine = new AGEE({ renderBackend: "webgpu", profiler: true });
  await engine.init();

  createOrbitCamera(engine, { target: { x: 0, y: 1, z: 0 }, distance: 8, height: 3 });

  engine.lighting.addAmbientLight(0x334455, 0.4);
  engine.lighting.addDirectionalLight(0xfff2d0, 1.1, { x: 8, y: 12, z: 6 }, true);

  // Ground — static collider the ragdoll and scattered props rest on
  const groundEid = engine.world.createEntity();
  const groundMesh = new THREE.Mesh(
    new THREE.BoxGeometry(24, 1, 24),
    new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.95 })
  );
  groundMesh.receiveShadow = true;
  engine.render.scene.add(groundMesh);
  engine.world.addComponent(groundEid, Transform, { x: 0, y: -0.5, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
  engine.world.addComponent(groundEid, MeshRenderer, { meshRef: groundMesh, visible: 1, castShadow: 0, receiveShadow: 1 });
  engine.physics.addBody(groundEid, "fixed");
  engine.physics.addCollider(groundEid, "box", { halfX: 12, halfY: 0.5, halfZ: 12 });

  // A few scattered boxes for the ragdoll to collide with / land on
  const rigidBodyStore = engine.world.getStore(RigidBody);
  const propPositions = [
    { x: -2.2, z: 1.5 }, { x: 2.4, z: -1 }, { x: 0.5, z: 2.6 }, { x: -1.6, z: -2.2 },
  ];
  for (const p of propPositions) {
    const eid = engine.world.createEntity();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x886644, roughness: 0.8 })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    engine.render.scene.add(mesh);
    engine.world.addComponent(eid, Transform, { x: p.x, y: 0.5, z: p.z, rx: 0, ry: Math.random() * Math.PI, rz: 0, sx: 1, sy: 1, sz: 1 });
    engine.world.addComponent(eid, MeshRenderer, { meshRef: mesh, visible: 1, castShadow: 1, receiveShadow: 1 });
    engine.physics.addBody(eid, "dynamic");
    rigidBodyStore.set(eid, "friction", 0.8);
    engine.physics.addCollider(eid, "box", { halfX: 0.25, halfY: 0.25, halfZ: 0.25 });
  }

  const materials: HumanoidMaterials = {
    body: new THREE.MeshStandardMaterial({ color: 0xd9a066, roughness: 0.7, metalness: 0.02 }),
    eyes: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3 }),
  };

  let humanoid: HumanoidData | null = null;
  let walking = true;

  function spawnHumanoid(): void {
    if (humanoid) {
      cleanupHumanoid(humanoid, engine.skeleton);
    }
    humanoid = createHumanoid(engine.skeleton, materials);
    humanoid.group.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
    engine.render.scene.add(humanoid.group);
  }

  spawnHumanoid();

  const forward = new THREE.Vector3();
  function ragdollHumanoid(): void {
    if (!humanoid || humanoid.ragdolling) return;
    const hipsPivot = humanoid.pivots[0]?.mesh;
    const worldPos = new THREE.Vector3();
    (hipsPivot ?? humanoid.group).getWorldPosition(worldPos);
    engine.render.camera.getWorldDirection(forward);
    startHumanoidRagdoll(humanoid, engine.skeleton, engine.physics, worldPos, forward.clone());
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "r" || e.key === "R") spawnHumanoid();
    if (e.key === " ") { e.preventDefault(); ragdollHumanoid(); }
  });

  engine.events.on("preUpdate", (dt: number) => {
    if (!humanoid) return;
    if (humanoid.ragdolling) {
      updateHumanoidRagdoll(humanoid, engine.skeleton);
    } else {
      animateHumanoidWalk(humanoid, dt, walking);
    }
  });

  const hud = createHUD("Physics Ragdoll", [
    "Drag to orbit, scroll to zoom",
    "Space (or button) = ragdoll, camera-aimed impulse",
    "R (or button) = reset",
    "` = dev console (F3/I need EDITOR=true)",
  ]);

  const walkRow = document.createElement("label");
  walkRow.className = "agee-row";
  const walkSpan = document.createElement("span");
  walkSpan.textContent = "Animate walk cycle";
  const walkCheckbox = document.createElement("input");
  walkCheckbox.type = "checkbox";
  walkCheckbox.checked = walking;
  walkCheckbox.addEventListener("change", () => { walking = walkCheckbox.checked; });
  walkRow.appendChild(walkSpan);
  walkRow.appendChild(walkCheckbox);
  hud.root.appendChild(walkRow);

  const ragdollBtn = document.createElement("button");
  ragdollBtn.className = "agee-btn";
  ragdollBtn.textContent = "Ragdoll!";
  ragdollBtn.style.marginTop = "6px";
  ragdollBtn.style.marginRight = "6px";
  ragdollBtn.addEventListener("click", ragdollHumanoid);
  hud.root.appendChild(ragdollBtn);

  const resetBtn = document.createElement("button");
  resetBtn.className = "agee-btn";
  resetBtn.textContent = "Reset";
  resetBtn.style.marginTop = "6px";
  resetBtn.addEventListener("click", spawnHumanoid);
  hud.root.appendChild(resetBtn);

  engine.events.on("postUpdate", () => {
    hud.setLine("state", `State: ${humanoid?.ragdolling ? "ragdolling (physics-driven)" : "animated (kinematic)"}`);
  });

  engine.start();
}

main().catch((err) => {
  console.error("[physics-ragdoll example] failed to start:", err);
  document.body.innerHTML = `<pre style="color:#f66;padding:16px;white-space:pre-wrap">${String(err?.stack ?? err)}</pre>`;
});
