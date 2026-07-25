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
  depth: number;
}

// Small binary min-heap over PlanNode.cost. GOAP's search never needs to decrease an
// in-heap node's key (a cheaper route to an already-queued state is just pushed as a new
// node and the stale one is filtered out on pop via bestCostForState) so push/pop is all
// this needs.
class PlanNodeHeap {
  private nodes: PlanNode[] = [];

  get length(): number { return this.nodes.length; }

  push(node: PlanNode): void {
    const nodes = this.nodes;
    nodes.push(node);
    let i = nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (nodes[parent].cost <= nodes[i].cost) break;
      const tmp = nodes[parent]; nodes[parent] = nodes[i]; nodes[i] = tmp;
      i = parent;
    }
  }

  pop(): PlanNode | undefined {
    const nodes = this.nodes;
    if (nodes.length === 0) return undefined;
    const top = nodes[0];
    const last = nodes.pop();
    if (nodes.length > 0 && last !== undefined) {
      nodes[0] = last;
      let i = 0;
      const n = nodes.length;
      while (true) {
        const left = 2 * i + 1, right = 2 * i + 2;
        let smallest = i;
        if (left < n && nodes[left].cost < nodes[smallest].cost) smallest = left;
        if (right < n && nodes[right].cost < nodes[smallest].cost) smallest = right;
        if (smallest === i) break;
        const tmp = nodes[smallest]; nodes[smallest] = nodes[i]; nodes[i] = tmp;
        i = smallest;
      }
    }
    return top;
  }
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
    const start: PlanNode = { state: new Map(currentState), action: null, cost: 0, parent: null, depth: 0 };
    const open = new PlanNodeHeap();
    open.push(start);
    // Best known cost to reach an equivalent world state, keyed by a canonical serialization
    // of that state's entries. Without this, the same state reached via two different action
    // orderings gets expanded again independently, burning most of the iteration budget on
    // duplicate work instead of exploring new states.
    const bestCostForState = new Map<string, number>();
    bestCostForState.set(this.stateKey(start.state), 0);
    let iterations = 0;

    let bestNode: PlanNode | null = null;
    let bestCost = Infinity;

    while (open.length > 0 && iterations < this.maxIterations) {
      iterations++;

      const current = open.pop()!;

      // A cheaper route to this same state was already found after this entry was queued —
      // it's stale, skip it rather than re-expanding.
      const key = this.stateKey(current.state);
      if (current.cost > (bestCostForState.get(key) ?? Infinity)) continue;

      if (this.stateContains(current.state, goalState)) {
        if (current.cost < bestCost) {
          bestCost = current.cost;
          bestNode = current;
        }
        continue;
      }

      if (current.depth >= this.maxPlanDepth) continue;

      for (const action of actions) {
        if (!this.preconditionsMet(action, current.state)) continue;

        const newState = new Map(current.state);
        for (const [key, val] of action.effects) {
          newState.set(key, val);
        }

        const newCost = current.cost + action.cost;
        const newKey = this.stateKey(newState);
        const known = bestCostForState.get(newKey);
        if (known !== undefined && known <= newCost) continue;
        bestCostForState.set(newKey, newCost);

        open.push({
          state: newState,
          action,
          cost: newCost,
          parent: current,
          depth: current.depth + 1,
        });
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

  /** Canonical string key for a world state, independent of Map insertion order — different
   *  action orderings can reach the same key/value content via different insertion
   *  sequences, and the closed-set above needs those to compare equal. */
  private stateKey(state: WorldState): string {
    const keys = Array.from(state.keys()).sort();
    let out = "";
    for (const k of keys) out += k + "=" + state.get(k) + "|";
    return out;
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

}
