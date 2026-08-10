import type { Handle } from "../core/handles/Handle";

export const enum DirtyFlags {
  NONE  = 0,
  LOCAL = 1 << 0,
  WORLD = 1 << 1,
  POSE  = 1 << 2,
  MOTOR = 1 << 3,
  // Set on a bone when some bone in its subtree (not itself) has a pending LOCAL change,
  // maintained incrementally by markLocalDirty()'s upward propagation rather than recomputed
  // by re-walking descendants on every check -- see markLocalDirty()/propagateDescendantDirty()
  // below and SkeletonSystem.evaluateBoneFK()'s use of it in place of a recursive descendant
  // scan (the same "propagate on write, read cached flag on check" shape as ArchetypeIndex's
  // version-counter pattern elsewhere in the engine).
  DESCENDANT_DIRTY = 1 << 4,
}

export const enum MotorMode {
  OFF      = 0,
  POSITION = 1,
  VELOCITY = 2,
  FORCE    = 3,
}

export class SkeletonInstance {
  readonly definitionHandle: Handle;
  readonly boneCount: number;

  localPosX: Float32Array;
  localPosY: Float32Array;
  localPosZ: Float32Array;
  localRotX: Float32Array;
  localRotY: Float32Array;
  localRotZ: Float32Array;
  localRotW: Float32Array;

  worldPosX: Float32Array;
  worldPosY: Float32Array;
  worldPosZ: Float32Array;
  worldRotX: Float32Array;
  worldRotY: Float32Array;
  worldRotZ: Float32Array;
  worldRotW: Float32Array;

  boneEntities: Int32Array;
  bodyHandles: Int32Array;
  colliderHandles: Int32Array;

  jointEntities: Int32Array;
  jointHandles: Int32Array;
  // Rapier joint type per bone's incoming joint (JointType enum; 0/FIXED default when a bone
  // has no joint). Only REVOLUTE and PRISMATIC joints support the single-axis motor API used
  // in SkeletonSystem.update() — this lets that code skip motor calls on SPHERICAL/FIXED
  // joints instead of calling revolute-only methods on the wrong Rapier joint type.
  jointTypes: Uint8Array;

  motorTargets: Float32Array;
  motorStiffness: Float32Array;
  motorDamping: Float32Array;
  motorVelocity: Float32Array;
  motorForce: Float32Array;
  motorModes: Uint8Array;
  motorEnabled: Uint8Array;

  dirtyFlags: Uint8Array;
  runtimeFlags: Uint16Array;

  active: boolean;

  // Optional parent-index chain (SkeletonDefinition.parents), used only to propagate
  // DESCENDANT_DIRTY up the ancestor chain from markLocalDirty(). Instances created directly
  // in isolation (without a definition's parent chain, e.g. in unit tests exercising just the
  // dirty-flag bookkeeping) simply skip propagation.
  private readonly parents: Int32Array | null;

  constructor(definitionHandle: Handle, boneCount: number, parents?: Int32Array) {
    this.definitionHandle = definitionHandle;
    this.boneCount = boneCount;
    this.parents = parents ?? null;

    this.localPosX = new Float32Array(boneCount);
    this.localPosY = new Float32Array(boneCount);
    this.localPosZ = new Float32Array(boneCount);
    this.localRotX = new Float32Array(boneCount);
    this.localRotY = new Float32Array(boneCount);
    this.localRotZ = new Float32Array(boneCount);
    this.localRotW = new Float32Array(boneCount);

    this.worldPosX = new Float32Array(boneCount);
    this.worldPosY = new Float32Array(boneCount);
    this.worldPosZ = new Float32Array(boneCount);
    this.worldRotX = new Float32Array(boneCount);
    this.worldRotY = new Float32Array(boneCount);
    this.worldRotZ = new Float32Array(boneCount);
    this.worldRotW = new Float32Array(boneCount);

    this.boneEntities = new Int32Array(boneCount).fill(-1);
    this.bodyHandles = new Int32Array(boneCount).fill(-1);
    this.colliderHandles = new Int32Array(boneCount).fill(-1);

    this.jointEntities = new Int32Array(boneCount).fill(-1);
    this.jointHandles = new Int32Array(boneCount).fill(-1);
    this.jointTypes = new Uint8Array(boneCount);

    this.motorTargets = new Float32Array(boneCount);
    this.motorStiffness = new Float32Array(boneCount);
    this.motorDamping = new Float32Array(boneCount);
    this.motorVelocity = new Float32Array(boneCount);
    this.motorForce = new Float32Array(boneCount);
    this.motorModes = new Uint8Array(boneCount);
    this.motorEnabled = new Uint8Array(boneCount);

    this.dirtyFlags = new Uint8Array(boneCount);
    this.runtimeFlags = new Uint16Array(boneCount);

    this.active = false;
  }

  initFromRestPose(
    restPosX: Float32Array, restPosY: Float32Array, restPosZ: Float32Array,
    restRotX: Float32Array, restRotY: Float32Array, restRotZ: Float32Array, restRotW: Float32Array
  ): void {
    this.localPosX.set(restPosX);
    this.localPosY.set(restPosY);
    this.localPosZ.set(restPosZ);
    this.localRotX.set(restRotX);
    this.localRotY.set(restRotY);
    this.localRotZ.set(restRotZ);
    this.localRotW.set(restRotW);
    this.dirtyFlags.fill(DirtyFlags.LOCAL | DirtyFlags.WORLD);
  }

  markLocalDirty(boneIndex: number): void {
    this.dirtyFlags[boneIndex] |= DirtyFlags.LOCAL;
    this.propagateDescendantDirty(boneIndex);
  }

  // Walks boneIndex's ancestor chain marking DESCENDANT_DIRTY, stopping as soon as it reaches
  // an ancestor that already has the bit set -- by the same invariant this method maintains,
  // that ancestor's own ancestors must already be marked too, so there's nothing further to do.
  // This is the "propagate on write" half of the incremental scheme: it replaces
  // SkeletonSystem's old hasDirtyLocalDescendant(), which re-walked every descendant of every
  // clean bone on every single frame just to answer the same question this now answers in O(1).
  private propagateDescendantDirty(boneIndex: number): void {
    if (!this.parents) return;
    let idx = this.parents[boneIndex];
    while (idx !== -1) {
      if (this.dirtyFlags[idx] & DirtyFlags.DESCENDANT_DIRTY) return;
      this.dirtyFlags[idx] |= DirtyFlags.DESCENDANT_DIRTY;
      idx = this.parents[idx];
    }
  }

  markMotorDirty(boneIndex: number): void {
    this.dirtyFlags[boneIndex] |= DirtyFlags.MOTOR;
  }

  clearDirty(boneIndex: number): void {
    this.dirtyFlags[boneIndex] = DirtyFlags.NONE;
  }

  isDirty(boneIndex: number, flag: DirtyFlags): boolean {
    return (this.dirtyFlags[boneIndex] & flag) !== 0;
  }
}
