import * as THREE from "three";
import {
  AGEE, Transform, MeshRenderer,
  AISystem, Perception, AIDebugPanel,
  SteeringSystem, SteeringAgent, SteeringFlag,
} from "../../src/index";
import type { BTNode } from "../../src/index";
import { createOrbitCamera } from "../shared/orbitCamera";
import { createHUD } from "../shared/hud";

const AGENT_COUNT = 5;
const ARENA_RADIUS = 9;

async function main(): Promise<void> {
  const engine = new AGEE({ renderBackend: "webgpu", profiler: true });
  await engine.init();

  // AISystem/SteeringSystem/AIDebugPanel are opt-in — the engine doesn't wire them up by
  // default the way physics/rendering are, so this example registers them itself.
  const steering = new SteeringSystem();
  const ai = new AISystem();
  const aiDebug = new AIDebugPanel();
  engine.world.addSystem(steering);
  engine.world.addSystem(ai);
  engine.world.addSystem(aiDebug);

  createOrbitCamera(engine, { target: { x: 0, y: 0, z: 0 }, distance: 20, height: 14 });
  engine.lighting.addAmbientLight(0x334455, 0.5);
  engine.lighting.addDirectionalLight(0xfff2d0, 1.0, { x: 6, y: 14, z: 4 }, true);

  const groundMesh = new THREE.Mesh(
    new THREE.CircleGeometry(ARENA_RADIUS + 1, 48),
    new THREE.MeshStandardMaterial({ color: 0x232730, roughness: 1 })
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.receiveShadow = true;
  engine.render.scene.add(groundMesh);

  // Bait entity — a plain Transform+MeshRenderer that tracks the mouse's intersection with
  // the ground plane. It carries no AI/steering of its own; agents perceive it via Perception.
  const baitEid = engine.world.createEntity();
  const baitMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 16, 16),
    new THREE.MeshStandardMaterial({ color: 0xffee66, emissive: 0x554400, emissiveIntensity: 0.6 })
  );
  engine.render.scene.add(baitMesh);
  engine.world.addComponent(baitEid, Transform, { x: 0, y: 0.25, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
  engine.world.addComponent(baitEid, MeshRenderer, { meshRef: baitMesh, visible: 1, castShadow: 0, receiveShadow: 0 });

  const baitTransformStore = engine.world.getStore(Transform);
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hitPoint = new THREE.Vector3();
  window.addEventListener("mousemove", (e) => {
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, engine.render.camera);
    if (raycaster.ray.intersectPlane(groundPlane, hitPoint)) {
      const r = Math.min(ARENA_RADIUS, Math.hypot(hitPoint.x, hitPoint.z));
      const angle = Math.atan2(hitPoint.z, hitPoint.x);
      baitTransformStore.set(baitEid, "x", Math.cos(angle) * r);
      baitTransformStore.set(baitEid, "z", Math.sin(angle) * r);
    }
  });

  // Only the bait is perceivable — agents shouldn't "see" the ground, each other, or the
  // camera rig entity that createOrbitCamera creates.
  ai.setFactionFilter((_perceiver, target) => target === baitEid);

  // --- Behavior tree: chase the bait when it's perceived, otherwise wander the arena ---
  ai.btRunner.registerCondition("hasTarget", (_eid, bb) => bb.get<boolean>("hasTarget") === true);

  ai.btRunner.registerAction("chase", (eid, bb) => {
    const tx = bb.get<number>("targetLastX") ?? 0;
    const tz = bb.get<number>("targetLastZ") ?? 0;
    steerStore.set(eid, "behaviors", SteeringFlag.Seek);
    steerStore.set(eid, "targetX", tx);
    steerStore.set(eid, "targetZ", tz);
    return "running";
  });

  ai.btRunner.registerAction("patrol", (eid) => {
    if (steerStore.get(eid, "behaviors") !== SteeringFlag.Wander) {
      steerStore.set(eid, "behaviors", SteeringFlag.Wander);
    }
    return "running";
  });

  const tree: BTNode = {
    type: "selector",
    name: "root",
    children: [
      { type: "sequence", name: "chaseSeq", children: [
        { type: "condition", name: "hasTarget" },
        { type: "action", name: "chase" },
      ] },
      { type: "action", name: "patrol" },
    ],
  };

  const steerStore = engine.world.getStore(SteeringAgent);
  const perceptionStore = engine.world.getStore(Perception);
  const transformStore = engine.world.getStore(Transform);

  const agentColors = [0x4af, 0xf84, 0x9f4, 0xf4c, 0x4fe];
  const agentEids: number[] = [];
  const agentMaterials: THREE.MeshStandardMaterial[] = [];

  const coneGeo = new THREE.ConeGeometry(0.35, 0.9, 12).rotateX(Math.PI / 2);

  for (let i = 0; i < AGENT_COUNT; i++) {
    const eid = engine.world.createEntity();
    const angle = (i / AGENT_COUNT) * Math.PI * 2;
    const spawnX = Math.cos(angle) * 5;
    const spawnZ = Math.sin(angle) * 5;

    const material = new THREE.MeshStandardMaterial({ color: agentColors[i % agentColors.length], roughness: 0.6 });
    agentMaterials.push(material);
    const mesh = new THREE.Mesh(coneGeo, material);
    mesh.castShadow = true;
    engine.render.scene.add(mesh);

    engine.world.addComponent(eid, Transform, { x: spawnX, y: 0.45, z: spawnZ, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    engine.world.addComponent(eid, MeshRenderer, { meshRef: mesh, visible: 1, castShadow: 1, receiveShadow: 0 });

    engine.world.addComponent(eid, SteeringAgent, {
      maxSpeed: 3, maxForce: 6, mass: 1,
      vx: 0, vy: 0, vz: 0, steerX: 0, steerY: 0, steerZ: 0,
      behaviors: SteeringFlag.Wander,
      wanderAngle: Math.random() * Math.PI * 2, wanderRadius: 1.5, wanderDistance: 2.5, wanderJitter: 1.2,
      arriveRadius: 0.3, slowRadius: 2,
      targetX: 0, targetY: 0, targetZ: 0, targetEid: -1,
      avoidDistance: 0, neighborRadius: 0,
      separationWeight: 0, alignmentWeight: 0, cohesionWeight: 0, groupId: 0,
    });

    engine.world.addComponent(eid, Perception, {
      sightRange: 5.5, sightAngle: 0, hearingRange: 0,
      targetEntity: -1, hasTarget: 0,
      targetLastX: 0, targetLastY: 0, targetLastZ: 0,
      alertLevel: 0,
    });

    ai.createAgent(eid, tree, 0.12);
    aiDebug.track(eid, `Agent ${i + 1}`, { blackboard: ai.getBlackboard(eid) ?? undefined });

    agentEids.push(eid);
  }

  // Keep each agent inside the arena — a soft steer-back-in force isn't in SteeringFlag, so
  // just clamp position directly each frame rather than fighting the steering forces.
  engine.events.on("preUpdate", () => {
    for (const eid of agentEids) {
      const x = transformStore.get(eid, "x") as number;
      const z = transformStore.get(eid, "z") as number;
      const r = Math.hypot(x, z);
      if (r > ARENA_RADIUS) {
        const s = ARENA_RADIUS / r;
        transformStore.set(eid, "x", x * s);
        transformStore.set(eid, "z", z * s);
      }
    }
  });

  // Recolor agents by chase/patrol state and refresh the HUD stat lines.
  const hud = createHUD("AI Agent", [
    "Move the mouse over the ground to lure agents",
    "Colored cones: cyan/patrol vs orange-tinted glow while chasing",
    "P (or button) toggles the AI debug panel",
  ]);

  const debugBtn = document.createElement("button");
  debugBtn.className = "agee-btn";
  debugBtn.textContent = "Toggle AI Debug Panel";
  debugBtn.style.marginTop = "6px";
  debugBtn.addEventListener("click", () => aiDebug.toggle());
  hud.root.appendChild(debugBtn);

  window.addEventListener("keydown", (e) => {
    if (e.key === "p" || e.key === "P") aiDebug.toggle();
  });

  engine.events.on("postUpdate", () => {
    let chasing = 0;
    for (let i = 0; i < agentEids.length; i++) {
      const eid = agentEids[i];
      const hasTarget = perceptionStore.get(eid, "hasTarget") === 1;
      if (hasTarget) chasing++;
      agentMaterials[i].emissive.setHex(hasTarget ? 0x552200 : 0x000000);
      agentMaterials[i].emissiveIntensity = hasTarget ? 0.8 : 0;
    }
    hud.setLine("chasing", `Chasing: ${chasing} / ${agentEids.length}`);
  });

  engine.start();
}

main().catch((err) => {
  console.error("[ai-agent example] failed to start:", err);
  document.body.innerHTML = `<pre style="color:#f66;padding:16px;white-space:pre-wrap">${String(err?.stack ?? err)}</pre>`;
});
