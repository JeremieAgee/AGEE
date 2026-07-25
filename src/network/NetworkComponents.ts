import { defineComponent } from "../ecs";

export const Replicated = defineComponent("Replicated", {
  networkId: "i32",
  owner: "i32",
  priority: "f32",
  lastSyncTick: "i32",
});

export const NetworkOwner = defineComponent("NetworkOwner", {
  clientId: "i32",
  authoritative: "u8",
});

export const NetworkInterpolated = defineComponent("NetworkInterpolated", {
  prevX: "f32", prevY: "f32", prevZ: "f32",
  prevRx: "f32", prevRy: "f32", prevRz: "f32",
  currX: "f32", currY: "f32", currZ: "f32",
  currRx: "f32", currRy: "f32", currRz: "f32",
  t: "f32",
  renderDelay: "f32",
});
