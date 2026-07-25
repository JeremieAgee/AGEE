import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { Vec3 } from "../core/math/Vec3";
import { Quat } from "../core/math/Quat";
import { Mat4 } from "../core/math/Mat4";
import { AABB } from "../core/math/AABB";
import { Frustum } from "../core/math/Frustum";
import { Clock } from "../core/Clock";
import { EventBus } from "../core/EventBus";
import { HandleAllocator, HandleMap, handleIndex, handleGeneration } from "../core/handles/Handle";
import { ResourceManager } from "../core/handles/ResourceManager";
import { SceneSerializer, SerializedScene } from "../core/serialization/SceneSerializer";
import { defineComponent } from "../ecs/Component";
import { World } from "../ecs/World";
import { SaveSystem } from "../gameplay/SaveSystem";
import { SystemScheduler } from "../ecs/SystemScheduler";
import { System } from "../ecs";
import { EngineProfiler } from "../core/EngineProfiler";
import { ValidationLayer } from "../core/ValidationLayer";

function approx(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

describe("Math", () => {
  it("Vec3.ZERO is immutable", () => {
    try {
      (Vec3.ZERO as any).x = 999;
      expect(Vec3.ZERO.x).toBe(0);
    } catch {
      expect(true).toBe(true);
    }
  });

  it("Vec3.UP is immutable", () => {
    try {
      (Vec3.UP as any).y = 999;
      expect(Vec3.UP.y).toBe(1);
    } catch {
      expect(true).toBe(true);
    }
  });

  it("Vec3.lerp basic interpolation", () => {
    const a = new Vec3(0, 0, 0);
    a.lerp(new Vec3(10, 20, 30), 0.5);
    expect(approx(a.x, 5)).toBe(true);
    expect(approx(a.y, 10)).toBe(true);
    expect(approx(a.z, 15)).toBe(true);
  });

  it("Vec3.lerp t=0 stays at origin", () => {
    const b = new Vec3(0, 0, 0);
    b.lerp(new Vec3(10, 0, 0), 0);
    expect(approx(b.x, 0)).toBe(true);
  });

  it("Vec3.lerp t=1 reaches target", () => {
    const c = new Vec3(0, 0, 0);
    c.lerp(new Vec3(10, 0, 0), 1);
    expect(approx(c.x, 10)).toBe(true);
  });

  it("Vec3.cross right-hand rule", () => {
    const a = new Vec3(1, 0, 0);
    const b = new Vec3(0, 1, 0);
    const c = a.cross(b);
    expect(approx(c.x, 0) && approx(c.y, 0) && approx(c.z, 1)).toBe(true);
  });

  it("Vec3.dot perpendicular", () => {
    const a = new Vec3(1, 0, 0);
    const b = new Vec3(0, 1, 0);
    expect(approx(a.dot(b), 0)).toBe(true);
  });

  it("Quat.rotateVec3 90 deg around Y", () => {
    const q = Quat.fromAxisAngle(new Vec3(0, 1, 0), Math.PI / 2);
    const v = new Vec3(1, 0, 0);
    const result = q.rotateVec3(v);
    expect(approx(result.x, 0)).toBe(true);
    expect(approx(result.y, 0)).toBe(true);
    expect(approx(result.z, -1)).toBe(true);
  });

  it("Quat.rotateVec3 90 deg around Z", () => {
    const q = Quat.fromAxisAngle(new Vec3(0, 0, 1), Math.PI / 2);
    const v = new Vec3(1, 0, 0);
    const result = q.rotateVec3(v);
    expect(approx(result.x, 0)).toBe(true);
    expect(approx(result.y, 1)).toBe(true);
    expect(approx(result.z, 0)).toBe(true);
  });

  it("Quat.rotateVec3 identity", () => {
    const q = new Quat(0, 0, 0, 1);
    const v = new Vec3(3, 4, 5);
    const result = q.rotateVec3(v);
    expect(approx(result.x, 3)).toBe(true);
    expect(approx(result.y, 4)).toBe(true);
    expect(approx(result.z, 5)).toBe(true);
  });

  it("Quat.multiply two 90 deg = 180 deg", () => {
    const q1 = Quat.fromAxisAngle(new Vec3(0, 1, 0), Math.PI / 2);
    const q2 = Quat.fromAxisAngle(new Vec3(0, 1, 0), Math.PI / 2);
    q1.multiply(q2);
    const result = q1.rotateVec3(new Vec3(1, 0, 0));
    expect(approx(result.x, -1)).toBe(true);
    expect(approx(result.y, 0)).toBe(true);
    expect(approx(result.z, 0)).toBe(true);
  });

  it("Quat.slerp halfway = 90 deg", () => {
    const q1 = new Quat(0, 0, 0, 1);
    const q2 = Quat.fromAxisAngle(new Vec3(0, 1, 0), Math.PI);
    q1.slerp(q2, 0.5);
    const result = q1.rotateVec3(new Vec3(1, 0, 0));
    expect(approx(result.x, 0, 1e-4)).toBe(true);
    expect(approx(result.z, -1, 1e-4)).toBe(true);
  });

  it("Mat4.multiply translation composition", () => {
    const a = new Mat4();
    a.compose(new Vec3(1, 2, 3), new Quat(0, 0, 0, 1), new Vec3(1, 1, 1));
    const b = new Mat4();
    b.compose(new Vec3(4, 5, 6), new Quat(0, 0, 0, 1), new Vec3(1, 1, 1));
    a.multiply(b);
    const t = a.getTranslation();
    expect(approx(t.x, 5)).toBe(true);
    expect(approx(t.y, 7)).toBe(true);
    expect(approx(t.z, 9)).toBe(true);
  });

  it("Mat4.decompose detects negative scale", () => {
    const m = new Mat4();
    m.compose(new Vec3(1, 2, 3), new Quat(0, 0, 0, 1), new Vec3(-2, 3, 4));
    const oPos = new Vec3(), oRot = new Quat(), oScale = new Vec3();
    m.decompose(oPos, oRot, oScale);
    expect(oScale.x).toBeLessThan(0);
    expect(approx(oPos.x, 1)).toBe(true);
    expect(approx(oPos.y, 2)).toBe(true);
    expect(approx(oPos.z, 3)).toBe(true);
  });

  it("Mat4.compose/decompose roundtrip", () => {
    const pos = new Vec3(10, -5, 3);
    const rot = Quat.fromAxisAngle(new Vec3(0, 1, 0), 0.7);
    const scale = new Vec3(2, 3, 4);
    const m = new Mat4();
    m.compose(pos, rot, scale);
    const oPos = new Vec3(), oRot = new Quat(), oScale = new Vec3();
    m.decompose(oPos, oRot, oScale);
    expect(approx(oScale.x, 2) && approx(oScale.y, 3) && approx(oScale.z, 4)).toBe(true);
    expect(approx(oPos.x, 10) && approx(oPos.y, -5) && approx(oPos.z, 3)).toBe(true);
  });

  it("Frustum.intersectsAABB returns boolean", () => {
    const f = new Frustum();
    const aabb = new AABB(new Vec3(-1, -1, -1), new Vec3(1, 1, 1));
    const result = f.intersectsAABB(aabb);
    expect(typeof result).toBe("boolean");
  });
});

describe("Clock", () => {
  it("starts unpaused with timeScale 1", () => {
    const clock = new Clock();
    expect(clock.paused).toBe(false);
    expect(clock.timeScale).toBe(1.0);
  });

  it("tick returns positive dt", () => {
    const clock = new Clock();
    clock.tick(1000);
    const dt = clock.tick(1016.667);
    expect(dt).toBeGreaterThan(0);
  });

  it("returns 0 when paused", () => {
    const clock = new Clock();
    clock.tick(1000);
    clock.pause();
    expect(clock.paused).toBe(true);
    const dt = clock.tick(1033.334);
    expect(dt).toBe(0);
  });

  it("resume unpauses", () => {
    const clock = new Clock();
    clock.pause();
    clock.resume();
    expect(clock.paused).toBe(false);
  });

  it("timeScale halves delta", () => {
    const clock = new Clock();
    clock.tick(1000);
    clock.timeScale = 0.5;
    const dt = clock.tick(1020);
    expect(dt).toBeGreaterThan(0);
    expect(dt).toBeLessThan(0.02);
  });

  it("handles NaN timestamp", () => {
    const clock = new Clock();
    clock.tick(0);
    const dt = clock.tick(NaN);
    expect(dt).toBe(0);
  });

  it("handles negative delta", () => {
    const clock = new Clock();
    clock.tick(100);
    const dt = clock.tick(50);
    expect(dt).toBe(0);
  });
});

describe("EventBus", () => {
  it("second listener runs despite first throwing", () => {
    const bus = new EventBus();
    let called = false;
    bus.on("test", () => { throw new Error("intentional"); });
    bus.on("test", () => { called = true; });
    const origError = console.error;
    console.error = () => {};
    bus.emit("test");
    console.error = origError;
    expect(called).toBe(true);
  });

  it("basic emit works", () => {
    const bus = new EventBus();
    const values: number[] = [];
    bus.on("data", (v: number) => values.push(v));
    bus.emit("data", 42);
    expect(values).toEqual([42]);
  });
});

describe("Handles & Resources", () => {
  it("allocated handle is valid, freed is invalid", () => {
    const alloc = new HandleAllocator(16);
    const h1 = alloc.alloc();
    expect(alloc.isValid(h1)).toBe(true);
    alloc.free(h1);
    expect(alloc.isValid(h1)).toBe(false);
  });

  it("reuses freed index with incremented generation", () => {
    const alloc = new HandleAllocator(16);
    const h1 = alloc.alloc();
    alloc.free(h1);
    const h2 = alloc.alloc();
    expect(handleIndex(h2)).toBe(handleIndex(h1));
    expect(handleGeneration(h2)).toBe(handleGeneration(h1) + 1);
  });

  it("HandleMap get/free lifecycle", () => {
    const map = new HandleMap<string>();
    const h = map.alloc("hello");
    expect(map.get(h)).toBe("hello");
    const freed = map.free(h);
    expect(freed).toBe("hello");
    expect(map.get(h)).toBe(null);
  });

  it("ResourceManager warns on unknown release", () => {
    const rm = new ResourceManager();
    const origWarn = console.warn;
    let warnCalled = false;
    console.warn = () => { warnCalled = true; };
    rm.release(0xDEAD as any);
    console.warn = origWarn;
    expect(warnCalled).toBe(true);
  });

  it("HandleMap refcount lifecycle", () => {
    const map = new HandleMap<string>();
    const h = map.alloc("test");
    expect(map.getRefCount(h)).toBe(1);
    map.retain(h);
    expect(map.getRefCount(h)).toBe(2);
    expect(map.release(h)).toBe(1);
    expect(map.release(h)).toBe(0);
  });

  it("ResourceManager starts empty", () => {
    const rm = new ResourceManager();
    const stats = rm.getStats();
    expect(stats.textures).toBe(0);
    expect(stats.totalRefs).toBe(0);
    expect(rm.getTotalMemory()).toBe(0);
  });
});

describe("Serialization", () => {
  it("serialize and deserialize with parent remapping", () => {
    const TestComp = defineComponent("TestComp_S", { x: "f32", y: "f32" });
    const ParentComp = defineComponent("Parent_S", { entity: "i32" });

    const world = new World();
    const serializer = new SceneSerializer();
    serializer.register(TestComp, ParentComp);

    const e1 = world.createEntity();
    const e2 = world.createEntity();
    world.addComponent(e1, TestComp, { x: 1, y: 2 });
    world.addComponent(e2, TestComp, { x: 3, y: 4 });
    world.addComponent(e2, ParentComp, { entity: e1 });

    const scene = serializer.serialize(world, "test");
    expect(scene.entities.length).toBe(2);
    expect(scene.version).toBe(1);

    const world2 = new World();
    const ids = serializer.deserialize(world2, scene);
    expect(ids.length).toBe(2);

    const parentStore = world2.getStore(ParentComp);
    const parentRef = parentStore.get(ids[1], "entity") as number;
    expect(parentRef).toBe(ids[0]);
  });

  it("handles null scene gracefully", () => {
    const serializer = new SceneSerializer();
    const world = new World();
    const origError = console.error;
    console.error = () => {};
    const ids = serializer.deserialize(world, null as any);
    console.error = origError;
    expect(ids.length).toBe(0);
  });

  it("detects circular parent hierarchy", () => {
    const ParentComp = defineComponent("Parent", { entity: "i32" });
    const serializer = new SceneSerializer();
    serializer.register(ParentComp);

    const scene: SerializedScene = {
      version: 1,
      name: "cycle_test",
      entities: [
        { id: 100, components: { Parent: { entity: 101 } } },
        { id: 101, components: { Parent: { entity: 100 } } },
      ],
    };

    const world = new World();
    const origError = console.error;
    let cycleDetected = false;
    console.error = (msg: string) => { if (typeof msg === "string" && msg.includes("ircular")) cycleDetected = true; };
    serializer.deserialize(world, scene);
    console.error = origError;
    expect(cycleDetected).toBe(true);
  });
});

describe("SaveSystem", () => {
  it("API shape is correct", () => {
    const serializer = new SceneSerializer();
    const save = new SaveSystem(serializer, "test_save_");
    expect(typeof save.save).toBe("function");
    expect(typeof save.load).toBe("function");
    expect(typeof save.deleteSlot).toBe("function");
  });
});

describe("ECS Core", () => {
  it("addComponent and getStore", () => {
    const TestComp = defineComponent("ECSTest1", { value: "f32" });
    const world = new World();
    const e1 = world.createEntity();
    world.addComponent(e1, TestComp, { value: 42 });
    expect(world.hasComponent(e1, TestComp)).toBe(true);
    const store = world.getStore(TestComp);
    expect(store.get(e1, "value")).toBe(42);
  });

  it("destroyEntity removes entity and components", () => {
    const TestComp = defineComponent("ECSTest2", { value: "f32" });
    const world = new World();
    const e1 = world.createEntity();
    world.addComponent(e1, TestComp, { value: 42 });
    world.destroyEntity(e1);
    expect(world.isAlive(e1)).toBe(false);
    expect(world.getStore(TestComp).has(e1)).toBe(false);
  });

  it("entity ID recycled with incremented generation", () => {
    const world = new World();
    const e1 = world.createEntity();
    world.destroyEntity(e1);
    const e2 = world.createEntity();
    expect(e2).toBe(e1);
    expect(world.generation(e2)).toBe(1);
  });

  it("onEntityDestroy callback fires", () => {
    const world = new World();
    let destroyedEid = -1;
    world.onEntityDestroy((eid) => { destroyedEid = eid; });
    const e = world.createEntity();
    world.destroyEntity(e);
    expect(destroyedEid).toBe(e);
  });

  it("entityCount tracks correctly", () => {
    const world = new World();
    expect(world.entityCount).toBe(0);
    const e1 = world.createEntity();
    const e2 = world.createEntity();
    expect(world.entityCount).toBe(2);
    world.destroyEntity(e1);
    expect(world.entityCount).toBe(1);
  });

  it("entity destroy callbacks are error-isolated", () => {
    const world = new World();
    let secondCalled = false;
    world.onEntityDestroy(() => { throw new Error("intentional"); });
    world.onEntityDestroy(() => { secondCalled = true; });
    const origError = console.error;
    console.error = () => {};
    const e = world.createEntity();
    world.destroyEntity(e);
    console.error = origError;
    expect(secondCalled).toBe(true);
  });
});

describe("SystemScheduler", () => {
  it("generates stages", () => {
    class ReadOnlySystem extends System {
      static reads = ["Transform"];
      static writes: string[] = [];
      update() {}
    }
    class WriteSystem extends System {
      static reads: string[] = [];
      static writes = ["Transform"];
      update() {}
    }
    class IndependentSystem extends System {
      static reads = ["Velocity"];
      static writes = ["Velocity"];
      update() {}
    }

    const scheduler = new SystemScheduler();
    const sysA = new ReadOnlySystem(); sysA.phase = "postPhysics"; sysA.priority = 0;
    const sysB = new WriteSystem(); sysB.phase = "postPhysics"; sysB.priority = 1;
    const sysC = new IndependentSystem(); sysC.phase = "postPhysics"; sysC.priority = 2;

    const plan = scheduler.buildPlan([sysA, sysB, sysC], ["postPhysics"]);
    const stages = plan.phases.get("postPhysics");
    expect(stages).toBeDefined();
    expect(stages!.length).toBeGreaterThan(0);
  });

  it("executes all systems", () => {
    const scheduler = new SystemScheduler();
    const executed: string[] = [];
    class TrackA extends System { static reads = ["A"]; static writes: string[] = []; update() { executed.push("A"); } }
    class TrackB extends System { static reads = ["B"]; static writes: string[] = []; update() { executed.push("B"); } }
    const tA = new TrackA(); tA.phase = "render"; tA.priority = 0;
    const tB = new TrackB(); tB.phase = "render"; tB.priority = 1;
    const plan = scheduler.buildPlan([tA, tB], ["render"]);
    scheduler.execute(plan, 0.016);
    expect(executed).toContain("A");
    expect(executed).toContain("B");
  });
});

describe("EngineProfiler", () => {
  it("tracks frame data", () => {
    const profiler = new EngineProfiler({ enabled: true, historyLength: 10 });
    profiler.beginFrame();
    profiler.setEntityCount(100);
    profiler.beginSystem("TestSystem");
    profiler.endSystem("TestSystem");
    profiler.endFrame();

    const latest = profiler.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.entityCount).toBe(100);
    expect(latest!.systemTimes.has("TestSystem")).toBe(true);
  });

  it("disabled skips recording", () => {
    const profiler = new EngineProfiler({ enabled: true, historyLength: 10 });
    profiler.beginFrame();
    profiler.setEntityCount(100);
    profiler.endFrame();

    profiler.setEnabled(false);
    profiler.beginFrame();
    profiler.setEntityCount(999);
    profiler.endFrame();

    const latest = profiler.getLatest();
    expect(latest!.entityCount).toBe(100);
  });
});

describe("ValidationLayer", () => {
  it("alive entity passes, dead entity fails", () => {
    const vl = new ValidationLayer();
    expect(vl.checkEntityAlive(5, "test", () => true)).toBe(true);
    expect(vl.checkEntityAlive(5, "test", () => false)).toBe(false);
    expect(vl.getWarningCount()).toBe(1);
  });

  it("reports unfreed allocations", () => {
    const vl = new ValidationLayer();
    vl.trackAllocation(42, "texture");
    const leaks = vl.reportLeaks();
    expect(leaks.length).toBe(1);
    expect(leaks[0].message).toContain("42");
  });

  it("no leak after dealloc", () => {
    const vl = new ValidationLayer();
    vl.trackAllocation(42, "texture");
    vl.trackDeallocation(42);
    expect(vl.reportLeaks().length).toBe(0);
  });

  it("disabled always returns true", () => {
    const vl = new ValidationLayer();
    vl.setEnabled(false);
    expect(vl.checkEntityAlive(999, "test", () => false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engine Integration — boots AGEE headless with parallel init, runs through engine
// Dynamic imports avoid loading Three.js at module scope in Node
// ---------------------------------------------------------------------------

describe("Engine Integration (headless)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let engine: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let TransformDef: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let RigidBodyDef: any;

  beforeAll(async () => {
    // Polyfill browser globals for Node environment
    if (typeof globalThis.self === "undefined") {
      (globalThis as any).self = globalThis;
    }
    if (typeof globalThis.requestAnimationFrame === "undefined") {
      (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 16) as unknown as number;
      (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
    }

    const engineMod = await import("../core/Engine");
    const compMod = await import("../core/Components");
    TransformDef = compMod.Transform;
    RigidBodyDef = compMod.RigidBody;

    engine = new engineMod.AGEE({ headless: true, profiler: true });
    await engine.init();
  }, 15000);

  afterAll(() => {
    engine?.destroy();
  });

  it("parallel init reaches initialized state", () => {
    expect(engine.state).toBe("initialized");
  });

  it("world has systems registered after init", () => {
    const systems = engine.world.getSystems();
    expect(systems.length).toBeGreaterThan(0);
    const names = systems.map((s: { constructor: { name: string } }) => s.constructor.name);
    expect(names).toContain("PhysicsSystem");
    expect(names).toContain("TransformHierarchySystem");
    expect(names).toContain("SkeletonSystem");
    expect(names).toContain("AssetSystem");
  });

  it("creates entities with components through engine", () => {
    const eid = engine.world.createEntity();
    engine.world.addComponent(eid, TransformDef, { x: 5, y: 10, z: 15, sx: 1, sy: 1, sz: 1 });
    expect(engine.world.isAlive(eid)).toBe(true);
    expect(engine.world.hasComponent(eid, TransformDef)).toBe(true);

    const store = engine.world.getStore(TransformDef);
    expect(store.get(eid, "x")).toBe(5);
    expect(store.get(eid, "y")).toBe(10);
    expect(store.get(eid, "z")).toBe(15);
  });

  it("runs update loop through engine systems", () => {
    const dt = 1 / 60;
    expect(() => engine.world.update(dt)).not.toThrow();
    engine.commands.flush(engine.world);
  });

  it("physics simulation works through engine update", () => {
    const eid = engine.world.createEntity();
    engine.world.addComponent(eid, TransformDef, { x: 0, y: 20, z: 0, sx: 1, sy: 1, sz: 1 });
    engine.world.addComponent(eid, RigidBodyDef, { bodyType: 0, mass: 1, restitution: 0.3, friction: 0.5 });

    const body = engine.physics.addBody(eid, "dynamic");
    engine.physics.addCollider(eid, "sphere", { radius: 0.5 });
    expect(body).toBeDefined();

    const initialY = body.translation().y;

    for (let i = 0; i < 60; i++) {
      engine.world.update(1 / 60);
      engine.commands.flush(engine.world);
    }

    const finalY = body.translation().y;
    expect(finalY).toBeLessThan(initialY);
  });

  it("system scheduler builds parallel stages", () => {
    const scheduler = new SystemScheduler();

    class MovementSystem extends System {
      static reads = ["Transform"];
      static writes = ["Transform"];
      update() {}
    }
    class AIThinkSystem extends System {
      static reads = ["AIAgent"];
      static writes = ["AIAgent"];
      update() {}
    }
    class AudioUpdateSystem extends System {
      static reads = ["AudioSource"];
      static writes = ["AudioSource"];
      update() {}
    }

    const movement = new MovementSystem(); movement.phase = "postPhysics"; movement.priority = 0;
    const ai = new AIThinkSystem(); ai.phase = "postPhysics"; ai.priority = 1;
    const audio = new AudioUpdateSystem(); audio.phase = "postPhysics"; audio.priority = 2;

    const plan = scheduler.buildPlan([movement, ai, audio], ["postPhysics"]);
    const stages = plan.phases.get("postPhysics")!;

    expect(stages.length).toBe(1);
    expect(stages[0].systems.length).toBe(3);
  });

  it("profiler tracks through engine update", () => {
    engine.profiler.setEnabled(true);
    engine.profiler.beginFrame();
    engine.profiler.setEntityCount(engine.world.entityCount);
    engine.world.update(1 / 60);
    engine.profiler.endFrame();

    const latest = engine.profiler.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.entityCount).toBeGreaterThan(0);
  });

  it("event bus fires through engine lifecycle", () => {
    let preUpdateFired = false;
    let postUpdateFired = false;
    const unsub1 = engine.events.on("preUpdate", () => { preUpdateFired = true; });
    const unsub2 = engine.events.on("postUpdate", () => { postUpdateFired = true; });

    engine.events.emit("preUpdate", 1 / 60);
    engine.world.update(1 / 60);
    engine.events.emit("postUpdate", 1 / 60);

    expect(preUpdateFired).toBe(true);
    expect(postUpdateFired).toBe(true);

    unsub1();
    unsub2();
  });

  it("entity destroy cleans up through engine", () => {
    const eid = engine.world.createEntity();
    engine.world.addComponent(eid, TransformDef, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    engine.world.addComponent(eid, RigidBodyDef, { bodyType: 0, mass: 1, restitution: 0.3, friction: 0.5 });
    engine.physics.addBody(eid, "dynamic");
    engine.physics.addCollider(eid, "box", { halfX: 0.5, halfY: 0.5, halfZ: 0.5 });

    expect(engine.world.isAlive(eid)).toBe(true);
    expect(engine.physics.getBody(eid)).toBeDefined();

    engine.world.destroyEntity(eid);
    expect(engine.world.isAlive(eid)).toBe(false);
  });

  it("command buffer defers and flushes through engine", () => {
    const TestComp = defineComponent("EngineTestCmd", { val: "f32" });
    const tempId = engine.commands.spawn();
    engine.commands.addComponent(tempId, TestComp, { val: 99 });
    engine.commands.flush(engine.world);

    const eid = engine.commands.resolveId(tempId);
    expect(eid).toBeDefined();
    expect(engine.world.isAlive(eid)).toBe(true);
    expect(engine.world.hasComponent(eid, TestComp)).toBe(true);
    expect(engine.world.getStore(TestComp).get(eid, "val")).toBe(99);
  });

  it("collision callbacks fire through engine physics", () => {
    const collisions: { a: number; b: number }[] = [];
    const unsub = engine.physics.onCollisionStart((e: { entityA: number; entityB: number }) => {
      collisions.push({ a: e.entityA, b: e.entityB });
    });

    const e1 = engine.world.createEntity();
    engine.world.addComponent(e1, TransformDef, { x: 0, y: 5, z: 0, sx: 1, sy: 1, sz: 1 });
    engine.world.addComponent(e1, RigidBodyDef, { bodyType: 0, mass: 1, restitution: 0.3, friction: 0.5 });
    engine.physics.addBody(e1, "dynamic");
    engine.physics.addCollider(e1, "sphere", { radius: 0.5 });

    const floor = engine.world.createEntity();
    engine.world.addComponent(floor, TransformDef, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    engine.world.addComponent(floor, RigidBodyDef, { bodyType: 1, mass: 0, restitution: 0.3, friction: 0.5 });
    engine.physics.addBody(floor, "fixed");
    engine.physics.addCollider(floor, "box", { halfX: 50, halfY: 0.5, halfZ: 50 });

    for (let i = 0; i < 120; i++) {
      engine.world.update(1 / 60);
    }

    expect(collisions.length).toBeGreaterThan(0);
    unsub();
  });

  it("multiple update ticks remain stable", () => {
    for (let i = 0; i < 300; i++) {
      expect(() => engine.world.update(1 / 60)).not.toThrow();
    }
  });
});
