import * as THREE from "three";
import { System, World, ComponentStore } from "../../ecs";
import { ComponentDef } from "../../ecs/Component";
import { Transform, MeshRenderer } from "../../core/Components";

export class DebugInspector extends System {
  priority = 855;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  private selectedEntity: number = -1;
  private panel: HTMLElement | null = null;
  private registeredDefs: ComponentDef[] = [];
  private camera!: THREE.Camera;
  private scene!: THREE.Scene;
  private raycaster = new THREE.Raycaster();
  private mouseNDC = new THREE.Vector2();
  private visible = false;

  setup(scene: THREE.Scene, camera: THREE.Camera): void {
    this.scene = scene;
    this.camera = camera;
  }

  registerComponents(...defs: ComponentDef[]): void {
    this.registeredDefs.push(...defs);
  }

  toggle(): void {
    this.visible = !this.visible;
    if (this.panel) {
      this.panel.style.display = this.visible ? "block" : "none";
    }
    if (this.visible && !this.panel) {
      this.createPanel();
    }
  }

  selectEntity(eid: number): void {
    this.selectedEntity = eid;
    this.refreshPanel();
  }

  pickAtScreen(screenX: number, screenY: number): number {
    this.mouseNDC.x = (screenX / window.innerWidth) * 2 - 1;
    this.mouseNDC.y = -(screenY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);

    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    if (hits.length === 0) return -1;

    const meshStore = this.world.getStore(MeshRenderer);
    const transformStore = this.world.getStore(Transform);

    for (const hit of hits) {
      for (const eid of meshStore.entities) {
        const meshRef = meshStore.get(eid, "meshRef");
        if (meshRef === hit.object) {
          this.selectEntity(eid);
          return eid;
        }
      }
    }

    return -1;
  }

  private createPanel(): void {
    this.panel = document.createElement("div");
    this.panel.id = "debug-inspector";
    Object.assign(this.panel.style, {
      position: "absolute",
      top: "10px",
      right: "10px",
      width: "280px",
      maxHeight: "80vh",
      overflow: "auto",
      backgroundColor: "rgba(0,0,0,0.85)",
      color: "#eee",
      fontFamily: "monospace",
      fontSize: "12px",
      padding: "10px",
      borderRadius: "6px",
      zIndex: "100",
      pointerEvents: "auto",
    });
    document.getElementById("ui-overlay")?.appendChild(this.panel);
  }

  private lastRenderedHtml = "";

  private refreshPanel(): void {
    if (!this.panel || this.selectedEntity < 0) return;

    let html = `<div style="color:#4af;font-size:14px;margin-bottom:8px;">Entity #${this.selectedEntity}</div>`;

    for (const def of this.registeredDefs) {
      const store = this.world.getStore(def);
      if (!store.has(this.selectedEntity)) continue;

      html += `<div style="color:#fa4;margin-top:6px;">${def.name}</div>`;
      for (const [field, type] of Object.entries(def.schema)) {
        if (type === "ref") continue;
        const value = store.get(this.selectedEntity, field);
        const displayValue = typeof value === "number" ? value.toFixed(3) : value;
        html += `<div style="padding-left:8px;">${field}: <span style="color:#8f8">${displayValue}</span></div>`;
      }
    }

    if (html.indexOf("Entity") === html.lastIndexOf("Entity") && html.split("</div>").length <= 3) {
      html += `<div style="color:#888;">No registered components found</div>`;
    }

    if (html !== this.lastRenderedHtml) {
      this.panel.innerHTML = html;
      this.lastRenderedHtml = html;
    }
  }

  private refreshAccumulator = 0;
  private refreshInterval = 0.1;

  update(dt: number): void {
    if (!this.visible || this.selectedEntity < 0) return;
    this.refreshAccumulator += dt;
    if (this.refreshAccumulator >= this.refreshInterval) {
      this.refreshAccumulator = 0;
      this.refreshPanel();
    }
  }

  destroy(): void {
    this.panel?.remove();
  }
}
