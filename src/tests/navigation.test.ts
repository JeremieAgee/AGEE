import { describe, it, expect } from "vitest";

import { World } from "../ecs/World";
import { Transform } from "../core/Components";
import { NavigationSystem, NavAgent } from "../navigation/NavigationSystem";
import { BinaryHeap } from "../navigation/BinaryHeap";

describe("BinaryHeap", () => {
  it("pop always returns the minimum score (basic min-heap ordering)", () => {
    const heap = new BinaryHeap(16);
    heap.push(0, 5);
    heap.push(1, 2);
    heap.push(2, 8);
    heap.push(3, 1);
    heap.push(4, 4);

    const order: number[] = [];
    while (heap.length > 0) order.push(heap.pop());

    expect(order).toEqual([3, 1, 4, 0, 2]);
  });

  it("length tracks size through push/pop", () => {
    const heap = new BinaryHeap(4);
    expect(heap.length).toBe(0);
    heap.push(0, 1);
    heap.push(1, 2);
    expect(heap.length).toBe(2);
    heap.pop();
    expect(heap.length).toBe(1);
  });

  it("pop on empty heap returns -1", () => {
    const heap = new BinaryHeap(4);
    expect(heap.pop()).toBe(-1);
  });

  it("contains reflects membership correctly", () => {
    const heap = new BinaryHeap(8);
    heap.push(3, 10);
    expect(heap.contains(3)).toBe(true);
    expect(heap.contains(5)).toBe(false);
    heap.pop();
    expect(heap.contains(3)).toBe(false);
  });

  it("decreaseKey reorders so the updated element pops first", () => {
    const heap = new BinaryHeap(8);
    heap.push(0, 10);
    heap.push(1, 20);
    heap.push(2, 30);

    // Element 2 currently has the worst (highest) score; decrease it below everything else.
    heap.decreaseKey(2, 1);
    expect(heap.pop()).toBe(2);
  });

  it("decreaseKey on a value not in the heap is a no-op", () => {
    const heap = new BinaryHeap(8);
    heap.push(0, 5);
    heap.decreaseKey(1, 0); // value 1 was never pushed
    expect(heap.pop()).toBe(0);
  });

  it("clear empties the heap and resets containment", () => {
    const heap = new BinaryHeap(8);
    heap.push(0, 1);
    heap.push(1, 2);
    heap.clear();
    expect(heap.length).toBe(0);
    expect(heap.contains(0)).toBe(false);
    expect(heap.contains(1)).toBe(false);
  });

  it("handles many pushes with duplicate/interleaved scores correctly", () => {
    const heap = new BinaryHeap(64);
    const values = [5, 3, 8, 1, 9, 2, 7, 4, 6, 0, 3, 8];
    for (let i = 0; i < values.length; i++) heap.push(i, values[i]);

    const poppedScores: number[] = [];
    while (heap.length > 0) {
      const v = heap.pop();
      poppedScores.push(values[v]);
    }
    const sorted = [...values].sort((a, b) => a - b);
    expect(poppedScores).toEqual(sorted);
  });
});

describe("NavigationSystem — A* pathfinding", () => {
  function makeNav(width: number, depth: number, cellSize = 1): { world: World; nav: NavigationSystem } {
    const world = new World();
    const nav = new NavigationSystem();
    world.addSystem(nav);
    nav.createGrid(width, depth, cellSize);
    return { world, nav };
  }

  it("finds a direct diagonal-ish path on an open grid", () => {
    const { nav } = makeNav(10, 10);
    const handle = nav.findPath(0.5, 0.5, 9.5, 9.5);
    expect(handle).toBeGreaterThanOrEqual(0);
  });

  it("returns -1 when the destination cell is not walkable", () => {
    const { nav } = makeNav(5, 5);
    nav.setWalkable(4, 4, false);
    const handle = nav.findPath(0.5, 0.5, 4.5, 4.5);
    expect(handle).toBe(-1);
  });

  it("returns -1 when the start/end coordinates are outside the grid", () => {
    const { nav } = makeNav(5, 5);
    expect(nav.findPath(-10, -10, 2, 2)).toBe(-1);
    expect(nav.findPath(2, 2, 100, 100)).toBe(-1);
  });

  it("routes around an impassable wall through the one open gap", () => {
    const { nav } = makeNav(7, 7);
    // Build a solid wall across x=3 for all z, except leave z=3 open as the only gap.
    for (let z = 0; z < 7; z++) {
      if (z === 3) continue;
      nav.setWalkable(3, z, false);
    }

    const handle = nav.findPath(0.5, 0.5, 6.5, 0.5);
    expect(handle).toBeGreaterThanOrEqual(0);

    // Reconstruct the path's waypoints and confirm it actually passes through the gap
    // column (x=3) at z close to 3 — i.e. it didn't cheat through a wall.
    const path = (nav as unknown as { pathData: Float32Array; pathLengths: Int32Array });
    const stride = 128 * 3; // MAX_PATH_NODES * 3, mirrors PATH_STRIDE in NavigationSystem.ts
    const len = path.pathLengths[handle];
    expect(len).toBeGreaterThan(0);

    let passedThroughGap = false;
    for (let i = 0; i < len; i++) {
      const px = path.pathData[handle * stride + i * 3];
      const pz = path.pathData[handle * stride + i * 3 + 2];
      const gridX = Math.floor(px);
      const gridZ = Math.floor(pz);
      if (gridX === 3 && gridZ === 3) passedThroughGap = true;
      if (gridX === 3 && gridZ !== 3) {
        throw new Error(`Path crossed the wall at non-gap cell z=${gridZ}`);
      }
    }
    expect(passedThroughGap).toBe(true);
  });

  it("returns -1 when completely walled off with no gap", () => {
    const { nav } = makeNav(7, 7);
    for (let z = 0; z < 7; z++) nav.setWalkable(3, z, false);

    const handle = nav.findPath(0.5, 0.5, 6.5, 0.5);
    expect(handle).toBe(-1);
  });

  it("start === end resolves to a trivial single/zero-length path, not a failure", () => {
    const { nav } = makeNav(5, 5);
    const handle = nav.findPath(2.5, 2.5, 2.5, 2.5);
    expect(handle).toBeGreaterThanOrEqual(0);
  });
});

describe("NavigationSystem — NavAgent movement", () => {
  it("moves an agent toward its target and clears hasTarget on arrival", () => {
    const world = new World();
    const nav = new NavigationSystem();
    world.addSystem(nav);
    nav.createGrid(20, 20, 1);

    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0.5, y: 0, z: 0.5, sx: 1, sy: 1, sz: 1 });
    world.addComponent(eid, NavAgent, {
      speed: 5, stoppingDistance: 0.2, targetX: 0, targetY: 0, targetZ: 0,
      hasTarget: 0, pathHandle: -1, pathIndex: 0, pathLength: 0,
    });

    nav.setTarget(eid, 10.5, 0, 0.5);

    const navStore = world.getStore(NavAgent);
    expect(navStore.get(eid, "hasTarget")).toBe(1);

    for (let i = 0; i < 600 && navStore.get(eid, "hasTarget") === 1; i++) {
      world.update(1 / 60);
    }

    expect(navStore.get(eid, "hasTarget")).toBe(0);
    const transformStore = world.getStore(Transform);
    expect(transformStore.get(eid, "x")).toBeGreaterThan(9);
  });

  it("setTarget with an unreachable destination leaves hasTarget false", () => {
    const world = new World();
    const nav = new NavigationSystem();
    world.addSystem(nav);
    nav.createGrid(5, 5, 1);
    nav.setWalkable(4, 4, false);

    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0.5, y: 0, z: 0.5, sx: 1, sy: 1, sz: 1 });
    world.addComponent(eid, NavAgent, {
      speed: 5, stoppingDistance: 0.2, targetX: 0, targetY: 0, targetZ: 0,
      hasTarget: 0, pathHandle: -1, pathIndex: 0, pathLength: 0,
    });

    nav.setTarget(eid, 4.5, 0, 4.5);

    const navStore = world.getStore(NavAgent);
    expect(navStore.get(eid, "hasTarget")).toBe(0);
  });

  it("agent facing (ry) turns to face its direction of travel", () => {
    const world = new World();
    const nav = new NavigationSystem();
    world.addSystem(nav);
    nav.createGrid(10, 10, 1);

    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0.5, y: 0, z: 0.5, ry: 0, sx: 1, sy: 1, sz: 1 });
    world.addComponent(eid, NavAgent, {
      speed: 3, stoppingDistance: 0.1, targetX: 0, targetY: 0, targetZ: 0,
      hasTarget: 0, pathHandle: -1, pathIndex: 0, pathLength: 0,
    });

    nav.setTarget(eid, 8.5, 0, 0.5);
    // The first waypoint in a freshly found path is the agent's own starting cell (findPath
    // includes the start node), so the first tick or two just consumes that trivial waypoint
    // without any actual movement/heading change — run enough ticks to reach a real one.
    for (let i = 0; i < 10; i++) world.update(1 / 60);

    const transformStore = world.getStore(Transform);
    // Moving purely in +X should orient ry away from the initial 0.
    expect(transformStore.get(eid, "ry")).not.toBe(0);
  });
});
