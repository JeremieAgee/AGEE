import * as THREE from "three";
import { AGEE, Transform, MeshRenderer, RigidBody } from "../../src/index";
import { createOrbitCamera } from "../shared/orbitCamera";
import { createHUD } from "../shared/hud";

const BRICK_HALF = { x: 0.5, y: 0.25, z: 0.25 }; // full brick = 1 x 0.5 x 0.5
const BRICK_COLORS = [0xaa5533, 0x9c4a2c, 0xb2603a, 0xa14e2e];
const WALL_ROWS = 25;
const WIDTH_HALF = 12; // house footprint: 24 wide (x) x 16 deep (z) — ~2000 bricks total
const DEPTH_HALF = 8;

interface HouseBrick {
  eid: number;
  spawnX: number;
  spawnY: number;
  spawnZ: number;
}

async function main(): Promise<void> {
  const engine = new AGEE({ renderBackend: "webgpu", profiler: true });
  await engine.init();

  createOrbitCamera(engine, { target: { x: 0, y: 6, z: 0 }, distance: 48, height: 20, maxDistance: 100 });

  engine.lighting.addAmbientLight(0x334455, 0.4);
  engine.lighting.addDirectionalLight(0xfff2d0, 1.1, { x: 10, y: 14, z: 8 }, true);

  // Ground — static collider the whole scene rests on
  const groundEid = engine.world.createEntity();
  const groundMesh = new THREE.Mesh(
    new THREE.BoxGeometry(40, 1, 40),
    new THREE.MeshStandardMaterial({ color: 0x2f3a2a, roughness: 0.95 })
  );
  groundMesh.receiveShadow = true;
  engine.render.scene.add(groundMesh);
  engine.world.addComponent(groundEid, Transform, { x: 0, y: -0.5, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
  engine.world.addComponent(groundEid, MeshRenderer, { meshRef: groundMesh, visible: 1, castShadow: 0, receiveShadow: 1 });
  engine.physics.addBody(groundEid, "fixed");
  engine.physics.addCollider(groundEid, "box", { halfX: 20, halfY: 0.5, halfZ: 20 });

  function createBrick(x: number, y: number, z: number, rotateY: number, hx: number, hy: number, hz: number): number {
    const eid = engine.world.createEntity();
    const color = BRICK_COLORS[Math.floor(Math.random() * BRICK_COLORS.length)];
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2),
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02 })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    engine.render.scene.add(mesh);
    engine.world.addComponent(eid, Transform, { x, y, z, rx: 0, ry: rotateY, rz: 0, sx: 1, sy: 1, sz: 1 });
    engine.world.addComponent(eid, MeshRenderer, { meshRef: mesh, visible: 1, castShadow: 1, receiveShadow: 1 });
    // RigidBody must exist before addBody() is called — addBody() only updates bodyHandle/
    // bodyType on an already-registered component, it won't create one for us.
    // High friction / low restitution so the house stands still under gravity and only comes
    // apart when actually struck, instead of jittering itself apart on spawn.
    engine.world.addComponent(eid, RigidBody, { bodyType: 1, mass: 1, restitution: 0.05, friction: 0.9 });
    // Bricks spawn fixed (immovable) — with ~2000 of them, simulating each as a free dynamic
    // body every step would be expensive for a structure that's mostly just sitting still.
    // Rapier skips collision detection between two non-dynamic bodies entirely, so a resting
    // wall of fixed bricks costs almost nothing. Struck bricks get flipped to dynamic (see
    // wakeBrick() below) the moment something moving actually touches them.
    engine.physics.addBody(eid, "fixed");
    engine.physics.addCollider(eid, "box", { halfX: hx, halfY: hy, halfZ: hz });
    return eid;
  }

  let house: HouseBrick[] = [];
  let houseBrickEids = new Set<number>();

  function buildHouse(): void {
    for (const brick of house) {
      if (engine.world.isAlive(brick.eid)) engine.world.destroyEntity(brick.eid);
    }
    house = [];
    houseBrickEids = new Set<number>();

    const addBrick = (x: number, y: number, z: number, rotateY: number, hx = BRICK_HALF.x, hy = BRICK_HALF.y, hz = BRICK_HALF.z): void => {
      const eid = createBrick(x, y, z, rotateY, hx, hy, hz);
      house.push({ eid, spawnX: x, spawnY: y, spawnZ: z });
      houseBrickEids.add(eid);
    };

    for (let row = 0; row < WALL_ROWS; row++) {
      const y = BRICK_HALF.y + row * (BRICK_HALF.y * 2);

      // Front wall (with a doorway gap in the bottom two rows) and back wall
      for (let x = -WIDTH_HALF + BRICK_HALF.x; x <= WIDTH_HALF - BRICK_HALF.x + 0.01; x += BRICK_HALF.x * 2) {
        const isDoorway = row < 2 && x > -1 && x < 1;
        if (!isDoorway) addBrick(x, y, -DEPTH_HALF, 0);
        addBrick(x, y, DEPTH_HALF, 0);
      }

      // Left and right walls (rotated 90° so the brick's long axis runs along Z)
      for (let z = -DEPTH_HALF + BRICK_HALF.x; z <= DEPTH_HALF - BRICK_HALF.x + 0.01; z += BRICK_HALF.x * 2) {
        addBrick(-WIDTH_HALF, y, z, Math.PI / 2);
        addBrick(WIDTH_HALF, y, z, Math.PI / 2);
      }
    }

    // Flat plank roof resting on top of the walls
    const roofY = BRICK_HALF.y * 2 * WALL_ROWS + 0.1;
    for (let z = -DEPTH_HALF + 0.4; z <= DEPTH_HALF - 0.4 + 0.01; z += 0.8) {
      addBrick(0, roofY, z, 0, WIDTH_HALF, 0.1, 0.38);
    }
  }

  buildHouse();

  // Wake a still-fixed brick into a free dynamic body. Only fires for collisions Rapier
  // actually reports, which — since fixed-vs-fixed contacts are never detected — means only
  // the wrecking ball or an already-falling brick can trigger this. That gives the collapse a
  // natural cascade for free: a struck brick goes dynamic, falls into its still-fixed
  // neighbors, and wakes them in turn.
  function wakeBrick(eid: number): void {
    if (!houseBrickEids.has(eid)) return;
    houseBrickEids.delete(eid);
    engine.physics.setBodyType(eid, "dynamic");
  }

  engine.physics.onCollisionStart(({ entityA, entityB }) => {
    wakeBrick(entityA);
    wakeBrick(entityB);
  });

  // Wrecking ball: right-click fires a heavy sphere from the camera along its look direction
  const projectiles: number[] = [];
  const forward = new THREE.Vector3();
  const spawnPos = new THREE.Vector3();

  function fireProjectile(): void {
    engine.render.camera.getWorldDirection(forward);
    spawnPos.copy(engine.render.camera.position).addScaledVector(forward, 2);

    const eid = engine.world.createEntity();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 20, 20),
      new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.7, roughness: 0.25 })
    );
    mesh.castShadow = true;
    engine.render.scene.add(mesh);
    engine.world.addComponent(eid, Transform, { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    engine.world.addComponent(eid, MeshRenderer, { meshRef: mesh, visible: 1, castShadow: 1, receiveShadow: 1 });
    engine.world.addComponent(eid, RigidBody, { bodyType: 0, mass: 6, restitution: 0.3, friction: 0.5 });
    engine.physics.addBody(eid, "dynamic");
    engine.physics.addCollider(eid, "sphere", { radius: 0.6 });

    const body = engine.physics.getBody(eid)!;
    const speed = 26;
    body.setLinvel({ x: forward.x * speed, y: forward.y * speed, z: forward.z * speed }, true);

    projectiles.push(eid);
  }

  window.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("mousedown", (e) => {
    if (e.button === 2) fireProjectile();
  });

  const hud = createHUD("Destructible Brick House", [
    "Left-drag to orbit, scroll to zoom",
    "Right-click to fire a wrecking ball",
    "` = dev console (F3/I need EDITOR=true)",
  ]);

  const resetBtn = document.createElement("button");
  resetBtn.className = "agee-btn";
  resetBtn.textContent = "Reset house";
  resetBtn.style.marginTop = "6px";
  resetBtn.addEventListener("click", () => {
    for (const p of projectiles.splice(0)) {
      if (engine.world.isAlive(p)) engine.world.destroyEntity(p);
    }
    buildHouse();
  });
  hud.root.appendChild(resetBtn);

  const transformStore = engine.world.getStore(Transform);
  engine.events.on("preUpdate", () => {
    // Clean up projectiles that have rolled far away or fallen off the world
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const eid = projectiles[i];
      if (!engine.world.isAlive(eid) || (transformStore.get(eid, "y") as number) < -10) {
        if (engine.world.isAlive(eid)) engine.world.destroyEntity(eid);
        projectiles.splice(i, 1);
      }
    }

    let toppled = 0;
    for (const brick of house) {
      if (!engine.world.isAlive(brick.eid)) continue;
      const dx = (transformStore.get(brick.eid, "x") as number) - brick.spawnX;
      const dy = (transformStore.get(brick.eid, "y") as number) - brick.spawnY;
      const dz = (transformStore.get(brick.eid, "z") as number) - brick.spawnZ;
      if (dx * dx + dy * dy + dz * dz > 0.5 * 0.5) toppled++;
    }
    hud.setLine("toppled", `Bricks toppled: ${toppled} / ${house.length}`);
    hud.setLine("projectiles", `Active projectiles: ${projectiles.length}`);
  });

  engine.start();
}

main().catch((err) => {
  console.error("[destructible-brick-house example] failed to start:", err);
  document.body.innerHTML = `<pre style="color:#f66;padding:16px;white-space:pre-wrap">${String(err?.stack ?? err)}</pre>`;
});
