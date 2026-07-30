import { describe, it, expect, beforeEach } from "vitest";

import { World } from "../ecs";
import { defineComponent } from "../ecs";
import { Transform } from "../core/Components";
import { SceneSerializer } from "../core/serialization/SceneSerializer";
import { EventBus } from "../core/EventBus";
import { GameState, GameStateManager } from "../gameplay/GameState";
import { SaveSystem } from "../gameplay/SaveSystem";
import { PrefabSystem, PrefabDef } from "../prefab/PrefabSystem";
import { SceneManager } from "../scene/SceneManager";

// ---------------------------------------------------------------------------
// A minimal in-memory localStorage polyfill (the "node" vitest environment has
// no Storage global). Fresh instance per test so save-slot state never leaks
// across tests.
// ---------------------------------------------------------------------------

class FakeStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null; }
  key(index: number): string | null { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}

beforeEach(() => {
  (globalThis as any).localStorage = new FakeStorage();
});

// ---------------------------------------------------------------------------
// GameState / GameStateManager
// ---------------------------------------------------------------------------

class RecordingState extends GameState {
  constructor(private name: string, private log: string[]) {
    super();
  }
  enter(): void { this.log.push(`enter:${this.name}`); }
  exit(): void { this.log.push(`exit:${this.name}`); }
  update(dt: number): void { this.log.push(`update:${this.name}:${dt}`); }
  pause(): void { this.log.push(`pause:${this.name}`); }
  resume(): void { this.log.push(`resume:${this.name}`); }
}

describe("GameStateManager", () => {
  it("push enters the new state and pauses the previous one", () => {
    const log: string[] = [];
    const mgr = new GameStateManager();
    const menu = new RecordingState("menu", log);
    const play = new RecordingState("play", log);

    mgr.push(menu);
    mgr.push(play);

    expect(log).toEqual(["enter:menu", "pause:menu", "enter:play"]);
    expect(mgr.current).toBe(play);
  });

  it("pop exits the top state and resumes the one beneath it", () => {
    const log: string[] = [];
    const mgr = new GameStateManager();
    const menu = new RecordingState("menu", log);
    const play = new RecordingState("play", log);
    mgr.push(menu);
    mgr.push(play);
    log.length = 0;

    const popped = mgr.pop();

    expect(popped).toBe(play);
    expect(log).toEqual(["exit:play", "resume:menu"]);
    expect(mgr.current).toBe(menu);
  });

  it("pop on an empty stack returns null and does not throw", () => {
    const mgr = new GameStateManager();
    expect(mgr.pop()).toBeNull();
    expect(mgr.current).toBeNull();
  });

  it("switch replaces the top state without touching states beneath it", () => {
    const log: string[] = [];
    const mgr = new GameStateManager();
    const menu = new RecordingState("menu", log);
    const play = new RecordingState("play", log);
    const pause = new RecordingState("pause", log);
    mgr.push(menu);
    mgr.push(play);
    log.length = 0;

    mgr.switch(pause);

    expect(log).toEqual(["exit:play", "enter:pause"]);
    expect(mgr.current).toBe(pause);
  });

  it("replace clears the whole stack before pushing the new state", () => {
    const log: string[] = [];
    const mgr = new GameStateManager();
    const menu = new RecordingState("menu", log);
    const play = new RecordingState("play", log);
    const gameOver = new RecordingState("gameOver", log);
    mgr.push(menu);
    mgr.push(play);
    log.length = 0;

    mgr.replace(gameOver);

    expect(log).toEqual(["exit:play", "exit:menu", "enter:gameOver"]);
    expect(mgr.current).toBe(gameOver);
  });

  it("update delegates only to the current (top) state", () => {
    const log: string[] = [];
    const mgr = new GameStateManager();
    const menu = new RecordingState("menu", log);
    const play = new RecordingState("play", log);
    mgr.push(menu);
    mgr.push(play);
    log.length = 0;

    mgr.update(0.016);

    expect(log).toEqual(["update:play:0.016"]);
  });

  it("clear exits every state on the stack", () => {
    const log: string[] = [];
    const mgr = new GameStateManager();
    mgr.push(new RecordingState("a", log));
    mgr.push(new RecordingState("b", log));
    log.length = 0;

    mgr.clear();

    expect(log).toEqual(["exit:b", "exit:a"]);
    expect(mgr.current).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SaveSystem — real save -> load round trip (supersedes the old
// "methods exist" check in src/tests/regression.test.ts)
// ---------------------------------------------------------------------------

describe("SaveSystem (real save/load round trip)", () => {
  function makeSerializer(): SceneSerializer {
    const serializer = new SceneSerializer();
    serializer.register(Transform);
    return serializer;
  }

  it("save() then load() restores equivalent Transform state on a fresh world", () => {
    const serializer = makeSerializer();
    const save = new SaveSystem(serializer, "test_save_");

    const worldA = new World();
    const e1 = worldA.createEntity();
    worldA.addComponent(e1, Transform, { x: 1, y: 2, z: 3, sx: 1, sy: 1, sz: 1 });
    const e2 = worldA.createEntity();
    worldA.addComponent(e2, Transform, { x: -5, y: 0, z: 10, sx: 2, sy: 2, sz: 2 });

    const result = save.save(worldA, "slot1", { level: "test-level" });
    expect(result.success).toBe(true);

    const worldB = new World();
    const loadResult = save.load(worldB, "slot1");
    expect(loadResult.success).toBe(true);

    expect(worldB.entityCount).toBe(2);
    const store = worldB.getStore(Transform);

    // Every entity created during load must carry over the exact Transform data.
    const entities: number[] = [];
    for (let eid = 0; eid < 16; eid++) {
      if (worldB.isAlive(eid) && worldB.hasComponent(eid, Transform)) entities.push(eid);
    }
    expect(entities.length).toBe(2);

    const xs = entities.map((eid) => store.get(eid, "x")).sort((a, b) => a - b);
    expect(xs).toEqual([-5, 1]);

    const withX1 = entities.find((eid) => store.get(eid, "x") === 1)!;
    expect(store.get(withX1, "y")).toBe(2);
    expect(store.get(withX1, "z")).toBe(3);

    const withXNeg5 = entities.find((eid) => store.get(eid, "x") === -5)!;
    expect(store.get(withXNeg5, "sx")).toBe(2);
    expect(store.get(withXNeg5, "z")).toBe(10);
  });

  it("hasSave/listSlots/deleteSlot reflect saved slots correctly", () => {
    const serializer = makeSerializer();
    const save = new SaveSystem(serializer, "test_save_");
    const world = new World();
    const e = world.createEntity();
    world.addComponent(e, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });

    expect(save.hasSave("alpha")).toBe(false);
    save.save(world, "alpha");
    save.save(world, "beta");

    expect(save.hasSave("alpha")).toBe(true);
    const slots = save.listSlots().map((s) => s.name).sort();
    expect(slots).toEqual(["alpha", "beta"]);

    save.deleteSlot("alpha");
    expect(save.hasSave("alpha")).toBe(false);
    expect(save.listSlots().map((s) => s.name)).toEqual(["beta"]);
  });

  it("load() on a missing slot fails without throwing", () => {
    const serializer = makeSerializer();
    const save = new SaveSystem(serializer, "test_save_");
    const world = new World();
    const result = save.load(world, "does-not-exist");
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// PrefabSystem
// ---------------------------------------------------------------------------

const Health = defineComponent("Health_PrefabTest", { hp: "f32", maxHp: "f32" });

describe("PrefabSystem", () => {
  function makeGoblinDef(): PrefabDef {
    return {
      name: "goblin",
      root: {
        components: [
          { def: Transform, data: { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 } },
          { def: Health, data: { hp: 10, maxHp: 10 } },
        ],
        children: [
          {
            components: [
              { def: Transform, data: { x: 0, y: 1, z: 0, sx: 1, sy: 1, sz: 1 } },
            ],
          },
        ],
      },
    };
  }

  it("instantiate() creates parent + child entities with the prefab's component data", () => {
    const world = new World();
    const prefabs = new PrefabSystem(world);
    prefabs.register(makeGoblinDef());

    const created = prefabs.instantiate("goblin");
    expect(created.length).toBe(2);

    const [root, child] = created;
    expect(world.hasComponent(root, Health)).toBe(true);
    expect(world.getStore(Health).get(root, "hp")).toBe(10);
    expect(world.hasComponent(child, Health)).toBe(false);
    expect(world.getStore(Transform).get(child, "y")).toBe(1);
  });

  it("instantiate() applies a position override only to the Transform component", () => {
    const world = new World();
    const prefabs = new PrefabSystem(world);
    prefabs.register(makeGoblinDef());

    const [root] = prefabs.instantiate("goblin", { x: 5, y: 6, z: 7 });
    const store = world.getStore(Transform);
    expect(store.get(root, "x")).toBe(5);
    expect(store.get(root, "y")).toBe(6);
    expect(store.get(root, "z")).toBe(7);
    // Non-Transform data must be untouched by the position override.
    expect(world.getStore(Health).get(root, "hp")).toBe(10);
  });

  it("instantiate() throws for an unregistered prefab name", () => {
    const world = new World();
    const prefabs = new PrefabSystem(world);
    expect(() => prefabs.instantiate("does-not-exist")).toThrow();
  });

  it("instantiateBatch() spawns N copies at the given flat positions", () => {
    const world = new World();
    const prefabs = new PrefabSystem(world);
    prefabs.register(makeGoblinDef());

    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const created = prefabs.instantiateBatch("goblin", positions, 3);

    // 3 requested positions * 2 entities (parent+child) per prefab.
    expect(created.length).toBe(6);
    const store = world.getStore(Transform);
    const roots = [created[0], created[2], created[4]];
    const xs = roots.map((eid) => store.get(eid, "x")).sort((a, b) => a - b);
    expect(xs).toEqual([0, 1, 2]);
  });

  it("instantiateVariant() applies component-field overrides without mutating the base prefab", () => {
    const world = new World();
    const prefabs = new PrefabSystem(world);
    prefabs.register(makeGoblinDef());

    const overrides = new Map<string, Partial<Record<string, any>>>();
    overrides.set("Health_PrefabTest", { hp: 999 });

    const [eliteRoot] = prefabs.instantiateVariant({ base: "goblin", overrides });
    expect(world.getStore(Health).get(eliteRoot, "hp")).toBe(999);

    // Base prefab must be unaffected by the variant's override.
    const [normalRoot] = prefabs.instantiate("goblin");
    expect(world.getStore(Health).get(normalRoot, "hp")).toBe(10);
  });

  it("register() with a repeated name updates in place and reuses the same handle", () => {
    const world = new World();
    const prefabs = new PrefabSystem(world);
    const h1 = prefabs.register(makeGoblinDef());
    const updatedDef: PrefabDef = { name: "goblin", root: { components: [{ def: Health, data: { hp: 50, maxHp: 50 } }] } };
    const h2 = prefabs.register(updatedDef);

    expect(h2).toBe(h1);
    expect(prefabs.get("goblin")).toBe(updatedDef);
  });

  it("unregister() removes the prefab so get()/instantiate() no longer find it", () => {
    const world = new World();
    const prefabs = new PrefabSystem(world);
    prefabs.register(makeGoblinDef());
    prefabs.unregister("goblin");

    expect(prefabs.get("goblin")).toBeNull();
    expect(() => prefabs.instantiate("goblin")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SceneManager
// ---------------------------------------------------------------------------

describe("SceneManager", () => {
  function makeManager() {
    const world = new World();
    const serializer = new SceneSerializer();
    serializer.register(Transform);
    const events = new EventBus();
    const mgr = new SceneManager();
    world.addSystem(mgr);
    mgr.setSerializer(serializer);
    mgr.setEvents(events);
    return { world, serializer, events, mgr };
  }

  it("loadSceneFromData() synchronously creates entities and marks the scene active", () => {
    const { world, mgr } = makeManager();
    const data = {
      version: 1,
      name: "level1",
      entities: [{ id: 0, components: { Transform: { x: 1, y: 0, z: 0, sx: 1, sy: 1, sz: 1 } } }],
    };

    const handle = mgr.loadSceneFromData("level1", data);
    expect(handle.state).toBe("active");
    expect(handle.entityIds.length).toBe(1);
    expect(world.isAlive(handle.entityIds[0])).toBe(true);
    expect(mgr.getActiveScenes()).toEqual(["level1"]);
  });

  it("unloadScene() destroys entities and removes the scene from tracking", () => {
    const { world, mgr } = makeManager();
    const data = { version: 1, name: "level1", entities: [{ id: 0, components: {} }] };
    const handle = mgr.loadSceneFromData("level1", data);
    const eid = handle.entityIds[0];

    mgr.unloadScene("level1");

    expect(world.isAlive(eid)).toBe(false);
    expect(mgr.getScene("level1")).toBeUndefined();
    expect(mgr.getActiveScenes()).toEqual([]);
  });

  it("unloadScene() is a no-op for a persistent scene", () => {
    const { world, mgr } = makeManager();
    const data = { version: 1, name: "hub", entities: [{ id: 0, components: {} }] };
    const handle = mgr.loadSceneFromData("hub", data, true);
    const eid = handle.entityIds[0];

    mgr.unloadScene("hub");

    expect(world.isAlive(eid)).toBe(true);
    expect(mgr.getScene("hub")).toBeDefined();
  });

  it("loadScene() with an async loader deserializes data and emits loading/loaded events in order", async () => {
    const { mgr, events } = makeManager();
    const seen: string[] = [];
    events.on("scene:loading", (name: string) => seen.push(`loading:${name}`));
    events.on("scene:loaded", (name: string) => seen.push(`loaded:${name}`));

    mgr.setLoader(async (name: string) => ({
      version: 1,
      name,
      entities: [{ id: 0, components: {} }],
    }));

    const handle = await mgr.loadScene("level2");
    expect(handle.state).toBe("active");
    expect(seen).toEqual(["loading:level2", "loaded:level2"]);
  });

  it("loadScene() deduplicates concurrent loads of the same scene name", async () => {
    const { mgr } = makeManager();
    let loadFnCalls = 0;
    mgr.setLoader(async (name: string) => {
      loadFnCalls++;
      return { version: 1, name, entities: [] };
    });

    const [a, b] = await Promise.all([mgr.loadScene("dup"), mgr.loadScene("dup")]);
    expect(a).toBe(b);
    expect(loadFnCalls).toBe(1);
  });

  it("loadScene() returns the cached handle for an already-loaded scene without reloading", async () => {
    const { mgr } = makeManager();
    let loadFnCalls = 0;
    mgr.setLoader(async (name: string) => {
      loadFnCalls++;
      return { version: 1, name, entities: [] };
    });

    await mgr.loadScene("cached");
    await mgr.loadScene("cached");
    expect(loadFnCalls).toBe(1);
  });

  it("transition() loads the target scene and unloads the source scene", async () => {
    const { world, mgr, events } = makeManager();
    const order: string[] = [];
    events.on("scene:transition:start", (from: string, to: string) => order.push(`start:${from}->${to}`));
    events.on("scene:transition:end", (from: string, to: string) => order.push(`end:${from}->${to}`));

    const fromHandle = mgr.loadSceneFromData("from", { version: 1, name: "from", entities: [{ id: 0, components: {} }] });
    const fromEid = fromHandle.entityIds[0];

    mgr.setLoader(async (name: string) => ({ version: 1, name, entities: [] }));
    await mgr.transition("from", "to");

    expect(order).toEqual(["start:from->to", "end:from->to"]);
    expect(world.isAlive(fromEid)).toBe(false);
    expect(mgr.getScene("from")).toBeUndefined();
    expect(mgr.getScene("to")?.state).toBe("active");
  });

  it("saveScene() serializes the current world state for a tracked scene", () => {
    const { mgr } = makeManager();
    const data = {
      version: 1,
      name: "level1",
      entities: [{ id: 0, components: { Transform: { x: 3, y: 0, z: 0, sx: 1, sy: 1, sz: 1 } } }],
    };
    mgr.loadSceneFromData("level1", data);

    const serialized = mgr.saveScene("level1");
    expect(serialized).not.toBeNull();
    expect(serialized!.entities.length).toBe(1);
    expect(serialized!.entities[0].components.Transform.x).toBe(3);
  });

  it("saveScene() returns null for an unknown scene", () => {
    const { mgr } = makeManager();
    expect(mgr.saveScene("nope")).toBeNull();
  });
});
