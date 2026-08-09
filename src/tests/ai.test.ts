import { describe, it, expect, beforeEach, vi } from "vitest";

import { BehaviorTreeRunner, Blackboard, BTNode } from "../ai/BehaviorTree";
import { FSMBuilder, FSMRunner } from "../ai/FSM";
import { GOAPDomainBuilder, GOAPPlanner, WorldState } from "../ai/GOAP";
import { UtilitySetBuilder, UtilityRunner, ResponseCurves, UtilityContext } from "../ai/UtilityAI";
import { SteeringSystem, SteeringAgent, SteeringFlag } from "../ai/SteeringBehaviors";
import { AISystem, AIAgent, Perception } from "../ai/AISystem";
import { World } from "../ecs/World";
import { Transform } from "../core/Components";
import * as DeterministicMath from "../core/DeterministicMath";

function approx(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) < eps;
}

// ===========================================================================
// BehaviorTree — normal (non-colliding) node behavior
// ===========================================================================

describe("BehaviorTree — leaf nodes", () => {
  it("action node returns the status the registered fn returns", () => {
    const runner = new BehaviorTreeRunner();
    runner.registerAction("doThing", () => "success");
    const bb = new Blackboard();
    const node: BTNode = { type: "action", name: "doThing" };
    expect(runner.tick(1, node, bb, 0.016)).toBe("success");
  });

  it("action node with no registered fn fails", () => {
    const runner = new BehaviorTreeRunner();
    const bb = new Blackboard();
    const node: BTNode = { type: "action", name: "missing" };
    expect(runner.tick(1, node, bb, 0.016)).toBe("failure");
  });

  it("condition node succeeds/fails based on registered predicate", () => {
    const runner = new BehaviorTreeRunner();
    runner.registerCondition("isHungry", (_eid, bb) => bb.get<boolean>("hungry") === true);
    const bb = new Blackboard();
    const node: BTNode = { type: "condition", name: "isHungry" };

    expect(runner.tick(1, node, bb, 0.016)).toBe("failure");
    bb.set("hungry", true);
    expect(runner.tick(1, node, bb, 0.016)).toBe("success");
  });
});

describe("BehaviorTree — Sequence", () => {
  it("succeeds only when all children succeed, short-circuits on first failure", () => {
    const runner = new BehaviorTreeRunner();
    const calls: string[] = [];
    runner.registerAction("a1", () => { calls.push("a1"); return "success"; });
    runner.registerAction("a2", () => { calls.push("a2"); return "failure"; });
    runner.registerAction("a3", () => { calls.push("a3"); return "success"; });

    const tree: BTNode = {
      type: "sequence",
      name: "seq1",
      children: [
        { type: "action", name: "a1" },
        { type: "action", name: "a2" },
        { type: "action", name: "a3" },
      ],
    };
    const bb = new Blackboard();
    const status = runner.tick(1, tree, bb, 0.016);
    expect(status).toBe("failure");
    expect(calls).toEqual(["a1", "a2"]); // a3 never reached
  });

  it("resumes a running child on the next tick from where it left off", () => {
    const runner = new BehaviorTreeRunner();
    let secondCallCount = 0;
    let firstCallCount = 0;
    runner.registerAction("first", () => { firstCallCount++; return "success"; });
    runner.registerAction("second", () => {
      secondCallCount++;
      return secondCallCount < 2 ? "running" : "success";
    });

    const tree: BTNode = {
      type: "sequence",
      name: "seqResume",
      children: [{ type: "action", name: "first" }, { type: "action", name: "second" }],
    };
    const bb = new Blackboard();

    expect(runner.tick(1, tree, bb, 0.016)).toBe("running");
    expect(firstCallCount).toBe(1);
    expect(secondCallCount).toBe(1);

    // Second tick: sequence should resume at "second", NOT re-run "first".
    expect(runner.tick(1, tree, bb, 0.016)).toBe("success");
    expect(firstCallCount).toBe(1); // still 1 -- not re-run
    expect(secondCallCount).toBe(2);
  });
});

describe("BehaviorTree — Selector", () => {
  it("returns success from the first succeeding child, skips the rest", () => {
    const runner = new BehaviorTreeRunner();
    const calls: string[] = [];
    runner.registerAction("failA", () => { calls.push("failA"); return "failure"; });
    runner.registerAction("succB", () => { calls.push("succB"); return "success"; });
    runner.registerAction("succC", () => { calls.push("succC"); return "success"; });

    const tree: BTNode = {
      type: "selector",
      name: "sel1",
      children: [
        { type: "action", name: "failA" },
        { type: "action", name: "succB" },
        { type: "action", name: "succC" },
      ],
    };
    const bb = new Blackboard();
    expect(runner.tick(1, tree, bb, 0.016)).toBe("success");
    expect(calls).toEqual(["failA", "succB"]); // succC never reached
  });

  it("fails only when every child fails", () => {
    const runner = new BehaviorTreeRunner();
    runner.registerAction("failA", () => "failure");
    runner.registerAction("failB", () => "failure");
    const tree: BTNode = {
      type: "selector",
      name: "selAllFail",
      children: [{ type: "action", name: "failA" }, { type: "action", name: "failB" }],
    };
    expect(runner.tick(1, tree, new Blackboard(), 0.016)).toBe("failure");
  });
});

describe("BehaviorTree — Parallel", () => {
  it("stays running while any child is running, doesn't re-run already-completed children", () => {
    const runner = new BehaviorTreeRunner();
    let runningCalls = 0;
    let doneCalls = 0;
    runner.registerAction("runningChild", () => {
      runningCalls++;
      return runningCalls < 2 ? "running" : "success";
    });
    runner.registerAction("doneChild", () => { doneCalls++; return "success"; });

    const tree: BTNode = {
      type: "parallel",
      name: "par1",
      children: [{ type: "action", name: "runningChild" }, { type: "action", name: "doneChild" }],
    };
    const bb = new Blackboard();

    expect(runner.tick(1, tree, bb, 0.016)).toBe("running");
    expect(doneCalls).toBe(1); // ticked once, completed, memoized

    expect(runner.tick(1, tree, bb, 0.016)).toBe("success");
    expect(doneCalls).toBe(1); // NOT re-ticked while sibling was still running
    expect(runningCalls).toBe(2);
  });

  it("reports failure if any child fails, even if others succeed", () => {
    const runner = new BehaviorTreeRunner();
    runner.registerAction("ok", () => "success");
    runner.registerAction("bad", () => "failure");
    const tree: BTNode = {
      type: "parallel",
      name: "parFail",
      children: [{ type: "action", name: "ok" }, { type: "action", name: "bad" }],
    };
    expect(runner.tick(1, tree, new Blackboard(), 0.016)).toBe("failure");
  });
});

describe("BehaviorTree — Decorators", () => {
  it("invert flips success/failure and passes through running", () => {
    const runner = new BehaviorTreeRunner();
    runner.registerAction("succ", () => "success");
    runner.registerAction("fail", () => "failure");
    runner.registerAction("run", () => "running");

    const invSucc: BTNode = { type: "decorator", name: "d1", decorator: "invert", children: [{ type: "action", name: "succ" }] };
    const invFail: BTNode = { type: "decorator", name: "d2", decorator: "invert", children: [{ type: "action", name: "fail" }] };
    const invRun: BTNode = { type: "decorator", name: "d3", decorator: "invert", children: [{ type: "action", name: "run" }] };

    expect(runner.tick(1, invSucc, new Blackboard(), 0.016)).toBe("failure");
    expect(runner.tick(1, invFail, new Blackboard(), 0.016)).toBe("success");
    expect(runner.tick(1, invRun, new Blackboard(), 0.016)).toBe("running");
  });

  it("succeedAlways always reports success unless still running", () => {
    const runner = new BehaviorTreeRunner();
    runner.registerAction("fail", () => "failure");
    const node: BTNode = { type: "decorator", name: "d4", decorator: "succeedAlways", children: [{ type: "action", name: "fail" }] };
    expect(runner.tick(1, node, new Blackboard(), 0.016)).toBe("success");
  });
});

describe("BehaviorTree — Subtree", () => {
  it("ticks the registered subtree by treeId", () => {
    const runner = new BehaviorTreeRunner();
    runner.registerAction("innerAction", () => "success");
    runner.registerSubtree("mySubtree", { type: "action", name: "innerAction" });

    const node: BTNode = { type: "subtree", name: "ref1", treeId: "mySubtree" };
    expect(runner.tick(1, node, new Blackboard(), 0.016)).toBe("success");
  });

  it("fails if the referenced subtree isn't registered", () => {
    const runner = new BehaviorTreeRunner();
    const node: BTNode = { type: "subtree", name: "ref2", treeId: "doesNotExist" };
    expect(runner.tick(1, node, new Blackboard(), 0.016)).toBe("failure");
  });
});

// ===========================================================================
// BUG #1 (AUDIT): node running-state is keyed by node.name, not identity/path.
// Two independent Sequence nodes sharing the same name collide on the same
// blackboard key. See BehaviorTree.ts:83 (tickSequence key = runningChildKey + node.name).
// ===========================================================================

describe("BehaviorTree — BUG: same-name node state collision", () => {
  it("two differently-named-but-identical 'patrol' sequences ticked in the same Parallel should track independent running-child state", () => {
    // AUDIT: node state keyed by name collides across identically-named nodes — see BehaviorTree.ts:83
    const runner = new BehaviorTreeRunner();

    let patrolBChild0Called = false;

    runner.registerAction("patrolA_child0", () => "success");
    runner.registerAction("patrolA_child1_running", () => "running");
    runner.registerAction("patrolB_child0", () => { patrolBChild0Called = true; return "success"; });
    runner.registerAction("patrolB_child1", () => "success");

    // Two independent Sequence nodes that both happen to be named "patrol" (e.g. two
    // separately-authored patrol routines nested under a Parallel supervisor).
    const patrolA: BTNode = {
      type: "sequence",
      name: "patrol",
      children: [{ type: "action", name: "patrolA_child0" }, { type: "action", name: "patrolA_child1_running" }],
    };
    const patrolB: BTNode = {
      type: "sequence",
      name: "patrol",
      children: [{ type: "action", name: "patrolB_child0" }, { type: "action", name: "patrolB_child1" }],
    };
    const root: BTNode = { type: "parallel", name: "root", children: [patrolA, patrolB] };

    const bb = new Blackboard();
    runner.tick(1, root, bb, 0.016);

    // patrolB is a fresh, independent sequence -- its first child should always run.
    // Because patrolA's tick wrote its running index (1) under key "__bt_running_patrol"
    // (derived purely from node.name), patrolB reads that same key as ITS OWN start index,
    // skipping patrolB_child0 entirely.
    expect(patrolBChild0Called).toBe(true);
  });
});

// ===========================================================================
// BUG #2 (AUDIT): no interrupt/abort hook. When something forces a selector to move
// on from a still-conceptually-running branch (there's no built-in API for this --
// callers can only reach in and mutate the blackboard directly, which is exactly what
// this test simulates), that branch's own nested running-index is never cleared.
// Re-entering the branch later resumes mid-branch instead of restarting from the top.
// See BehaviorTree.ts:101-119 (tickSelector).
// ===========================================================================

describe("BehaviorTree — BUG: no abort/interrupt clears stale nested running state", () => {
  it("a branch re-entered after being switched away from should restart from its first child", () => {
    const runner = new BehaviorTreeRunner();
    let a1Calls = 0;
    let a2Calls = 0;
    let a2Mode: "running" | "success" = "running";

    runner.registerAction("actionA1", () => { a1Calls++; return "success"; });
    runner.registerAction("actionA2", () => { a2Calls++; return a2Mode; });
    runner.registerAction("actionB", () => "success");

    const branchA: BTNode = {
      type: "sequence",
      name: "branchA",
      children: [{ type: "action", name: "actionA1" }, { type: "action", name: "actionA2" }],
    };
    const branchB: BTNode = { type: "action", name: "actionB" };
    const root: BTNode = { type: "selector", name: "root", children: [branchA, branchB] };

    const bb = new Blackboard();

    // Tick 1: branchA partially runs -- actionA1 succeeds, actionA2 leaves it "running".
    expect(runner.tick(1, root, bb, 0.016)).toBe("running");
    expect(a1Calls).toBe(1);
    expect(bb.get("__bt_running_branchA")).toBe(1); // nested running index stored

    // Simulate an external interrupt/abort forcing the tree to switch to branchB.
    // There's no API for this in the engine, so the only way to represent "the game
    // decided to abandon branchA" is to poke the blackboard directly -- which is itself
    // evidence of the missing hook.
    bb.set("__bt_running_root", 1);

    // Tick 2: root resumes at branchB (index 1) and it succeeds, resetting root's own key.
    expect(runner.tick(1, root, bb, 0.016)).toBe("success");
    expect(bb.get("__bt_running_root")).toBeUndefined();

    // branchA's OWN nested key was never touched during the abort -- it's still stale.
    expect(bb.get("__bt_running_branchA")).toBe(1);

    a1Calls = 0;
    a2Calls = 0;

    // Tick 3: root naturally restarts at index 0 (branchA) since its key was cleared.
    // A correct implementation would restart branchA fresh, calling actionA1 again.
    runner.tick(1, root, bb, 0.016);
    expect(a1Calls).toBe(1); // EXPECTED: branchA restarts from the top
  });
});

// ===========================================================================
// FSM — correct behavior
// ===========================================================================

describe("FSM", () => {
  it("stays in current state and runs onUpdate when no guard passes", () => {
    const events: string[] = [];
    const def = new FSMBuilder("guard")
      .state("idle", { onUpdate: () => events.push("idle:update") })
      .transition("chase", (_eid, bb) => bb.get("seeEnemy") === true)
      .build();

    const runner = new FSMRunner();
    const instance = runner.createInstance(def);
    const result = runner.tick(1, instance, 0.5);

    expect(result).toBe("idle");
    expect(instance.timeInState).toBeCloseTo(0.5, 5);
    expect(events).toEqual(["idle:update"]);
  });

  it("transitions when guard passes, running onExit -> onEnter -> onUpdate in order", () => {
    const events: string[] = [];
    const def = new FSMBuilder("basic")
      .state("idle", {
        onEnter: () => events.push("idle:enter"),
        onUpdate: () => events.push("idle:update"),
        onExit: () => events.push("idle:exit"),
      })
      .transition("chase", (_eid, bb) => bb.get("seeEnemy") === true)
      .state("chase", {
        onEnter: () => events.push("chase:enter"),
        onUpdate: () => events.push("chase:update"),
      })
      .build();

    const runner = new FSMRunner();
    const instance = runner.createInstance(def);
    instance.blackboard.set("seeEnemy", true);

    const result = runner.tick(1, instance, 0.1);

    expect(result).toBe("chase");
    expect(instance.currentState).toBe("chase");
    expect(instance.previousState).toBe("idle");
    expect(instance.timeInState).toBe(0);
    expect(instance.stateChangeCount).toBe(1);
    expect(events).toEqual(["idle:exit", "chase:enter", "chase:update"]);
  });

  it("picks the higher-priority transition when multiple guards pass", () => {
    const def = new FSMBuilder("priority")
      .state("idle")
      .transition("chase", () => true, 1)
      .transition("flee", () => true, 10)
      .state("chase")
      .state("flee")
      .build();

    const runner = new FSMRunner();
    const instance = runner.createInstance(def);
    const result = runner.tick(1, instance, 0.1);

    expect(result).toBe("flee");
  });

  it("forceState runs exit/enter/update and resets timeInState", () => {
    const events: string[] = [];
    const def = new FSMBuilder("force")
      .state("idle", { onExit: () => events.push("idle:exit") })
      .state("attack", {
        onEnter: () => events.push("attack:enter"),
        onUpdate: () => events.push("attack:update"),
      })
      .build();

    const runner = new FSMRunner();
    const instance = runner.createInstance(def);
    instance.timeInState = 5;

    runner.forceState(1, instance, "attack");

    expect(instance.currentState).toBe("attack");
    expect(instance.previousState).toBe("idle");
    expect(instance.timeInState).toBe(0);
    expect(instance.stateChangeCount).toBe(1);
    expect(events).toEqual(["idle:exit", "attack:enter", "attack:update"]);
  });
});

// ===========================================================================
// GOAP — planner correctness
// ===========================================================================

describe("GOAP", () => {
  function buildWoodcuttingDomain() {
    return new GOAPDomainBuilder("woodcutting")
      .action("pickUpAxe", 1, { haveAxe: false }, { haveAxe: true }, () => "done")
      .action("walkToTree", 1, { nearTree: false }, { nearTree: true }, () => "done")
      .action("chopTree", 1, { nearTree: true, haveAxe: true }, { haveWood: true }, () => "done")
      .goal("getWood", { haveWood: true }, () => 1)
      .build();
  }

  it("finds a valid plan whose precondition/effect chain is satisfiable step by step", () => {
    const domain = buildWoodcuttingDomain();
    const planner = new GOAPPlanner();

    const initialState: WorldState = new Map([
      ["nearTree", false],
      ["haveAxe", false],
      ["haveWood", false],
    ]);
    const goal: WorldState = new Map([["haveWood", true]]);

    const plan = planner.plan(domain.actions, initialState, goal);

    expect(plan.length).toBe(3);
    expect(plan[plan.length - 1].name).toBe("chopTree");
    expect(plan.map(a => a.name).sort()).toEqual(["chopTree", "pickUpAxe", "walkToTree"]);

    // Walk the plan and verify every action's preconditions are actually met by the
    // state accumulated from all prior actions' effects (not just "a plan exists").
    const state = new Map(initialState);
    for (const action of plan) {
      for (const [key, val] of action.preconditions) {
        expect(state.get(key)).toBe(val);
      }
      for (const [key, val] of action.effects) {
        state.set(key, val);
      }
    }
    for (const [key, val] of goal) {
      expect(state.get(key)).toBe(val);
    }
  });

  it("returns no plan when the goal is unreachable with the given actions", () => {
    const domain = new GOAPDomainBuilder("stuck")
      .action("chopTree", 1, { nearTree: true, haveAxe: true }, { haveWood: true }, () => "done")
      .goal("getWood", { haveWood: true }, () => 1)
      .build();
    const planner = new GOAPPlanner();
    const plan = planner.plan(domain.actions, new Map([["nearTree", false], ["haveAxe", false]]), new Map([["haveWood", true]]));
    expect(plan).toEqual([]);
  });

  it("prefers the cheaper of two alternative plans", () => {
    const domain = new GOAPDomainBuilder("cheapest")
      .action("expensiveDirect", 10, {}, { haveWood: true }, () => "done")
      .action("pickUpAxe", 1, { haveAxe: false }, { haveAxe: true }, () => "done")
      .action("chopTree", 1, { haveAxe: true }, { haveWood: true }, () => "done")
      .goal("getWood", { haveWood: true }, () => 1)
      .build();
    const planner = new GOAPPlanner();
    const plan = planner.plan(domain.actions, new Map([["haveAxe", false]]), new Map([["haveWood", true]]));
    expect(plan.map(a => a.name)).toEqual(["pickUpAxe", "chopTree"]); // cost 2 vs 10
  });

  it("tick() selects the highest-priority unsatisfied goal and executes the plan to completion", () => {
    const executed: string[] = [];
    const domain = new GOAPDomainBuilder("ticking")
      .action("step1", 1, { done1: false }, { done1: true }, () => { executed.push("step1"); return "done"; })
      .action("step2", 1, { done1: true }, { done2: true }, () => { executed.push("step2"); return "done"; })
      .goal("lowPriority", { done2: true }, () => 1)
      .goal("alreadyDone", { alreadySatisfied: true }, () => 100)
      .build();

    const planner = new GOAPPlanner();
    const instance = planner.createInstance(domain, 10);
    instance.worldState.set("done1", false);
    instance.worldState.set("done2", false);
    instance.worldState.set("alreadySatisfied", true); // this goal is already met, should be skipped

    let result = planner.tick(1, instance, 0.1);
    expect(instance.currentGoal?.name).toBe("lowPriority");
    expect(result).toBe("step1");

    result = planner.tick(1, instance, 0.1);
    expect(result).toBe("step2");
    expect(instance.worldState.get("done2")).toBe(true);

    result = planner.tick(1, instance, 0.1);
    expect(result).toBe("done");
    expect(executed).toEqual(["step1", "step2"]);
  });
});

// ===========================================================================
// UtilityAI — scoring/selection
// ===========================================================================

describe("UtilityAI", () => {
  it("picks the action with the highest computed score", () => {
    const executed: string[] = [];
    const set = new UtilitySetBuilder("test")
      .action("flee", (_eid, _dt, _ctx) => { executed.push("flee"); }, [
        { name: "health", score: (_eid, ctx) => ctx.blackboard.get("healthFactor") ?? 0, weight: 1 },
      ])
      .action("idle", (_eid, _dt, _ctx) => { executed.push("idle"); }, [
        { name: "const", score: () => 0.3, weight: 1 },
      ])
      .build();

    const runner = new UtilityRunner();
    const instance = runner.createInstance(set);
    instance.blackboard.set("healthFactor", 0.9); // flee (0.9) should beat idle (0.3)

    const chosen = runner.tick(1, instance, 0.1);
    expect(chosen).toBe("flee");
    expect(executed).toEqual(["flee"]);
    expect(instance.lastScores.get("flee")).toBeCloseTo(0.9, 5);
    expect(instance.lastScores.get("idle")).toBeCloseTo(0.3, 5);
  });

  it("uses geometric mean across multiple considerations, not a raw product", () => {
    const set = new UtilitySetBuilder("multi")
      .action("multi", () => {}, [
        { name: "a", score: () => 0.5, weight: 1 },
        { name: "b", score: () => 0.5, weight: 1 },
      ])
      .build();
    const runner = new UtilityRunner();
    const instance = runner.createInstance(set);
    runner.tick(1, instance, 0.1);
    // Geometric mean of [0.5, 0.5] is 0.5 (not 0.25, which a raw product would give).
    expect(instance.lastScores.get("multi")).toBeCloseTo(0.5, 5);
  });

  it("respects minScore -- an action scoring below its floor is never selected", () => {
    const set = new UtilitySetBuilder("floor")
      .action("highButGated", () => {}, [{ name: "s", score: () => 0.9, weight: 1 }], { minScore: 0.95 })
      .action("fallback", () => {}, [{ name: "s", score: () => 0.2, weight: 1 }])
      .build();
    const runner = new UtilityRunner();
    const instance = runner.createInstance(set);
    const chosen = runner.tick(1, instance, 0.1);
    expect(chosen).toBe("fallback");
  });

  it("applies inertia so the current action resists flipping to a marginally-better one", () => {
    let currentScore = 0.5;
    const set = new UtilitySetBuilder("inertia")
      .setInertia(0.2)
      .action("current", () => {}, [{ name: "s", score: () => currentScore, weight: 1 }])
      .action("challenger", () => {}, [{ name: "s", score: () => 0.55, weight: 1 }])
      .build();
    const runner = new UtilityRunner();
    const instance = runner.createInstance(set);
    instance.currentAction = "current";

    // challenger (0.55) > current (0.5), but current gets +0.2 inertia => 0.7 wins.
    const chosen = runner.tick(1, instance, 0.1);
    expect(chosen).toBe("current");
  });

  it("puts a vacated action on cooldown and refuses to reselect it until it expires", () => {
    let aScore = 0.9;
    const set = new UtilitySetBuilder("cooldown")
      .action("a", () => {}, [{ name: "s", score: () => aScore, weight: 1 }], { cooldown: 1.0 })
      .action("b", () => {}, [{ name: "s", score: () => 0.1, weight: 1 }])
      .build();
    const runner = new UtilityRunner();
    const instance = runner.createInstance(set);
    instance.currentAction = "a";

    aScore = 0.0; // "a" no longer wins -- switch to "b"
    expect(runner.tick(1, instance, 0.1)).toBe("b");
    expect(instance.cooldowns.get("a")).toBeCloseTo(1.0, 5);

    aScore = 0.9; // "a" would win again on raw score...
    expect(runner.tick(1, instance, 0.1)).toBe("b"); // ...but it's on cooldown
    expect(instance.lastScores.get("a")).toBe(0);

    // Advance past the cooldown window.
    runner.tick(1, instance, 1.0);
    expect(instance.cooldowns.has("a")).toBe(false);
  });
});

describe("ResponseCurves", () => {
  it("computes the documented curve shapes", () => {
    expect(ResponseCurves.linear(0.3)).toBeCloseTo(0.3, 5);
    expect(ResponseCurves.quadratic(0.5)).toBeCloseTo(0.25, 5);
    expect(ResponseCurves.inverse(0.3)).toBeCloseTo(0.7, 5);
    expect(ResponseCurves.inverseQuadratic(0.5)).toBeCloseTo(0.75, 5);
    expect(ResponseCurves.smoothstep(0.5)).toBeCloseTo(0.5, 5);
    expect(ResponseCurves.threshold(0.6, 0.5)).toBe(1);
    expect(ResponseCurves.threshold(0.4, 0.5)).toBe(0);
    expect(ResponseCurves.sigmoid(0.5)).toBeCloseTo(0.5, 5);
  });

  it("clamp normalizes a value into [min,max] onto a 0-1 score, then clamps to 0-1", () => {
    expect(ResponseCurves.clamp(5, 0, 10)).toBeCloseTo(0.5, 5);
    expect(ResponseCurves.clamp(-5, 0, 10)).toBe(0); // below min clamps to 0, not negative
    expect(ResponseCurves.clamp(15, 0, 10)).toBe(1); // above max clamps to 1
    expect(ResponseCurves.clamp(6, 5, 10)).toBeCloseTo(0.2, 5); // non-zero min handled correctly
  });
});

// ===========================================================================
// SteeringBehaviors — vector math for individual behaviors
// ===========================================================================

function makeSteeringWorld() {
  const world = new World();
  const system = new SteeringSystem();
  world.addSystem(system);
  return { world, system };
}

function addSteerEntity(world: World, overrides: Partial<Record<string, number>> = {}) {
  const eid = world.createEntity();
  world.addComponent(eid, Transform, { x: overrides.x ?? 0, y: overrides.y ?? 0, z: overrides.z ?? 0, sx: 1, sy: 1, sz: 1 });
  world.addComponent(eid, SteeringAgent, {
    maxSpeed: 5, maxForce: 1000, mass: 1,
    vx: 0, vy: 0, vz: 0,
    targetX: 0, targetY: 0, targetZ: 0,
    arriveRadius: 0.5, slowRadius: 5,
    wanderAngle: 0, wanderRadius: 2, wanderDistance: 5, wanderJitter: 0,
    neighborRadius: 0, separationWeight: 1, alignmentWeight: 1, cohesionWeight: 1,
    groupId: 0, targetEid: -1, avoidDistance: 0, behaviors: 0,
    ...overrides,
  });
  return eid;
}

describe("SteeringBehaviors — Seek", () => {
  it("steers directly toward the target at up-to-maxSpeed closing velocity", () => {
    const { world, system } = makeSteeringWorld();
    const eid = addSteerEntity(world, { x: 0, y: 0, z: 0, targetX: 10, targetY: 0, targetZ: 0, maxSpeed: 5, behaviors: SteeringFlag.Seek });

    system.update(1 / 60);

    const store = world.getStore(SteeringAgent);
    // desired = normalize(target-pos)*maxSpeed = (5,0,0); steer = desired - velocity(0) = (5,0,0)
    expect(approx(store.get(eid, "steerX"), 5)).toBe(true);
    expect(approx(store.get(eid, "steerY"), 0)).toBe(true);
    expect(approx(store.get(eid, "steerZ"), 0)).toBe(true);
  });
});

describe("SteeringBehaviors — Flee", () => {
  it("steers directly away from the target", () => {
    const { world, system } = makeSteeringWorld();
    const eid = addSteerEntity(world, { x: 0, y: 0, z: 0, targetX: 10, targetY: 0, targetZ: 0, maxSpeed: 5, behaviors: SteeringFlag.Flee });

    system.update(1 / 60);

    const store = world.getStore(SteeringAgent);
    // desired = normalize(pos-target)*maxSpeed = (-5,0,0)
    expect(approx(store.get(eid, "steerX"), -5)).toBe(true);
    expect(approx(store.get(eid, "steerZ"), 0)).toBe(true);
  });
});

describe("SteeringBehaviors — Arrive", () => {
  it("seeks at full speed while outside the slow radius", () => {
    const { world, system } = makeSteeringWorld();
    const eid = addSteerEntity(world, { x: 0, y: 0, z: 0, targetX: 20, targetY: 0, targetZ: 0, maxSpeed: 5, slowRadius: 5, arriveRadius: 0.5, behaviors: SteeringFlag.Arrive });
    system.update(1 / 60);
    const store = world.getStore(SteeringAgent);
    expect(approx(store.get(eid, "steerX"), 5)).toBe(true); // same as full-speed seek
  });

  it("scales desired speed down proportionally to distance inside the slow radius", () => {
    const { world, system } = makeSteeringWorld();
    // dist=2, slowRadius=5 -> desiredSpeed = maxSpeed*(2/5) = 2 ; steer = dir*desiredSpeed = (2,0,0)
    const eid = addSteerEntity(world, { x: 0, y: 0, z: 0, targetX: 2, targetY: 0, targetZ: 0, maxSpeed: 5, slowRadius: 5, arriveRadius: 0.5, behaviors: SteeringFlag.Arrive });
    system.update(1 / 60);
    const store = world.getStore(SteeringAgent);
    expect(approx(store.get(eid, "steerX"), 2)).toBe(true);
  });

  it("decelerates to a stop inside the arrive radius", () => {
    const { world, system } = makeSteeringWorld();
    const eid = addSteerEntity(world, {
      x: 0, y: 0, z: 0, targetX: 0.1, targetY: 0, targetZ: 0,
      maxSpeed: 5, slowRadius: 5, arriveRadius: 0.5, vx: 3, vy: 0, vz: 0,
      behaviors: SteeringFlag.Arrive,
    });
    system.update(1 / 60);
    const store = world.getStore(SteeringAgent);
    // Inside arriveRadius: steer = -velocity
    expect(approx(store.get(eid, "steerX"), -3)).toBe(true);
  });
});

describe("SteeringBehaviors — Wander", () => {
  it("produces a steering force of magnitude ~maxSpeed in the wander-circle direction", () => {
    const { world, system } = makeSteeringWorld();
    // wanderJitter=0 keeps wanderAngle deterministic (0) regardless of Math.random().
    const eid = addSteerEntity(world, {
      x: 0, y: 0, z: 0, maxSpeed: 10, wanderRadius: 2, wanderDistance: 5, wanderJitter: 0, wanderAngle: 0,
      vx: 0, vy: 0, vz: 0, behaviors: SteeringFlag.Wander,
    });
    system.update(1 / 60);
    const store = world.getStore(SteeringAgent);
    const fx = store.get(eid, "steerX");
    const fz = store.get(eid, "steerZ");

    // Facing defaults to +Z when stationary. Wander target = (px + 0*wd, pz + 1*wd) + (cos0, sin0)*wr
    // = (0 + wr, wd) = (2, 5). Unit vector * maxSpeed(10) has magnitude exactly 10 (v=0).
    const mag = Math.sqrt(fx * fx + fz * fz);
    expect(approx(mag, 10, 1e-3)).toBe(true);
    expect(approx(Math.atan2(fx, fz), Math.atan2(2, 5), 1e-3)).toBe(true);
  });
});

// ===========================================================================
// Flocking (Separation/Alignment/Cohesion) queries a SpatialHash for neighbor candidates
// instead of scanning every other steering entity, so a distance check (and thus a dsqrt call)
// only happens against nearby candidates. Demonstrated via a deterministic count of dsqrt calls
// in the neighbor loop (not wall-clock timing, to avoid flaky CI).
// ===========================================================================

describe("SteeringBehaviors — flocking neighbor search uses a spatial partition", () => {
  function countSqrtCallsForNEntities(n: number): number {
    const { world, system } = makeSteeringWorld();
    for (let i = 0; i < n; i++) {
      addSteerEntity(world, {
        x: i, y: 0, z: 0, maxSpeed: 5,
        neighborRadius: 100000, separationWeight: 1, groupId: 0,
        behaviors: SteeringFlag.Separation,
      });
    }
    const originalSqrt = DeterministicMath.dsqrt;
    let count = 0;
    const spy = vi.spyOn(DeterministicMath, "dsqrt").mockImplementation((v: number) => {
      count++;
      return originalSqrt(v);
    });
    try {
      system.update(1 / 60);
    } finally {
      spy.mockRestore();
    }
    return count;
  }

  it("dsqrt call count should scale roughly linearly with a spatial partition, not quadratically", () => {
    const countAt10 = countSqrtCallsForNEntities(10);
    const countAt20 = countSqrtCallsForNEntities(20);
    const ratio = countAt20 / countAt10;
    // Doubling entity count with a spatial partition (or any sub-quadratic neighbor search)
    // would keep this ratio well under quadratic growth (4x). With the current O(n^2)
    // all-pairs scan it comes out at essentially exactly 4x.
    expect(ratio).toBeLessThan(2.5);
  });
});

// ===========================================================================
// BUG #3 (AUDIT): Perception data (hasTarget/alertLevel/targetEntity) is never
// bridged into the blackboard AISystem builds. Only eid/dt/x/y/z are injected
// (AISystem.ts update(), ~line 213-220). Any BT/FSM/GOAP/Utility condition or
// action reading bb.get("hasTarget") etc. silently gets undefined unless the
// user manually calls world.getStore(Perception) themselves.
// ===========================================================================

describe("AISystem — BUG: Perception is not bridged into the blackboard", () => {
  it("blackboard has no Perception fields even though the Perception component does", () => {
    const world = new World();
    const aiSystem = new AISystem();
    world.addSystem(aiSystem);

    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    world.addComponent(eid, Perception, {
      sightRange: 10, sightAngle: 0, hearingRange: 0,
      targetEntity: 999, hasTarget: true, alertLevel: 0.7,
      targetLastX: 0, targetLastY: 0, targetLastZ: 0,
    });

    const tree: BTNode = { type: "action", name: "noop" };
    aiSystem.btRunner.registerAction("noop", () => "success");
    aiSystem.createAgent(eid, tree);

    aiSystem.update(1 / 60);

    // Source-of-truth: the Perception component really does have this data.
    const perceptionStore = world.getStore(Perception);
    expect(perceptionStore.get(eid, "hasTarget")).toBe(1);

    const bb = aiSystem.getBlackboard(eid)!;
    expect(bb).toBeTruthy();

    // What IS auto-injected:
    expect(bb.has("eid")).toBe(true);
    expect(bb.has("dt")).toBe(true);
    expect(bb.has("x")).toBe(true);

    // EXPECTED (if Perception were bridged): the blackboard would also carry hasTarget.
    // ACTUAL: it's simply never copied over anywhere in AISystem.update().
    expect(bb.has("hasTarget")).toBe(true);
  });

  it("a naive condition function reading blackboard perception fields gets undefined and fails", () => {
    const world = new World();
    const aiSystem = new AISystem();
    world.addSystem(aiSystem);

    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    world.addComponent(eid, Perception, {
      sightRange: 10, sightAngle: 0, hearingRange: 0,
      targetEntity: 999, hasTarget: true, alertLevel: 0.7,
      targetLastX: 0, targetLastY: 0, targetLastZ: 0,
    });

    aiSystem.btRunner.registerCondition("hasTargetCond", (_eid, bb) => bb.get<boolean>("hasTarget") === true);
    const tree: BTNode = { type: "condition", name: "hasTargetCond" };
    aiSystem.createAgent(eid, tree);

    aiSystem.update(1 / 60);

    const agentStore = world.getStore(AIAgent);
    // lastStatus: 0=success, 1=failure, 2=running (per AISystem.update()'s mapping).
    // A user who (reasonably) expects Perception to be bridged would expect "success" (0)
    // here since hasTarget was set true on the component -- but it comes back failure (1)
    // because the condition read an undefined blackboard value.
    expect(agentStore.get(eid, "lastStatus")).toBe(0);
  });
});
