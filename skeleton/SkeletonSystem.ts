import RAPIER from "@dimforge/rapier3d-compat";
import { System, ComponentStore } from "../ecs";
import { Handle, HandleMap } from "../core/handles/Handle";
import { Transform, RigidBody } from "../core/Components";
import { PhysicsSystem } from "../systems/PhysicsSystem";
import { SkeletonDefinition, BoneConfig, BoneFlags, ColliderType } from "./SkeletonDefinition";
import { SkeletonInstance, DirtyFlags, MotorMode } from "./SkeletonInstance";
import { Joint, JointType } from "./SkeletonComponents";

export interface JointConfig {
  parentBone: number;
  childBone: number;
  type: JointType;
  dofMask: number;
  limits?: { lo1?: number; hi1?: number; lo2?: number; hi2?: number; lo3?: number; hi3?: number };
  anchors?: {
    ax?: number; ay?: number; az?: number;
    bx?: number; by?: number; bz?: number;
  };
}

export interface SkeletonConfig {
  bones: BoneConfig[];
  joints: JointConfig[];
}

export class SkeletonSystem extends System {
  priority = 90;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "prePhysics";

  static reads = ["Transform"];
  static writes: string[] = [];

  private definitions = new HandleMap<SkeletonDefinition>();
  private instances = new HandleMap<SkeletonInstance>();
  private activeInstances: Handle[] = [];

  private transformStore!: ComponentStore;
  private physics!: PhysicsSystem;

  setPhysics(physics: PhysicsSystem): void {
    this.physics = physics;
  }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
  }

  createDefinition(bones: BoneConfig[]): Handle {
    const def = new SkeletonDefinition(bones);
    return this.definitions.alloc(def);
  }

  getDefinition(handle: Handle): SkeletonDefinition | null {
    return this.definitions.get(handle);
  }

  createInstance(definitionHandle: Handle): Handle {
    const def = this.definitions.get(definitionHandle);
    if (!def) throw new Error("Invalid definition handle");

    const instance = new SkeletonInstance(definitionHandle, def.boneCount);
    instance.initFromRestPose(
      def.restPosX, def.restPosY, def.restPosZ,
      def.restRotX, def.restRotY, def.restRotZ, def.restRotW
    );
    instance.runtimeFlags.set(def.flags);

    return this.instances.alloc(instance);
  }

  getInstance(handle: Handle): SkeletonInstance | null {
    return this.instances.get(handle);
  }

  activate(instanceHandle: Handle, joints: JointConfig[]): void {
    if (!this.physics) throw new Error("PhysicsSystem not set");

    const instance = this.instances.get(instanceHandle);
    if (!instance || instance.active) return;

    const def = this.definitions.get(instance.definitionHandle);
    if (!def) return;

    for (let i = 0; i < def.boneCount; i++) {
      if (def.flags[i] & BoneFlags.DISABLED) continue;

      const eid = this.world.createEntity();
      instance.boneEntities[i] = eid;

      const px = instance.localPosX[i];
      const py = instance.localPosY[i];
      const pz = instance.localPosZ[i];

      this.world.addComponent(eid, Transform, {
        x: px, y: py, z: pz,
        rx: 0, ry: 0, rz: 0,
        sx: 1, sy: 1, sz: 1,
      });

      const isKinematic = (instance.runtimeFlags[i] & BoneFlags.KINEMATIC) !== 0;
      const bodyType = isKinematic ? "kinematic" : "dynamic";
      this.world.addComponent(eid, RigidBody, {
        bodyHandle: 0,
        bodyType: isKinematic ? 2 : 0,
        mass: def.masses[i],
        restitution: 0.1,
        friction: 0.5,
      });

      const body = this.physics.addBody(eid, bodyType);
      instance.bodyHandles[i] = body.handle;

      const boneLength = def.lengths[i];
      const halfHeight = boneLength * 0.5;
      const radius = Math.max(boneLength * 0.15 * (1 - def.tapers[i] * 0.5), 0.02);

      if (!(def.flags[i] & BoneFlags.NO_COLLISION)) {
        const colliderType = def.colliderTypes[i];
        let shape: "capsule" | "sphere" | "box" | "cylinder";
        let params: { halfX?: number; halfY?: number; halfZ?: number; radius?: number; halfHeight?: number };

        switch (colliderType) {
          case ColliderType.SPHERE:
            shape = "sphere";
            params = { radius: halfHeight };
            break;
          case ColliderType.BOX:
            shape = "box";
            params = { halfX: radius, halfY: halfHeight, halfZ: radius };
            break;
          case ColliderType.CYLINDER:
            shape = "cylinder";
            params = { radius, halfHeight };
            break;
          default:
            shape = "capsule";
            params = { radius, halfHeight };
            break;
        }

        const collider = this.physics.addCollider(eid, shape, params);
        instance.colliderHandles[i] = collider.handle;
      }
    }

    for (let j = 0; j < joints.length; j++) {
      const jc = joints[j];
      const parentEid = instance.boneEntities[jc.parentBone];
      const childEid = instance.boneEntities[jc.childBone];
      if (parentEid === -1 || childEid === -1) continue;

      const anchorA = {
        x: jc.anchors?.ax ?? 0,
        y: jc.anchors?.ay ?? 0,
        z: jc.anchors?.az ?? 0,
      };
      const anchorB = {
        x: jc.anchors?.bx ?? 0,
        y: jc.anchors?.by ?? 0,
        z: jc.anchors?.bz ?? 0,
      };

      let jointId: number;
      switch (jc.type) {
        case JointType.FIXED:
          jointId = this.physics.createFixedJoint(parentEid, childEid, anchorA, anchorB);
          break;
        case JointType.REVOLUTE:
          jointId = this.physics.createRevoluteJoint(parentEid, childEid, 0, 0, 1, anchorA, anchorB);
          break;
        case JointType.SPHERICAL:
          jointId = this.physics.createSphericalJoint(parentEid, childEid, anchorA, anchorB);
          break;
        case JointType.PRISMATIC:
          jointId = this.physics.createPrismaticJoint(parentEid, childEid, 1, 0, 0, anchorA, anchorB);
          break;
        default:
          continue;
      }

      const rapierJoint = this.physics.getJoint(jointId);

      if (rapierJoint && jc.limits) {
        if (jc.type === JointType.REVOLUTE) {
          const lo = jc.limits.lo1 ?? -Math.PI;
          const hi = jc.limits.hi1 ?? Math.PI;
          (rapierJoint as RAPIER.RevoluteImpulseJoint).setLimits(lo, hi);
        } else if (jc.type === JointType.PRISMATIC) {
          const lo = jc.limits.lo1 ?? -1;
          const hi = jc.limits.hi1 ?? 1;
          (rapierJoint as RAPIER.PrismaticImpulseJoint).setLimits(lo, hi);
        }
      }

      const jointEid = this.world.createEntity();
      this.world.addComponent(jointEid, Joint, {
        jointType: jc.type,
        dofMask: jc.dofMask,
        rapierHandle: jointId,
        limLo1: jc.limits?.lo1 ?? 0, limHi1: jc.limits?.hi1 ?? 0,
        limLo2: jc.limits?.lo2 ?? 0, limHi2: jc.limits?.hi2 ?? 0,
        limLo3: jc.limits?.lo3 ?? 0, limHi3: jc.limits?.hi3 ?? 0,
        anchorAx: anchorA.x, anchorAy: anchorA.y, anchorAz: anchorA.z,
        anchorBx: anchorB.x, anchorBy: anchorB.y, anchorBz: anchorB.z,
      });

      instance.jointEntities[jc.childBone] = jointEid;
      instance.jointHandles[jc.childBone] = jointId;
    }

    instance.active = true;
    this.activeInstances.push(instanceHandle);
  }

  deactivate(instanceHandle: Handle): void {
    const instance = this.instances.get(instanceHandle);
    if (!instance || !instance.active) return;

    for (let i = 0; i < instance.boneCount; i++) {
      const jointHandle = instance.jointHandles[i];
      if (jointHandle !== -1) {
        this.physics.removeJoint(jointHandle);
        instance.jointHandles[i] = -1;
      }

      const jointEid = instance.jointEntities[i];
      if (jointEid !== -1) {
        this.world.destroyEntity(jointEid);
        instance.jointEntities[i] = -1;
      }

      const boneEid = instance.boneEntities[i];
      if (boneEid !== -1) {
        this.physics.removeBody(boneEid);
        this.world.destroyEntity(boneEid);
        instance.boneEntities[i] = -1;
        instance.bodyHandles[i] = -1;
        instance.colliderHandles[i] = -1;
      }
    }

    instance.active = false;
    const idx = this.activeInstances.indexOf(instanceHandle);
    if (idx !== -1) this.activeInstances.splice(idx, 1);
  }

  destroyInstance(instanceHandle: Handle): void {
    const instance = this.instances.get(instanceHandle);
    if (!instance) return;

    if (instance.active) {
      this.deactivate(instanceHandle);
    }

    this.instances.free(instanceHandle);
  }

  destroyDefinition(definitionHandle: Handle): void {
    this.definitions.free(definitionHandle);
  }

  getBoneWorldPose(instanceHandle: Handle, boneIndex: number): {
    px: number; py: number; pz: number;
    rx: number; ry: number; rz: number; rw: number;
  } | null {
    const instance = this.instances.get(instanceHandle);
    if (!instance || boneIndex < 0 || boneIndex >= instance.boneCount) return null;

    return {
      px: instance.worldPosX[boneIndex],
      py: instance.worldPosY[boneIndex],
      pz: instance.worldPosZ[boneIndex],
      rx: instance.worldRotX[boneIndex],
      ry: instance.worldRotY[boneIndex],
      rz: instance.worldRotZ[boneIndex],
      rw: instance.worldRotW[boneIndex],
    };
  }

  setBoneLocalPose(
    instanceHandle: Handle, boneIndex: number,
    px: number, py: number, pz: number,
    rx: number, ry: number, rz: number, rw: number
  ): void {
    const instance = this.instances.get(instanceHandle);
    if (!instance || boneIndex < 0 || boneIndex >= instance.boneCount) return;

    instance.localPosX[boneIndex] = px;
    instance.localPosY[boneIndex] = py;
    instance.localPosZ[boneIndex] = pz;
    instance.localRotX[boneIndex] = rx;
    instance.localRotY[boneIndex] = ry;
    instance.localRotZ[boneIndex] = rz;
    instance.localRotW[boneIndex] = rw;
    instance.markLocalDirty(boneIndex);
  }

  setMotor(
    instanceHandle: Handle, boneIndex: number,
    mode: MotorMode, target: number, stiffness: number, damping: number
  ): void {
    const instance = this.instances.get(instanceHandle);
    if (!instance || boneIndex < 0 || boneIndex >= instance.boneCount) return;

    instance.motorModes[boneIndex] = mode;
    instance.motorTargets[boneIndex] = target;
    instance.motorStiffness[boneIndex] = stiffness;
    instance.motorDamping[boneIndex] = damping;
    instance.motorEnabled[boneIndex] = mode !== MotorMode.OFF ? 1 : 0;
    instance.markMotorDirty(boneIndex);
  }

  getBoneIndex(definitionHandle: Handle, name: string): number {
    const def = this.definitions.get(definitionHandle);
    if (!def) return -1;
    return def.getBoneIndex(name);
  }

  update(dt: number): void {
    for (let a = 0; a < this.activeInstances.length; a++) {
      const handle = this.activeInstances[a];
      const instance = this.instances.get(handle);
      if (!instance || !instance.active) continue;

      for (let i = 0; i < instance.boneCount; i++) {
        if (instance.dirtyFlags[i] & DirtyFlags.MOTOR) {
          const jointHandle = instance.jointHandles[i];
          if (jointHandle !== -1 && instance.motorEnabled[i]) {
            const rapierJoint = this.physics.getJoint(jointHandle);
            if (rapierJoint) {
              const mode = instance.motorModes[i];
              if (mode === MotorMode.POSITION) {
                (rapierJoint as RAPIER.RevoluteImpulseJoint).configureMotorPosition(
                  instance.motorTargets[i],
                  instance.motorStiffness[i],
                  instance.motorDamping[i]
                );
              } else if (mode === MotorMode.VELOCITY) {
                (rapierJoint as RAPIER.RevoluteImpulseJoint).configureMotorVelocity(
                  instance.motorVelocity[i],
                  instance.motorDamping[i]
                );
              }
            }
          }
          instance.dirtyFlags[i] &= ~DirtyFlags.MOTOR;
        }

        const bodyHandle = instance.bodyHandles[i];
        if (bodyHandle === -1) continue;

        const body = this.physics.getBodyByHandle(bodyHandle);
        if (!body) continue;

        const pos = body.translation();
        const rot = body.rotation();

        instance.worldPosX[i] = pos.x;
        instance.worldPosY[i] = pos.y;
        instance.worldPosZ[i] = pos.z;
        instance.worldRotX[i] = rot.x;
        instance.worldRotY[i] = rot.y;
        instance.worldRotZ[i] = rot.z;
        instance.worldRotW[i] = rot.w;

        instance.dirtyFlags[i] &= ~DirtyFlags.WORLD;
      }
    }
  }

  destroy(): void {
    const handles: Handle[] = [];
    this.instances.forEach((_, index) => handles.push(index));
    for (const h of handles) {
      this.destroyInstance(h);
    }
  }
}
