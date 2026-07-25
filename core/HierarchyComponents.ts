import { defineComponent } from "../ecs";

export const LocalTransform = defineComponent("LocalTransform", {
  x: "f32", y: "f32", z: "f32",
  rx: "f32", ry: "f32", rz: "f32", rw: "f32",
  sx: "f32", sy: "f32", sz: "f32",
});

export const WorldTransform = defineComponent("WorldTransform", {
  m00: "f32", m01: "f32", m02: "f32", m03: "f32",
  m10: "f32", m11: "f32", m12: "f32", m13: "f32",
  m20: "f32", m21: "f32", m22: "f32", m23: "f32",
  m30: "f32", m31: "f32", m32: "f32", m33: "f32",
  dirty: "u8",
});

export const Parent = defineComponent("Parent", {
  entity: "i32",
});

export const Children = defineComponent("Children", {
  entities: "ref",
});
