import type { Blackboard } from "./BehaviorTree";

// The perception fields AISystem writes onto an entity's shared Blackboard (see AISystem.ts)
// that GOAP/UtilityAI pull into their own per-instance state each tick. Kept as one list so
// adding/renaming a perception key only needs to change one place instead of staying in sync
// by hand across every AI paradigm that reads it.
const PERCEPTION_KEYS = [
  "hasTarget",
  "targetEntity",
  "alertLevel",
  "targetLastX",
  "targetLastY",
  "targetLastZ",
] as const;

// Copies the shared perception keys from `blackboard` into `dst` if a target has been
// perceived, e.g. GOAPInstance.worldState or UtilityInstance.blackboard. No-op if the entity
// currently has no target (dst keeps whatever it last held).
export function syncPerceptionState(dst: Map<string, any>, blackboard?: Blackboard | null): void {
  if (!blackboard?.has("hasTarget")) return;
  for (const key of PERCEPTION_KEYS) {
    dst.set(key, blackboard.get(key));
  }
}
