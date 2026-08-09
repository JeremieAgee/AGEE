import { MinHeap } from "../core/BinaryHeap";
import type { Blackboard } from "./BehaviorTree";
import { syncPerceptionState } from "./PerceptionSync";

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

// A search in progress, resumable across multiple stepSearch() calls so a single agent's
// up-to-500-iteration plan search can be spread across several AISystem.update() frames
// instead of running to completion in one.
interface SearchState {
  actions: GOAPAction[];
  goalState: WorldState;
  open: MinHeap<PlanNode>;
  stateKeys: string[];
  bestCostForState: Map<string, number>;
  bestNode: PlanNode | null;
  bestCost: number;
  iterations: number;
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
  pendingSearch: SearchState | null;
}

export class GOAPPlanner {
  private maxPlanDepth = 10;
  private maxIterations = 500;
  // Total search iterations (state-map clones) every GOAP agent combined may spend inside a
  // single AISystem.update() call. About 4x one agent's own maxIterations, so a handful of
  // agents replanning on the same frame — the common case, since agents created with the same
  // default replanInterval tend to line up — still finish in one frame, while a much larger
  // pile of simultaneous replans spreads its cost across several frames instead of spiking one.
  private iterationBudgetPerFrame = 2000;
  private remainingBudget = this.iterationBudgetPerFrame;
  // Safety net for callers that drive tick() directly instead of through AISystem (which
  // calls beginFrame() once per real frame): without it, remainingBudget only ever counts
  // down and a planner used standalone permanently stops producing new plans once the
  // one-time budget is exhausted, since nothing else would ever replenish it. Refilling on
  // a real-time window (rather than only via explicit beginFrame() calls) makes the budget
  // self-sustaining for standalone use while staying a no-op for AISystem-driven use, since
  // beginFrame() there already resets it well within this window every frame.
  private static readonly AUTO_REFILL_WINDOW_MS = 1000 / 30;
  private lastRefillAt = GOAPPlanner.now();

  private static now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  beginFrame(): void {
    this.remainingBudget = this.iterationBudgetPerFrame;
    this.lastRefillAt = GOAPPlanner.now();
  }

  private ensureBudget(): void {
    const t = GOAPPlanner.now();
    if (t - this.lastRefillAt >= GOAPPlanner.AUTO_REFILL_WINDOW_MS) {
      this.remainingBudget = this.iterationBudgetPerFrame;
      this.lastRefillAt = t;
    }
  }

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
      pendingSearch: null,
    };
  }

  tick(eid: number, instance: GOAPInstance, dt: number, blackboard?: Blackboard | null): string {
    syncPerceptionState(instance.worldState, blackboard);

    instance.replanCooldown -= dt;

    if (instance.actionStatus === "failed" || instance.plan.length === 0 || instance.replanCooldown <= 0 || instance.pendingSearch) {
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
    this.ensureBudget();
    if (!instance.pendingSearch) {
      // Budget already spent by other agents this frame -- leave the trigger conditions in
      // tick() unsatisfied-and-retried (plan stays empty / actionStatus stays "failed") so
      // this agent's goal pick and search start on a later frame instead of starving forever.
      if (this.remainingBudget <= 0) return;

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
      instance.pendingSearch = this.beginSearch(instance.domain.actions, instance.worldState, bestGoal.conditions);
    }

    if (this.remainingBudget <= 0) return;

    const search = instance.pendingSearch;
    const before = search.iterations;
    const status = this.stepSearch(search, this.remainingBudget);
    this.remainingBudget -= search.iterations - before;

    if (status === "done") {
      instance.plan = this.extractPlan(search);
      instance.pendingSearch = null;
      instance.planIndex = 0;
      instance.actionStatus = instance.plan.length > 0 ? "running" : "idle";
    }
  }

  private goalSatisfied(goal: GOAPGoal, state: WorldState): boolean {
    for (const [key, val] of goal.conditions) {
      if (state.get(key) !== val) return false;
    }
    return true;
  }

  plan(actions: GOAPAction[], currentState: WorldState, goalState: WorldState): GOAPAction[] {
    const search = this.beginSearch(actions, currentState, goalState);
    this.stepSearch(search, this.maxIterations);
    return this.extractPlan(search);
  }

  // Builds the initial search frontier from `currentState` toward `goalState`. Split out from
  // the iteration loop (stepSearch) so AISystem's hot path can spend a capped number of
  // iterations on it per frame and resume the same search next frame instead of blocking until
  // it's fully solved (see selectGoalAndPlan).
  private beginSearch(actions: GOAPAction[], currentState: WorldState, goalState: WorldState): SearchState {
    const start: PlanNode = { state: new Map(currentState), action: null, cost: 0, parent: null, depth: 0 };
    // GOAP's search never needs to decrease an in-heap node's key (a cheaper route to an
    // already-queued state is just pushed as a new node and the stale one is filtered out on
    // pop via bestCostForState) so the plain shared MinHeap — push/pop keyed by cost, no
    // decrease-key/contains — is all this needs.
    const open = new MinHeap<PlanNode>();
    open.push(start, start.cost);
    // Fixed, pre-sorted list of every key that can ever appear in a state reached from
    // `start` (a successor state only ever gains keys via action.effects, never loses any —
    // see the plain `new Map(current.state)` + `.set()` below). Computed once per search so
    // stateKey() below can build a canonical string by walking this instead of re-deriving
    // and re-sorting `Array.from(state.keys())` from scratch on every single node, which was
    // the search's dominant source of allocation churn (called for every expanded node and
    // every one of its successors, with maxIterations up to 500 and one GOAP instance replanning
    // per active agent).
    const stateKeys = this.collectStateKeys(actions, currentState, goalState);
    // Best known cost to reach an equivalent world state, keyed by a canonical serialization
    // of that state's entries. Without this, the same state reached via two different action
    // orderings gets expanded again independently, burning most of the iteration budget on
    // duplicate work instead of exploring new states.
    const bestCostForState = new Map<string, number>();
    bestCostForState.set(this.stateKey(start.state, stateKeys), 0);

    return { actions, goalState, open, stateKeys, bestCostForState, bestNode: null, bestCost: Infinity, iterations: 0 };
  }

  // Runs up to `budget` more iterations of `search` from wherever it last left off. Returns
  // "done" once the frontier is exhausted or the search's own maxIterations cap is hit, or
  // "pending" if it stopped early only because `budget` ran out (more work remains for a later
  // call).
  private stepSearch(search: SearchState, budget: number): "done" | "pending" {
    const { actions, goalState, open, stateKeys, bestCostForState } = search;
    let spent = 0;

    while (open.length > 0 && search.iterations < this.maxIterations && spent < budget) {
      search.iterations++;
      spent++;

      const current = open.pop()!;

      // A cheaper route to this same state was already found after this entry was queued —
      // it's stale, skip it rather than re-expanding.
      const key = this.stateKey(current.state, stateKeys);
      if (current.cost > (bestCostForState.get(key) ?? Infinity)) continue;

      if (this.stateContains(current.state, goalState)) {
        if (current.cost < search.bestCost) {
          search.bestCost = current.cost;
          search.bestNode = current;
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
        const newKey = this.stateKey(newState, stateKeys);
        const known = bestCostForState.get(newKey);
        if (known !== undefined && known <= newCost) continue;
        bestCostForState.set(newKey, newCost);

        const newNode: PlanNode = {
          state: newState,
          action,
          cost: newCost,
          parent: current,
          depth: current.depth + 1,
        };
        open.push(newNode, newNode.cost);
      }
    }

    return open.length === 0 || search.iterations >= this.maxIterations ? "done" : "pending";
  }

  private extractPlan(search: SearchState): GOAPAction[] {
    if (!search.bestNode) return [];

    const result: GOAPAction[] = [];
    let node: PlanNode | null = search.bestNode;
    while (node && node.action) {
      result.unshift(node.action);
      node = node.parent;
    }
    return result;
  }

  // Every key that could ever appear in a state reachable from currentState during this
  // plan() call: the starting keys, the goal's keys (so goal-only conditions still contribute
  // to the canonical key), and every action's precondition/effect keys (the only way a new
  // key can ever get introduced into a successor state). Sorted once and reused by every
  // stateKey() call for the rest of this search.
  private collectStateKeys(actions: GOAPAction[], currentState: WorldState, goalState: WorldState): string[] {
    const keys = new Set<string>();
    for (const k of currentState.keys()) keys.add(k);
    for (const k of goalState.keys()) keys.add(k);
    for (const action of actions) {
      for (const k of action.preconditions.keys()) keys.add(k);
      for (const k of action.effects.keys()) keys.add(k);
    }
    return Array.from(keys).sort();
  }

  /** Canonical string key for a world state, independent of Map insertion order — different
   *  action orderings can reach the same key/value content via different insertion
   *  sequences, and the closed-set above needs those to compare equal. `keys` must be a
   *  superset of every key `state` could contain (see collectStateKeys). */
  private stateKey(state: WorldState, keys: string[]): string {
    let out = "";
    for (const k of keys) {
      if (state.has(k)) out += k + "=" + state.get(k) + "|";
    }
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
