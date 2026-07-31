import { System, World, ComponentStore } from "../ecs";
import { Transform } from "../core/Components";
import { AIAgent, Perception } from "./AISystem";
import { SteeringAgent } from "./SteeringBehaviors";
import { FSMInstance } from "./FSM";
import { UtilityInstance } from "./UtilityAI";
import { GOAPInstance } from "./GOAP";
import { Blackboard } from "./BehaviorTree";
import { escapeHtml } from "../ui/Widget";

interface AIDebugEntry {
  eid: number;
  label: string;
  fsm?: FSMInstance;
  utility?: UtilityInstance;
  goap?: GOAPInstance;
  blackboard?: Blackboard;
}

export class AIDebugPanel extends System {
  priority = 990;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  private panel: HTMLDivElement | null = null;
  private content: HTMLDivElement | null = null;
  private visible = false;
  private accumulator = 0;
  private refreshRate = 0.15;

  private trackedEntities = new Map<number, AIDebugEntry>();
  private selectedEid = -1;

  private agentStore: ComponentStore | null = null;
  private perceptionStore: ComponentStore | null = null;
  private steerStore: ComponentStore | null = null;
  private transformStore: ComponentStore | null = null;

  init(): void {
    try { this.agentStore = this.world.getStore(AIAgent); } catch { this.agentStore = null; }
    try { this.perceptionStore = this.world.getStore(Perception); } catch { this.perceptionStore = null; }
    try { this.steerStore = this.world.getStore(SteeringAgent); } catch { this.steerStore = null; }
    try { this.transformStore = this.world.getStore(Transform); } catch { this.transformStore = null; }
  }

  track(eid: number, label: string, opts?: {
    fsm?: FSMInstance;
    utility?: UtilityInstance;
    goap?: GOAPInstance;
    blackboard?: Blackboard;
  }): void {
    this.trackedEntities.set(eid, {
      eid,
      label,
      fsm: opts?.fsm,
      utility: opts?.utility,
      goap: opts?.goap,
      blackboard: opts?.blackboard,
    });
    if (this.selectedEid < 0) this.selectedEid = eid;
  }

  untrack(eid: number): void {
    this.trackedEntities.delete(eid);
    if (this.selectedEid === eid) {
      const first = this.trackedEntities.keys().next();
      this.selectedEid = first.done ? -1 : first.value;
    }
  }

  select(eid: number): void {
    this.selectedEid = eid;
  }

  toggle(): void {
    this.visible = !this.visible;
    if (this.visible && !this.panel) this.createPanel();
    if (this.panel) this.panel.style.display = this.visible ? "block" : "none";
  }

  show(): void { this.visible = true; if (!this.panel) this.createPanel(); if (this.panel) this.panel.style.display = "block"; }
  hide(): void { this.visible = false; if (this.panel) this.panel.style.display = "none"; }

  private createPanel(): void {
    this.panel = document.createElement("div");
    this.panel.id = "ai-debug-panel";
    Object.assign(this.panel.style, {
      position: "fixed",
      bottom: "10px",
      left: "10px",
      width: "340px",
      maxHeight: "50vh",
      overflow: "auto",
      backgroundColor: "rgba(0,0,0,0.9)",
      color: "#eee",
      fontFamily: "monospace",
      fontSize: "11px",
      lineHeight: "1.5",
      padding: "10px",
      borderRadius: "6px",
      border: "1px solid #333",
      zIndex: "100000",
      pointerEvents: "auto",
    });

    const header = document.createElement("div");
    Object.assign(header.style, { color: "#4af", fontSize: "13px", fontWeight: "bold", marginBottom: "6px" });
    header.textContent = "AI Debug";
    this.panel.appendChild(header);

    const entityList = document.createElement("div");
    entityList.id = "ai-debug-entities";
    Object.assign(entityList.style, { marginBottom: "8px", display: "flex", flexWrap: "wrap", gap: "4px" });
    this.panel.appendChild(entityList);

    this.content = document.createElement("div");
    this.content.id = "ai-debug-content";
    this.panel.appendChild(this.content);

    document.body.appendChild(this.panel);
  }

  update(dt: number): void {
    if (!this.visible || !this.panel) return;
    this.accumulator += dt;
    if (this.accumulator < this.refreshRate) return;
    this.accumulator = 0;
    this.refresh();
  }

  private refresh(): void {
    if (!this.panel || !this.content) return;

    const entityList = this.panel.querySelector("#ai-debug-entities");
    if (entityList) {
      entityList.innerHTML = "";
      for (const [eid, entry] of this.trackedEntities) {
        const btn = document.createElement("span");
        const isSelected = eid === this.selectedEid;
        Object.assign(btn.style, {
          padding: "2px 6px",
          borderRadius: "3px",
          cursor: "pointer",
          backgroundColor: isSelected ? "#4af" : "#333",
          color: isSelected ? "#000" : "#ccc",
          fontSize: "10px",
        });
        btn.textContent = `${entry.label} (#${eid})`;
        btn.onclick = () => { this.selectedEid = eid; };
        entityList.appendChild(btn);
      }
    }

    const entry = this.trackedEntities.get(this.selectedEid);
    if (!entry) {
      this.content!.innerHTML = `<div style="color:#666">No entity selected</div>`;
      return;
    }

    let html = "";

    html += this.renderAgentInfo(entry);
    html += this.renderPerception(entry);
    html += this.renderSteering(entry);
    html += this.renderFSM(entry);
    html += this.renderUtility(entry);
    html += this.renderGOAP(entry);
    html += this.renderBlackboard(entry);

    this.content!.innerHTML = html;
  }

  private renderAgentInfo(entry: AIDebugEntry): string {
    if (!this.agentStore?.has(entry.eid)) return "";
    const active = this.agentStore.get(entry.eid, "active");
    const tickRate = this.agentStore.get(entry.eid, "tickRate") as number;
    const status = this.agentStore.get(entry.eid, "lastStatus") as number;
    const statusStr = status === 0 ? `<span style="color:#0f0">success</span>` :
                      status === 1 ? `<span style="color:#f44">failure</span>` :
                      `<span style="color:#ff0">running</span>`;

    return `<div style="margin-bottom:6px;">
      <div style="color:#fa4;">BT Agent</div>
      <div style="padding-left:8px;">active: ${active ? "yes" : "no"} | tick: ${tickRate.toFixed(2)}s | status: ${statusStr}</div>
    </div>`;
  }

  private renderPerception(entry: AIDebugEntry): string {
    if (!this.perceptionStore?.has(entry.eid)) return "";
    const range = (this.perceptionStore.get(entry.eid, "sightRange") as number).toFixed(1);
    const angle = (this.perceptionStore.get(entry.eid, "sightAngle") as number).toFixed(1);
    const hasTarget = this.perceptionStore.get(entry.eid, "hasTarget");
    const target = this.perceptionStore.get(entry.eid, "targetEntity") as number;
    const alert = (this.perceptionStore.get(entry.eid, "alertLevel") as number).toFixed(2);

    const alertColor = parseFloat(alert) > 0.7 ? "#f44" : parseFloat(alert) > 0.3 ? "#ff0" : "#0f0";
    const alertBar = this.bar(parseFloat(alert), alertColor);

    return `<div style="margin-bottom:6px;">
      <div style="color:#fa4;">Perception</div>
      <div style="padding-left:8px;">sight: ${range}m @ ${angle}deg</div>
      <div style="padding-left:8px;">target: ${hasTarget ? `#${target}` : "none"}</div>
      <div style="padding-left:8px;">alert: ${alertBar} ${alert}</div>
    </div>`;
  }

  private renderSteering(entry: AIDebugEntry): string {
    if (!this.steerStore?.has(entry.eid)) return "";
    const vx = (this.steerStore.get(entry.eid, "vx") as number).toFixed(2);
    const vz = (this.steerStore.get(entry.eid, "vz") as number).toFixed(2);
    const sx = (this.steerStore.get(entry.eid, "steerX") as number).toFixed(2);
    const sz = (this.steerStore.get(entry.eid, "steerZ") as number).toFixed(2);
    const speed = Math.sqrt(parseFloat(vx) ** 2 + parseFloat(vz) ** 2).toFixed(2);
    const maxSpeed = (this.steerStore.get(entry.eid, "maxSpeed") as number).toFixed(2);
    const flags = this.steerStore.get(entry.eid, "behaviors") as number;

    const activeFlags: string[] = [];
    const flagNames = ["Seek","Flee","Arrive","Wander","Pursue","Evade","Avoid","Sep","Align","Cohesion"];
    for (let i = 0; i < flagNames.length; i++) {
      if (flags & (1 << i)) activeFlags.push(flagNames[i]);
    }

    const speedRatio = Math.min(1, parseFloat(speed) / Math.max(0.01, parseFloat(maxSpeed)));
    const speedBar = this.bar(speedRatio, "#4af");

    return `<div style="margin-bottom:6px;">
      <div style="color:#fa4;">Steering</div>
      <div style="padding-left:8px;">behaviors: ${activeFlags.join(", ") || "none"}</div>
      <div style="padding-left:8px;">vel: (${vx}, ${vz}) | speed: ${speedBar} ${speed}/${maxSpeed}</div>
      <div style="padding-left:8px;">force: (${sx}, ${sz})</div>
    </div>`;
  }

  private renderFSM(entry: AIDebugEntry): string {
    if (!entry.fsm) return "";
    const fsm = entry.fsm;
    const state = fsm.definition.states.get(fsm.currentState);
    const transitions = state?.transitions.map(t => {
      const color = t.guard(entry.eid, fsm.blackboard) ? "#0f0" : "#666";
      return `<span style="color:${color}">${escapeHtml(t.to)}</span>`;
    }).join(", ") ?? "";

    return `<div style="margin-bottom:6px;">
      <div style="color:#fa4;">FSM: ${escapeHtml(fsm.definition.name)}</div>
      <div style="padding-left:8px;">state: <span style="color:#4f4;font-weight:bold">${escapeHtml(fsm.currentState)}</span> (${fsm.timeInState.toFixed(1)}s)</div>
      <div style="padding-left:8px;">prev: ${escapeHtml(fsm.previousState || "-")} | changes: ${fsm.stateChangeCount}</div>
      <div style="padding-left:8px;">transitions: ${transitions || "none"}</div>
    </div>`;
  }

  private renderUtility(entry: AIDebugEntry): string {
    if (!entry.utility) return "";
    const u = entry.utility;

    let scoreRows = "";
    const maxScore = Math.max(0.01, ...Array.from(u.lastScores.values()));
    for (const action of u.set.actions) {
      const score = u.lastScores.get(action.name) ?? 0;
      const isActive = action.name === u.currentAction;
      const color = isActive ? "#4f4" : "#888";
      const barColor = isActive ? "#4f4" : "#555";
      const bar = this.bar(score / maxScore, barColor);
      const cd = u.cooldowns.get(action.name);
      const cdStr = cd ? ` <span style="color:#f44">(cd:${cd.toFixed(1)}s)</span>` : "";
      scoreRows += `<div style="padding-left:8px;color:${color}">${bar} ${escapeHtml(action.name)}: ${score.toFixed(3)}${cdStr}</div>`;
    }

    return `<div style="margin-bottom:6px;">
      <div style="color:#fa4;">Utility: ${escapeHtml(u.set.name)}</div>
      <div style="padding-left:8px;">active: <span style="color:#4f4;font-weight:bold">${escapeHtml(u.currentAction)}</span> (${u.actionTime.toFixed(1)}s)</div>
      ${scoreRows}
    </div>`;
  }

  private renderGOAP(entry: AIDebugEntry): string {
    if (!entry.goap) return "";
    const g = entry.goap;

    const goalName = g.currentGoal?.name ?? "none";
    const planSteps = g.plan.map((a, i) => {
      const isCurrent = i === g.planIndex;
      const done = i < g.planIndex;
      const color = isCurrent ? "#4f4" : done ? "#666" : "#aaa";
      const prefix = isCurrent ? ">" : done ? "v" : " ";
      return `<div style="padding-left:16px;color:${color}">${prefix} ${escapeHtml(a.name)} (cost:${a.cost})</div>`;
    }).join("");

    let stateRows = "";
    for (const [key, val] of g.worldState) {
      stateRows += `<div style="padding-left:16px;color:#888">${escapeHtml(key)}: <span style="color:#8f8">${val}</span></div>`;
    }

    return `<div style="margin-bottom:6px;">
      <div style="color:#fa4;">GOAP</div>
      <div style="padding-left:8px;">goal: <span style="color:#ff4">${escapeHtml(goalName)}</span> | status: ${g.actionStatus}</div>
      <div style="padding-left:8px;">plan (${g.plan.length} steps):</div>
      ${planSteps || `<div style="padding-left:16px;color:#666">empty</div>`}
      <div style="padding-left:8px;">world state:</div>
      ${stateRows || `<div style="padding-left:16px;color:#666">empty</div>`}
    </div>`;
  }

  private renderBlackboard(entry: AIDebugEntry): string {
    if (!entry.blackboard) return "";
    const bb = entry.blackboard;
    let rows = "";
    const skipKeys = new Set(["eid", "dt", "x", "y", "z"]);

    const data = (bb as any).data as Map<string, any>;
    if (!data || data.size === 0) return "";

    for (const [key, val] of data) {
      if (skipKeys.has(key)) continue;
      // Blackboard values are `any` and set at runtime by arbitrary AI/game code — unlike
      // component fields (numeric/boolean only, see ComponentSchema) a blackboard entry can
      // hold a plain string sourced from anywhere (chat text, a player display name, etc.).
      // Escape before interpolating into innerHTML or a value like `<img src=x onerror=...>`
      // renders as live markup in this panel.
      const display = typeof val === "number" ? val.toFixed(3) :
                      typeof val === "boolean" ? String(val) :
                      typeof val === "string" ? escapeHtml(val) : escapeHtml(JSON.stringify(val));
      rows += `<div style="padding-left:8px;color:#888">${escapeHtml(key)}: <span style="color:#8f8">${display}</span></div>`;
    }

    if (!rows) return "";

    return `<div style="margin-bottom:6px;">
      <div style="color:#fa4;">Blackboard</div>
      ${rows}
    </div>`;
  }

  private bar(ratio: number, color: string): string {
    const clamped = Math.max(0, Math.min(1, ratio));
    const filled = Math.round(clamped * 8);
    const empty = 8 - filled;
    return `<span style="color:${color}">${"█".repeat(filled)}</span><span style="color:#333">${"█".repeat(empty)}</span>`;
  }

  destroy(): void {
    this.panel?.remove();
    this.trackedEntities.clear();
  }
}
