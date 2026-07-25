import { System, World, ComponentStore, defineComponent } from "../ecs";
import { Transform } from "../core/Components";
import { BehaviorTreeRunner, BTNode, Blackboard } from "./BehaviorTree";
import { Handle, HandleMap } from "../core/handles/Handle";
import { FSMDefinition, FSMInstance, FSMRunner } from "./FSM";
import { UtilitySet, UtilityInstance, UtilityRunner } from "./UtilityAI";
import { GOAPDomain, GOAPInstance, GOAPPlanner } from "./GOAP";

export const enum AIType { BehaviorTree = 0, FSM = 1, Utility = 2, GOAP = 3 }

// SOA component — all hot AI data in typed arrays
export const AIAgent = defineComponent("AIAgent", {
  treeHandle: "i32",
  bbHandle: "i32",
  tickRate: "f32",
  accumulator: "f32",
  lastStatus: "u8",
  active: "bool",
  aiType: "u8",
  instanceHandle: "i32",
});

export const Perception = defineComponent("Perception", {
  sightRange: "f32",
  sightAngle: "f32",
  // Not consumed yet — there's no sound-event system to feed it (nothing in the engine
  // currently emits noise events for footsteps/gunfire/etc. for perception to react to).
  hearingRange: "f32",
  targetEntity: "i32",
  hasTarget: "bool",
  targetLastX: "f32",
  targetLastY: "f32",
  targetLastZ: "f32",
  alertLevel: "f32",
});

export class AISystem extends System {
  priority = 30;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "prePhysics";

  static reads = ["Transform", "AIAgent", "Perception"];
  static writes = ["AIAgent"];

  readonly btRunner = new BehaviorTreeRunner();
  readonly fsmRunner = new FSMRunner();
  readonly utilityRunner = new UtilityRunner();
  readonly goapPlanner = new GOAPPlanner();

  // Handle pools — BT trees and Blackboards behind handles, not per-entity Maps
  private treePools = new HandleMap<BTNode>();
  private bbPool = new HandleMap<Blackboard>();
  private fsmPool = new HandleMap<FSMInstance>();
  private utilityPool = new HandleMap<UtilityInstance>();
  private goapPool = new HandleMap<GOAPInstance>();

  private agentStore!: ComponentStore;
  private transformStore!: ComponentStore;
  private perceptionStore!: ComponentStore;
  private agentQuery!: ReturnType<World["query"]>;
  private perceptionQuery!: ReturnType<World["query"]>;
  private allTransformQuery!: ReturnType<World["query"]>;
  private factionFilter: ((perceiver: number, target: number) => boolean) | null = null;

  setFactionFilter(fn: (perceiver: number, target: number) => boolean): void {
    this.factionFilter = fn;
  }

  init(): void {
    this.agentStore = this.world.getStore(AIAgent);
    this.transformStore = this.world.getStore(Transform);
    this.perceptionStore = this.world.getStore(Perception);
    this.agentQuery = this.world.query(AIAgent, Transform);
    this.perceptionQuery = this.world.query(Perception, Transform);
    this.allTransformQuery = this.world.query(Transform);
  }

  createAgent(eid: number, tree: BTNode, tickRate: number = 0): void {
    const treeHandle = this.treePools.alloc(tree);
    const bb = new Blackboard();
    const bbHandle = this.bbPool.alloc(bb);

    this.world.addComponent(eid, AIAgent, {
      treeHandle,
      bbHandle,
      tickRate,
      accumulator: 0,
      lastStatus: 0,
      active: 1,
      aiType: AIType.BehaviorTree,
      instanceHandle: -1,
    });
  }

  createFSMAgent(eid: number, definition: FSMDefinition, tickRate: number = 0): FSMInstance {
    const instance = this.fsmRunner.createInstance(definition);
    const handle = this.fsmPool.alloc(instance);
    const bb = new Blackboard();
    const bbHandle = this.bbPool.alloc(bb);

    this.world.addComponent(eid, AIAgent, {
      treeHandle: -1,
      bbHandle,
      tickRate,
      accumulator: 0,
      lastStatus: 0,
      active: 1,
      aiType: AIType.FSM,
      instanceHandle: handle,
    });
    return instance;
  }

  createUtilityAgent(eid: number, set: UtilitySet, tickRate: number = 0): UtilityInstance {
    const instance = this.utilityRunner.createInstance(set);
    const handle = this.utilityPool.alloc(instance);
    const bb = new Blackboard();
    const bbHandle = this.bbPool.alloc(bb);

    this.world.addComponent(eid, AIAgent, {
      treeHandle: -1,
      bbHandle,
      tickRate,
      accumulator: 0,
      lastStatus: 0,
      active: 1,
      aiType: AIType.Utility,
      instanceHandle: handle,
    });
    return instance;
  }

  createGOAPAgent(eid: number, domain: GOAPDomain, tickRate: number = 0, replanInterval: number = 1.0): GOAPInstance {
    const instance = this.goapPlanner.createInstance(domain, replanInterval);
    const handle = this.goapPool.alloc(instance);
    const bb = new Blackboard();
    const bbHandle = this.bbPool.alloc(bb);

    this.world.addComponent(eid, AIAgent, {
      treeHandle: -1,
      bbHandle,
      tickRate,
      accumulator: 0,
      lastStatus: 0,
      active: 1,
      aiType: AIType.GOAP,
      instanceHandle: handle,
    });
    return instance;
  }

  getFSMInstance(eid: number): FSMInstance | null {
    if (!this.agentStore.has(eid)) return null;
    const h = this.agentStore.get(eid, "instanceHandle") as number;
    return this.fsmPool.get(h);
  }

  getUtilityInstance(eid: number): UtilityInstance | null {
    if (!this.agentStore.has(eid)) return null;
    const h = this.agentStore.get(eid, "instanceHandle") as number;
    return this.utilityPool.get(h);
  }

  getGOAPInstance(eid: number): GOAPInstance | null {
    if (!this.agentStore.has(eid)) return null;
    const h = this.agentStore.get(eid, "instanceHandle") as number;
    return this.goapPool.get(h);
  }

  getBlackboard(eid: number): Blackboard | null {
    if (!this.agentStore.has(eid)) return null;
    const h = this.agentStore.get(eid, "bbHandle") as number;
    return this.bbPool.get(h);
  }

  setTree(eid: number, tree: BTNode): void {
    const oldH = this.agentStore.get(eid, "treeHandle") as number;
    if (oldH >= 0) this.treePools.free(oldH);
    const newH = this.treePools.alloc(tree);
    this.agentStore.set(eid, "treeHandle", newH);
  }

  // Hot loop — reads SOA columns for tick gating, resolves handles only when ticking
  update(dt: number): void {
    const entities = this.agentQuery.entities;
    const active = this.agentStore.getColumn("active");
    const tickRates = this.agentStore.getColumn("tickRate");
    const accumulators = this.agentStore.getColumn("accumulator");
    const treeHandles = this.agentStore.getColumn("treeHandle");
    const bbHandles = this.agentStore.getColumn("bbHandle");
    const lastStatuses = this.agentStore.getColumn("lastStatus");
    const aiTypes = this.agentStore.getColumn("aiType");
    const instanceHandles = this.agentStore.getColumn("instanceHandle");

    const tx = this.transformStore.getColumn("x");
    const ty = this.transformStore.getColumn("y");
    const tz = this.transformStore.getColumn("z");

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (active[eid] === 0) continue;

      // Tick rate gating — SOA accumulator check
      const rate = tickRates[eid];
      if (rate > 0) {
        accumulators[eid] += dt;
        if (accumulators[eid] < rate) continue;
        accumulators[eid] -= rate;
      }

      const type = aiTypes[eid];

      // Inject blackboard context for all types
      const bb = this.bbPool.get(bbHandles[eid]);
      if (bb) {
        bb.set("eid", eid);
        bb.set("dt", dt);
        bb.set("x", tx[eid]);
        bb.set("y", ty[eid]);
        bb.set("z", tz[eid]);
      }

      switch (type) {
        case AIType.BehaviorTree: {
          const tree = this.treePools.get(treeHandles[eid]);
          if (!tree || !bb) break;
          const status = this.btRunner.tick(eid, tree, bb, dt);
          lastStatuses[eid] = status === "success" ? 0 : status === "failure" ? 1 : 2;
          break;
        }
        case AIType.FSM: {
          const fsm = this.fsmPool.get(instanceHandles[eid]);
          if (!fsm) break;
          if (bb) {
            for (const [k, v] of fsm.blackboard) bb.set(k, v);
          }
          this.fsmRunner.tick(eid, fsm, dt);
          lastStatuses[eid] = 0;
          break;
        }
        case AIType.Utility: {
          const util = this.utilityPool.get(instanceHandles[eid]);
          if (!util) break;
          this.utilityRunner.tick(eid, util, dt);
          lastStatuses[eid] = 0;
          break;
        }
        case AIType.GOAP: {
          const goap = this.goapPool.get(instanceHandles[eid]);
          if (!goap) break;
          const result = this.goapPlanner.tick(eid, goap, dt);
          lastStatuses[eid] = result === "failed" ? 1 : result === "idle" || result === "done" ? 0 : 2;
          break;
        }
      }
    }

    this.updatePerception();
  }

  private updatePerception(): void {
    const perceivers = this.perceptionQuery.entities;
    if (perceivers.length === 0) return;

    const targets = this.allTransformQuery.entities;

    const sightRanges = this.perceptionStore.getColumn("sightRange");
    const sightAngles = this.perceptionStore.getColumn("sightAngle");
    const hasTargets = this.perceptionStore.getColumn("hasTarget");
    const targetEntities = this.perceptionStore.getColumn("targetEntity");
    const targetLastX = this.perceptionStore.getColumn("targetLastX");
    const targetLastY = this.perceptionStore.getColumn("targetLastY");
    const targetLastZ = this.perceptionStore.getColumn("targetLastZ");
    const alertLevels = this.perceptionStore.getColumn("alertLevel");

    const tx = this.transformStore.getColumn("x");
    const ty = this.transformStore.getColumn("y");
    const tz = this.transformStore.getColumn("z");
    const ry = this.transformStore.getColumn("ry");

    for (let i = 0; i < perceivers.length; i++) {
      const eid = perceivers[i];
      const range = sightRanges[eid];
      const rangeSq = range * range;
      // Horizontal (XZ) field-of-view half-angle, matching the ry (yaw-only) heading
      // convention used elsewhere (SteeringSystem/NavigationSystem face movement via
      // atan2(vx, vz)). A sightAngle <= 0 or >= 2*PI is treated as omnidirectional.
      const halfFov = sightAngles[eid] > 0 ? sightAngles[eid] * 0.5 : Math.PI;
      const facingX = Math.sin(ry[eid]);
      const facingZ = Math.cos(ry[eid]);
      let closestDist = rangeSq;
      let closestTarget = -1;

      for (let j = 0; j < targets.length; j++) {
        const other = targets[j];
        if (other === eid) continue;

        if (this.factionFilter && !this.factionFilter(eid, other)) continue;

        const dx = tx[other] - tx[eid];
        const dy = ty[other] - ty[eid];
        const dz = tz[other] - tz[eid];
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq >= closestDist) continue;

        if (halfFov < Math.PI) {
          const horizDistSq = dx * dx + dz * dz;
          if (horizDistSq > 0.0001) {
            const invHorizDist = 1 / Math.sqrt(horizDistSq);
            const cosAngle = (dx * facingX + dz * facingZ) * invHorizDist;
            if (cosAngle < Math.cos(halfFov)) continue;
          }
        }

        closestDist = distSq;
        closestTarget = other;
      }

      if (closestTarget >= 0) {
        hasTargets[eid] = 1;
        targetEntities[eid] = closestTarget;
        targetLastX[eid] = tx[closestTarget];
        targetLastY[eid] = ty[closestTarget];
        targetLastZ[eid] = tz[closestTarget];
        alertLevels[eid] = Math.min(1, alertLevels[eid] + 0.1);
      } else {
        alertLevels[eid] = Math.max(0, alertLevels[eid] - 0.05);
        if (alertLevels[eid] <= 0) {
          hasTargets[eid] = 0;
          targetEntities[eid] = -1;
        }
      }
    }
  }

  removeAgent(eid: number): void {
    const th = this.agentStore.get(eid, "treeHandle") as number;
    const bh = this.agentStore.get(eid, "bbHandle") as number;
    const ih = this.agentStore.get(eid, "instanceHandle") as number;
    const type = this.agentStore.get(eid, "aiType") as number;
    if (th >= 0) this.treePools.free(th);
    if (bh >= 0) this.bbPool.free(bh);
    if (ih >= 0) {
      switch (type) {
        case AIType.FSM: this.fsmPool.free(ih); break;
        case AIType.Utility: this.utilityPool.free(ih); break;
        case AIType.GOAP: this.goapPool.free(ih); break;
      }
    }
  }

  destroy(): void {
    const entities = this.agentQuery.entities;
    for (const eid of entities) this.removeAgent(eid);
  }
}
