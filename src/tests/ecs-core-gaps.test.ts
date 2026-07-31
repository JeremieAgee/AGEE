import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

import { BitSet } from "../ecs/BitSet";
import { SparseSet } from "../ecs/SparseSet";
import { ArchetypeIndex } from "../ecs/ArchetypeIndex";
import { Query } from "../ecs/Query";
import { defineComponent } from "../ecs/Component";
import { ComponentStore } from "../ecs/ComponentStore";
import { CommandBuffer } from "../ecs/CommandBuffer";
import { World } from "../ecs/World";
import { Parent } from "../core/HierarchyComponents";
import {
  dsin, dcos, dtan, datan2, dasin, dacos, dsqrt, dabs,
  dmin, dmax, dclamp, dlerp, dfloor, dceil, dround, dfrac, dsign,
  dquaternionToEuler, deulerToQuaternion, SeededRNG,
} from "../core/DeterministicMath";
import { MemoryBudget } from "../core/MemoryBudget";
import { HandleMap, ResourceType, Handle } from "../core/handles/Handle";
import { EventJournal, defineEvent } from "../core/EventJournal";
import { SpatialHash } from "../core/spatial/SpatialHash";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(__dirname, "..");

function approx(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

// ===========================================================================
// BitSet
// ===========================================================================
describe("BitSet", () => {
  it("add/has/remove basic correctness", () => {
    const bs = new BitSet();
    expect(bs.has(5)).toBe(false);
    bs.add(5);
    expect(bs.has(5)).toBe(true);
    expect(bs.size).toBe(1);
    bs.remove(5);
    expect(bs.has(5)).toBe(false);
    expect(bs.size).toBe(0);
  });

  it("adding the same id twice does not double-count size", () => {
    const bs = new BitSet();
    bs.add(10);
    bs.add(10);
    expect(bs.size).toBe(1);
  });

  it("removing an id that was never added is a no-op", () => {
    const bs = new BitSet();
    bs.add(1);
    bs.remove(999);
    expect(bs.size).toBe(1);
    expect(bs.has(1)).toBe(true);
  });

  it("grows beyond initial capacity and keeps working", () => {
    const bs = new BitSet(64); // small initial capacity -> forces grow()
    const bigId = 5000;
    bs.add(bigId);
    expect(bs.has(bigId)).toBe(true);
    expect(bs.size).toBe(1);
    expect(bs.rawWordCount * 32).toBeGreaterThan(bigId);
  });

  it("iterates ids in ascending order matching toArray()", () => {
    const bs = new BitSet();
    const ids = [3, 1, 200, 65, 0, 1023];
    for (const id of ids) bs.add(id);
    const iterated = [...bs];
    const sorted = [...ids].sort((a, b) => a - b);
    expect(iterated).toEqual(sorted);
    expect(bs.toArray()).toEqual(sorted);
  });

  it("clear() empties the set", () => {
    const bs = new BitSet();
    bs.add(1); bs.add(2); bs.add(3);
    bs.clear();
    expect(bs.size).toBe(0);
    expect(bs.toArray()).toEqual([]);
    expect(bs.has(1)).toBe(false);
  });
});

// ===========================================================================
// SparseSet
// ===========================================================================
describe("SparseSet", () => {
  it("add/has/remove basic correctness", () => {
    const ss = new SparseSet();
    ss.add(7);
    expect(ss.has(7)).toBe(true);
    expect(ss.size).toBe(1);
    ss.remove(7);
    expect(ss.has(7)).toBe(false);
    expect(ss.size).toBe(0);
  });

  it("swap-remove keeps remaining elements intact and queryable", () => {
    const ss = new SparseSet();
    ss.add(1);
    ss.add(2);
    ss.add(3);
    ss.remove(1); // removes from the middle of dense array, triggers swap with last (3)
    expect(ss.has(1)).toBe(false);
    expect(ss.has(2)).toBe(true);
    expect(ss.has(3)).toBe(true);
    expect(ss.size).toBe(2);
    expect(new Set(ss.toArray())).toEqual(new Set([2, 3]));
  });

  it("adding a duplicate id is a no-op", () => {
    const ss = new SparseSet();
    ss.add(4);
    ss.add(4);
    expect(ss.size).toBe(1);
  });

  it("iterator matches toArray()", () => {
    const ss = new SparseSet();
    ss.add(9); ss.add(8); ss.add(7);
    expect([...ss]).toEqual(ss.toArray());
  });

  it("clear() empties the set", () => {
    const ss = new SparseSet();
    ss.add(1); ss.add(2);
    ss.clear();
    expect(ss.size).toBe(0);
    expect(ss.has(1)).toBe(false);
  });
});

// ===========================================================================
// Query (ArchetypeIndex-backed)
// ===========================================================================
describe("Query filtering semantics", () => {
  it("only returns entities whose archetype mask is a superset of the query mask", () => {
    const idx = new ArchetypeIndex();
    const eBoth = 1, eOnlyA = 2, eOnlyB = 3, eNeither = 4;
    for (const e of [eBoth, eOnlyA, eOnlyB, eNeither]) idx.addEntity(e);

    const A = 0b01n, B = 0b10n;
    idx.setMask(eBoth, A | B);
    idx.setMask(eOnlyA, A);
    idx.setMask(eOnlyB, B);
    // eNeither stays at mask 0

    const queryAB = new Query(idx, A | B);
    expect(new Set(queryAB.entities)).toEqual(new Set([eBoth]));

    const queryA = new Query(idx, A);
    expect(new Set(queryA.entities)).toEqual(new Set([eBoth, eOnlyA]));
  });

  it("reflects component additions and removals through World", () => {
    const Comp = defineComponent("QueryGapsComp", { v: "f32" });
    const world = new World();
    const e1 = world.createEntity();
    const e2 = world.createEntity();

    const q = world.query(Comp);
    expect(q.entities).toEqual([]);

    world.addComponent(e1, Comp, { v: 1 });
    expect(q.entities).toEqual([e1]);

    world.addComponent(e2, Comp, { v: 2 });
    expect(new Set(q.entities)).toEqual(new Set([e1, e2]));

    world.removeComponent(e1, Comp);
    expect(q.entities).toEqual([e2]);
  });

  it("destroyed entities drop out of matching queries", () => {
    const Comp = defineComponent("QueryGapsComp2", { v: "f32" });
    const world = new World();
    const e1 = world.createEntity();
    world.addComponent(e1, Comp, { v: 1 });
    const q = world.query(Comp);
    expect(q.entities).toEqual([e1]);

    world.destroyEntity(e1);
    expect(q.entities).toEqual([]);
  });

  it("multi-component query requires ALL components (AND semantics)", () => {
    const CompA = defineComponent("QueryGapsA", { v: "f32" });
    const CompB = defineComponent("QueryGapsB", { v: "f32" });
    const world = new World();
    const e1 = world.createEntity();
    const e2 = world.createEntity();
    world.addComponent(e1, CompA, { v: 1 });
    world.addComponent(e1, CompB, { v: 1 });
    world.addComponent(e2, CompA, { v: 1 }); // missing CompB

    const q = world.query(CompA, CompB);
    expect(q.entities).toEqual([e1]);
  });
});

// ===========================================================================
// ComponentStore (normal, non-upsert case)
// ===========================================================================
describe("ComponentStore", () => {
  it("add/get/has/remove basic lifecycle", () => {
    const def = defineComponent("CSGapsBasic", { x: "f32", y: "f32" });
    const store = new ComponentStore(def);
    expect(store.has(3)).toBe(false);

    store.add(3, { x: 1, y: 2 });
    expect(store.has(3)).toBe(true);
    expect(store.get(3, "x")).toBe(1);
    expect(store.get(3, "y")).toBe(2);

    store.remove(3);
    expect(store.has(3)).toBe(false);
    expect(store.get(3, "x")).toBe(0); // cleared on remove
  });

  it("set() updates a field on an existing row", () => {
    const def = defineComponent("CSGapsSet", { v: "f32" });
    const store = new ComponentStore(def);
    store.add(1, { v: 10 });
    store.set(1, "v", 99);
    expect(store.get(1, "v")).toBe(99);
  });

  it("bool fields coerce truthy/falsy values to 1/0", () => {
    const def = defineComponent("CSGapsBool", { flag: "bool" });
    const store = new ComponentStore(def);
    store.add(1, { flag: true });
    expect(store.get(1, "flag")).toBe(1);
    store.set(1, "flag", false);
    expect(store.get(1, "flag")).toBe(0);
  });

  it("ref fields store arbitrary objects and null them on remove", () => {
    const def = defineComponent("CSGapsRef", { payload: "ref" });
    const store = new ComponentStore(def);
    const obj = { hello: "world" };
    store.add(5, { payload: obj });
    expect(store.get(5, "payload")).toBe(obj);
    store.remove(5);
    expect(store.get(5, "payload")).toBe(null);
  });

  it("onAdd/onRemove callbacks fire and unsubscribe correctly", () => {
    const def = defineComponent("CSGapsCallbacks", { v: "f32" });
    const store = new ComponentStore(def);
    const addedIds: number[] = [];
    const removedIds: number[] = [];
    const unsubAdd = store.onAdd((eid) => addedIds.push(eid));
    store.onRemove((eid) => removedIds.push(eid));

    store.add(1, { v: 1 });
    expect(addedIds).toEqual([1]);

    unsubAdd();
    store.add(2, { v: 2 });
    expect(addedIds).toEqual([1]); // no longer receiving events

    store.remove(1);
    expect(removedIds).toEqual([1]);
  });

  it("grows storage transparently beyond the initial 256-entity capacity", () => {
    const def = defineComponent("CSGapsGrow", { v: "f32" });
    const store = new ComponentStore(def);
    const bigId = 1000; // well beyond INITIAL_CAPACITY (256)
    store.add(bigId, { v: 42 });
    expect(store.has(bigId)).toBe(true);
    expect(store.get(bigId, "v")).toBe(42);
  });
});

// ===========================================================================
// CommandBuffer (deferred ops flushed against a real World)
// ===========================================================================
describe("CommandBuffer", () => {
  it("spawn + addComponent via tempId resolves and flushes correctly", () => {
    const Comp = defineComponent("CmdBufGapsSpawn", { v: "f32" });
    const world = new World();
    const cmds = new CommandBuffer();

    const tempId = cmds.spawn();
    cmds.addComponent(tempId, Comp, { v: 7 });
    expect(cmds.pending).toBe(2);

    cmds.flush(world);
    expect(cmds.pending).toBe(0);

    const eid = cmds.resolveId(tempId);
    expect(eid).toBeDefined();
    expect(world.isAlive(eid!)).toBe(true);
    expect(world.hasComponent(eid!, Comp)).toBe(true);
    expect(world.getStore(Comp).get(eid!, "v")).toBe(7);
  });

  it("spawn with inline components works via spawn(...) args", () => {
    const Comp = defineComponent("CmdBufGapsInline", { v: "f32" });
    const world = new World();
    const cmds = new CommandBuffer();
    const tempId = cmds.spawn({ def: Comp, data: { v: 55 } });
    cmds.flush(world);
    const eid = cmds.resolveId(tempId)!;
    expect(world.getStore(Comp).get(eid, "v")).toBe(55);
  });

  it("despawn on a tempId spawned in the same flush batch destroys it", () => {
    const world = new World();
    const cmds = new CommandBuffer();
    const tempId = cmds.spawn();
    cmds.despawn(tempId);
    cmds.flush(world);
    const eid = cmds.resolveId(tempId)!;
    expect(world.isAlive(eid)).toBe(false);
  });

  it("removeComponent deferred against an existing entity flushes correctly", () => {
    const Comp = defineComponent("CmdBufGapsRemove", { v: "f32" });
    const world = new World();
    const eid = world.createEntity();
    world.addComponent(eid, Comp, { v: 1 });

    const cmds = new CommandBuffer();
    cmds.removeComponent(eid, Comp);
    cmds.flush(world);

    expect(world.hasComponent(eid, Comp)).toBe(false);
  });

  it("despawn on an existing (non-temp) entity id flushes correctly", () => {
    const world = new World();
    const eid = world.createEntity();
    const cmds = new CommandBuffer();
    cmds.despawn(eid);
    cmds.flush(world);
    expect(world.isAlive(eid)).toBe(false);
  });

  it("clear() drops pending commands without touching the world", () => {
    const world = new World();
    const cmds = new CommandBuffer();
    cmds.spawn();
    expect(cmds.pending).toBe(1);
    cmds.clear();
    expect(cmds.pending).toBe(0);
    cmds.flush(world);
    expect(world.entityCount).toBe(0);
  });
});

// ===========================================================================
// DeterministicMath — its OWN internal correctness
// ===========================================================================
describe("DeterministicMath internal correctness", () => {
  it("dsin/dcos approximate native Math.sin/cos", () => {
    for (const angle of [0, Math.PI / 6, Math.PI / 4, Math.PI / 2, Math.PI, 3.5, -1.2]) {
      expect(approx(dsin(angle), Math.sin(angle), 1e-3)).toBe(true);
      expect(approx(dcos(angle), Math.cos(angle), 1e-3)).toBe(true);
    }
  });

  it("dtan approximates native Math.tan away from asymptotes", () => {
    expect(approx(dtan(Math.PI / 4), Math.tan(Math.PI / 4), 1e-2)).toBe(true);
  });

  it("dsqrt approximates native Math.sqrt via Newton-Raphson", () => {
    for (const v of [0, 1, 2, 4, 9, 100, 0.25]) {
      expect(approx(dsqrt(v), Math.sqrt(v), 1e-6)).toBe(true);
    }
  });

  it("dsqrt of a negative number returns 0 (documented clamp behavior)", () => {
    expect(dsqrt(-5)).toBe(0);
  });

  it("datan2 approximates native Math.atan2 across quadrants", () => {
    // datan2's atanApprox() is a low-order polynomial (accurate near r=0, weakest near r=1,
    // i.e. the 45-degree diagonals) — worst-case error is ~0.06 rad there, so use a looser
    // tolerance than the table-based dsin/dcos.
    const cases: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 5], [5, 0], [0, 0]];
    for (const [y, x] of cases) {
      expect(approx(datan2(y, x), Math.atan2(y, x), 0.1)).toBe(true);
    }
  });

  it("dasin/dacos approximate native Math.asin/acos", () => {
    for (const v of [-1, -0.5, 0, 0.5, 1]) {
      expect(approx(dasin(v), Math.asin(v), 1e-3)).toBe(true);
      expect(approx(dacos(v), Math.acos(v), 1e-3)).toBe(true);
    }
  });

  it("dabs/dmin/dmax/dclamp/dlerp behave as expected", () => {
    expect(dabs(-5)).toBe(5);
    expect(dmin(3, 7)).toBe(3);
    expect(dmax(3, 7)).toBe(7);
    expect(dclamp(10, 0, 5)).toBe(5);
    expect(dclamp(-10, 0, 5)).toBe(0);
    expect(dlerp(0, 10, 0.5)).toBe(5);
  });

  it("dfloor/dceil/dround/dfrac/dsign behave as expected, including negatives", () => {
    expect(dfloor(1.9)).toBe(1);
    expect(dfloor(-1.1)).toBe(-2);
    expect(dceil(1.1)).toBe(2);
    expect(dceil(-1.9)).toBe(-1);
    expect(dround(1.5)).toBe(2);
    expect(approx(dfrac(3.75), 0.75)).toBe(true);
    expect(dsign(5)).toBe(1);
    expect(dsign(-5)).toBe(-1);
    expect(dsign(0)).toBe(0);
  });

  it("deulerToQuaternion / dquaternionToEuler are self-consistent round trip", () => {
    const rx = 0.3, ry = 0.6, rz = -0.2;
    const q = deulerToQuaternion(rx, ry, rz);
    const out = new Float32Array(3);
    dquaternionToEuler(q.x, q.y, q.z, q.w, out);
    // Round trip compounds dsin/dcos table error with datan2's polynomial-approximation error
    // (see the datan2 test above), so allow a slightly looser tolerance than a single dsin call.
    expect(approx(out[0], rx, 1e-2)).toBe(true);
    expect(approx(out[1], ry, 1e-2)).toBe(true);
    expect(approx(out[2], rz, 1e-2)).toBe(true);
  });

  it("SeededRNG is deterministic for a fixed seed and varies with a different seed", () => {
    const rngA1 = new SeededRNG(1234);
    const rngA2 = new SeededRNG(1234);
    const seqA1 = [rngA1.next(), rngA1.next(), rngA1.next()];
    const seqA2 = [rngA2.next(), rngA2.next(), rngA2.next()];
    expect(seqA1).toEqual(seqA2);

    const rngB = new SeededRNG(5678);
    const seqB = [rngB.next(), rngB.next(), rngB.next()];
    expect(seqB).not.toEqual(seqA1);

    for (const v of seqA1) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("SeededRNG.nextRange/nextInt stay within bounds", () => {
    const rng = new SeededRNG(42);
    for (let i = 0; i < 50; i++) {
      const r = rng.nextRange(10, 20);
      expect(r).toBeGreaterThanOrEqual(10);
      expect(r).toBeLessThan(20);
      const n = rng.nextInt(0, 5);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(5);
    }
  });

  // AUDIT: DeterministicMath is internally correct and self-consistent (verified above), but
  // Vec3.ts/Quat.ts/Mat4.ts never import or call into it — they call native Math.sin/cos/sqrt/
  // atan2 directly. Confirmed by scanning the actual math source files for any reference to
  // this module. This means "deterministic" trig/sqrt exists in the codebase but does not
  // influence any real math path an entity actually goes through — see DeterministicMath.ts.
  it("AUDIT: Vec3/Quat/Mat4 source never references DeterministicMath (wiring gap, not a correctness bug)", () => {
    const vec3Src = readFileSync(resolve(srcRoot, "core/math/Vec3.ts"), "utf-8");
    const quatSrc = readFileSync(resolve(srcRoot, "core/math/Quat.ts"), "utf-8");
    const mat4Src = readFileSync(resolve(srcRoot, "core/math/Mat4.ts"), "utf-8");

    expect(vec3Src).not.toMatch(/DeterministicMath|from ["'].*DeterministicMath["']/);
    expect(quatSrc).not.toMatch(/DeterministicMath|from ["'].*DeterministicMath["']/);
    expect(mat4Src).not.toMatch(/DeterministicMath|from ["'].*DeterministicMath["']/);
  });
});

// ===========================================================================
// MemoryBudget
// ===========================================================================
describe("MemoryBudget", () => {
  it("tracks allocation/deallocation usage per resource type and in total", () => {
    const budget = new MemoryBudget();
    budget.trackAllocation(ResourceType.Texture, 100);
    budget.trackAllocation(ResourceType.Mesh, 50);
    expect(budget.getUsage(ResourceType.Texture)).toBe(100);
    expect(budget.getUsage(ResourceType.Mesh)).toBe(50);
    expect(budget.totalUsage).toBe(150);

    budget.trackDeallocation(ResourceType.Texture, 40);
    expect(budget.getUsage(ResourceType.Texture)).toBe(60);
    expect(budget.totalUsage).toBe(110);
  });

  it("deallocation never drives usage below zero", () => {
    const budget = new MemoryBudget();
    budget.trackAllocation(ResourceType.Audio, 10);
    budget.trackDeallocation(ResourceType.Audio, 999);
    expect(budget.getUsage(ResourceType.Audio)).toBe(0);
    expect(budget.totalUsage).toBe(0);
  });

  it("isOverBudget reports true once a per-type or total budget is exceeded", () => {
    const budget = new MemoryBudget({ textures: 100, total: 1000 });
    expect(budget.isOverBudget(ResourceType.Texture)).toBe(false);
    budget.trackAllocation(ResourceType.Texture, 150);
    expect(budget.isOverBudget(ResourceType.Texture)).toBe(true);
    expect(budget.isOverBudget()).toBe(false); // total (1000) not exceeded yet

    budget.trackAllocation(ResourceType.Mesh, 900);
    expect(budget.isOverBudget()).toBe(true); // total now exceeded
  });

  it("getStats reports utilization relative to budget", () => {
    const budget = new MemoryBudget({ textures: 200 });
    budget.trackAllocation(ResourceType.Texture, 100);
    const stats = budget.getStats();
    const texStats = stats.find((s) => s.type === "Texture")!;
    expect(texStats.usage).toBe(100);
    expect(texStats.budget).toBe(200);
    expect(approx(texStats.utilization, 0.5)).toBe(true);
  });

  it("reset() zeroes all tracked usage", () => {
    const budget = new MemoryBudget();
    budget.trackAllocation(ResourceType.Texture, 100);
    budget.reset();
    expect(budget.getUsage(ResourceType.Texture)).toBe(0);
    expect(budget.totalUsage).toBe(0);
  });

  it("evictLRU frees least-recently-used entries and invokes eviction callbacks", () => {
    const budget = new MemoryBudget();
    const map = new HandleMap<string>();
    const h1 = map.alloc("tex1", ResourceType.Texture, 60);
    map.get(h1); // touch to update lastAccess
    const h2 = map.alloc("tex2", ResourceType.Texture, 60);
    budget.trackAllocation(ResourceType.Texture, 60);
    budget.trackAllocation(ResourceType.Texture, 60);

    const evictedHandles: Handle[] = [];
    budget.onEviction((h) => evictedHandles.push(h));

    const evicted = budget.evictLRU(map, ResourceType.Texture, 60);
    expect(evicted.length).toBeGreaterThan(0);
    expect(evictedHandles.length).toBe(evicted.length);
    expect(budget.getUsage(ResourceType.Texture)).toBeLessThan(120);
  });
});

// ===========================================================================
// EventJournal
// ===========================================================================
describe("EventJournal", () => {
  it("emit() queues; listeners only fire after flush()", () => {
    const journal = new EventJournal();
    const ev = defineEvent<number>("ej-basic");
    const received: number[] = [];
    journal.on(ev, (v) => received.push(v));

    journal.emit(ev, 42);
    expect(received).toEqual([]); // not dispatched yet
    journal.flush();
    expect(received).toEqual([42]);
  });

  it("listeners run in priority order (lower priority first)", () => {
    const journal = new EventJournal();
    const ev = defineEvent<void>("ej-priority");
    const order: string[] = [];
    journal.on(ev, () => order.push("late"), 10);
    journal.on(ev, () => order.push("early"), -10);
    journal.on(ev, () => order.push("mid"), 0);

    journal.emit(ev, undefined);
    journal.flush();
    expect(order).toEqual(["early", "mid", "late"]);
  });

  it("once() listeners fire exactly one time", () => {
    const journal = new EventJournal();
    const ev = defineEvent<void>("ej-once");
    let count = 0;
    journal.once(ev, () => { count++; });

    journal.emit(ev, undefined);
    journal.flush();
    journal.emit(ev, undefined);
    journal.flush();
    expect(count).toBe(1);
  });

  it("emitImmediate dispatches synchronously without a flush()", () => {
    const journal = new EventJournal();
    const ev = defineEvent<string>("ej-immediate");
    let received = "";
    journal.on(ev, (v) => { received = v; });
    journal.emitImmediate(ev, "now");
    expect(received).toBe("now");
  });

  // NOT one of the six audited bugs — found while writing this suite. Traced through
  // EventJournal.flush(): each while-loop iteration sets `this.swapQueue = []` before
  // dispatching a batch (so re-entrant emit() calls made during dispatch correctly land in
  // that fresh array), but immediately AFTER the dispatch loop it does
  // `batch.length = 0; this.swapQueue = batch;` — clobbering `this.swapQueue` with the
  // now-emptied `batch` array instead of keeping the array that just received the re-entrant
  // events. Those events are silently discarded rather than processed later in the same
  // flush() (or even a subsequent one). Flag this as an unexpected finding beyond the audit.
  it("re-entrant emit() during flush() is still drained within the same flush() call", () => {
    const journal = new EventJournal();
    const evA = defineEvent<void>("ej-reentrant-a");
    const evB = defineEvent<void>("ej-reentrant-b");
    let bFired = false;

    journal.on(evA, () => {
      journal.emit(evB, undefined); // emitted WHILE flushing
    });
    journal.on(evB, () => { bFired = true; });

    journal.emit(evA, undefined);
    journal.flush();
    expect(bFired).toBe(true);
  });

  it("unsubscribe function returned by on() removes the listener", () => {
    const journal = new EventJournal();
    const ev = defineEvent<void>("ej-unsub");
    let count = 0;
    const unsub = journal.on(ev, () => { count++; });
    journal.emit(ev, undefined);
    journal.flush();
    unsub();
    journal.emit(ev, undefined);
    journal.flush();
    expect(count).toBe(1);
  });

  it("a throwing listener does not prevent other listeners from running", () => {
    const journal = new EventJournal();
    const ev = defineEvent<void>("ej-throw");
    let secondRan = false;
    journal.on(ev, () => { throw new Error("boom"); });
    journal.on(ev, () => { secondRan = true; });

    const origError = console.error;
    console.error = () => {};
    journal.emit(ev, undefined);
    journal.flush();
    console.error = origError;

    expect(secondRan).toBe(true);
  });

  it("journal records emitted events only when enabled, and can be queried/cleared", () => {
    const journal = new EventJournal();
    const ev = defineEvent<number>("ej-record");
    journal.on(ev, () => {});

    journal.emit(ev, 1); // journaling disabled -> not recorded
    journal.flush();
    expect(journal.getJournal().length).toBe(0);

    journal.enableJournal(true);
    journal.emit(ev, 2);
    journal.flush();
    expect(journal.getJournal().length).toBe(1);
    expect(journal.getJournalForEvent(ev.id).length).toBe(1);

    journal.clearJournal();
    expect(journal.getJournal().length).toBe(0);
  });

  it("advanceFrame()/frame track the current frame counter, stamped onto queued events", () => {
    const journal = new EventJournal();
    const ev = defineEvent<void>("ej-frame");
    journal.enableJournal(true);
    journal.on(ev, () => {});

    expect(journal.frame).toBe(0);
    journal.emit(ev, undefined);
    journal.advanceFrame();
    journal.emit(ev, undefined);
    journal.flush();

    const recorded = journal.getJournalForEvent(ev.id);
    expect(recorded[0].frame).toBe(0);
    expect(recorded[1].frame).toBe(1);
  });

  it("pendingCount reflects queued-but-not-flushed events", () => {
    const journal = new EventJournal();
    const ev = defineEvent<void>("ej-pending");
    expect(journal.pendingCount).toBe(0);
    journal.emit(ev, undefined);
    expect(journal.pendingCount).toBe(1);
    journal.flush();
    expect(journal.pendingCount).toBe(0);
  });
});

// ===========================================================================
// AUDIT (bug #6): ArchetypeIndex's global version counter
// ===========================================================================
describe("AUDIT (bug #6): ArchetypeIndex query-match cache uses one global version", () => {
  it("archetype churn on an entity UNRELATED to a query's mask still bumps the shared version", () => {
    const idx = new ArchetypeIndex();
    const eX = 1, eY = 2;
    idx.addEntity(eX);
    idx.addEntity(eY);

    const maskY = 0b01n; // query only cares about this bit
    idx.setMask(eY, maskY);

    const queryY = new Query(idx, maskY);
    expect(queryY.entities).toEqual([eY]); // primes the query's cache at the current version
    const versionAfterPriming = idx.version;

    // Churn eX's archetype with a completely different bit — has nothing to do with queryY.
    idx.setMask(eX, 0b10n);

    // AUDIT: setMask() bumps ONE shared `_version` counter regardless of which bits changed
    // (see ArchetypeIndex.ts `this._version++` in setMask/addEntity/removeEntity), so any
    // query anywhere is forced to rebuild its full match list on the next access even when the
    // churn was entirely unrelated to that query's component mask. This assertion documents
    // the gap by expecting the version to stay put for unrelated churn — it does not.
    expect(idx.version).toBe(versionAfterPriming);
  });
});

// ===========================================================================
// AUDIT (bug #4): ComponentStore.add() silent no-op on existing component
// ===========================================================================
describe("AUDIT (bug #4): ComponentStore.add() is not a usable upsert", () => {
  it("calling add() a second time with different data does not overwrite the first", () => {
    const def = defineComponent("AuditUpsertGap", { value: "f32" });
    const store = new ComponentStore(def);
    store.add(5, { value: 1 });
    store.add(5, { value: 2 }); // AUDIT: ComponentStore.ts add() returns early via `if (this.entities.has(entityId)) return;`
    // before writing any of the new `data` — silently drops the second call's payload.
    expect(store.get(5, "value")).toBe(2);
  });
});

// ===========================================================================
// AUDIT (bug #2): Parent.entity has no generation guard and no destroy cleanup
// ===========================================================================
describe("AUDIT (bug #2): HierarchyComponents Parent.entity is a raw, unguarded id", () => {
  it("Parent schema carries no generation alongside the raw entity id", () => {
    // AUDIT: HierarchyComponents.ts:17-19 — `Parent` only stores `entity: "i32"`, a raw
    // recycled entity id, with no paired generation field to detect staleness.
    expect(Object.keys(Parent.schema)).toContain("entityGeneration");
  });

  it("destroying a parent leaves the child's Parent component pointing at a since-recycled id, uncleaned", () => {
    const world = new World();
    const parent = world.createEntity();
    const child = world.createEntity();
    world.addComponent(child, Parent, { entity: parent });

    world.destroyEntity(parent);

    // Recycling is LIFO (World.recycled is a stack), so the very next createEntity() reuses
    // `parent`'s old id — but loop defensively in case that ever changes, per the audit brief.
    let reusedId = -1;
    for (let i = 0; i < 16; i++) {
      const e = world.createEntity();
      if (e === parent) { reusedId = e; break; }
    }
    expect(reusedId).toBe(parent); // sanity check that recycling actually happened

    // AUDIT: nothing hooks world.onEntityDestroy() to clear or invalidate `child`'s Parent
    // component when `parent` is destroyed (see HierarchyComponents.ts / TransformHierarchySystem.ts
    // — neither registers a destroy callback for this). The component silently survives,
    // still holding the raw, now-recycled id, and the generation has moved on with no way for
    // a reader to detect that.
    expect(world.hasComponent(child, Parent)).toBe(false);
  });

  it("destroying one parent only cleans up its own children, leaving unrelated parents' children untouched (reverse-index correctness)", () => {
    // World.cleanupDanglingParentRefs now looks children up via a childrenByParent reverse
    // index instead of scanning every entity with a Parent component on every destroy —
    // this exercises that the index stays correctly scoped per-parent across multiple
    // independent hierarchies.
    const world = new World();
    const parentA = world.createEntity();
    const parentB = world.createEntity();
    const childA1 = world.createEntity();
    const childA2 = world.createEntity();
    const childB1 = world.createEntity();
    world.addComponent(childA1, Parent, { entity: parentA });
    world.addComponent(childA2, Parent, { entity: parentA });
    world.addComponent(childB1, Parent, { entity: parentB });

    world.destroyEntity(parentA);

    expect(world.hasComponent(childA1, Parent)).toBe(false);
    expect(world.hasComponent(childA2, Parent)).toBe(false);
    expect(world.hasComponent(childB1, Parent)).toBe(true);
    expect(world.getStore(Parent).get(childB1, "entity")).toBe(parentB);
  });

  it("removeComponent/hasComponent no-op consistently for a destroyed entity id, matching addComponent's existing isAlive guard", () => {
    const Comp = defineComponent("AuditIsAliveConsistency", { v: "f32" });
    const world = new World();
    const eid = world.createEntity();
    world.addComponent(eid, Comp, { v: 1 });
    world.destroyEntity(eid);

    expect(world.hasComponent(eid, Comp)).toBe(false);
    expect(() => world.removeComponent(eid, Comp)).not.toThrow();
    expect(world.hasComponent(eid, Comp)).toBe(false);
  });
});

// ===========================================================================
// AUDIT (bug #5): SpatialHash cell-key collisions pollute spatial queries
// ===========================================================================
describe("AUDIT (bug #5): SpatialHash (cx,cz) key collisions leak unrelated entities", () => {
  it("two far-apart cells that hash-collide both land in the same bucket", () => {
    const grid = new SpatialHash(16);

    // Brute-forced offline against SpatialHash's own hash(cx,cz) = ((cx*92837111) ^ (cz*689287499)) >>> 0:
    // cell (-387, 48) and cell (-374, -25) collide to the same 32-bit key, despite being
    // ~1186 world units apart (cellSize=16) — nowhere near each other.
    const posA = { x: -387 * 16, z: 48 * 16 };
    const posB = { x: -374 * 16, z: -25 * 16 };

    grid.insert(1, posA.x, posA.z);
    grid.insert(2, posB.x, posB.z);

    // AUDIT: SpatialHash.ts's hash() XORs two 32-bit products with no collision-resolution
    // (no secondary check, no chaining by actual (cx,cz), no downstream distance re-verification
    // in queryRadius/queryAABB), so a narrow-radius query around entity 1's real position wrongly
    // pulls in entity 2 purely because they share a hash bucket.
    const results = grid.queryRadius(posA.x, posA.z, 5);
    expect(results).toContain(1);
    expect(results).not.toContain(2);
  });

  it("queryAABB around only cell A's bounds is similarly polluted by the colliding cell B", () => {
    const grid = new SpatialHash(16);
    const posA = { x: -387 * 16, z: 48 * 16 };
    const posB = { x: -374 * 16, z: -25 * 16 };
    grid.insert(10, posA.x, posA.z);
    grid.insert(20, posB.x, posB.z);

    const results = grid.queryAABB(posA.x - 1, posA.z - 1, posA.x + 1, posA.z + 1);
    expect(results).toContain(10);
    expect(results).not.toContain(20);
  });
});
