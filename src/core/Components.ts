import { defineComponent } from "../ecs";

export const Transform = defineComponent("Transform", {
  x: "f32",
  y: "f32",
  z: "f32",
  rx: "f32",
  ry: "f32",
  rz: "f32",
  sx: "f32",
  sy: "f32",
  sz: "f32",
});

export const Velocity = defineComponent("Velocity", {
  vx: "f32",
  vy: "f32",
  vz: "f32",
  ax: "f32",
  ay: "f32",
  az: "f32",
});

export const RigidBody = defineComponent("RigidBody", {
  bodyHandle: "i32",
  bodyType: "u8", // 0=dynamic, 1=fixed, 2=kinematic
  mass: "f32",
  restitution: "f32",
  friction: "f32",
});

export const Collider = defineComponent("Collider", {
  colliderHandle: "i32",
  shapeType: "u8", // 0=box, 1=sphere, 2=capsule, 3=cylinder
  halfX: "f32",
  halfY: "f32",
  halfZ: "f32",
  radius: "f32",
});

export const MeshRenderer = defineComponent("MeshRenderer", {
  meshRef: "ref",
  visible: "bool",
  // Set when a GPU-native twin of this THREE.Object3D (see GPUMeshRenderer) already
  // draws it — keeps the THREE-side draw suppressed without touching `visible`, which
  // stays the single source of truth for "is this entity supposed to be shown at all"
  // for both the THREE and GPU-native paths (see CullingSystem).
  skipThreeDraw: "bool",
  castShadow: "bool",
  receiveShadow: "bool",
});

export const Light = defineComponent("Light", {
  lightRef: "ref",
  lightType: "u8", // 0=point, 1=directional, 2=spot, 3=ambient
  color: "i32",
  intensity: "f32",
  distance: "f32",
  angle: "f32",
  penumbra: "f32",
  castShadow: "bool",
});

export const AudioSource = defineComponent("AudioSource", {
  bufferRef: "ref",
  sourceRef: "ref",
  volume: "f32",
  loop: "bool",
  playing: "bool",
  spatial: "bool",
});

export const ParticleEmitter = defineComponent("ParticleEmitter", {
  systemRef: "ref",
  maxParticles: "i32",
  emitRate: "f32",
  lifetime: "f32",
  speed: "f32",
  spread: "f32",
  startSize: "f32",
  endSize: "f32",
  startColor: "i32",
  endColor: "i32",
  active: "bool",
});

export const Tag = defineComponent("Tag", {
  value: "ref",
});

export const GPUMeshRenderer = defineComponent("GPUMeshRenderer", {
  meshHandle: "i32",
  materialHandle: "i32",
  visible: "bool",
  castShadow: "bool",
  receiveShadow: "bool",
});
