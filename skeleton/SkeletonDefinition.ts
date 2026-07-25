export const enum BoneFlags {
  NONE         = 0,
  KINEMATIC    = 1 << 0,
  SIMULATED    = 1 << 1,
  ANIMATED     = 1 << 2,
  DISABLED     = 1 << 3,
  HIDDEN       = 1 << 4,
  NO_COLLISION = 1 << 5,
}

export const enum BoneCategory {
  SPINE = 0,
  ARM   = 1,
  LEG   = 2,
  HEAD  = 3,
  TAIL  = 4,
  HAND  = 5,
  FOOT  = 6,
  OTHER = 7,
}

export const enum ColliderType {
  CAPSULE  = 0,
  SPHERE   = 1,
  BOX      = 2,
  CYLINDER = 3,
}

export interface BoneConfig {
  name: string;
  parentIndex: number;
  length: number;
  taper?: number;
  colliderType?: ColliderType;
  flags?: number;
  category?: BoneCategory;
  mirrorPartner?: number;
  mass?: number;
  density?: number;
  bindPos?: { x: number; y: number; z: number };
  bindRot?: { x: number; y: number; z: number; w: number };
  restPos?: { x: number; y: number; z: number };
  restRot?: { x: number; y: number; z: number; w: number };
}

function hashString(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

export class SkeletonDefinition {
  readonly boneCount: number;

  readonly names: string[];
  readonly nameHashes: Uint32Array;

  readonly parents: Int32Array;
  readonly depths: Uint8Array;
  readonly firstChild: Int32Array;
  readonly nextSibling: Int32Array;

  readonly lengths: Float32Array;
  readonly tapers: Float32Array;

  readonly bindPosX: Float32Array;
  readonly bindPosY: Float32Array;
  readonly bindPosZ: Float32Array;
  readonly bindRotX: Float32Array;
  readonly bindRotY: Float32Array;
  readonly bindRotZ: Float32Array;
  readonly bindRotW: Float32Array;

  readonly restPosX: Float32Array;
  readonly restPosY: Float32Array;
  readonly restPosZ: Float32Array;
  readonly restRotX: Float32Array;
  readonly restRotY: Float32Array;
  readonly restRotZ: Float32Array;
  readonly restRotW: Float32Array;

  readonly flags: Uint16Array;
  readonly colliderTypes: Uint8Array;
  readonly mirrorPartners: Int32Array;
  readonly categories: Uint8Array;

  readonly masses: Float32Array;
  readonly densities: Float32Array;

  private nameToIndex: Map<number, number>;

  constructor(bones: BoneConfig[]) {
    const n = bones.length;
    this.boneCount = n;

    this.names = new Array(n);
    this.nameHashes = new Uint32Array(n);

    this.parents = new Int32Array(n);
    this.depths = new Uint8Array(n);
    this.firstChild = new Int32Array(n).fill(-1);
    this.nextSibling = new Int32Array(n).fill(-1);

    this.lengths = new Float32Array(n);
    this.tapers = new Float32Array(n);

    this.bindPosX = new Float32Array(n);
    this.bindPosY = new Float32Array(n);
    this.bindPosZ = new Float32Array(n);
    this.bindRotX = new Float32Array(n);
    this.bindRotY = new Float32Array(n);
    this.bindRotZ = new Float32Array(n);
    this.bindRotW = new Float32Array(n);

    this.restPosX = new Float32Array(n);
    this.restPosY = new Float32Array(n);
    this.restPosZ = new Float32Array(n);
    this.restRotX = new Float32Array(n);
    this.restRotY = new Float32Array(n);
    this.restRotZ = new Float32Array(n);
    this.restRotW = new Float32Array(n);

    this.flags = new Uint16Array(n);
    this.colliderTypes = new Uint8Array(n);
    this.mirrorPartners = new Int32Array(n).fill(-1);
    this.categories = new Uint8Array(n);

    this.masses = new Float32Array(n);
    this.densities = new Float32Array(n);

    this.nameToIndex = new Map();

    for (let i = 0; i < n; i++) {
      const b = bones[i];

      this.names[i] = b.name;
      const hash = hashString(b.name);
      this.nameHashes[i] = hash;
      this.nameToIndex.set(hash, i);

      this.parents[i] = b.parentIndex;
      this.lengths[i] = b.length;
      this.tapers[i] = b.taper ?? 0;
      this.colliderTypes[i] = b.colliderType ?? ColliderType.CAPSULE;
      this.flags[i] = b.flags ?? BoneFlags.SIMULATED;
      this.categories[i] = b.category ?? BoneCategory.OTHER;
      this.mirrorPartners[i] = b.mirrorPartner ?? -1;
      this.masses[i] = b.mass ?? 1;
      this.densities[i] = b.density ?? 1;

      if (b.bindPos) {
        this.bindPosX[i] = b.bindPos.x;
        this.bindPosY[i] = b.bindPos.y;
        this.bindPosZ[i] = b.bindPos.z;
      }
      const bRot = b.bindRot ?? { x: 0, y: 0, z: 0, w: 1 };
      this.bindRotX[i] = bRot.x;
      this.bindRotY[i] = bRot.y;
      this.bindRotZ[i] = bRot.z;
      this.bindRotW[i] = bRot.w;

      if (b.restPos) {
        this.restPosX[i] = b.restPos.x;
        this.restPosY[i] = b.restPos.y;
        this.restPosZ[i] = b.restPos.z;
      }
      const rRot = b.restRot ?? { x: 0, y: 0, z: 0, w: 1 };
      this.restRotX[i] = rRot.x;
      this.restRotY[i] = rRot.y;
      this.restRotZ[i] = rRot.z;
      this.restRotW[i] = rRot.w;
    }

    this.buildDepths();
    this.buildChildSiblingLinks();
  }

  private buildDepths(): void {
    for (let i = 0; i < this.boneCount; i++) {
      let depth = 0;
      let p = this.parents[i];
      while (p !== -1) {
        depth++;
        p = this.parents[p];
      }
      this.depths[i] = depth;
    }
  }

  private buildChildSiblingLinks(): void {
    for (let i = this.boneCount - 1; i >= 0; i--) {
      const p = this.parents[i];
      if (p === -1) continue;
      this.nextSibling[i] = this.firstChild[p];
      this.firstChild[p] = i;
    }
  }

  getBoneIndex(name: string): number {
    const hash = hashString(name);
    return this.nameToIndex.get(hash) ?? -1;
  }

  getBoneIndexByHash(hash: number): number {
    return this.nameToIndex.get(hash) ?? -1;
  }
}
