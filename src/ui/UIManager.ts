import * as THREE from "three";
import { System, World, ComponentStore } from "../ecs";
import { Transform } from "../core/Components";
import { Widget, Panel, resolveUIOverlay } from "./Widget";
import { defineComponent } from "../ecs";

export const WorldUI = defineComponent("WorldUI", {
  widgetRef: "ref",
  offsetY: "f32",
  maxDistance: "f32",
  billboard: "bool",
});

// UIManager/Widget is a standalone retained-mode widget tree (Panel/Label/Button/...); it does
// not share state, z-order, or overlay lifecycle with UISystem's separate raw-HTML-string
// widget map. Engine only instantiates UISystem by default — using both in the same scene
// means two independent DOM overlays, not one composed UI. Pick one per project rather than
// mixing them.
export class UIManager extends System {
  priority = 840;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  private root!: Panel;
  private overlay!: HTMLElement;
  private widgets = new Map<string, Widget>();
  private worldUIQuery!: ReturnType<World["query"]>;
  private transformStore!: ComponentStore;
  private worldUIStore!: ComponentStore;
  private camera!: THREE.Camera;
  private worldUIElements = new Map<number, HTMLElement>();

  constructor(overlayId: string = "ui-overlay") {
    super();
    this.overlay = resolveUIOverlay(overlayId);
    this.root = new Panel("root", {
      width: "100%",
      height: "100%",
      position: "absolute",
    });
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  init(): void {
    this.root.mount(this.overlay);
    this.root.element.style.pointerEvents = "none";
    this.transformStore = this.world.getStore(Transform);
    this.worldUIStore = this.world.getStore(WorldUI);
    this.worldUIQuery = this.world.query(Transform, WorldUI);
  }

  add(widget: Widget): void {
    this.widgets.set(widget.id, widget);
    widget.mount(this.root.element);
    widget.element.style.pointerEvents = "auto";
  }

  remove(id: string): void {
    const widget = this.widgets.get(id);
    if (widget) {
      widget.unmount();
      this.widgets.delete(id);
    }
  }

  get(id: string): Widget | undefined {
    return this.widgets.get(id);
  }

  /**
   * `html` is inserted via innerHTML as-is. Any untrusted content interpolated into it (player
   * names, chat text, etc.) must be run through `escapeHtml()` from `./Widget` first, or this
   * is an XSS vector.
   */
  createWorldUI(eid: number, html: string, offsetY: number = 1.5, maxDistance: number = 30): void {
    const el = document.createElement("div");
    el.innerHTML = html;
    el.style.position = "absolute";
    el.style.pointerEvents = "none";
    el.style.transform = "translate(-50%, -100%)";
    el.style.whiteSpace = "nowrap";
    el.style.transition = "opacity 0.2s";
    this.overlay.appendChild(el);
    this.worldUIElements.set(eid, el);

    this.world.addComponent(eid, WorldUI, {
      widgetRef: el,
      offsetY,
      maxDistance,
      billboard: 1,
    });
  }

  removeWorldUI(eid: number): void {
    const el = this.worldUIElements.get(eid);
    if (el) {
      el.remove();
      this.worldUIElements.delete(eid);
    }
  }

  update(_dt: number): void {
    if (!this.camera) return;

    const entities = this.worldUIQuery.entities;
    const tx = this.transformStore.getColumn("x");
    const ty = this.transformStore.getColumn("y");
    const tz = this.transformStore.getColumn("z");
    const projected = new THREE.Vector3();

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const el = this.worldUIElements.get(eid);
      if (!el) continue;

      const offsetY = this.worldUIStore.get(eid, "offsetY");
      const maxDist = this.worldUIStore.get(eid, "maxDistance");

      projected.set(tx[eid], ty[eid] + offsetY, tz[eid]);
      projected.project(this.camera);

      if (projected.z > 1) {
        el.style.display = "none";
        continue;
      }

      const sx = (projected.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-projected.y * 0.5 + 0.5) * window.innerHeight;

      const camPos = this.camera.position;
      const dist = Math.sqrt(
        (tx[eid] - camPos.x) ** 2 + (ty[eid] - camPos.y) ** 2 + (tz[eid] - camPos.z) ** 2
      );

      if (dist > maxDist) {
        el.style.display = "none";
        continue;
      }

      el.style.display = "";
      el.style.left = `${sx}px`;
      el.style.top = `${sy}px`;
      el.style.opacity = dist > maxDist * 0.8 ? `${1 - (dist - maxDist * 0.8) / (maxDist * 0.2)}` : "1";
    }
  }

  destroy(): void {
    for (const el of this.worldUIElements.values()) el.remove();
    this.worldUIElements.clear();
    this.root.unmount();
    this.widgets.clear();
  }
}
