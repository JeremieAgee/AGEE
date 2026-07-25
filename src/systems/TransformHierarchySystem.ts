import { System, World, ComponentStore } from "../ecs";
import { LocalTransform, WorldTransform, Parent, Children } from "../core/HierarchyComponents";
import { Mat4 } from "../core/math/Mat4";
import { Vec3 } from "../core/math/Vec3";
import { Quat } from "../core/math/Quat";

const tmpPos = new Vec3();
const tmpRot = new Quat();
const tmpScale = new Vec3();
const tmpMat = new Mat4();

const MAX_HIERARCHY_DEPTH = 64;
const matStack: Mat4[] = Array.from({ length: MAX_HIERARCHY_DEPTH }, () => new Mat4());

export class TransformHierarchySystem extends System {
  priority = 200;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "postPhysics";

  static reads = ["LocalTransform", "Parent", "Children"];
  static writes = ["WorldTransform"];

  private localStore!: ComponentStore;
  private worldStore!: ComponentStore;
  private parentStore!: ComponentStore;
  private childrenStore!: ComponentStore;
  private rootQuery!: ReturnType<World["query"]>;
  private depthWarned = false;

  // Cycle detection: track entities being visited in current traversal
  private visiting = new Set<number>();

  init(): void {
    this.localStore = this.world.getStore(LocalTransform);
    this.worldStore = this.world.getStore(WorldTransform);
    this.parentStore = this.world.getStore(Parent);
    this.childrenStore = this.world.getStore(Children);
    this.rootQuery = this.world.query(LocalTransform, WorldTransform);
  }

  update(_dt: number): void {
    const entities = this.rootQuery.entities;
    this.visiting.clear();

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (this.parentStore.has(eid)) continue;
      this.updateEntity(eid, 0);
    }
  }

  private updateEntity(eid: number, depth: number): void {
    if (!this.localStore.has(eid) || !this.worldStore.has(eid)) return;

    if (depth >= MAX_HIERARCHY_DEPTH) {
      if (!this.depthWarned) {
        console.warn(`[AGEE] Transform hierarchy depth exceeded ${MAX_HIERARCHY_DEPTH} at entity ${eid}. Deeper nodes are skipped.`);
        this.depthWarned = true;
      }
      return;
    }

    // Cycle detection
    if (this.visiting.has(eid)) {
      console.error(`[AGEE] Cycle detected in transform hierarchy at entity ${eid}. Skipping.`);
      return;
    }
    this.visiting.add(eid);

    // Check dirty flag — skip if clean
    const dirty = this.worldStore.get(eid, "dirty") as number;
    const hasDirtyChildren = this.hasDirtyDescendants(eid);

    if (dirty === 0 && !hasDirtyChildren && depth > 0) {
      this.visiting.delete(eid);
      return;
    }

    tmpPos.set(
      this.localStore.get(eid, "x"),
      this.localStore.get(eid, "y"),
      this.localStore.get(eid, "z")
    );
    tmpRot.set(
      this.localStore.get(eid, "rx"),
      this.localStore.get(eid, "ry"),
      this.localStore.get(eid, "rz"),
      this.localStore.get(eid, "rw")
    );
    tmpScale.set(
      this.localStore.get(eid, "sx"),
      this.localStore.get(eid, "sy"),
      this.localStore.get(eid, "sz")
    );

    tmpMat.compose(tmpPos, tmpRot, tmpScale);

    const worldMat = matStack[depth];
    if (depth > 0) {
      worldMat.copy(matStack[depth - 1]);
      worldMat.multiply(tmpMat);
    } else {
      worldMat.copy(tmpMat);
    }

    this.writeWorldMatrix(eid, worldMat);

    if (!this.childrenStore.has(eid)) {
      this.visiting.delete(eid);
      return;
    }
    const childIds = this.childrenStore.get(eid, "entities") as number[] | null;
    if (!childIds) {
      this.visiting.delete(eid);
      return;
    }

    // Snapshot length to guard against mutation during iteration
    const len = childIds.length;
    for (let c = 0; c < len; c++) {
      const childEid = childIds[c];
      if (childEid !== undefined) {
        // Propagate dirty flag to children when parent is dirty
        if (dirty !== 0 && this.worldStore.has(childEid)) {
          this.worldStore.set(childEid, "dirty", 1);
        }
        this.updateEntity(childEid, depth + 1);
      }
    }

    this.visiting.delete(eid);
  }

  // Recurses through the full subtree, not just immediate children — a dirty entity two or
  // more levels below `eid` needs to be found here too, otherwise an ancestor whose own
  // immediate children are all clean short-circuits at the `dirty === 0 && !hasDirtyChildren`
  // check above and never recurses into that branch, leaving its world matrices stale.
  // This does mean a node's subtree can get rescanned once per ancestor on the way down;
  // that's accepted here as simpler and still bounded by MAX_HIERARCHY_DEPTH rather than
  // restructuring the traversal to cache a bottom-up subtree-dirty flag.
  private hasDirtyDescendants(eid: number): boolean {
    if (!this.childrenStore.has(eid)) return false;
    const childIds = this.childrenStore.get(eid, "entities") as number[] | null;
    if (!childIds) return false;
    for (let i = 0; i < childIds.length; i++) {
      const childEid = childIds[i];
      if (childEid === undefined) continue;
      if (this.worldStore.has(childEid) && this.worldStore.get(childEid, "dirty") !== 0) {
        return true;
      }
      if (this.hasDirtyDescendants(childEid)) return true;
    }
    return false;
  }

  markDirty(eid: number): void {
    if (this.worldStore.has(eid)) {
      this.worldStore.set(eid, "dirty", 1);
    }
  }

  private writeWorldMatrix(eid: number, mat: Mat4): void {
    const e = mat.elements;
    const ws = this.worldStore;
    ws.set(eid, "m00", e[0]);  ws.set(eid, "m01", e[1]);
    ws.set(eid, "m02", e[2]);  ws.set(eid, "m03", e[3]);
    ws.set(eid, "m10", e[4]);  ws.set(eid, "m11", e[5]);
    ws.set(eid, "m12", e[6]);  ws.set(eid, "m13", e[7]);
    ws.set(eid, "m20", e[8]);  ws.set(eid, "m21", e[9]);
    ws.set(eid, "m22", e[10]); ws.set(eid, "m23", e[11]);
    ws.set(eid, "m30", e[12]); ws.set(eid, "m31", e[13]);
    ws.set(eid, "m32", e[14]); ws.set(eid, "m33", e[15]);
    ws.set(eid, "dirty", 0);
  }
}
