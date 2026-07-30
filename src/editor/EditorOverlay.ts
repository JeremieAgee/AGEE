import type { AGEE } from "../core/Engine";
import { Transform, Velocity, RigidBody, Collider, MeshRenderer, Light, AudioSource, ParticleEmitter, Tag } from "../core/Components";
import type { ComponentDef, World } from "../ecs";

// Components an entity is checked against for the badge list in the inspector row. World has
// no generic "list this entity's components" API, so this enumerates the built-in set —
// enough for scene-inspection purposes without requiring every example to register its own.
const KNOWN_COMPONENTS: Array<{ name: string; def: ComponentDef }> = [
  { name: "Transform", def: Transform },
  { name: "Velocity", def: Velocity },
  { name: "RigidBody", def: RigidBody },
  { name: "Collider", def: Collider },
  { name: "MeshRenderer", def: MeshRenderer },
  { name: "Light", def: Light },
  { name: "AudioSource", def: AudioSource },
  { name: "ParticleEmitter", def: ParticleEmitter },
  { name: "Tag", def: Tag },
];

const TRANSFORM_FIELDS = ["x", "y", "z", "rx", "ry", "rz", "sx", "sy", "sz"] as const;

// Entry point for editor-only tooling. Everything this module imports is excluded from
// production builds — see the `__EDITOR__` gate in Engine.ts and `define` in vite.config.ts.
// Wires up a scene inspector (entity list + live Transform editing) and surfaces the engine's
// existing perf overlay/dev console, which otherwise ship dark with no key bound to show them.
export class EditorOverlay {
  static init(engine: AGEE): EditorOverlay {
    return new EditorOverlay(engine);
  }

  private engine: AGEE;
  private world: World;
  private root: HTMLDivElement;
  private listEl: HTMLDivElement;
  private detailEl: HTMLDivElement;
  private countEl: HTMLDivElement;
  private query: ReturnType<World["query"]>;
  private visible = true;
  private selected = -1;
  private accumulator = 0;
  private refreshInterval = 0.5;
  private focusedField: string | null = null;

  private constructor(engine: AGEE) {
    this.engine = engine;
    this.world = engine.world;
    this.query = this.world.query(Transform);

    engine.profiler.setEnabled(true);
    engine.debugOverlay.show();
    window.addEventListener("keydown", this.onKeyDown);

    this.root = document.createElement("div");
    this.root.id = "agee-editor-inspector";
    Object.assign(this.root.style, {
      position: "fixed",
      top: "0",
      right: "0",
      width: "260px",
      maxHeight: "100vh",
      overflowY: "auto",
      zIndex: "100000",
      background: "rgba(12,14,20,0.9)",
      color: "#e6e8ee",
      fontFamily: "monospace",
      fontSize: "11px",
      borderLeft: "1px solid rgba(255,255,255,0.12)",
      padding: "8px",
      boxSizing: "border-box",
    });

    const header = document.createElement("div");
    header.textContent = "SCENE INSPECTOR (I to toggle, F3 = perf, ` = console)";
    Object.assign(header.style, { color: "#4af", marginBottom: "6px", lineHeight: "1.4" });
    this.root.appendChild(header);

    this.countEl = document.createElement("div");
    Object.assign(this.countEl.style, { marginBottom: "6px", color: "#9aa1b0" });
    this.root.appendChild(this.countEl);

    this.listEl = document.createElement("div");
    this.root.appendChild(this.listEl);

    this.detailEl = document.createElement("div");
    Object.assign(this.detailEl.style, {
      marginTop: "8px",
      paddingTop: "8px",
      borderTop: "1px solid rgba(255,255,255,0.12)",
    });
    this.root.appendChild(this.detailEl);

    document.body.appendChild(this.root);

    engine.events.on("preUpdate", (dt: number) => this.tick(dt));
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "i" || e.key === "I") {
      if (document.activeElement instanceof HTMLInputElement) return;
      this.visible = !this.visible;
      this.root.style.display = this.visible ? "block" : "none";
    } else if (e.key === "F3") {
      e.preventDefault();
      this.engine.debugOverlay.toggle();
    }
  };

  private tick(dt: number): void {
    if (!this.visible || this.focusedField) return;
    this.accumulator += dt;
    if (this.accumulator < this.refreshInterval) return;
    this.accumulator = 0;
    this.render();
  }

  private render(): void {
    const entities = this.query.entities;
    this.countEl.textContent = `${entities.length} entities`;
    this.listEl.innerHTML = "";

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const badges = KNOWN_COMPONENTS.filter((c) => this.world.hasComponent(eid, c.def)).map((c) => c.name);

      const row = document.createElement("div");
      row.textContent = `#${eid} ${badges.join(", ")}`;
      Object.assign(row.style, {
        padding: "2px 4px",
        cursor: "pointer",
        borderRadius: "3px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        background: eid === this.selected ? "rgba(68,170,255,0.25)" : "transparent",
      });
      row.addEventListener("click", () => {
        this.selected = eid;
        this.render();
      });
      this.listEl.appendChild(row);
    }

    this.renderDetail();
  }

  private renderDetail(): void {
    this.detailEl.innerHTML = "";
    const eid = this.selected;
    if (eid < 0 || !this.world.isAlive(eid) || !this.world.hasComponent(eid, Transform)) {
      this.detailEl.textContent = "Select an entity to inspect its Transform.";
      return;
    }

    const title = document.createElement("div");
    title.textContent = `Transform — entity #${eid}`;
    Object.assign(title.style, { color: "#4af", marginBottom: "4px" });
    this.detailEl.appendChild(title);

    const store = this.world.getStore(Transform);
    for (const field of TRANSFORM_FIELDS) {
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", justifyContent: "space-between", gap: "6px", margin: "2px 0" });

      const label = document.createElement("span");
      label.textContent = field;
      label.style.color = "#9aa1b0";

      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.1";
      input.value = (store.get(eid, field) as number).toFixed(2);
      Object.assign(input.style, {
        width: "90px",
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.12)",
        color: "#e6e8ee",
        fontFamily: "monospace",
        fontSize: "11px",
      });
      input.addEventListener("focus", () => { this.focusedField = field; });
      input.addEventListener("blur", () => { this.focusedField = null; });
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        if (!Number.isNaN(v)) store.set(eid, field, v);
      });

      row.appendChild(label);
      row.appendChild(input);
      this.detailEl.appendChild(row);
    }
  }
}
