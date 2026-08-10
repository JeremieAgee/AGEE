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

// Copies the shared perception keys from `blackboard` into `dst`, e.g. GOAPInstance.worldState
// or UtilityInstance.blackboard. The guard below is keyed on whether "hasTarget" was ever
// *set* on the blackboard (i.e. whether AISystem bridged a Perception component onto it at
// all, see AISystem.update()) -- not on its current true/false *value* -- so this syncs live
// state (including alertLevel and the targetLastX/Y/Z "last known position" fields, which stay
// meaningful for last-known-location reasoning even after a target is lost) on every tick the
// entity has Perception, regardless of whether hasTarget is currently true or false. It's a
// no-op only when the entity has no Perception component bridged onto the blackboard at all
// (dst keeps whatever it last held).
export function syncPerceptionState(dst: Map<string, any>, blackboard?: Blackboard | null): void {
  if (!blackboard?.has("hasTarget")) return;
  for (const key of PERCEPTION_KEYS) {
    dst.set(key, blackboard.get(key));
  }
}
