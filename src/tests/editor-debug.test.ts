// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";

import { EditorOverlay } from "../editor/EditorOverlay";
import { DebugInspector } from "../systems/debug/DebugInspector";
import { DebugOverlay } from "../systems/debug/DebugOverlay";
import { DevConsole } from "../systems/debug/DevConsole";
import { AIDebugPanel } from "../ai/AIDebugPanel";
import { Blackboard } from "../ai/BehaviorTree";
import { World } from "../ecs";
import { Transform } from "../core/Components";

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// EditorOverlay — editor-only scene inspector. Exercised with a minimal fake
// `AGEE` engine object exposing just the surface EditorOverlay actually reads
// (profiler, debugOverlay, events, world). One smoke test is enough here: the
// class wires up a fair amount of DOM, but its logic is a thin render loop
// over World.query(Transform).
// ---------------------------------------------------------------------------

describe("EditorOverlay", () => {
  function makeFakeEngine() {
    const world = new World();
    let preUpdateCb: ((dt: number) => void) | null = null;
    const engine = {
      world,
      profiler: { setEnabled: vi.fn() },
      debugOverlay: { show: vi.fn(), toggle: vi.fn() },
      events: {
        on: vi.fn((event: string, cb: (dt: number) => void) => {
          if (event === "preUpdate") preUpdateCb = cb;
          return () => {};
        }),
      },
    } as any;
    return { engine, world, tick: (dt: number) => preUpdateCb?.(dt) };
  }

  it("init() builds the inspector panel and lists live entities once ticked", () => {
    const { engine, world, tick } = makeFakeEngine();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 1, y: 2, z: 3, sx: 1, sy: 1, sz: 1 });

    const overlay = EditorOverlay.init(engine);
    expect(overlay).toBeInstanceOf(EditorOverlay);

    const root = document.getElementById("agee-editor-inspector");
    expect(root).not.toBeNull();
    expect(engine.profiler.setEnabled).toHaveBeenCalledWith(true);
    expect(engine.debugOverlay.show).toHaveBeenCalled();

    // Drive the render loop past its refresh interval (0.5s) directly.
    tick(0.6);

    expect(root!.textContent).toContain("1 entities");
    expect(root!.textContent).toContain(`#${eid}`);
  });

  it("pressing 'i' toggles panel visibility", () => {
    const { engine } = makeFakeEngine();
    EditorOverlay.init(engine);
    const root = document.getElementById("agee-editor-inspector")!;
    expect(root.style.display).not.toBe("none");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "i" }));
    expect(root.style.display).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// DebugInspector
// ---------------------------------------------------------------------------

describe("DebugInspector", () => {
  function makeInspector() {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    const world = new World();
    const inspector = new DebugInspector();
    world.addSystem(inspector);
    inspector.registerComponents(Transform);
    return { world, inspector };
  }

  it("toggle() creates and shows the panel inside #ui-overlay", () => {
    const { inspector } = makeInspector();
    inspector.toggle();

    const panel = document.getElementById("debug-inspector");
    expect(panel).not.toBeNull();
    expect(document.getElementById("ui-overlay")!.contains(panel)).toBe(true);
    expect(panel!.style.display).not.toBe("none");
  });

  it("toggle() twice hides the panel without destroying it", () => {
    const { inspector } = makeInspector();
    inspector.toggle();
    inspector.toggle();
    const panel = document.getElementById("debug-inspector")!;
    expect(panel.style.display).toBe("none");
  });

  it("selectEntity() renders the entity's registered component fields", () => {
    const { world, inspector } = makeInspector();
    inspector.toggle();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 1.5, y: 2, z: 0, sx: 1, sy: 1, sz: 1 });

    inspector.selectEntity(eid);

    const panel = document.getElementById("debug-inspector")!;
    expect(panel.textContent).toContain(`Entity #${eid}`);
    expect(panel.textContent).toContain("Transform");
    expect(panel.textContent).toContain("1.500");
  });

  it("selectEntity() with no matching registered components shows the empty-state message", () => {
    const { world, inspector } = makeInspector();
    inspector.toggle();
    const eid = world.createEntity(); // no components at all

    inspector.selectEntity(eid);

    const panel = document.getElementById("debug-inspector")!;
    expect(panel.textContent).toContain("No registered components found");
  });

  it("update() only refreshes the panel while visible with a selection, throttled by refreshInterval", () => {
    const { world, inspector } = makeInspector();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 1, y: 1, z: 1, sx: 1, sy: 1, sz: 1 });

    // Not visible yet: update() must not create a panel.
    inspector.update(1);
    expect(document.getElementById("debug-inspector")).toBeNull();

    inspector.toggle();
    inspector.selectEntity(eid);
    const panel = document.getElementById("debug-inspector")!;
    const before = panel.innerHTML;

    world.getStore(Transform).set(eid, "x", 42);
    inspector.update(0.05); // below the 0.1s refresh interval -> no refresh yet
    expect(panel.innerHTML).toBe(before);

    inspector.update(0.2); // crosses the interval -> refresh happens
    expect(panel.innerHTML).toContain("42.000");
  });
});

// ---------------------------------------------------------------------------
// DebugOverlay
// ---------------------------------------------------------------------------

describe("DebugOverlay", () => {
  class FakeCtx2D {
    fillStyle = "";
    strokeStyle = "";
    lineWidth = 1;
    clearRect() {}
    fillRect() {}
    beginPath() {}
    moveTo() {}
    lineTo() {}
    stroke() {}
    setLineDash() {}
  }

  function makeOverlay() {
    // jsdom's canvas has no real 2D context without the optional "canvas"
    // package; stub getContext so init()/update() can exercise the real
    // drawGraph() path instead of silently no-op'ing on a null context.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(new FakeCtx2D() as any);
    const world = new World();
    const overlay = new DebugOverlay();
    world.addSystem(overlay);
    return { overlay };
  }

  it("init() creates a hidden container with a stats <pre> and a graph canvas", () => {
    const { overlay } = makeOverlay();
    const container = document.getElementById("debug-overlay")!;
    expect(container).not.toBeNull();
    expect(container.style.display).toBe("none");
    overlay.show();
    expect(container.style.display).toBe("block");
  });

  it("toggle() flips visibility state", () => {
    const { overlay } = makeOverlay();
    const container = document.getElementById("debug-overlay")!;
    overlay.toggle();
    expect(container.style.display).toBe("block");
    overlay.toggle();
    expect(container.style.display).toBe("none");
  });

  it("update() is a no-op while hidden or without a profiler", () => {
    const { overlay } = makeOverlay();
    expect(() => overlay.update(0.5)).not.toThrow();
  });

  it("update() renders formatted stats once visible with an enabled profiler", () => {
    const { overlay } = makeOverlay();
    overlay.show();
    const stats = {
      frameTime: 16.2, fps: 61.5, systemTimes: new Map([["Physics", 3.2], ["Render", 5.1]]),
      entityCount: 12500, visibleCount: 300, culledCount: 50, drawCalls: 120, triangles: 45000,
      textureCount: 10, geometryCount: 5, physicsBodyCount: 20, activeParticles: 200,
      assetCount: 30, vramEstimate: 128.4,
    };
    const profiler = {
      isEnabled: () => true,
      getLatest: () => stats,
      getHistory: () => [{ frameTime: 16 }, { frameTime: 20 }],
    };
    overlay.setProfiler(profiler as any);

    overlay.update(0.2); // exceeds the 0.1s updateInterval

    const statsText = document.querySelector("#debug-overlay pre")!.innerHTML;
    expect(statsText).toContain("Entities: 12.5K");
    expect(statsText).toContain("--- Systems ---");
  });

  it("destroy() removes the container from the DOM", () => {
    const { overlay } = makeOverlay();
    overlay.destroy();
    expect(document.getElementById("debug-overlay")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DevConsole
// ---------------------------------------------------------------------------

describe("DevConsole", () => {
  function makeConsole() {
    const world = new World();
    const devConsole = new DevConsole();
    world.addSystem(devConsole);
    return { world, devConsole };
  }

  it("init() builds a hidden console UI attached to the document body", () => {
    const { devConsole } = makeConsole();
    const container = document.getElementById("dev-console")!;
    expect(container).not.toBeNull();
    expect(container.style.display).toBe("none");
    expect(devConsole.isOpen).toBe(false);
  });

  it("toggle()/show()/hide() control visibility", () => {
    const { devConsole } = makeConsole();
    devConsole.show();
    expect(devConsole.isOpen).toBe(true);
    expect(document.getElementById("dev-console")!.style.display).toBe("flex");

    devConsole.hide();
    expect(devConsole.isOpen).toBe(false);
    expect(document.getElementById("dev-console")!.style.display).toBe("none");
  });

  it("the backtick key toggles the console open", () => {
    const { devConsole } = makeConsole();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "`" }));
    expect(devConsole.isOpen).toBe(true);
  });

  it("execute() runs a registered command and logs its output", () => {
    const { devConsole } = makeConsole();
    devConsole.registerCommand("ping", () => "pong");

    devConsole.execute("ping");

    const output = document.querySelector("#dev-console")!.textContent!;
    expect(output).toContain("pong");
  });

  it("execute() logs an error message for an unknown command", () => {
    const { devConsole } = makeConsole();
    devConsole.execute("does-not-exist");
    const output = document.querySelector("#dev-console")!.textContent!;
    expect(output).toContain("Unknown command: does-not-exist");
  });

  it("built-in 'entities' command reports the world's live entity count", () => {
    const { world, devConsole } = makeConsole();
    world.createEntity();
    world.createEntity();

    devConsole.execute("entities");

    const output = document.querySelector("#dev-console")!.textContent!;
    expect(output).toContain("Total entities: 2");
  });

  it("built-in 'enable'/'disable' commands toggle a system's enabled flag by class name", () => {
    const { world, devConsole } = makeConsole();
    devConsole.execute("disable DevConsole");
    expect(world.getSystems().find((s) => s.constructor.name === "DevConsole")!.enabled).toBe(false);

    devConsole.execute("enable DevConsole");
    expect(world.getSystems().find((s) => s.constructor.name === "DevConsole")!.enabled).toBe(true);
  });

  it("unregisterCommand() makes the command unknown again", () => {
    const { devConsole } = makeConsole();
    devConsole.registerCommand("temp", () => "ok");
    devConsole.unregisterCommand("temp");

    devConsole.execute("temp");

    const output = document.querySelector("#dev-console")!.textContent!;
    expect(output).toContain("Unknown command: temp");
  });

  it("destroy() removes the console container from the DOM", () => {
    const { devConsole } = makeConsole();
    devConsole.destroy();
    expect(document.getElementById("dev-console")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AIDebugPanel — AUDIT (fixed): renderBlackboard() interpolated arbitrary blackboard
// values/keys straight into an innerHTML string with no escaping. A blackboard is a plain
// `Map<string, any>` any AI/game code can write into at runtime (not a typed ECS component
// field), so a string value sourced from untrusted input (chat text, a player display name,
// etc.) could inject live markup into the debug panel. Same issue for FSM/Utility/GOAP name
// strings, fixed the same way.
// ---------------------------------------------------------------------------

describe("AIDebugPanel", () => {
  function makePanel() {
    const world = new World();
    const panel = new AIDebugPanel();
    world.addSystem(panel);
    panel.show();
    return { world, panel };
  }

  it("escapes blackboard string values before interpolating them into the panel's innerHTML", () => {
    const { panel } = makePanel();
    const bb = new Blackboard();
    bb.set("lastMessage", '<img src=x onerror="window.__pwned = true">');
    panel.track(1, "goblin", { blackboard: bb });

    panel.update(1); // > refreshRate, forces a refresh

    const content = document.getElementById("ai-debug-content")!;
    expect(content.innerHTML).not.toContain("<img");
    expect(content.innerHTML).toContain("&lt;img");
    expect(content.querySelector("img")).toBeNull();
  });

  it("escapes blackboard keys the same way", () => {
    const { panel } = makePanel();
    const bb = new Blackboard();
    bb.set('"><script>window.__pwned = true</script>', "value");
    panel.track(2, "goblin", { blackboard: bb });

    panel.update(1);

    const content = document.getElementById("ai-debug-content")!;
    expect(content.querySelector("script")).toBeNull();
  });
});
