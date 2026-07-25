import { defineComponent } from "../ecs";

export const Joint = defineComponent("Joint", {
  jointType:    "u8",   // 0=fixed, 1=revolute, 2=spherical, 3=prismatic
  dofMask:      "u8",   // bitmask: AngX=1, AngY=2, AngZ=4, LinX=8, LinY=16, LinZ=32
  rapierHandle: "i32",

  limLo1: "f32", limHi1: "f32",
  limLo2: "f32", limHi2: "f32",
  limLo3: "f32", limHi3: "f32",

  anchorAx: "f32", anchorAy: "f32", anchorAz: "f32",
  anchorBx: "f32", anchorBy: "f32", anchorBz: "f32",
});

export const enum JointType {
  FIXED     = 0,
  REVOLUTE  = 1,
  SPHERICAL = 2,
  PRISMATIC = 3,
}

export const enum DofMask {
  ANG_X = 1 << 0,
  ANG_Y = 1 << 1,
  ANG_Z = 1 << 2,
  LIN_X = 1 << 3,
  LIN_Y = 1 << 4,
  LIN_Z = 1 << 5,
}
