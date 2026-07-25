import { defineComponent } from "../ecs";

export const Animator = defineComponent("Animator", {
  mixerSlot: "i32",
  currentClip: "i32",
  prevClip: "i32",
  time: "f32",
  speed: "f32",
  blendFactor: "f32",
  blendDuration: "f32",
  playing: "bool",
  looping: "bool",
});

