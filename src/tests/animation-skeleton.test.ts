import { describe, it, expect } from "vitest";
import * as THREE from "three";

import { World } from "../ecs/World";
import { Transform } from "../core/Components";
import { Animator } from "../animation/AnimationComponents";
import { AnimationGraph } from "../animation/AnimationGraph";
import { AnimationSystem } from "../animation/AnimationSystem";
import { SkeletonDefinition, BoneFlags, ColliderType } from "../skeleton/SkeletonDefinition";
import { SkeletonInstance, DirtyFlags } from "../skeleton/SkeletonInstance";
import { SkeletonSystem } from "../skeleton/SkeletonSystem";
import { ObjectPool } from "../pooling/ObjectPool";

function approx(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) < eps;
}

function makeClip(name: string, duration = 1): THREE.AnimationClip {
  const track = new THREE.NumberKeyframeTrack(".rotation[y]", [0, duration], [0, 1]);
  return new THREE.AnimationClip(name, duration, [track]);
}

// ---------------------------------------------------------------------------
// AnimationGraph — pure state machine, no THREE/mixer dependency
// ---------------------------------------------------------------------------

describe("AnimationGraph", () => {
  it("first added state becomes currentState", () => {
    const graph = new AnimationGraph();
    graph.addState({ name: "idle", clipHandle: 1 as never, speed: 1, loop: true });
    expect(graph.currentState).toBe("idle");
  });

  it("evaluate returns the target state when a transition's condition passes", () => {
    const graph = new AnimationGraph();
    graph.addState({ name: "idle", clipHandle: 1 as never, speed: 1, loop: true });
    graph.addState({ name: "walk", clipHandle: 2 as never, speed: 1, loop: true });
    graph.addTransition({
      from: "idle", to: "walk", duration: 0.2,
      condition: (params) => (params.get("speed") ?? 0) > 0,
    });

    expect(graph.evaluate()).toBeNull();
    graph.setParam("speed", 2);
    expect(graph.evaluate()).toBe("walk");
  });

  it("getParam returns 0 for unset parameters", () => {
    const graph = new AnimationGraph();
    expect(graph.getParam("nonexistent")).toBe(0);
  });

  it("evaluate only considers transitions from the current state", () => {
    const graph = new AnimationGraph();
    graph.addState({ name: "a", clipHandle: 1 as never, speed: 1, loop: true });
    graph.addState({ name: "b", clipHandle: 2 as never, speed: 1, loop: true });
    graph.addState({ name: "c", clipHandle: 3 as never, speed: 1, loop: true });
    graph.addTransition({ from: "b", to: "c", duration: 0.1, condition: () => true });

    // currentState is "a" — the b->c transition should never fire.
    expect(graph.evaluate()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AnimationSystem — mixer pool, clip playback, slot reuse
// ---------------------------------------------------------------------------

describe("AnimationSystem", () => {
  it("createMixer initializes Animator with documented defaults", () => {
    const world = new World();
    const animSystem = new AnimationSystem();
    world.addSystem(animSystem);

    const eid = world.createEntity();
    const root = new THREE.Object3D();
    animSystem.createMixer(eid, root);

    const store = world.getStore(Animator);
    expect(store.get(eid, "currentClip")).toBe(-1);
    expect(store.get(eid, "prevClip")).toBe(-1);
    expect(store.get(eid, "speed")).toBe(1);
    expect(store.get(eid, "blendDuration")).toBeCloseTo(0.3);
    expect(store.get(eid, "playing")).toBe(1);
  });

  it("addClip + play swaps currentClip and starts playback", () => {
    const world = new World();
    const animSystem = new AnimationSystem();
    world.addSystem(animSystem);

    const eid = world.createEntity();
    const root = new THREE.Object3D();
    animSystem.createMixer(eid, root);
    const idx = animSystem.addClip(eid, "spin", makeClip("spin"));
    expect(idx).toBe(0);

    animSystem.play(eid, "spin", 0);
    const store = world.getStore(Animator);
    expect(store.get(eid, "currentClip")).toBe(0);
    expect(store.get(eid, "playing")).toBe(1);
  });

  it("play accepts a clip index as well as a name", () => {
    const world = new World();
    const animSystem = new AnimationSystem();
    world.addSystem(animSystem);

    const eid = world.createEntity();
    animSystem.createMixer(eid, new THREE.Object3D());
    animSystem.addClip(eid, "a", makeClip("a"));
    const idxB = animSystem.addClip(eid, "b", makeClip("b"));

    animSystem.play(eid, idxB, 0);
    expect(world.getStore(Animator).get(eid, "currentClip")).toBe(idxB);
  });

  it("stop halts playback and resets currentClip", () => {
    const world = new World();
    const animSystem = new AnimationSystem();
    world.addSystem(animSystem);

    const eid = world.createEntity();
    animSystem.createMixer(eid, new THREE.Object3D());
    animSystem.addClip(eid, "spin", makeClip("spin"));
    animSystem.play(eid, "spin", 0);

    animSystem.stop(eid);
    const store = world.getStore(Animator);
    expect(store.get(eid, "playing")).toBe(0);
    expect(store.get(eid, "currentClip")).toBe(-1);
  });

  it("update() advances the mixer without throwing across many ticks", () => {
    const world = new World();
    const animSystem = new AnimationSystem();
    world.addSystem(animSystem);

    const eid = world.createEntity();
    animSystem.createMixer(eid, new THREE.Object3D());
    animSystem.addClip(eid, "spin", makeClip("spin"));
    animSystem.play(eid, "spin", 0);

    expect(() => {
      for (let i = 0; i < 30; i++) animSystem.update(1 / 60);
    }).not.toThrow();
  });

  it("removeMixer frees the slot so a subsequent createMixer reuses it", () => {
    const world = new World();
    const animSystem = new AnimationSystem();
    world.addSystem(animSystem);

    const e1 = world.createEntity();
    const slot1 = animSystem.createMixer(e1, new THREE.Object3D());
    const e2 = world.createEntity();
    animSystem.createMixer(e2, new THREE.Object3D());

    animSystem.removeMixer(e1);

    const e3 = world.createEntity();
    const slot3 = animSystem.createMixer(e3, new THREE.Object3D());
    expect(slot3).toBe(slot1);
  });

  it("graph-driven playback only advances currentState when a clip exists for the target", () => {
    const world = new World();
    const animSystem = new AnimationSystem();
    world.addSystem(animSystem);

    const eid = world.createEntity();
    animSystem.createMixer(eid, new THREE.Object3D());
    animSystem.addClip(eid, "idle", makeClip("idle"));
    // Deliberately do NOT add a "walk" clip — the graph will want to transition there, but
    // no mixer action exists for it.

    const graph = new AnimationGraph();
    graph.addState({ name: "idle", clipHandle: 1 as never, speed: 1, loop: true });
    graph.addState({ name: "walk", clipHandle: 2 as never, speed: 1, loop: true });
    graph.addTransition({ from: "idle", to: "walk", duration: 0.1, condition: () => true });
    animSystem.attachGraph(eid, graph);
    animSystem.play(eid, "idle", 0);

    animSystem.update(1 / 60);

    // Correct/defensive behavior: since no "walk" clip is registered, the graph must not
    // advance past "idle" — otherwise every future from === currentState lookup goes stale.
    expect(graph.currentState).toBe("idle");
  });

  it(
    // AUDIT: Animator.blendFactor/blendDuration are advanced every frame by AnimationSystem
    // (see AnimationSystem.ts:165-167) but nothing in the engine ever reads them back —
    // actual crossfading is delegated entirely to THREE.AnimationAction.fadeIn/fadeOut,
    // whose fade duration comes from the caller's `fadeIn` argument to play(), not from
    // Animator.blendDuration. Correct/expected behavior: the exposed blendFactor should
    // actually reflect (or drive) the real crossfade progress, so forcing it to 1
    // ("fully blended") should make the outgoing action's effective weight collapse to 0.
    "forcing blendFactor to 1 should be reflected in the outgoing action's actual weight",
    () => {
      const world = new World();
      const animSystem = new AnimationSystem();
      world.addSystem(animSystem);

      const eid = world.createEntity();
      const root = new THREE.Object3D();
      animSystem.createMixer(eid, root);
      const idxA = animSystem.addClip(eid, "a", makeClip("a"));
      const idxB = animSystem.addClip(eid, "b", makeClip("b"));

      animSystem.play(eid, idxA, 0); // instantly fully weighted
      animSystem.update(1 / 60);

      animSystem.play(eid, idxB, 0.5); // start a half-second crossfade a -> b

      const store = world.getStore(Animator);
      // Simulate the "intended" semantics: the caller (or engine) forces blendFactor to
      // represent a fully-completed blend.
      store.set(eid, "blendFactor", 1);

      const slot = store.get(eid, "mixerSlot") as number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const actionA = (animSystem as any).mixerActions[slot][idxA] as THREE.AnimationAction;

      expect(approx(actionA.getEffectiveWeight(), 0, 0.05)).toBe(true);
    }
  );
});

// ---------------------------------------------------------------------------
// SkeletonDefinition — bind/rest pose math, hierarchy, name lookup
// ---------------------------------------------------------------------------

describe("SkeletonDefinition", () => {
  const bones = [
    { name: "root", parentIndex: -1, length: 1 },
    { name: "child_a", parentIndex: 0, length: 0.5 },
    { name: "child_b", parentIndex: 0, length: 0.5 },
    { name: "grandchild", parentIndex: 1, length: 0.25 },
  ];

  it("computes depths from the parent chain", () => {
    const def = new SkeletonDefinition(bones);
    expect(def.depths[0]).toBe(0); // root
    expect(def.depths[1]).toBe(1); // child_a
    expect(def.depths[2]).toBe(1); // child_b
    expect(def.depths[3]).toBe(2); // grandchild
  });

  it("builds firstChild/nextSibling linked lists matching parentIndex", () => {
    const def = new SkeletonDefinition(bones);
    // root's children are child_a (1) and child_b (2), linked via nextSibling.
    const rootFirstChild = def.firstChild[0];
    expect([1, 2]).toContain(rootFirstChild);
    const sibling = def.nextSibling[rootFirstChild];
    const children = [rootFirstChild, sibling].sort();
    expect(children).toEqual([1, 2]);

    // child_a's only child is grandchild (3).
    expect(def.firstChild[1]).toBe(3);
    expect(def.nextSibling[3]).toBe(-1);

    // grandchild and child_b have no children.
    expect(def.firstChild[3]).toBe(-1);
    expect(def.firstChild[2]).toBe(-1);
  });

  it("getBoneIndex resolves names to indices, and back via getBoneIndexByHash", () => {
    const def = new SkeletonDefinition(bones);
    expect(def.getBoneIndex("child_a")).toBe(1);
    expect(def.getBoneIndex("grandchild")).toBe(3);
    expect(def.getBoneIndex("nonexistent")).toBe(-1);

    const hash = def.nameHashes[2];
    expect(def.getBoneIndexByHash(hash)).toBe(2);
  });

  it("defaults bindRot/restRot to identity quaternions when not specified", () => {
    const def = new SkeletonDefinition(bones);
    for (let i = 0; i < def.boneCount; i++) {
      expect(def.bindRotW[i]).toBe(1);
      expect(def.bindRotX[i]).toBe(0);
      expect(def.restRotW[i]).toBe(1);
    }
  });

  it("defaults mass/density to 1 and flags to SIMULATED when unspecified", () => {
    const def = new SkeletonDefinition(bones);
    expect(def.masses[0]).toBe(1);
    expect(def.densities[0]).toBe(1);
    expect(def.flags[0]).toBe(BoneFlags.SIMULATED);
  });

  it("respects explicit bindPos/restPos/collider/mass overrides", () => {
    const def = new SkeletonDefinition([
      {
        name: "custom", parentIndex: -1, length: 2, mass: 5, density: 2,
        colliderType: ColliderType.SPHERE,
        bindPos: { x: 1, y: 2, z: 3 },
        restPos: { x: 4, y: 5, z: 6 },
      },
    ]);
    expect(def.bindPosX[0]).toBe(1);
    expect(def.bindPosY[0]).toBe(2);
    expect(def.bindPosZ[0]).toBe(3);
    expect(def.restPosX[0]).toBe(4);
    expect(def.restPosY[0]).toBe(5);
    expect(def.restPosZ[0]).toBe(6);
    expect(def.masses[0]).toBe(5);
    expect(def.densities[0]).toBe(2);
    expect(def.colliderTypes[0]).toBe(ColliderType.SPHERE);
  });
});

// ---------------------------------------------------------------------------
// SkeletonInstance — rest-pose init and dirty-flag bookkeeping (no FK/physics involved)
// ---------------------------------------------------------------------------

describe("SkeletonInstance", () => {
  it("initFromRestPose copies rest arrays into local pose and marks everything dirty", () => {
    const restPosX = new Float32Array([1, 2]);
    const restPosY = new Float32Array([3, 4]);
    const restPosZ = new Float32Array([5, 6]);
    const restRotX = new Float32Array([0, 0]);
    const restRotY = new Float32Array([0, 0]);
    const restRotZ = new Float32Array([0, 0]);
    const restRotW = new Float32Array([1, 1]);

    const instance = new SkeletonInstance(1 as never, 2);
    instance.initFromRestPose(restPosX, restPosY, restPosZ, restRotX, restRotY, restRotZ, restRotW);

    expect(Array.from(instance.localPosX)).toEqual([1, 2]);
    expect(Array.from(instance.localPosY)).toEqual([3, 4]);
    expect(Array.from(instance.localPosZ)).toEqual([5, 6]);
    expect(instance.isDirty(0, DirtyFlags.LOCAL)).toBe(true);
    expect(instance.isDirty(0, DirtyFlags.WORLD)).toBe(true);
    expect(instance.isDirty(1, DirtyFlags.LOCAL)).toBe(true);
  });

  it("markLocalDirty/markMotorDirty set only their own bit, clearDirty resets fully", () => {
    const instance = new SkeletonInstance(1 as never, 1);
    instance.clearDirty(0);
    expect(instance.isDirty(0, DirtyFlags.LOCAL)).toBe(false);

    instance.markLocalDirty(0);
    expect(instance.isDirty(0, DirtyFlags.LOCAL)).toBe(true);
    expect(instance.isDirty(0, DirtyFlags.MOTOR)).toBe(false);

    instance.markMotorDirty(0);
    expect(instance.isDirty(0, DirtyFlags.MOTOR)).toBe(true);
    expect(instance.isDirty(0, DirtyFlags.LOCAL)).toBe(true); // still set from before

    instance.clearDirty(0);
    expect(instance.isDirty(0, DirtyFlags.LOCAL)).toBe(false);
    expect(instance.isDirty(0, DirtyFlags.MOTOR)).toBe(false);
  });

  it("starts inactive with all bone entity/handle slots at -1", () => {
    const instance = new SkeletonInstance(1 as never, 3);
    expect(instance.active).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(instance.boneEntities[i]).toBe(-1);
      expect(instance.bodyHandles[i]).toBe(-1);
      expect(instance.jointHandles[i]).toBe(-1);
    }
  });
});

// ---------------------------------------------------------------------------
// AUDIT: no forward-kinematics evaluator for non-ragdolled instances
// ---------------------------------------------------------------------------

describe("SkeletonSystem — AUDIT findings", () => {
  it(
    // AUDIT: SkeletonSystem.update() (SkeletonSystem.ts:330-387) only ever writes bone world
    // transforms by reading back Rapier ragdoll body transforms for instances in
    // activeInstances (populated only by activate(), which requires a live PhysicsSystem and
    // spawns real rigid bodies per bone). There is no code path that walks
    // SkeletonDefinition.parents to compose local poses into world poses for a purely
    // animated (non-ragdolled) instance — so setBoneLocalPose() has no effect on
    // getBoneWorldPose() unless the instance has been physically activated.
    "setBoneLocalPose on a non-ragdolled instance should update getBoneWorldPose via forward kinematics",
    () => {
      const world = new World();
      const skeleton = new SkeletonSystem();
      world.addSystem(skeleton);

      const defHandle = skeleton.createDefinition([
        { name: "root", parentIndex: -1, length: 1 },
      ]);
      const instHandle = skeleton.createInstance(defHandle);

      // Deliberately do NOT call skeleton.activate() — this is a purely-animated instance,
      // never handed off to physics/ragdoll.
      skeleton.setBoneLocalPose(instHandle, 0, 1, 2, 3, 0, 0, 0, 1);
      skeleton.update(1 / 60);

      const pose = skeleton.getBoneWorldPose(instHandle, 0);
      expect(pose).not.toBeNull();
      // For a root bone (no parent), world pose should equal the local pose we just set.
      expect(pose!.px).toBeCloseTo(1);
      expect(pose!.py).toBeCloseTo(2);
      expect(pose!.pz).toBeCloseTo(3);
    }
  );
});

// ---------------------------------------------------------------------------
// ObjectPool
// ---------------------------------------------------------------------------

describe("ObjectPool", () => {
  function makePool(capacity: number) {
    const created: number[] = [];
    const acquired: number[] = [];
    const released: number[] = [];
    const pool = new ObjectPool(capacity, {
      onCreate: (slot) => {
        created.push(slot);
        return slot * 100; // fake "entity id"
      },
      onAcquire: (slot) => acquired.push(slot),
      onRelease: (slot) => released.push(slot),
    });
    return { pool, created, acquired, released };
  }

  it("acquire creates new slots up to capacity, then returns null", () => {
    const { pool } = makePool(2);
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).toBeNull();
    expect(pool.count).toBe(2);
    expect(pool.available).toBe(0);
  });

  it("release returns a slot to the free stack for reuse", () => {
    const { pool, created } = makePool(1);
    const first = pool.acquire()!;
    pool.release(first.slot);
    expect(pool.isActive(first.slot)).toBe(false);
    expect(pool.available).toBe(1);

    const second = pool.acquire()!;
    expect(second.slot).toBe(first.slot);
    expect(second.eid).toBe(first.eid);
    // onCreate should only have run once — the slot was reused, not recreated.
    expect(created.length).toBe(1);
  });

  it("release on an already-inactive slot is a no-op", () => {
    const { pool, released } = makePool(2);
    const a = pool.acquire()!;
    pool.release(a.slot);
    pool.release(a.slot); // double release
    expect(released.length).toBe(1);
  });

  it("prewarm pre-creates slots onto the free stack without activating them", () => {
    const { pool, created } = makePool(5);
    pool.prewarm(3);
    expect(created.length).toBe(3);
    expect(pool.count).toBe(0); // prewarmed slots are not active
    expect(pool.available).toBe(5);

    const acquired = pool.acquire()!;
    // Reused one of the prewarmed slots rather than creating a new one.
    expect(created.length).toBe(3);
    expect(acquired).not.toBeNull();
  });

  it("forEachActive visits only active slots", () => {
    const { pool } = makePool(3);
    const a = pool.acquire()!;
    const b = pool.acquire()!;
    pool.release(a.slot);

    const visited: number[] = [];
    pool.forEachActive((slot) => visited.push(slot));
    expect(visited).toEqual([b.slot]);
  });

  it("releaseAll deactivates every active slot", () => {
    const { pool } = makePool(3);
    pool.acquire();
    pool.acquire();
    pool.releaseAll();
    expect(pool.count).toBe(0);
  });
});
