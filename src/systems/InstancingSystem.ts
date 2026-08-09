import * as THREE from "three";
import { System, World, ComponentStore, defineComponent } from "../ecs";
import { Transform } from "../core/Components";

export const InstancedTag = defineComponent("InstancedTag", {
  groupId: "i32",
});

const MAX_GROUPS = 64;
const SHRINK_THRESHOLD = 0.25;

const tmpVec = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const tmpScale = new THREE.Vector3(1, 1, 1);
const tmpMatrix = new THREE.Matrix4();

export class InstancingSystem extends System {
  priority = 820;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  static reads = ["Transform", "InstancedTag"];
  static writes: string[] = [];

  private groupGeometries: (THREE.BufferGeometry | null)[];
  private groupMaterials: (THREE.Material | null)[];
  private groupMeshes: (THREE.InstancedMesh | null)[];
  private groupEntities: number[][];
  // Mirrors groupEntities: entity id -> its index within that group's array, so
  // add/remove/reorder and the per-frame dirty-entity lookup are all O(1) instead of
  // scanning the group with indexOf().
  private groupEntityIndex: Map<number, number>[];
  private groupCapacities: Int32Array;
  private groupDirty: Uint8Array;
  private groupCount = 0;

  // Per-entity dirty tracking: only update matrices for entities that moved
  private entityDirty: Set<number>[] = [];
  private groupFullRebuild: Uint8Array;

  private transformStore!: ComponentStore;
  private instanceStore!: ComponentStore;
  private scene!: THREE.Scene;

  constructor() {
    super();
    this.groupGeometries = new Array(MAX_GROUPS).fill(null);
    this.groupMaterials = new Array(MAX_GROUPS).fill(null);
    this.groupMeshes = new Array(MAX_GROUPS).fill(null);
    this.groupEntities = new Array(MAX_GROUPS).fill(null).map(() => []);
    this.groupEntityIndex = new Array(MAX_GROUPS).fill(null).map(() => new Map());
    this.groupCapacities = new Int32Array(MAX_GROUPS);
    this.groupDirty = new Uint8Array(MAX_GROUPS);
    this.groupFullRebuild = new Uint8Array(MAX_GROUPS);
    for (let i = 0; i < MAX_GROUPS; i++) {
      this.entityDirty.push(new Set());
    }
  }

  setScene(scene: THREE.Scene): void {
    this.scene = scene;
  }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
    this.instanceStore = this.world.getStore(InstancedTag);
  }

  createGroup(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    initialCapacity: number = 100
  ): number {
    const id = this.groupCount++;
    const mesh = new THREE.InstancedMesh(geometry, material, initialCapacity);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    this.groupGeometries[id] = geometry;
    this.groupMaterials[id] = material;
    this.groupMeshes[id] = mesh;
    this.groupCapacities[id] = initialCapacity;
    this.groupDirty[id] = 1;
    this.groupFullRebuild[id] = 1;

    return id;
  }

  addToGroup(eid: number, groupId: number): void {
    if (groupId >= this.groupCount) return;

    const entities = this.groupEntities[groupId];
    this.groupEntityIndex[groupId].set(eid, entities.length);
    entities.push(eid);
    this.world.addComponent(eid, InstancedTag, { groupId });

    if (entities.length > this.groupCapacities[groupId]) {
      this.growGroup(groupId);
    }

    this.groupMeshes[groupId]!.count = entities.length;
    this.groupFullRebuild[groupId] = 1;
    this.groupDirty[groupId] = 1;
  }

  removeFromGroup(eid: number, groupId: number): void {
    if (groupId >= this.groupCount) return;
    const entities = this.groupEntities[groupId];
    const indexMap = this.groupEntityIndex[groupId];
    const idx = indexMap.get(eid);
    if (idx !== undefined) {
      const lastEid = entities[entities.length - 1];
      entities[idx] = lastEid;
      entities.pop();
      indexMap.delete(eid);
      if (lastEid !== eid) indexMap.set(lastEid, idx);

      this.groupMeshes[groupId]!.count = entities.length;
      this.groupFullRebuild[groupId] = 1;
      this.groupDirty[groupId] = 1;

      // Shrink if utilization drops below threshold
      const cap = this.groupCapacities[groupId];
      if (cap > 100 && entities.length < cap * SHRINK_THRESHOLD) {
        this.shrinkGroup(groupId);
      }
    }
  }

  markEntityDirty(eid: number, groupId: number): void {
    this.entityDirty[groupId]?.add(eid);
    this.groupDirty[groupId] = 1;
  }

  markDirty(groupId: number): void {
    this.groupFullRebuild[groupId] = 1;
    this.groupDirty[groupId] = 1;
  }

  markAllDirty(): void {
    for (let g = 0; g < this.groupCount; g++) {
      this.groupFullRebuild[g] = 1;
      this.groupDirty[g] = 1;
    }
  }

  private growGroup(groupId: number): void {
    const newCap = this.groupCapacities[groupId] * 2;
    this.rebuildGroupMesh(groupId, newCap);
  }

  private shrinkGroup(groupId: number): void {
    const entities = this.groupEntities[groupId];
    const newCap = Math.max(100, Math.ceil(entities.length * 1.5));
    if (newCap >= this.groupCapacities[groupId]) return;
    this.rebuildGroupMesh(groupId, newCap);
  }

  private rebuildGroupMesh(groupId: number, newCap: number): void {
    const oldMesh = this.groupMeshes[groupId]!;
    this.scene.remove(oldMesh);
    oldMesh.dispose();

    const mesh = new THREE.InstancedMesh(
      this.groupGeometries[groupId]!,
      this.groupMaterials[groupId]!,
      newCap
    );
    mesh.count = this.groupEntities[groupId].length;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    this.groupMeshes[groupId] = mesh;
    this.groupCapacities[groupId] = newCap;
    this.groupFullRebuild[groupId] = 1;
    this.groupDirty[groupId] = 1;
  }

  update(_dt: number): void {
    const tx = this.transformStore.getColumn("x");
    const ty = this.transformStore.getColumn("y");
    const tz = this.transformStore.getColumn("z");
    const trx = this.transformStore.getColumn("rx");
    const trY = this.transformStore.getColumn("ry");
    const trz = this.transformStore.getColumn("rz");
    const tsx = this.transformStore.getColumn("sx");
    const tsy = this.transformStore.getColumn("sy");
    const tsz = this.transformStore.getColumn("sz");

    for (let g = 0; g < this.groupCount; g++) {
      if (!this.groupDirty[g]) continue;

      const mesh = this.groupMeshes[g];
      if (!mesh) continue;

      const entities = this.groupEntities[g];

      if (this.groupFullRebuild[g]) {
        // Full rebuild: update all matrices
        for (let i = 0; i < entities.length; i++) {
          this.writeMatrix(mesh, i, entities[i], tx, ty, tz, trx, trY, trz, tsx, tsy, tsz);
        }
        this.groupFullRebuild[g] = 0;
      } else {
        // Sparse update: only update dirty entities
        const dirtySet = this.entityDirty[g];
        const indexMap = this.groupEntityIndex[g];
        for (const eid of dirtySet) {
          const idx = indexMap.get(eid);
          if (idx !== undefined) {
            this.writeMatrix(mesh, idx, eid, tx, ty, tz, trx, trY, trz, tsx, tsy, tsz);
          }
        }
      }

      mesh.instanceMatrix.needsUpdate = true;
      this.groupDirty[g] = 0;
      this.entityDirty[g].clear();
    }
  }

  private writeMatrix(
    mesh: THREE.InstancedMesh, index: number, eid: number,
    tx: any, ty: any, tz: any, trx: any, trY: any, trz: any,
    tsx: any, tsy: any, tsz: any
  ): void {
    tmpVec.set(tx[eid], ty[eid], tz[eid]);
    tmpEuler.set(trx[eid], trY[eid], trz[eid]);
    tmpQuat.setFromEuler(tmpEuler);
    tmpScale.set(tsx[eid], tsy[eid], tsz[eid]);
    tmpMatrix.compose(tmpVec, tmpQuat, tmpScale);
    mesh.setMatrixAt(index, tmpMatrix);
  }

  destroyGroup(groupId: number): void {
    const mesh = this.groupMeshes[groupId];
    if (mesh) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.groupMeshes[groupId] = null;
    this.groupGeometries[groupId] = null;
    this.groupMaterials[groupId] = null;
    this.groupEntities[groupId] = [];
    this.groupEntityIndex[groupId]?.clear();
    this.entityDirty[groupId]?.clear();
  }

  destroy(): void {
    for (let i = 0; i < this.groupCount; i++) this.destroyGroup(i);
  }
}
