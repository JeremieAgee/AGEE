// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";

import { Panel, Label, Button, ProgressBar, Widget } from "../ui/Widget";
import { UIManager, WorldUI } from "../ui/UIManager";
import { UISystem } from "../ui/UISystem";
import { InputSystem } from "../input/InputSystem";
import { InputActions } from "../input/InputActions";
import { World } from "../ecs";
import { Transform } from "../core/Components";

beforeEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Widget / Panel / Label / Button / ProgressBar
// ---------------------------------------------------------------------------

describe("Widget", () => {
  it("mount() creates the backing element, assigns its id, and applies style", () => {
    const panel = new Panel("hud", { width: 200, height: "50%", backgroundColor: "red" });
    panel.mount(document.body);

    expect(panel.element.id).toBe("ui-hud");
    expect(panel.element.style.width).toBe("200px");
    expect(panel.element.style.height).toBe("50%");
    expect(panel.element.style.backgroundColor).toBe("red");
    expect(document.body.contains(panel.element)).toBe(true);
  });

  it("addChild() nests the child element under the parent once mounted", () => {
    const root = new Panel("root");
    const label = new Label("title", "Hello");
    root.addChild(label);
    root.mount(document.body);

    expect(label.parent).toBe(root);
    expect(root.element.contains(label.element)).toBe(true);
    expect(label.element.textContent).toBe("Hello");
  });

  it("removeChild() detaches the child from both the tree and the DOM", () => {
    const root = new Panel("root");
    const label = new Label("title", "Hello");
    root.addChild(label);
    root.mount(document.body);

    root.removeChild(label);

    expect(root.children).not.toContain(label);
    expect(label.parent).toBeNull();
    expect(root.element.contains(label.element)).toBe(false);
  });

  it("unmount() removes the element and recurses into children", () => {
    const root = new Panel("root");
    const label = new Label("title", "Hello");
    root.addChild(label);
    root.mount(document.body);

    root.unmount();

    expect(document.body.contains(root.element)).toBe(false);
    expect(document.body.contains(label.element)).toBe(false);
  });

  it("Button.on('click') fires when the underlying <button> is clicked", () => {
    const button = new Button("go", "Go");
    button.mount(document.body);
    let clicked = false;
    button.on("click", () => { clicked = true; });

    button.element.dispatchEvent(new Event("click", { bubbles: true }));

    expect(clicked).toBe(true);
  });

  it("setVisible(false) hides the element via display:none; true restores it", () => {
    const label = new Label("l", "x");
    label.mount(document.body);

    label.setVisible(false);
    expect(label.element.style.display).toBe("none");

    label.setVisible(true);
    expect(label.element.style.display).toBe("");
  });

  it("flexDirection/justifyContent/alignItems are translated to CSS flex values", () => {
    const panel = new Panel("flexy", {
      flexDirection: "row",
      justifyContent: "between",
      alignItems: "center",
    });
    panel.mount(document.body);

    expect(panel.element.style.display).toBe("flex");
    expect(panel.element.style.flexDirection).toBe("row");
    expect(panel.element.style.justifyContent).toBe("space-between");
    expect(panel.element.style.alignItems).toBe("center");
  });

  it("ProgressBar.setValue() clamps to [0, max] and sizes the inner bar accordingly", () => {
    const bar = new ProgressBar("hp", 50, 100);
    bar.mount(document.body);
    const barEl = bar.element.firstElementChild as HTMLElement;
    expect(barEl.style.width).toBe("50%");

    bar.setValue(150);
    expect(bar.value).toBe(100);
    expect(barEl.style.width).toBe("100%");

    bar.setValue(-10);
    expect(bar.value).toBe(0);
    expect(barEl.style.width).toBe("0%");
  });

  it("Label.setText() updates both the model and the live DOM text", () => {
    const label = new Label("l", "before");
    label.mount(document.body);
    label.setText("after");
    expect(label.text).toBe("after");
    expect(label.element.textContent).toBe("after");
  });
});

// ---------------------------------------------------------------------------
// UIManager (retained-mode widget tree)
// ---------------------------------------------------------------------------

describe("UIManager", () => {
  function makeManager() {
    const overlay = document.createElement("div");
    overlay.id = "ui-overlay";
    document.body.appendChild(overlay);

    const world = new World();
    const uiManager = new UIManager();
    world.addSystem(uiManager);
    uiManager.setCamera(new THREE.PerspectiveCamera(75, 1, 0.1, 10000));
    return { overlay, world, uiManager };
  }

  it("init() mounts the root panel into the overlay with pointer-events disabled", () => {
    const { overlay, uiManager } = makeManager();
    const root = overlay.firstElementChild as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.style.pointerEvents).toBe("none");
    expect(uiManager.get("does-not-exist")).toBeUndefined();
  });

  it("add()/remove()/get() manage widgets mounted under the root panel", () => {
    const { uiManager } = makeManager();
    const label = new Label("score", "0");

    uiManager.add(label);
    expect(uiManager.get("score")).toBe(label);
    expect(label.element.style.pointerEvents).toBe("auto");

    uiManager.remove("score");
    expect(uiManager.get("score")).toBeUndefined();
  });

  it("createWorldUI()/removeWorldUI() attach and detach a floating DOM element for an entity", () => {
    const { overlay, world, uiManager } = makeManager();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });

    uiManager.createWorldUI(eid, "<b>Boss</b>", 2, 40);
    expect(world.hasComponent(eid, WorldUI)).toBe(true);
    expect(overlay.querySelector("b")?.textContent).toBe("Boss");

    uiManager.removeWorldUI(eid);
    expect(overlay.querySelector("b")).toBeNull();
  });

  // AUDIT: an entity destroyed by anything other than an explicit removeWorldUI(eid) call (e.g.
  // world.destroyEntity via level streaming) left its <div> and worldUIElements entry behind
  // forever — UIManager never hooked worldUIStore.onRemove the way AudioSystem hooks its own
  // store for exactly this reason.
  it("destroying the entity directly (not via removeWorldUI) still detaches its DOM element", () => {
    const { overlay, world, uiManager } = makeManager();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });

    uiManager.createWorldUI(eid, "<b>Boss</b>", 2, 40);
    expect(overlay.querySelector("b")?.textContent).toBe("Boss");

    world.destroyEntity(eid);

    expect(overlay.querySelector("b")).toBeNull();
  });

  it("update() hides a world-space UI element once the entity exceeds maxDistance", () => {
    const { world, uiManager } = makeManager();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: -1000, sx: 1, sy: 1, sz: 1 });
    uiManager.createWorldUI(eid, "<span>far</span>", 0, 5);

    uiManager.update(0);

    const el = document.querySelector("span")!.parentElement as HTMLElement;
    expect(el.style.display).toBe("none");
  });

  it("destroy() unmounts the root panel and clears all world UI elements", () => {
    const { overlay, world, uiManager } = makeManager();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    uiManager.createWorldUI(eid, "<span>hi</span>");

    uiManager.destroy();

    expect(overlay.children.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// UISystem (raw HTML-string widgets)
// ---------------------------------------------------------------------------

describe("UISystem", () => {
  it("addWidget() creates a styled element under the overlay and getWidget() returns it", () => {
    const overlay = document.createElement("div");
    overlay.id = "ui-overlay";
    document.body.appendChild(overlay);

    const ui = new UISystem();
    const el = ui.addWidget("fps", "99", { color: "red" });

    expect(el.id).toBe("ui-fps");
    expect(el.textContent).toBe("99");
    expect(el.style.color).toBe("red");
    expect(ui.getWidget("fps")).toBe(el);
    expect(overlay.contains(el)).toBe(true);
  });

  it("addWidget() with a repeated id returns the existing element instead of creating a duplicate", () => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    const ui = new UISystem();
    const first = ui.addWidget("hud", "a");
    const second = ui.addWidget("hud", "b");
    expect(second).toBe(first);
    expect(second.textContent).toBe("a");
  });

  it("update() invokes each widget's per-frame update callback", () => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    const ui = new UISystem();
    const calls: number[] = [];
    ui.addWidget("clock", "0", undefined, (dt, el) => { calls.push(dt); el.textContent = String(dt); });

    ui.update(0.5);

    expect(calls).toEqual([0.5]);
    expect(ui.getWidget("clock")!.textContent).toBe("0.5");
  });

  it("removeWidget()/destroy() clean up DOM nodes", () => {
    document.body.innerHTML = '<div id="ui-overlay"></div>';
    const ui = new UISystem();
    ui.addWidget("a", "1");
    ui.addWidget("b", "2");

    ui.removeWidget("a");
    expect(ui.getWidget("a")).toBeUndefined();

    ui.destroy();
    expect(ui.getWidget("b")).toBeUndefined();
    expect(document.getElementById("ui-overlay")!.children.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AUDIT: UIManager and UISystem both mount into the same #ui-overlay element
// with no ownership coordination — see UIManager.ts:29, UISystem.ts:18
// ---------------------------------------------------------------------------

describe("AUDIT: UIManager / UISystem overlay collision", () => {
  it("both default to the exact same DOM element with no ownership check between them", () => {
    const overlay = document.createElement("div");
    overlay.id = "ui-overlay";
    document.body.appendChild(overlay);

    const world = new World();
    const uiManager = new UIManager();
    world.addSystem(uiManager);
    const uiSystem = new UISystem();

    // Both systems independently resolved the SAME overlay node.
    expect((uiManager as any).overlay).toBe(overlay);
    expect((uiSystem as any).overlay).toBe(overlay);

    // Mounting widgets from both stacks land as undifferentiated siblings —
    // neither system is aware the other exists or owns any of these children.
    uiSystem.addWidget("hud", "<span>HP</span>");
    expect(overlay.children.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// InputSystem
// ---------------------------------------------------------------------------

describe("InputSystem", () => {
  function makeInput() {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const input = new InputSystem(el);
    input.init();
    return { el, input };
  }

  it("tracks keydown/keyup state, press-this-frame, and released-this-frame sets", () => {
    const { input } = makeInput();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "W" }));
    expect(input.isKeyDown("w")).toBe(true);
    expect(input.isKeyPressed("w")).toBe(true);

    input.endFrame();
    expect(input.isKeyDown("w")).toBe(true); // still held
    expect(input.isKeyPressed("w")).toBe(false); // "pressed this frame" clears

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "W" }));
    expect(input.isKeyDown("w")).toBe(false);
    expect(input.isKeyReleased("w")).toBe(true);
  });

  it("key lookups are case-insensitive", () => {
    const { input } = makeInput();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A" }));
    expect(input.isKeyDown("a")).toBe(true);
    expect(input.isKeyDown("A")).toBe(true);
  });

  it("buffers a keypress for setBufferFrames() frames after it happened", () => {
    const { input } = makeInput();
    input.setBufferFrames(2);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));

    expect(input.isKeyBuffered(" ")).toBe(true);
    input.endFrame();
    expect(input.isKeyBuffered(" ")).toBe(true);
    input.endFrame();
    expect(input.isKeyBuffered(" ")).toBe(false);
  });

  it("tracks mouse button down/up/pressed/released and clears per-frame flags on endFrame()", () => {
    const { el, input } = makeInput();
    el.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    expect(input.isMouseDown(0)).toBe(true);
    expect(input.isMousePressed(0)).toBe(true);

    input.endFrame();
    expect(input.isMousePressed(0)).toBe(false);
    expect(input.isMouseDown(0)).toBe(true);

    el.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    expect(input.isMouseDown(0)).toBe(false);
    expect(input.isMouseReleased(0)).toBe(true);
  });

  it("accumulates mouse movement deltas and resets them on endFrame()", () => {
    const { el, input } = makeInput();
    el.dispatchEvent(new MouseEvent("mousemove", { movementX: 3, movementY: -2, clientX: 10, clientY: 20 }));
    el.dispatchEvent(new MouseEvent("mousemove", { movementX: 2, movementY: 1, clientX: 12, clientY: 21 }));

    expect(input.mouse.dx).toBe(5);
    expect(input.mouse.dy).toBe(-1);
    expect(input.mouse.x).toBe(12);
    expect(input.mouse.y).toBe(21);

    input.endFrame();
    expect(input.mouse.dx).toBe(0);
    expect(input.mouse.dy).toBe(0);
  });

  it("window blur releases all held keys and mouse buttons", () => {
    const { el, input } = makeInput();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" }));
    el.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    input.endFrame(); // clear this-frame press flags so only the blur's effect is observed

    window.dispatchEvent(new Event("blur"));

    // Alt-tabbing away never fires a matching keyup/mouseup (that happens outside the page),
    // so without an explicit release-on-blur, isKeyDown()/isMouseDown() would keep reporting
    // "w"/button 0 as held indefinitely even after focus returns.
    expect(input.isKeyDown("w")).toBe(false);
    expect(input.isKeyReleased("w")).toBe(true);
    expect(input.isKeyBuffered("w")).toBe(false);
    expect(input.isMouseDown(0)).toBe(false);
    expect(input.isMouseReleased(0)).toBe(true);
  });

  it("tab backgrounding (visibilitychange while hidden) also releases held inputs", () => {
    const { input } = makeInput();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    input.endFrame();

    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(input.isKeyDown("a")).toBe(false);
    expect(input.isKeyReleased("a")).toBe(true);
  });

  it("visibilitychange while still visible does not release held inputs", () => {
    const { input } = makeInput();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));
    input.endFrame();

    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(input.isKeyDown("s")).toBe(true);
  });

  it("requestPointerLock()/exitPointerLock() delegate to the DOM APIs", () => {
    const { el, input } = makeInput();
    el.requestPointerLock = vi.fn();
    document.exitPointerLock = vi.fn();

    input.requestPointerLock();
    input.exitPointerLock();

    expect(el.requestPointerLock).toHaveBeenCalledTimes(1);
    expect(document.exitPointerLock).toHaveBeenCalledTimes(1);
  });

  it("update() reads navigator.getGamepads(), applying the configured dead zone", () => {
    const { input } = makeInput();
    (navigator as any).getGamepads = vi.fn(() => [
      { axes: [0.05, 0.9, -1], buttons: [{ pressed: true }, { pressed: false }] },
    ]);

    input.update(0);
    const pad = input.getGamepad(0)!;
    expect(pad.connected).toBe(true);
    expect(pad.axes[0]).toBe(0); // below default deadZone (0.15) -> zeroed
    expect(pad.axes[1]).toBeGreaterThan(0.8); // remapped but still near 1
    expect(pad.buttons).toEqual([true, false]);
  });

  it("update() clears stale axes/buttons once a gamepad disconnects", () => {
    const { input } = makeInput();
    (navigator as any).getGamepads = vi.fn(() => [
      { axes: [1, 1], buttons: [{ pressed: true }] },
    ]);
    input.update(0);
    expect(input.getGamepad(0)!.connected).toBe(true);

    (navigator as any).getGamepads = vi.fn(() => []);
    input.update(0);

    const pad = input.getGamepad(0)!;
    expect(pad.connected).toBe(false);
    expect(pad.axes).toEqual([0, 0]);
    expect(pad.buttons).toEqual([false]);
  });

  it("destroy() detaches listeners so further DOM events no longer update state", () => {
    const { input } = makeInput();
    input.destroy();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }));
    expect(input.isKeyDown("z")).toBe(false);
  });

  it("destroy() also detaches the wheel and contextmenu listeners", () => {
    const { el, input } = makeInput();
    input.destroy();

    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 5 }));
    expect(input.mouse.wheel).toBe(0);

    // contextmenu's preventDefault() used to be registered via an inline arrow function that
    // was never stored anywhere, so destroy() had no reference to pass to
    // removeEventListener() and could never actually detach it — right-click would keep
    // opening the browser context menu after destroy().
    const event = new Event("contextmenu", { cancelable: true });
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// InputActions
// ---------------------------------------------------------------------------

describe("InputActions", () => {
  function makeActions() {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const input = new InputSystem(el);
    input.init();
    const actions = new InputActions(input);
    return { el, input, actions };
  }

  it("isDown() resolves true when any bound key is held", () => {
    const { actions } = makeActions();
    actions.bind("jump", { keys: ["space", "w"] });

    expect(actions.isDown("jump")).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" }));
    expect(actions.isDown("jump")).toBe(true);
  });

  it("isDown() also resolves via bound mouse buttons", () => {
    const { el, actions } = makeActions();
    actions.bind("attack", { mouseButtons: [0] });

    el.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
    expect(actions.isDown("attack")).toBe(true);
  });

  it("isPressed() is true only on the frame the key/button was first pressed", () => {
    const { input, actions } = makeActions();
    actions.bind("interact", { keys: ["e"] });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "e" }));
    expect(actions.isPressed("interact")).toBe(true);

    input.endFrame();
    expect(actions.isPressed("interact")).toBe(false);
    expect(actions.isDown("interact")).toBe(true); // still held
  });

  it("unbind() removes an action so isDown() reports false", () => {
    const { actions } = makeActions();
    actions.bind("jump", { keys: [" "] }); // KeyboardEvent.key for Space is the literal " "
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(actions.isDown("jump")).toBe(true);

    actions.unbind("jump");
    expect(actions.isDown("jump")).toBe(false);
  });

  it("getAxis() returns -1/0/+1 based on the negative/positive bindings", () => {
    const { actions } = makeActions();
    actions.bind("left", { keys: ["a"] });
    actions.bind("right", { keys: ["d"] });

    expect(actions.getAxis("left", "right")).toBe(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" }));
    expect(actions.getAxis("left", "right")).toBe(1);
  });

  it("getAxis2D() normalizes diagonal input to unit length", () => {
    const { actions } = makeActions();
    actions.bind("moveLeft", { keys: ["a"] });
    actions.bind("moveRight", { keys: ["d"] });
    actions.bind("moveForward", { keys: ["w"] });
    actions.bind("moveBackward", { keys: ["s"] });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" }));

    const v = actions.getAxis2D("moveLeft", "moveRight", "moveBackward", "moveForward");
    const len = Math.sqrt(v.x * v.x + v.y * v.y);
    expect(len).toBeCloseTo(1, 5);
  });

  it("defaultBindings() wires up the standard action set", () => {
    const { actions } = makeActions();
    InputActions.defaultBindings(actions);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" }));
    expect(actions.isDown("moveForward")).toBe(true);
    expect(actions.isDown("moveBackward")).toBe(false);
  });
});
