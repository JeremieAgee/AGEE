import * as THREE from "three";
import type { Handle } from "../core/handles/Handle";
import { BoneFlags, BoneCategory, ColliderType } from "./SkeletonDefinition";
import type { BoneConfig } from "./SkeletonDefinition";
import { JointType, DofMask } from "./SkeletonComponents";
import type { SkeletonSystem } from "./SkeletonSystem";
import type { JointConfig } from "./SkeletonSystem";
import type { PhysicsSystem } from "../systems/PhysicsSystem";

export const HUMANOID_BONES: BoneConfig[] = [
  { name: "hips",      parentIndex: -1, length: 0.15, category: BoneCategory.SPINE,  colliderType: ColliderType.BOX,     mass: 2.0,  flags: BoneFlags.SIMULATED, restPos: { x: 0, y: 0.85, z: 0 } },
  { name: "spine",     parentIndex: 0,  length: 0.25, category: BoneCategory.SPINE,  colliderType: ColliderType.CAPSULE, mass: 1.5,  flags: BoneFlags.SIMULATED, restPos: { x: 0, y: 1.08, z: 0 } },
  { name: "head",      parentIndex: 1,  length: 0.14, category: BoneCategory.HEAD,   colliderType: ColliderType.SPHERE,  mass: 1.0,  flags: BoneFlags.SIMULATED, restPos: { x: 0, y: 1.35, z: 0 } },
  { name: "upperArmL", parentIndex: 1,  length: 0.22, category: BoneCategory.ARM,    colliderType: ColliderType.CAPSULE, mass: 0.5,  flags: BoneFlags.SIMULATED, restPos: { x: -0.2, y: 1.08, z: 0 } },
  { name: "lowerArmL", parentIndex: 3,  length: 0.20, category: BoneCategory.ARM,    colliderType: ColliderType.CAPSULE, mass: 0.35, flags: BoneFlags.SIMULATED, restPos: { x: -0.2, y: 0.82, z: 0 } },
  { name: "upperArmR", parentIndex: 1,  length: 0.22, category: BoneCategory.ARM,    colliderType: ColliderType.CAPSULE, mass: 0.5,  flags: BoneFlags.SIMULATED, restPos: { x: 0.2,  y: 1.08, z: 0 }, mirrorPartner: 3 },
  { name: "lowerArmR", parentIndex: 5,  length: 0.20, category: BoneCategory.ARM,    colliderType: ColliderType.CAPSULE, mass: 0.35, flags: BoneFlags.SIMULATED, restPos: { x: 0.2,  y: 0.82, z: 0 }, mirrorPartner: 4 },
  { name: "upperLegL", parentIndex: 0,  length: 0.30, category: BoneCategory.LEG,    colliderType: ColliderType.CAPSULE, mass: 0.9,  flags: BoneFlags.SIMULATED, restPos: { x: -0.1, y: 0.55, z: 0 } },
  { name: "lowerLegL", parentIndex: 7,  length: 0.28, category: BoneCategory.LEG,    colliderType: ColliderType.CAPSULE, mass: 0.6,  flags: BoneFlags.SIMULATED, restPos: { x: -0.1, y: 0.25, z: 0 } },
  { name: "upperLegR", parentIndex: 0,  length: 0.30, category: BoneCategory.LEG,    colliderType: ColliderType.CAPSULE, mass: 0.9,  flags: BoneFlags.SIMULATED, restPos: { x: 0.1,  y: 0.55, z: 0 }, mirrorPartner: 7 },
  { name: "lowerLegR", parentIndex: 9,  length: 0.28, category: BoneCategory.LEG,    colliderType: ColliderType.CAPSULE, mass: 0.6,  flags: BoneFlags.SIMULATED, restPos: { x: 0.1,  y: 0.25, z: 0 }, mirrorPartner: 8 },
];

export const HUMANOID_JOINTS: JointConfig[] = [
  { parentBone: 0, childBone: 1, type: JointType.SPHERICAL, dofMask: DofMask.ANG_X | DofMask.ANG_Z,
    anchors: { ax: 0, ay: 0.1, az: 0, bx: 0, by: -0.12, bz: 0 } },
  { parentBone: 1, childBone: 2, type: JointType.SPHERICAL, dofMask: DofMask.ANG_X | DofMask.ANG_Y,
    anchors: { ax: 0, ay: 0.14, az: 0, bx: 0, by: -0.07, bz: 0 } },
  { parentBone: 1, childBone: 3, type: JointType.SPHERICAL, dofMask: DofMask.ANG_X | DofMask.ANG_Z,
    anchors: { ax: -0.14, ay: 0.08, az: 0, bx: 0, by: 0.11, bz: 0 } },
  { parentBone: 3, childBone: 4, type: JointType.REVOLUTE,  dofMask: DofMask.ANG_X,
    anchors: { ax: 0, ay: -0.11, az: 0, bx: 0, by: 0.1, bz: 0 },
    limits: { lo1: -2.5, hi1: 0 } },
  { parentBone: 1, childBone: 5, type: JointType.SPHERICAL, dofMask: DofMask.ANG_X | DofMask.ANG_Z,
    anchors: { ax: 0.14, ay: 0.08, az: 0, bx: 0, by: 0.11, bz: 0 } },
  { parentBone: 5, childBone: 6, type: JointType.REVOLUTE,  dofMask: DofMask.ANG_X,
    anchors: { ax: 0, ay: -0.11, az: 0, bx: 0, by: 0.1, bz: 0 },
    limits: { lo1: 0, hi1: 2.5 } },
  { parentBone: 0, childBone: 7, type: JointType.SPHERICAL, dofMask: DofMask.ANG_X | DofMask.ANG_Z,
    anchors: { ax: -0.06, ay: -0.08, az: 0, bx: 0, by: 0.15, bz: 0 } },
  { parentBone: 7, childBone: 8, type: JointType.REVOLUTE,  dofMask: DofMask.ANG_X,
    anchors: { ax: 0, ay: -0.15, az: 0, bx: 0, by: 0.14, bz: 0 },
    limits: { lo1: 0, hi1: 2.5 } },
  { parentBone: 0, childBone: 9, type: JointType.SPHERICAL, dofMask: DofMask.ANG_X | DofMask.ANG_Z,
    anchors: { ax: 0.06, ay: -0.08, az: 0, bx: 0, by: 0.15, bz: 0 } },
  { parentBone: 9, childBone: 10, type: JointType.REVOLUTE, dofMask: DofMask.ANG_X,
    anchors: { ax: 0, ay: -0.15, az: 0, bx: 0, by: 0.14, bz: 0 },
    limits: { lo1: 0, hi1: 2.5 } },
];

export enum HumanoidBone {
  HIPS, SPINE, HEAD,
  UPPER_ARM_L, LOWER_ARM_L,
  UPPER_ARM_R, LOWER_ARM_R,
  UPPER_LEG_L, LOWER_LEG_L,
  UPPER_LEG_R, LOWER_LEG_R,
}

export interface BonePivot {
  pivot: THREE.Object3D;
  mesh: THREE.Mesh;
}

export interface HumanoidMaterials {
  body: THREE.Material;
  eyes: THREE.Material;
}

export interface HumanoidData {
  group: THREE.Group;
  pivots: BonePivot[];
  eyes: THREE.Mesh[];
  defHandle: Handle;
  instHandle: Handle;
  walkPhase: number;
  ragdolling: boolean;
}

let sharedDefHandle: Handle | null = null;

function getOrCreateDefinition(skeleton: SkeletonSystem): Handle {
  if (sharedDefHandle !== null) return sharedDefHandle;
  sharedDefHandle = skeleton.createDefinition(HUMANOID_BONES);
  return sharedDefHandle;
}

function addPivot(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
  const pivot = new THREE.Object3D();
  pivot.position.set(x, y, z);
  parent.add(pivot);
  return pivot;
}

function buildBody(group: THREE.Group, mat: HumanoidMaterials): { pivots: BonePivot[]; eyes: THREE.Mesh[] } {
  const pivots: BonePivot[] = [];
  const body = mat.body;

  function reg(boneIdx: number, pivot: THREE.Object3D, mesh: THREE.Mesh): BonePivot {
    mesh.castShadow = true;
    pivot.add(mesh);
    const bp: BonePivot = { pivot, mesh };
    pivots[boneIdx] = bp;
    return bp;
  }

  const B = HumanoidBone;

  const hipsPivot = addPivot(group, 0, 0.85, 0);
  reg(B.HIPS, hipsPivot, new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.18), body));

  // Torso - wider at shoulders, tapers to waist
  const spinePivot = addPivot(hipsPivot, 0, 0.1, 0);
  const torsoShape = new THREE.Shape();
  torsoShape.moveTo(-0.19, -0.22);
  torsoShape.lineTo(-0.22, 0.1);
  torsoShape.lineTo(-0.19, 0.22);
  torsoShape.lineTo(0.19, 0.22);
  torsoShape.lineTo(0.22, 0.1);
  torsoShape.lineTo(0.19, -0.22);
  torsoShape.closePath();
  const torsoGeo = new THREE.ExtrudeGeometry(torsoShape, {
    depth: 0.16, bevelEnabled: true,
    bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2,
  });
  torsoGeo.translate(0, 0, -0.08);
  reg(B.SPINE, spinePivot, new THREE.Mesh(torsoGeo, body));

  // Shoulder caps
  const shoulderGeo = new THREE.SphereGeometry(0.07, 8, 6);
  for (const side of [-1, 1]) {
    const cap = new THREE.Mesh(shoulderGeo, body);
    cap.position.set(side * 0.22, 0.18, 0);
    cap.castShadow = true;
    spinePivot.add(cap);
  }

  // Neck + Head
  const headPivot = addPivot(spinePivot, 0, 0.28, 0);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 8), body);
  neck.position.y = -0.02;
  neck.castShadow = true;
  headPivot.add(neck);
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), body);
  headMesh.position.y = 0.08;
  headMesh.scale.set(1, 1.12, 0.95);
  reg(B.HEAD, headPivot, headMesh);

  // Arms — pivot at shoulder socket, mesh hangs down
  const upperArmL = addPivot(spinePivot, -0.25, 0.17, 0);
  const uaMeshL = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.2, 5, 8), body);
  uaMeshL.position.y = -0.15;
  reg(B.UPPER_ARM_L, upperArmL, uaMeshL);
  const elbowL = addPivot(upperArmL, 0, -0.3, 0);
  const laMeshL = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.2, 5, 8), body);
  laMeshL.position.y = -0.14;
  reg(B.LOWER_ARM_L, elbowL, laMeshL);
  const handL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.03), body);
  handL.position.y = -0.28;
  handL.rotation.y = Math.PI / 2;
  handL.castShadow = true;
  elbowL.add(handL);

  const upperArmR = addPivot(spinePivot, 0.25, 0.17, 0);
  const uaMeshR = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.2, 5, 8), body);
  uaMeshR.position.y = -0.15;
  reg(B.UPPER_ARM_R, upperArmR, uaMeshR);
  const elbowR = addPivot(upperArmR, 0, -0.3, 0);
  const laMeshR = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.2, 5, 8), body);
  laMeshR.position.y = -0.14;
  reg(B.LOWER_ARM_R, elbowR, laMeshR);
  const handR = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.03), body);
  handR.position.y = -0.28; handR.castShadow = true;
  elbowR.add(handR);

  // Legs — pivot at hip socket, mesh hangs down
  const hipL = addPivot(hipsPivot, -0.1, -0.1, 0);
  const ulMeshL = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.28, 5, 8), body);
  ulMeshL.position.y = -0.2;
  reg(B.UPPER_LEG_L, hipL, ulMeshL);
  const kneeL = addPivot(hipL, 0, -0.4, 0);
  const llMeshL = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.26, 5, 8), body);
  llMeshL.position.y = -0.18;
  reg(B.LOWER_LEG_L, kneeL, llMeshL);
  const footL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 0.14), body);
  footL.position.set(0, -0.35, -0.03); footL.castShadow = true;
  kneeL.add(footL);

  const hipR = addPivot(hipsPivot, 0.1, -0.1, 0);
  const ulMeshR = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.28, 5, 8), body);
  ulMeshR.position.y = -0.2;
  reg(B.UPPER_LEG_R, hipR, ulMeshR);
  const kneeR = addPivot(hipR, 0, -0.4, 0);
  const llMeshR = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.26, 5, 8), body);
  llMeshR.position.y = -0.18;
  reg(B.LOWER_LEG_R, kneeR, llMeshR);
  const footR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 0.14), body);
  footR.position.set(0, -0.35, -0.03); footR.castShadow = true;
  kneeR.add(footR);

  // Eyes
  const eyes: THREE.Mesh[] = [];
  for (const x of [-0.045, 0.045]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 4), mat.eyes);
    eye.position.set(x, 0.1, -0.11);
    headPivot.add(eye);
    eyes.push(eye);
  }

  return { pivots, eyes };
}

export function createHumanoid(skeleton: SkeletonSystem, materials: HumanoidMaterials): HumanoidData {
  const group = new THREE.Group();
  const { pivots, eyes } = buildBody(group, materials);
  const defHandle = getOrCreateDefinition(skeleton);
  const instHandle = skeleton.createInstance(defHandle);

  return {
    group, pivots, eyes,
    defHandle, instHandle,
    walkPhase: Math.random() * Math.PI * 2,
    ragdolling: false,
  };
}

function legIK(phase: number, amp: number): { hip: number; knee: number } {
  // Verified against the actual rendered rig, not just inferred from a
  // comment: positive hip swings the thigh forward, positive knee folds
  // the shin backward behind the thigh (the normal human knee direction).
  // The previous signs here were both backward from that — the leg
  // visibly swung back when it should swing forward, and the knee bent
  // forward instead of back.
  const hip = -Math.sin(phase) * 0.45 * amp;
  // Tied directly to `hip` (rather than an independently phased sine) so
  // the knee is only ever bent while the thigh itself is swinging
  // forward (hip > 0) — it can't stay bent into the backward/trailing
  // stroke, which is what made the leg look bent at the knee while also
  // swinging back.
  const knee = Math.max(0, hip) * (0.7 / 0.45);
  return { hip, knee };
}

export function animateHumanoidWalk(data: HumanoidData, dt: number, moving: boolean): void {
  if (data.ragdolling) return;

  data.walkPhase += dt * (moving ? 7 : 0.5);
  const phase = data.walkPhase;
  const amp = moving ? 1.0 : 0.12;
  const B = HumanoidBone;

  // Legs - opposite phase, each with independent hip/knee/foot
  const legL = legIK(phase, amp);
  const legR = legIK(phase + Math.PI, amp);

  data.pivots[B.UPPER_LEG_L].pivot.rotation.x = legL.hip;
  data.pivots[B.LOWER_LEG_L].pivot.rotation.x = legL.knee;
  data.pivots[B.UPPER_LEG_R].pivot.rotation.x = legR.hip;
  data.pivots[B.LOWER_LEG_R].pivot.rotation.x = legR.knee;

  // Arms counter-swing to legs with elbow bend during backstroke
  const armL = legL.hip * 0.7;
  const armR = legR.hip * 0.7;
  data.pivots[B.UPPER_ARM_L].pivot.rotation.x = armL;
  data.pivots[B.LOWER_ARM_L].pivot.rotation.x = -Math.max(0, armL) * 0.6 - 0.1 * amp;
  data.pivots[B.UPPER_ARM_R].pivot.rotation.x = armR;
  data.pivots[B.LOWER_ARM_R].pivot.rotation.x = Math.max(0, armR) * 0.6 + 0.1 * amp;

  // Torso counter-rotates to hips
  data.pivots[B.SPINE].pivot.rotation.y = Math.sin(phase) * 0.06 * amp;
  data.pivots[B.SPINE].pivot.rotation.z = Math.sin(phase) * 0.025 * amp;

  // Hips tilt side to side with each step
  data.pivots[B.HIPS].pivot.rotation.z = Math.sin(phase) * 0.03 * amp;

  // Head stays relatively stable, slight counter to torso
  data.pivots[B.HEAD].pivot.rotation.y = -Math.sin(phase) * 0.03 * amp;

  // Vertical bob - two bounces per cycle (each foot strike)
  const bob = Math.abs(Math.sin(phase)) * 0.02 * amp;
  data.pivots[B.HIPS].pivot.position.y = 0.85 + bob;
}

const _q = new THREE.Quaternion();

export function startHumanoidRagdoll(
  data: HumanoidData,
  skeleton: SkeletonSystem,
  physics: PhysicsSystem,
  worldPos: THREE.Vector3,
  hitDir?: THREE.Vector3,
): void {
  if (data.ragdolling) return;
  data.ragdolling = true;

  const worldPositions: THREE.Vector3[] = [];
  for (let i = 0; i < data.pivots.length; i++) {
    const wp = new THREE.Vector3();
    data.pivots[i].mesh.getWorldPosition(wp);
    worldPositions.push(wp);
  }

  const inst = skeleton.getInstance(data.instHandle);
  if (!inst) return;

  for (let i = 0; i < HUMANOID_BONES.length; i++) {
    inst.localPosX[i] = worldPositions[i].x;
    inst.localPosY[i] = worldPositions[i].y;
    inst.localPosZ[i] = worldPositions[i].z;
  }

  skeleton.activate(data.instHandle, HUMANOID_JOINTS);

  if (hitDir && inst.bodyHandles[HumanoidBone.HIPS] !== -1) {
    const body = physics.getBodyByHandle(inst.bodyHandles[HumanoidBone.HIPS]);
    if (body) {
      const impulse = hitDir.clone().multiplyScalar(3);
      impulse.y = 2;
      body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
    }
  }

  const scene = data.group.parent;
  if (!scene) return;

  for (let i = 0; i < data.pivots.length; i++) {
    const mesh = data.pivots[i].mesh;
    mesh.removeFromParent();
    mesh.position.copy(worldPositions[i]);
    mesh.rotation.set(0, 0, 0);
    scene.add(mesh);
  }

  data.group.removeFromParent();
}

export function updateHumanoidRagdoll(data: HumanoidData, skeleton: SkeletonSystem): void {
  if (!data.ragdolling) return;

  for (let i = 0; i < data.pivots.length; i++) {
    const pose = skeleton.getBoneWorldPose(data.instHandle, i);
    if (!pose) continue;
    data.pivots[i].mesh.position.set(pose.px, pose.py, pose.pz);
    _q.set(pose.rx, pose.ry, pose.rz, pose.rw);
    data.pivots[i].mesh.quaternion.copy(_q);
  }
}

export function cleanupHumanoid(data: HumanoidData, skeleton: SkeletonSystem): void {
  skeleton.destroyInstance(data.instHandle);
  for (const bp of data.pivots) {
    bp.mesh.removeFromParent();
    bp.mesh.geometry.dispose();
  }
}
