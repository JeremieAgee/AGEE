import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

import { World } from "../ecs/World";
import { Transform, RigidBody, Collider, Velocity } from "../core/Components";
import { PhysicsSystem } from "../systems/PhysicsSystem";
import { Quat } from "../core/math/Quat";

function approx(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) < eps;
}

// Builds a fresh World + initialized PhysicsSystem pair. Mirrors how AGEE.doInit() wires
// PhysicsSystem: initRapier() (loads the WASM module) and world.addSystem() (which calls
// PhysicsSystem.init() to grab component stores/queries) can happen in either order since
// they touch disjoint state.
async function makePhysicsWorld(): Promise<{ world: World; physics: PhysicsSystem }> {
  const world = new World();
  const physics = new PhysicsSystem();
  await physics.initRapier();
  world.addSystem(physics);
  return { world, physics };
}

function addFallingBody(
  world: World,
  physics: PhysicsSystem,
  type: "dynamic" | "fixed" | "kinematic",
  y: number,
  opts: { canSleep?: boolean } = {}
) {
  const eid = world.createEntity();
  world.addComponent(eid, Transform, { x: 0, y, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
  world.addComponent(eid, RigidBody, { bodyType: type === "dynamic" ? 0 : type === "fixed" ? 1 : 2, mass: 1, restitution: 0.3, friction: 0.5 });
  const body = physics.addBody(eid, type, opts);
  return { eid, body };
}

describe("PhysicsSystem — rigid body lifecycle", () => {
  let world: World;
  let physics: PhysicsSystem;

  beforeAll(async () => {
    ({ world, physics } = await makePhysicsWorld());
  }, 15000);

  afterAll(() => {
    physics.destroy();
  });

  it("addBody creates a dynamic body retrievable via getBody", () => {
    const { eid, body } = addFallingBody(world, physics, "dynamic", 10);
    expect(physics.getBody(eid)).toBe(body);
    expect(body.isDynamic()).toBe(true);
  });

  it("addBody creates a fixed body that never falls", () => {
    const { eid, body } = addFallingBody(world, physics, "fixed", 0);
    expect(body.isFixed()).toBe(true);
    expect(physics.getBody(eid)).toBe(body);
  });

  it("addBody creates a kinematic body", () => {
    const { body } = addFallingBody(world, physics, "kinematic", 3);
    expect(body.isKinematic()).toBeTruthy();
  });

  it("addCollider attaches a collider retrievable via getCollider", () => {
    const { eid } = addFallingBody(world, physics, "dynamic", 8);
    const collider = physics.addCollider(eid, "sphere", { radius: 0.4 });
    expect(physics.getCollider(eid)).toBe(collider);
    expect(world.hasComponent(eid, Collider)).toBe(true);
  });

  it("removeBody fully cleans up body, collider, and components", () => {
    const { eid } = addFallingBody(world, physics, "dynamic", 6);
    physics.addCollider(eid, "box", { halfX: 0.5, halfY: 0.5, halfZ: 0.5 });
    expect(physics.getBody(eid)).toBeDefined();

    physics.removeBody(eid);

    expect(physics.getBody(eid)).toBeUndefined();
    expect(physics.getCollider(eid)).toBeUndefined();
    expect(world.hasComponent(eid, RigidBody)).toBe(false);
    expect(world.hasComponent(eid, Collider)).toBe(false);
  });

  it("entity destroy triggers RigidBody store's onRemove and cleans up physics state", () => {
    const { eid } = addFallingBody(world, physics, "dynamic", 4);
    physics.addCollider(eid, "sphere", { radius: 0.5 });
    world.destroyEntity(eid);
    expect(physics.getBody(eid)).toBeUndefined();
  });

  it("ensureCapacity grows internal SOA arrays past the initial 256 slots", () => {
    // INITIAL_CAPACITY in PhysicsSystem is 256 — push entity IDs well beyond that to force
    // the doubling-growth path in ensureCapacity() and confirm no data is lost/corrupted.
    let lastEid = 0;
    for (let i = 0; i < 300; i++) {
      const { eid, body } = addFallingBody(world, physics, "dynamic", 1 + i * 0.01);
      lastEid = eid;
      if (i === 299) {
        expect(physics.getBody(eid)).toBe(body);
      }
    }
    expect(lastEid).toBeGreaterThan(256);
    expect(physics.getBody(lastEid)).toBeDefined();
  });
});

describe("PhysicsSystem — simulation & interpolation", () => {
  let world: World;
  let physics: PhysicsSystem;

  beforeEach(async () => {
    ({ world, physics } = await makePhysicsWorld());
  }, 15000);

  afterEach(() => {
    physics.destroy();
  });

  it("dynamic body falls under gravity over time", () => {
    const { eid } = addFallingBody(world, physics, "dynamic", 20);
    physics.addCollider(eid, "sphere", { radius: 0.5 });
    const transformStore = world.getStore(Transform);
    const startY = transformStore.get(eid, "y");

    for (let i = 0; i < 30; i++) world.update(1 / 60);

    const endY = transformStore.get(eid, "y");
    expect(endY).toBeLessThan(startY);
  });

  it("fixed body never moves despite gravity", () => {
    const { eid } = addFallingBody(world, physics, "fixed", 5);
    physics.addCollider(eid, "box", { halfX: 1, halfY: 1, halfZ: 1 });
    const transformStore = world.getStore(Transform);

    for (let i = 0; i < 30; i++) world.update(1 / 60);

    expect(transformStore.get(eid, "y")).toBe(5);
  });

  it("Velocity component is populated from the rigid body's linear velocity", () => {
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 20, z: 0, sx: 1, sy: 1, sz: 1 });
    world.addComponent(eid, RigidBody, { bodyType: 0, mass: 1, restitution: 0.3, friction: 0.5 });
    world.addComponent(eid, Velocity, {});
    physics.addBody(eid, "dynamic");
    physics.addCollider(eid, "sphere", { radius: 0.5 });

    for (let i = 0; i < 10; i++) world.update(1 / 60);

    const velocityStore = world.getStore(Velocity);
    // Falling under gravity for several steps — vy should be meaningfully negative.
    expect(velocityStore.get(eid, "vy")).toBeLessThan(-0.1);
  });

  it("getInterpolatedPosition lerps correctly between prev and current physics steps", () => {
    const { eid } = addFallingBody(world, physics, "dynamic", 20, { canSleep: false });
    physics.addCollider(eid, "sphere", { radius: 0.5 });

    world.update(1 / 60);
    const interp = physics.getInterpolatedPosition(eid);
    const transformStore = world.getStore(Transform);
    // Transform.y (written by update()) uses the exact same interpolation formula, so they
    // must agree.
    expect(approx(interp.y, transformStore.get(eid, "y"))).toBe(true);
  });
});

describe("PhysicsSystem — collision & trigger events", () => {
  let world: World;
  let physics: PhysicsSystem;

  beforeEach(async () => {
    ({ world, physics } = await makePhysicsWorld());
  }, 15000);

  afterEach(() => {
    physics.destroy();
  });

  it("onCollisionStart fires when a falling body lands on a floor", () => {
    const events: { a: number; b: number }[] = [];
    const unsub = physics.onCollisionStart((e) => events.push({ a: e.entityA, b: e.entityB }));

    const { eid: ball } = addFallingBody(world, physics, "dynamic", 5);
    physics.addCollider(ball, "sphere", { radius: 0.5 });

    const { eid: floor } = addFallingBody(world, physics, "fixed", 0);
    physics.addCollider(floor, "box", { halfX: 20, halfY: 0.5, halfZ: 20 });

    for (let i = 0; i < 120; i++) world.update(1 / 60);

    expect(events.length).toBeGreaterThan(0);
    const ids = events[0];
    expect([ids.a, ids.b]).toContain(ball);
    expect([ids.a, ids.b]).toContain(floor);
    unsub();
  });

  it("onCollisionEnd fires after two bodies separate", () => {
    const startEvents: number[] = [];
    const endEvents: number[] = [];
    physics.onCollisionStart(() => startEvents.push(1));
    physics.onCollisionEnd(() => endEvents.push(1));

    const { eid: ball, body } = addFallingBody(world, physics, "dynamic", 2, { canSleep: false });
    physics.addCollider(ball, "sphere", { radius: 0.5 });
    const { eid: floor } = addFallingBody(world, physics, "fixed", 0);
    physics.addCollider(floor, "box", { halfX: 20, halfY: 0.5, halfZ: 20 });

    for (let i = 0; i < 60; i++) world.update(1 / 60);
    expect(startEvents.length).toBeGreaterThan(0);

    // Knock it back up into the air to force separation.
    body.setTranslation({ x: 0, y: 10, z: 0 }, true);
    body.setLinvel({ x: 0, y: 5, z: 0 }, true);
    for (let i = 0; i < 60; i++) world.update(1 / 60);

    expect(endEvents.length).toBeGreaterThan(0);
  });

  it("onTriggerEnter/onTriggerExit fire for sensor colliders, not collision callbacks", () => {
    const triggerEnters: number[] = [];
    const collisionStarts: number[] = [];
    physics.onTriggerEnter(() => triggerEnters.push(1));
    physics.onCollisionStart(() => collisionStarts.push(1));

    const { eid: ball } = addFallingBody(world, physics, "dynamic", 3, { canSleep: false });
    physics.addCollider(ball, "sphere", { radius: 0.5 });

    const { eid: zone } = addFallingBody(world, physics, "fixed", 0);
    physics.addTrigger(zone, "box", { halfX: 20, halfY: 2, halfZ: 20 });

    for (let i = 0; i < 90; i++) world.update(1 / 60);

    expect(triggerEnters.length).toBeGreaterThan(0);
    expect(collisionStarts.length).toBe(0);
  });

  it("unsubscribing a collision callback stops further invocations", () => {
    let count = 0;
    const unsub = physics.onCollisionStart(() => count++);
    unsub();

    const { eid: ball } = addFallingBody(world, physics, "dynamic", 2);
    physics.addCollider(ball, "sphere", { radius: 0.5 });
    const { eid: floor } = addFallingBody(world, physics, "fixed", 0);
    physics.addCollider(floor, "box", { halfX: 20, halfY: 0.5, halfZ: 20 });

    for (let i = 0; i < 60; i++) world.update(1 / 60);
    expect(count).toBe(0);
  });
});

describe("PhysicsSystem — raycasting & shape queries", () => {
  let world: World;
  let physics: PhysicsSystem;

  beforeAll(async () => {
    ({ world, physics } = await makePhysicsWorld());
  }, 15000);

  afterAll(() => {
    physics.destroy();
  });

  it("raycast hits a fixed body directly below the origin", () => {
    const { eid: floor } = addFallingBody(world, physics, "fixed", 0);
    physics.addCollider(floor, "box", { halfX: 5, halfY: 0.5, halfZ: 5 });
    // Rapier's query pipeline (used internally by castRayAndGetNormal/intersections*) is
    // only refreshed during World.step() — a collider added since the last step is invisible
    // to spatial queries until at least one more step runs.
    world.update(1 / 60);

    const hit = physics.raycast(0, 10, 0, 0, -1, 0, 100);
    expect(hit).not.toBeNull();
    expect(hit!.entityId).toBe(floor);
    expect(approx(hit!.point.y, 0.5, 1e-2)).toBe(true);
  });

  it("raycast returns null when nothing is in the path", () => {
    const hit = physics.raycast(1000, 1000, 1000, 0, -1, 0, 5);
    expect(hit).toBeNull();
  });

  it("raycast respects excludeEid", () => {
    const { eid: floorA } = addFallingBody(world, physics, "fixed", 0);
    physics.addCollider(floorA, "box", { halfX: 5, halfY: 0.5, halfZ: 5 });
    world.update(1 / 60);

    const hitExcluded = physics.raycast(0, 10, 0, 0, -1, 0, 100, floorA);
    // With the only collider under the ray excluded, nothing should be hit (or a different,
    // deeper collider if present) — here we just assert the excluded entity itself is never
    // reported as the hit.
    if (hitExcluded) {
      expect(hitExcluded.entityId).not.toBe(floorA);
    } else {
      expect(hitExcluded).toBeNull();
    }
  });

  it("raycastAll can report multiple stacked colliders along the ray", () => {
    const { eid: lower } = addFallingBody(world, physics, "fixed", 0);
    physics.addCollider(lower, "box", { halfX: 5, halfY: 0.5, halfZ: 5 });
    const { eid: upper } = addFallingBody(world, physics, "fixed", 3);
    physics.addCollider(upper, "box", { halfX: 5, halfY: 0.5, halfZ: 5 });
    world.update(1 / 60);

    const hits = physics.raycastAll(0, 20, 0, 0, -1, 0, 100);
    const hitEntities = hits.map((h) => h.entityId);
    expect(hitEntities).toContain(lower);
    expect(hitEntities).toContain(upper);
  });

  it("overlapSphere finds bodies within a radius", () => {
    const { eid } = addFallingBody(world, physics, "fixed", 50);
    physics.addCollider(eid, "sphere", { radius: 1 });
    world.update(1 / 60);

    const found = physics.overlapSphere(0, 50, 0, 2);
    expect(found).toContain(eid);

    const notFound = physics.overlapSphere(0, -50, 0, 2);
    expect(notFound).not.toContain(eid);
  });

  it("overlapBox finds bodies within a box region", () => {
    const { eid } = addFallingBody(world, physics, "fixed", 60);
    physics.addCollider(eid, "box", { halfX: 1, halfY: 1, halfZ: 1 });
    world.update(1 / 60);

    const found = physics.overlapBox(0, 60, 0, 2, 2, 2);
    expect(found).toContain(eid);
  });
});

describe("PhysicsSystem — joints", () => {
  let world: World;
  let physics: PhysicsSystem;

  beforeAll(async () => {
    ({ world, physics } = await makePhysicsWorld());
  }, 15000);

  afterAll(() => {
    physics.destroy();
  });

  it("createFixedJoint links two bodies retrievable via getJoint", () => {
    const { eid: a } = addFallingBody(world, physics, "dynamic", 10);
    physics.addCollider(a, "sphere", { radius: 0.3 });
    const { eid: b } = addFallingBody(world, physics, "dynamic", 10.5);
    physics.addCollider(b, "sphere", { radius: 0.3 });

    const jointId = physics.createFixedJoint(a, b);
    expect(physics.getJoint(jointId)).toBeDefined();

    physics.removeJoint(jointId);
    expect(physics.getJoint(jointId)).toBeUndefined();
  });

  it("createRevoluteJoint keeps bodies roughly together as they fall", () => {
    const { eid: a } = addFallingBody(world, physics, "dynamic", 15, { canSleep: false });
    physics.addCollider(a, "sphere", { radius: 0.3 });
    const { eid: b } = addFallingBody(world, physics, "dynamic", 15.4, { canSleep: false });
    physics.addCollider(b, "sphere", { radius: 0.3 });

    physics.createRevoluteJoint(a, b, 1, 0, 0);

    for (let i = 0; i < 30; i++) world.update(1 / 60);

    const bodyA = physics.getBody(a)!;
    const bodyB = physics.getBody(b)!;
    const dy = Math.abs(bodyA.translation().y - bodyB.translation().y);
    // Jointed bodies should stay near their original 0.4 separation, not drift arbitrarily
    // far apart the way two unconnected falling bodies dropped from the same height would.
    expect(dy).toBeLessThan(2);
  });
});

describe("PhysicsSystem — character controller", () => {
  let world: World;
  let physics: PhysicsSystem;

  beforeAll(async () => {
    ({ world, physics } = await makePhysicsWorld());
  }, 15000);

  afterAll(() => {
    physics.destroy();
  });

  it("moveCharacter reports grounded on a floor and moves the kinematic body", () => {
    const { eid: floor } = addFallingBody(world, physics, "fixed", 0);
    physics.addCollider(floor, "box", { halfX: 20, halfY: 0.5, halfZ: 20 });

    const { eid: player } = addFallingBody(world, physics, "kinematic", 1.5);
    physics.addCollider(player, "capsule", { radius: 0.3, halfHeight: 0.5 });
    physics.createCharacterController(player, {
      height: 1.8, radius: 0.3, stepHeight: 0.3, maxSlope: Math.PI / 4, skinWidth: 0.01,
    });

    // Rapier's query pipeline (which the character controller's shape-cast movement relies
    // on, and which reflects the kinematic body's own setNextKinematicTranslation() call) is
    // only refreshed during World.step() — a realistic per-frame loop interleaves
    // moveCharacter() with a physics step, so do the same here.
    world.update(1 / 60);

    // Let the controller settle onto the floor first. moveCharacter takes a velocity
    // (units/second), not a per-frame displacement, so -6 u/s * (1/60)s = -0.1 units/call.
    for (let i = 0; i < 30; i++) {
      physics.moveCharacter(player, 0, -6, 0, 1 / 60);
      world.update(1 / 60);
    }

    const result = physics.moveCharacter(player, 6, 0, 0, 1 / 60);
    world.update(1 / 60);
    expect(result.grounded).toBe(true);

    // Check the ground-truth Rapier body position rather than the ECS Transform column here:
    // Transform.x is written through PhysicsSystem's prevPos/currPos interpolation, which (by
    // design) lags a step behind when dt lines up with an exact multiple of fixedStep — that's
    // a rendering-smoothness feature, not what this test is verifying.
    expect(physics.getBody(player)!.translation().x).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AUDIT findings — these encode CORRECT expected behavior. Where the underlying bug is
// present, the assertion below is expected to fail for real (no .skip/.fails).
// ---------------------------------------------------------------------------

describe("PhysicsSystem — AUDIT findings", () => {
  it(
    // AUDIT: PhysicsSystem interpolates position (prevPos/currPos lerp by alpha) but assigns
    // rotation straight from the latest body.rotation() with no slerp against the previous
    // step's rotation — see PhysicsSystem.ts:762 (position interpolation) vs
    // PhysicsSystem.ts:807-811 (rotation assigned directly, ignoring alpha). A rotating body's
    // Transform should be just as smoothly interpolated as its position.
    "rotation should be slerped between physics steps the same way position is lerped",
    async () => {
      const { world, physics } = await makePhysicsWorld();
      try {
        const eid = world.createEntity();
        world.addComponent(eid, Transform, { x: 0, y: 5, z: 0, sx: 1, sy: 1, sz: 1 });
        world.addComponent(eid, RigidBody, { bodyType: 0, mass: 1, restitution: 0.3, friction: 0.5 });
        const body = physics.addBody(eid, "dynamic", { canSleep: false });
        physics.addCollider(eid, "sphere", { radius: 0.5 });
        body.setAngvel({ x: 0, y: 5, z: 0 }, true);

        // First call: exactly one fixed substep, small leftover accumulator so the "current"
        // rotation right now represents the state after physics step #1.
        world.update((1 / 60) * 1.2);
        const afterStep1 = body.rotation();
        const prevQuat = new Quat(afterStep1.x, afterStep1.y, afterStep1.z, afterStep1.w);

        // Second call: exactly one more fixed substep (total 2), landing the leftover
        // accumulator at exactly half a fixed step -> interpolationAlpha === 0.5.
        world.update((1 / 60) * 1.3);
        const afterStep2 = body.rotation();
        const currQuat = new Quat(afterStep2.x, afterStep2.y, afterStep2.z, afterStep2.w);

        expect(approx(physics.interpolationAlpha, 0.5, 0.05)).toBe(true);

        const expectedSlerp = prevQuat.clone().slerp(currQuat, physics.interpolationAlpha);
        const expectedEuler = expectedSlerp.toEuler();

        const transformStore = world.getStore(Transform);
        const actualRy = transformStore.get(eid, "ry");

        expect(approx(actualRy, expectedEuler.y, 1e-3)).toBe(true);
      } finally {
        physics.destroy();
      }
    }
  );

  it(
    // AUDIT: addBody() hardcodes restitution:0.3, friction:0.5 and does `mass || 1` on the
    // RigidBody component it (re-)writes — see PhysicsSystem.ts:236-243. Any code path where
    // addBody() is the thing that first creates the RigidBody component (its own
    // world.addComponent call succeeds) permanently locks the entity to these hardcoded
    // values: a later, more specific world.addComponent call for the same entity is a no-op
    // (ComponentStore.add() only writes fields the first time an entity is registered), so a
    // caller who wanted mass:0 (density-derived) / custom restitution+friction can never
    // achieve it once addBody() has already run.
    "a caller's intended mass/restitution/friction should stick even after addBody() has run",
    async () => {
      const { world, physics } = await makePhysicsWorld();
      try {
        const eid = world.createEntity();
        world.addComponent(eid, Transform, { x: 0, y: 5, z: 0, sx: 1, sy: 1, sz: 1 });
        physics.addBody(eid, "dynamic");

        // Caller now expresses their real intent: mass 0 (derive from collider density),
        // and custom restitution/friction.
        world.addComponent(eid, RigidBody, {
          bodyHandle: 0, bodyType: 0, mass: 0, restitution: 0.8, friction: 0.9,
        });

        const store = world.getStore(RigidBody);
        expect(store.get(eid, "mass")).toBe(0);
        expect(approx(store.get(eid, "restitution"), 0.8)).toBe(true);
        expect(approx(store.get(eid, "friction"), 0.9)).toBe(true);
      } finally {
        physics.destroy();
      }
    }
  );

  it(
    // AUDIT: when physics falls behind (steps >= maxSubSteps), PhysicsSystem.update()
    // discards the leftover accumulator instead of carrying it into the next frame — see
    // PhysicsSystem.ts:757-759 (`if (steps >= this.maxSubSteps) this.accumulator = 0;`). This
    // means the same total elapsed wall-clock time simulates a different number of physics
    // steps depending on how it's chopped into frames, which is not frame-rate independent /
    // reproducible.
    "the same total elapsed time should simulate the same result regardless of how it's split across frames",
    async () => {
      // Scenario A: many small frames (dt below fixedStep) that never trip the maxSubSteps
      // cap — every unit of time is faithfully simulated.
      const a = await makePhysicsWorld();
      const eidA = addFallingBody(a.world, a.physics, "dynamic", 100, { canSleep: false }).eid;
      a.physics.addCollider(eidA, "sphere", { radius: 0.5 }); // a body needs a collider for Rapier to derive a finite mass — without one gravity has no effect at all, which would make this comparison vacuously "pass"
      for (let i = 0; i < 20; i++) a.world.update(1 / 240);
      const yA = a.physics.getBody(eidA)!.translation().y;
      a.physics.destroy();

      // Scenario B: one big frame covering the exact same total elapsed time (5/60s), but
      // large enough to hit the 4-substep cap in a single update() call.
      const b = await makePhysicsWorld();
      const eidB = addFallingBody(b.world, b.physics, "dynamic", 100, { canSleep: false }).eid;
      b.physics.addCollider(eidB, "sphere", { radius: 0.5 });
      b.world.update(5 / 60);
      const yB = b.physics.getBody(eidB)!.translation().y;
      b.physics.destroy();

      // Same wall-clock time elapsed (5/60s) in both scenarios -> free-fall under identical
      // gravity should land at the same height, regardless of frame chopping.
      expect(approx(yA, yB, 1e-3)).toBe(true);
    }
  );

  it(
    // AUDIT: colliders[eid] is a single-slot SoA array even though an entity can carry
    // multiple colliders (trackCollider() already supports a per-entity handle list) — see
    // PhysicsSystem.ts:84 (declaration) and PhysicsSystem.ts:306 (unconditional overwrite
    // inside addCollider()). Adding a second collider to an entity (e.g. a compound shape)
    // silently makes the first unreachable through getCollider(), even though Rapier still
    // simulates it (it's never removed).
    "getCollider should still resolve the first collider after a second is added to the same entity",
    async () => {
      const { world, physics } = await makePhysicsWorld();
      try {
        const { eid } = addFallingBody(world, physics, "dynamic", 10);
        const first = physics.addCollider(eid, "box", { halfX: 0.5, halfY: 0.5, halfZ: 0.5 });
        const second = physics.addCollider(eid, "sphere", { radius: 0.2 });

        // Both colliders should still be simulated by Rapier...
        expect(physics.rapierWorld.getCollider(first.handle)).toBeDefined();
        expect(physics.rapierWorld.getCollider(second.handle)).toBeDefined();
        // ...and the first one added should still be the one getCollider() resolves to,
        // since it was never removed and getCollider() has no way to express "both".
        expect(physics.getCollider(eid)).toBe(first);
      } finally {
        physics.destroy();
      }
    }
  );

  it(
    // AUDIT: moveCharacter(eid, vx, vy, vz, dt) accepted dt but never used it — the vector
    // was handed straight to Rapier's shape-cast as an absolute per-call displacement, so the
    // same (vx, vy, vz) moved a character by the same distance regardless of frame time
    // instead of scaling by dt like a velocity should. See PhysicsSystem.ts moveCharacter().
    "moveCharacter scales movement by dt instead of ignoring it",
    async () => {
      const { world, physics } = await makePhysicsWorld();
      try {
        const { eid: floor } = addFallingBody(world, physics, "fixed", -5);
        physics.addCollider(floor, "box", { halfX: 50, halfY: 0.5, halfZ: 50 });

        const { eid: player } = addFallingBody(world, physics, "kinematic", 0);
        physics.addCollider(player, "capsule", { radius: 0.3, halfHeight: 0.5 });
        physics.createCharacterController(player, {
          height: 1.8, radius: 0.3, stepHeight: 0.3, maxSlope: Math.PI / 4, skinWidth: 0.01,
        });
        world.update(1 / 60);

        const startX = physics.getBody(player)!.translation().x;
        physics.moveCharacter(player, 6, 0, 0, 1 / 60);
        world.update(1 / 60);
        const movedAtFullDt = physics.getBody(player)!.translation().x - startX;

        const midX = physics.getBody(player)!.translation().x;
        physics.moveCharacter(player, 6, 0, 0, 1 / 120);
        world.update(1 / 60);
        const movedAtHalfDt = physics.getBody(player)!.translation().x - midX;

        // Same velocity, half the dt, should move roughly half as far.
        expect(movedAtFullDt).toBeGreaterThan(0);
        expect(approx(movedAtHalfDt, movedAtFullDt / 2, 1e-3)).toBe(true);
      } finally {
        physics.destroy();
      }
    }
  );
});
