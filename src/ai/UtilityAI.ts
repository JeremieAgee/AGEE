import type { Blackboard } from "./BehaviorTree";

export type ScoreFunction = (eid: number, context: UtilityContext) => number;
export type UtilityActionFn = (eid: number, dt: number, context: UtilityContext) => void;

export interface UtilityContext {
  dt: number;
  blackboard: Map<string, any>;
  currentAction: string;
  actionTime: number;
}

export interface UtilityConsideration {
  name: string;
  score: ScoreFunction;
  weight: number;
}

export interface UtilityAction {
  name: string;
  considerations: UtilityConsideration[];
  execute: UtilityActionFn;
  cooldown?: number;
  minScore?: number;
  bonus?: number;
  momentum?: number;
}

export interface UtilitySet {
  name: string;
  actions: UtilityAction[];
  defaultAction?: string;
  inertia: number;
}

export class UtilitySetBuilder {
  private name: string;
  private actions: UtilityAction[] = [];
  private defaultAction?: string;
  private inertia = 0;

  constructor(name: string) {
    this.name = name;
  }

  action(
    name: string,
    execute: UtilityActionFn,
    considerations: UtilityConsideration[],
    opts?: { cooldown?: number; minScore?: number; bonus?: number; momentum?: number }
  ): this {
    this.actions.push({
      name,
      execute,
      considerations,
      cooldown: opts?.cooldown,
      minScore: opts?.minScore,
      bonus: opts?.bonus,
      momentum: opts?.momentum,
    });
    return this;
  }

  setDefault(name: string): this {
    this.defaultAction = name;
    return this;
  }

  setInertia(value: number): this {
    this.inertia = value;
    return this;
  }

  build(): UtilitySet {
    return {
      name: this.name,
      actions: this.actions,
      defaultAction: this.defaultAction,
      inertia: this.inertia,
    };
  }
}

export interface UtilityInstance {
  set: UtilitySet;
  currentAction: string;
  actionTime: number;
  cooldowns: Map<string, number>;
  blackboard: Map<string, any>;
  lastScores: Map<string, number>;
}

export class UtilityRunner {
  createInstance(set: UtilitySet): UtilityInstance {
    return {
      set,
      currentAction: set.defaultAction ?? (set.actions[0]?.name ?? ""),
      actionTime: 0,
      cooldowns: new Map(),
      blackboard: new Map(),
      lastScores: new Map(),
    };
  }

  tick(eid: number, instance: UtilityInstance, dt: number, blackboard?: Blackboard | null): string {
    if (blackboard?.has("hasTarget")) {
      instance.blackboard.set("hasTarget", blackboard.get("hasTarget"));
      instance.blackboard.set("targetEntity", blackboard.get("targetEntity"));
      instance.blackboard.set("alertLevel", blackboard.get("alertLevel"));
      instance.blackboard.set("targetLastX", blackboard.get("targetLastX"));
      instance.blackboard.set("targetLastY", blackboard.get("targetLastY"));
      instance.blackboard.set("targetLastZ", blackboard.get("targetLastZ"));
    }

    const ctx: UtilityContext = {
      dt,
      blackboard: instance.blackboard,
      currentAction: instance.currentAction,
      actionTime: instance.actionTime,
    };

    for (const [name, remaining] of instance.cooldowns) {
      const next = remaining - dt;
      if (next <= 0) instance.cooldowns.delete(name);
      else instance.cooldowns.set(name, next);
    }

    let bestAction = "";
    let bestScore = -Infinity;

    for (const action of instance.set.actions) {
      if (instance.cooldowns.has(action.name)) {
        instance.lastScores.set(action.name, 0);
        continue;
      }

      let score = this.scoreAction(eid, action, ctx);

      if (action.bonus) score += action.bonus;

      if (action.name === instance.currentAction) {
        score += instance.set.inertia;
        if (action.momentum) score += action.momentum;
      }

      instance.lastScores.set(action.name, score);

      if (action.minScore !== undefined && score < action.minScore) continue;

      if (score > bestScore) {
        bestScore = score;
        bestAction = action.name;
      }
    }

    if (!bestAction && instance.set.defaultAction) {
      bestAction = instance.set.defaultAction;
    }

    if (bestAction && bestAction !== instance.currentAction) {
      const prevAction = instance.set.actions.find(a => a.name === instance.currentAction);
      if (prevAction?.cooldown) {
        instance.cooldowns.set(prevAction.name, prevAction.cooldown);
      }
      instance.currentAction = bestAction;
      instance.actionTime = 0;
    }

    const active = instance.set.actions.find(a => a.name === instance.currentAction);
    if (active) {
      active.execute(eid, dt, ctx);
    }
    instance.actionTime += dt;

    return instance.currentAction;
  }

  private scoreAction(eid: number, action: UtilityAction, ctx: UtilityContext): number {
    if (action.considerations.length === 0) return 0;

    let product = 1;
    for (const c of action.considerations) {
      const raw = c.score(eid, ctx);
      const clamped = Math.max(0, Math.min(1, raw));
      // Weight as an exponent, not a multiplier: pow(clamped, weight) stays inside [0,1]
      // for any weight >= 0 (weight 1 = no change, >1 makes the consideration more
      // discriminating, <1 flattens it), whereas multiplying a [0,1] factor by an
      // unbounded/negative weight breaks the assumed product range outright.
      const weight = Math.max(0, c.weight);
      product *= Math.pow(clamped, weight);
    }

    // Geometric mean rather than a raw product, so an action isn't penalized just for
    // having more considerations than another action to multiply together.
    return Math.pow(product, 1 / action.considerations.length);
  }
}

export const ResponseCurves = {
  linear: (x: number) => x,
  quadratic: (x: number) => x * x,
  inverse: (x: number) => 1 - x,
  inverseQuadratic: (x: number) => 1 - x * x,
  sigmoid: (x: number, k = 10) => 1 / (1 + Math.exp(-k * (x - 0.5))),
  smoothstep: (x: number) => x * x * (3 - 2 * x),
  threshold: (x: number, t = 0.5) => x >= t ? 1 : 0,
  // Normalizes value into [min,max] range to a 0-1 score -- the result of that division is
  // already the normalized score, so it must be clamped to [0,1], not to [min,max] again
  // (which silently returned the wrong, often min-floored value whenever min !== 0).
  clamp: (value: number, min: number, max: number) => Math.max(0, Math.min(1, (value - min) / (max - min))),
};
