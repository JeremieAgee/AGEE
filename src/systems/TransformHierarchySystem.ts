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

const INITIAL_LOCAL_CACHE_CAPACITY = 256;

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

  // Per-entity cache of the last-seen LocalTransform values, so a direct write to
  // LocalTransform (moving a turret head, a weapon socket, an attached prop) is detected here
  // every frame by comparison instead of depending on the caller remembering to call
  // markDirty() — markDirty() existed as a public API but nothing in the engine ever called
  // it, so any LocalTransform edit after an entity's first frame silently stopped propagating
  // to WorldTransform. This mirrors the same cached-compare pattern GPURenderSystem already
  // uses for its own per-entity model-matrix cache.
  private localCacheCapacity = 0;
  private cachedLx: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedLy: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedLz: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedLrx: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedLry: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedLrz: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedLrw: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedLsx: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedLsy: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedLsz: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedLocalValid: Uint8Array<ArrayBuffer> = new Uint8Array(0);

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

    // Check dirty flag — skip if clean. "Dirty" is the flag column OR'd with a fresh
    // cached-value comparison, so a LocalTransform write reaching this entity is caught here
    // every frame regardless of whether anything remembered to call markDirty().
    const flagDirty = this.worldStore.get(eid, "dirty") as number;
    const dirty = (flagDirty !== 0 || this.isLocallyDirty(eid)) ? 1 : 0;
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

    this.ensureLocalCacheCapacity(eid + 1);
    this.cachedLx[eid] = lx; this.cachedLy[eid] = ly; this.cachedLz[eid] = lz;
    this.cachedLrx[eid] = lrx; this.cachedLry[eid] = lry; this.cachedLrz[eid] = lrz; this.cachedLrw[eid] = lrw;
    this.cachedLsx[eid] = lsx; this.cachedLsy[eid] = lsy; this.cachedLsz[eid] = lsz;
    this.cachedLocalValid[eid] = 1;

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
  private hasDirtyDescendants(eid: number): boolean {
    if (!this.childrenStore.has(eid)) return false;
    const childIds = this.childrenStore.get(eid, "entities") as number[] | null;
    if (!childIds) return false;
    for (let i = 0; i < childIds.length; i++) {
      const childEid = childIds[i];
      if (childEid === undefined) continue;
      if (this.worldStore.has(childEid) && (this.worldStore.get(childEid, "dirty") !== 0 || this.isLocallyDirty(childEid))) {
        return true;
      }
      if (this.hasDirtyDescendants(childEid)) return true;
    }
    return false;
  }

  // True when eid's current LocalTransform values differ from what was cached the last time
  // this system actually recomputed its WorldTransform (or it's never been cached at all) — a
  // read-only probe, safe to call from hasDirtyDescendants() without disturbing the cache that
  // updateEntity() itself updates once it commits to recomputing.
  private isLocallyDirty(eid: number): boolean {
    if (eid >= this.localCacheCapacity || this.cachedLocalValid[eid] === 0) return true;
    const l = this.localStore;
    return (
      this.cachedLx[eid] !== (l.get(eid, "x") as number) ||
      this.cachedLy[eid] !== (l.get(eid, "y") as number) ||
      this.cachedLz[eid] !== (l.get(eid, "z") as number) ||
      this.cachedLrx[eid] !== (l.get(eid, "rx") as number) ||
      this.cachedLry[eid] !== (l.get(eid, "ry") as number) ||
      this.cachedLrz[eid] !== (l.get(eid, "rz") as number) ||
      this.cachedLrw[eid] !== (l.get(eid, "rw") as number) ||
      this.cachedLsx[eid] !== (l.get(eid, "sx") as number) ||
      this.cachedLsy[eid] !== (l.get(eid, "sy") as number) ||
      this.cachedLsz[eid] !== (l.get(eid, "sz") as number)
    );
  }

  private ensureLocalCacheCapacity(minCapacity: number): void {
    if (minCapacity <= this.localCacheCapacity) return;
    let cap = this.localCacheCapacity || INITIAL_LOCAL_CACHE_CAPACITY;
    while (cap < minCapacity) cap *= 2;

    const grow = (old: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> => {
      const fresh = new Float32Array(cap);
      fresh.set(old);
      return fresh;
    };
    this.cachedLx = grow(this.cachedLx); this.cachedLy = grow(this.cachedLy); this.cachedLz = grow(this.cachedLz);
    this.cachedLrx = grow(this.cachedLrx); this.cachedLry = grow(this.cachedLry); this.cachedLrz = grow(this.cachedLrz); this.cachedLrw = grow(this.cachedLrw);
    this.cachedLsx = grow(this.cachedLsx); this.cachedLsy = grow(this.cachedLsy); this.cachedLsz = grow(this.cachedLsz);

    const freshValid = new Uint8Array(cap);
    freshValid.set(this.cachedLocalValid);
    this.cachedLocalValid = freshValid;

    this.localCacheCapacity = cap;
  }

  // Still a valid, explicit way to force a recompute (e.g. an entity whose WorldTransform needs
  // to be recomputed for a reason other than its own LocalTransform changing) — no longer the
  // only way dirtiness gets detected, see isLocallyDirty().
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
