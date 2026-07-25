export type WorldState = Map<string, number | boolean>;
export type GOAPActionFn = (eid: number, dt: number, state: WorldState) => "running" | "done" | "failed";

export interface GOAPAction {
  name: string;
  cost: number;
  preconditions: WorldState;
  effects: WorldState;
  execute: GOAPActionFn;
}

export interface GOAPGoal {
  name: string;
  conditions: WorldState;
  priority: (eid: number, state: WorldState) => number;
}

export interface GOAPDomain {
  name: string;
  actions: GOAPAction[];
  goals: GOAPGoal[];
}

export class GOAPDomainBuilder {
  private name: string;
  private actions: GOAPAction[] = [];
  private goals: GOAPGoal[] = [];

  constructor(name: string) {
    this.name = name;
  }

  action(
    name: string,
    cost: number,
    preconditions: Record<string, number | boolean>,
    effects: Record<string, number | boolean>,
    execute: GOAPActionFn
  ): this {
    this.actions.push({
      name,
      cost,
      preconditions: new Map(Object.entries(preconditions)),
      effects: new Map(Object.entries(effects)),
      execute,
    });
    return this;
  }

  goal(
    name: string,
    conditions: Record<string, number | boolean>,
    priority: (eid: number, state: WorldState) => number
  ): this {
    this.goals.push({
      name,
      conditions: new Map(Object.entries(conditions)),
      priority,
    });
    return this;
  }

  build(): GOAPDomain {
    return { name: this.name, actions: this.actions, goals: this.goals };
  }
}

interface PlanNode {
  state: WorldState;
  action: GOAPAction | null;
  cost: number;
  parent: PlanNode | null;
}

export interface GOAPInstance {
  domain: GOAPDomain;
  worldState: WorldState;
  currentGoal: GOAPGoal | null;
  plan: GOAPAction[];
  planIndex: number;
  actionStatus: "idle" | "running" | "done" | "failed";
  replanCooldown: number;
  replanInterval: number;
}

export class GOAPPlanner {
  private maxPlanDepth = 10;
  private maxIterations = 500;

  createInstance(domain: GOAPDomain, replanInterval = 1.0): GOAPInstance {
    return {
      domain,
      worldState: new Map(),
      currentGoal: null,
      plan: [],
      planIndex: 0,
      actionStatus: "idle",
      replanCooldown: 0,
      replanInterval,
    };
  }

  tick(eid: number, instance: GOAPInstance, dt: number): string {
    instance.replanCooldown -= dt;

    if (instance.actionStatus === "failed" || instance.plan.length === 0 || instance.replanCooldown <= 0) {
      this.selectGoalAndPlan(eid, instance);
    }

    if (instance.plan.length === 0) return "idle";

    if (instance.planIndex >= instance.plan.length) {
      instance.actionStatus = "done";
      instance.plan = [];
      instance.planIndex = 0;
      return "done";
    }

    const action = instance.plan[instance.planIndex];
    const result = action.execute(eid, dt, instance.worldState);

    if (result === "done") {
      for (const [key, val] of action.effects) {
        instance.worldState.set(key, val);
      }
      instance.planIndex++;
      instance.actionStatus = instance.planIndex >= instance.plan.length ? "done" : "running";
      return action.name;
    }

    if (result === "failed") {
      instance.actionStatus = "failed";
      instance.plan = [];
      instance.planIndex = 0;
      return "failed";
    }

    instance.actionStatus = "running";
    return action.name;
  }

  private selectGoalAndPlan(eid: number, instance: GOAPInstance): void {
    instance.replanCooldown = instance.replanInterval;

    let bestGoal: GOAPGoal | null = null;
    let bestPriority = -Infinity;

    for (const goal of instance.domain.goals) {
      const p = goal.priority(eid, instance.worldState);
      if (p > bestPriority && !this.goalSatisfied(goal, instance.worldState)) {
        bestPriority = p;
        bestGoal = goal;
      }
    }

    if (!bestGoal) {
      instance.currentGoal = null;
      instance.plan = [];
      instance.planIndex = 0;
      return;
    }

    instance.currentGoal = bestGoal;
    const plan = this.plan(instance.domain.actions, instance.worldState, bestGoal.conditions);
    instance.plan = plan;
    instance.planIndex = 0;
    instance.actionStatus = plan.length > 0 ? "running" : "idle";
  }

  private goalSatisfied(goal: GOAPGoal, state: WorldState): boolean {
    for (const [key, val] of goal.conditions) {
      if (state.get(key) !== val) return false;
    }
    return true;
  }

  plan(actions: GOAPAction[], currentState: WorldState, goalState: WorldState): GOAPAction[] {
    const start: PlanNode = { state: new Map(currentState), action: null, cost: 0, parent: null };
    const open: PlanNode[] = [start];
    let iterations = 0;

    let bestNode: PlanNode | null = null;
    let bestCost = Infinity;

    while (open.length > 0 && iterations < this.maxIterations) {
      iterations++;

      let cheapestIdx = 0;
      for (let i = 1; i < open.length; i++) {
        if (open[i].cost < open[cheapestIdx].cost) cheapestIdx = i;
      }
      const current = open[cheapestIdx];
      open[cheapestIdx] = open[open.length - 1];
      open.pop();

      if (this.stateContains(current.state, goalState)) {
        if (current.cost < bestCost) {
          bestCost = current.cost;
          bestNode = current;
        }
        continue;
      }

      const depth = this.getDepth(current);
      if (depth >= this.maxPlanDepth) continue;

      for (const action of actions) {
        if (!this.preconditionsMet(action, current.state)) continue;

        const newState = new Map(current.state);
        for (const [key, val] of action.effects) {
          newState.set(key, val);
        }

        const node: PlanNode = {
          state: newState,
          action,
          cost: current.cost + action.cost,
          parent: current,
        };
        open.push(node);
      }
    }

    if (!bestNode) return [];

    const result: GOAPAction[] = [];
    let node: PlanNode | null = bestNode;
    while (node && node.action) {
      result.unshift(node.action);
      node = node.parent;
    }
    return result;
  }

  private stateContains(state: WorldState, goal: WorldState): boolean {
    for (const [key, val] of goal) {
      if (state.get(key) !== val) return false;
    }
    return true;
  }

  private preconditionsMet(action: GOAPAction, state: WorldState): boolean {
    for (const [key, val] of action.preconditions) {
      if (state.get(key) !== val) return false;
    }
    return true;
  }

  private getDepth(node: PlanNode): number {
    let depth = 0;
    let n: PlanNode | null = node;
    while (n?.parent) { depth++; n = n.parent; }
    return depth;
  }
}
