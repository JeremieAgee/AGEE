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

    // A direct write to LocalTransform (moving a turret head, a weapon socket, an attached
    // prop) must dirty the corresponding WorldTransform so it gets recomputed next update() --
    // markDirty() exists as a public API but nothing in the engine calls it, so relying on
    // callers to remember it silently stopped propagation after an entity's first frame. Hook
    // the store's own write path instead of shadow-copying every LocalTransform field to
    // detect edits by comparison.
    this.localStore.onSet((eid) => {
      if (this.worldStore.has(eid)) this.worldStore.set(eid, "dirty", 1);
    });
    // Guarantees a freshly-added WorldTransform gets its first recompute regardless of
    // whether the caller passed `dirty: 1` explicitly (matching what an uncached entity used
    // to get for free from the old shadow-cache's "never seen this eid before" check).
    this.worldStore.onAdd((eid) => {
      this.worldStore.set(eid, "dirty", 1);
    });
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

    // Check dirty flag — skip if clean. Any LocalTransform write reaches this entity's dirty
    // flag directly (see the store's onSet hook registered in init()), so this single column
    // read is authoritative without needing to re-compare LocalTransform's fields by hand.
    const dirty = (this.worldStore.get(eid, "dirty") as number) !== 0 ? 1 : 0;
    const hasDirtyChildren = this.hasDirtyDescendants(eid);

    if (dirty === 0 && !hasDirtyChildren && depth > 0) {
      this.visiting.delete(eid);
      return;
    }

    const lx = this.localStore.get(eid, "x") as number;
    const ly = this.localStore.get(eid, "y") as number;
    const lz = this.localStore.get(eid, "z") as number;
    const lrx = this.localStore.get(eid, "rx") as number;
    const lry = this.localStore.get(eid, "ry") as number;
    const lrz = this.localStore.get(eid, "rz") as number;
    const lrw = this.localStore.get(eid, "rw") as number;
    const lsx = this.localStore.get(eid, "sx") as number;
    const lsy = this.localStore.get(eid, "sy") as number;
    const lsz = this.localStore.get(eid, "sz") as number;

    tmpPos.set(lx, ly, lz);
    tmpRot.set(lrx, lry, lrz, lrw);
    tmpScale.set(lsx, lsy, lsz);

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
  // `visited` mirrors updateEntity()'s `visiting` cycle guard: this runs BEFORE that
  // protection applies (it's called from within updateEntity() before any cycle can be
  // caught there), so without its own guard a cyclic Parent/Children graph recurses here
  // unbounded and overflows the stack. Threaded through the recursion (not the shared
  // `this.visiting` field) since this is a read-only lookahead with no enter/exit pairing --
  // a fresh Set per top-level call still stops any cycle after at most one full loop.
  private hasDirtyDescendants(eid: number, visited: Set<number> = new Set()): boolean {
    if (visited.has(eid)) return false;
    visited.add(eid);

    if (!this.childrenStore.has(eid)) return false;
    const childIds = this.childrenStore.get(eid, "entities") as number[] | null;
    if (!childIds) return false;
    for (let i = 0; i < childIds.length; i++) {
      const childEid = childIds[i];
      if (childEid === undefined) continue;
      if (this.worldStore.has(childEid) && this.worldStore.get(childEid, "dirty") !== 0) {
        return true;
      }
      if (this.hasDirtyDescendants(childEid, visited)) return true;
    }
    return false;
  }

  // Still a valid, explicit way to force a recompute (e.g. an entity whose WorldTransform needs
  // to be recomputed for a reason other than its own LocalTransform changing) — no longer the
  // only way dirtiness gets detected, see the onSet hook registered in init().
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
