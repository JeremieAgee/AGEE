import * as THREE from "three";
import { System, World, ComponentStore } from "../ecs";
import { Transform, MeshRenderer, GPUMeshRenderer } from "../core/Components";
import { Frustum } from "../core/math/Frustum";
import { Vec3 } from "../core/math/Vec3";
import { AABB } from "../core/math/AABB";
import { SpatialHash } from "../core/spatial/SpatialHash";

interface SubtreeBoundsEntry {
  mesh: THREE.Object3D;
  localBox: THREE.Box3;
  childCount: number;
}

export class CullingSystem extends System {
  priority = 800;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  static reads = ["Transform", "MeshRenderer", "GPUMeshRenderer"];
  static writes: string[] = ["GPUMeshRenderer"];

  private transformStore!: ComponentStore;
  private meshStore!: ComponentStore;
  private gpuMeshStore!: ComponentStore;
  private query!: ReturnType<World["query"]>;
  private frustum = new Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private camera!: THREE.Camera;

  visibleCount = 0;
  totalCount = 0;
  private point = new Vec3();
  private aabb = new AABB();
  private tmpBox = new THREE.Box3();

  // Broad phase: same XZ SpatialHash pattern SteeringBehaviors' flocking already uses.
  // Rebuilt every frame (positions can change every frame and Transform carries no dirty
  // flag), then queried once for the camera frustum's XZ footprint so the expensive
  // sphere/AABB-vs-planes test below only runs against plausibly-visible candidates
  // instead of every renderable in the scene.
  private spatialHash = new SpatialHash();
  private candidateIds: number[] = [];
  private candidateSet = new Set<number>();
  private frustumCorner = new THREE.Vector3();

  // Cache of per-entity subtree bounds (local space, relative to the mesh's own transform)
  // for the "container with children but no geometry" fallback path — invalidated only when
  // the mesh reference or its direct child count changes, instead of walking the whole
  // subtree and recomputing every frame.
  private subtreeBoundsCache = new Map<number, SubtreeBoundsEntry>();
  private tmpLocalBox = new THREE.Box3();
  private tmpInvRoot = new THREE.Matrix4();
  private tmpRelMatrix = new THREE.Matrix4();

  private fMinX = 0;
  private fMaxX = 0;
  private fMinZ = 0;
  private fMaxZ = 0;

  // Radius assumed for renderables with no geometry bounding sphere to measure (container/
  // group meshes handled by getSubtreeWorldBox) when padding the broad-phase query below.
  private static readonly CONTAINER_FALLBACK_RADIUS = 32;

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
    this.meshStore = this.world.getStore(MeshRenderer);
    this.gpuMeshStore = this.world.getStore(GPUMeshRenderer);
    this.query = this.world.query(Transform, MeshRenderer);
  }

  update(_dt: number): void {
    if (!this.camera) return;

    this.camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix.elements);

    const entities = this.query.entities;
    const tx = this.transformStore.getColumn("x");
    const ty = this.transformStore.getColumn("y");
    const tz = this.transformStore.getColumn("z");
    const meshRefs = this.meshStore.getColumn("meshRef");
    const visibleCol = this.meshStore.getColumn("visible");
    const skipThreeDrawCol = this.meshStore.getColumn("skipThreeDraw");

    this.totalCount = entities.length;
    let visible = 0;
    const point = this.point;
    const aabb = this.aabb;

    this.spatialHash.clear();
    // The hash only indexes each entity by its Transform origin point, not its extent, so the
    // broad-phase query below is padded by the largest renderable radius seen this frame —
    // otherwise a large mesh (a building, terrain slab, long wall) whose origin sits just
    // outside the frustum's XZ footprint but whose geometry still extends into view would be
    // excluded as a candidate and forced invisible before the precise per-mesh test ever runs.
    let maxRadius = 0;
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const mesh = meshRefs[eid] as THREE.Object3D | null;
      if (!mesh) continue;
      this.spatialHash.insert(eid, tx[eid], tz[eid]);

      const meshObj = mesh as THREE.Mesh;
      let radius: number;
      if (meshObj.geometry) {
        if (!meshObj.geometry.boundingSphere) meshObj.geometry.computeBoundingSphere();
        radius = meshObj.geometry.boundingSphere?.radius ?? 0;
      } else if (mesh.children.length > 0) {
        radius = CullingSystem.CONTAINER_FALLBACK_RADIUS;
      } else {
        radius = 0;
      }
      if (radius > maxRadius) maxRadius = radius;
    }
    this.updateFrustumXZBounds();
    this.spatialHash.queryAABB(
      this.fMinX - maxRadius, this.fMinZ - maxRadius,
      this.fMaxX + maxRadius, this.fMaxZ + maxRadius,
      this.candidateIds
    );
    this.candidateSet.clear();
    for (let i = 0; i < this.candidateIds.length; i++) this.candidateSet.add(this.candidateIds[i]);

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const mesh = meshRefs[eid] as THREE.Object3D | null;
      if (!mesh) continue;

      if (visibleCol[eid] === 0) {
        mesh.visible = false;
        this.setGPUVisible(eid, false);
        continue;
      }

      // Broad phase: not near the frustum's XZ footprint at all -> skip the precise test.
      if (!this.candidateSet.has(eid)) {
        mesh.visible = false;
        this.setGPUVisible(eid, false);
        continue;
      }

      let inFrustum: boolean;
      const meshObj = mesh as THREE.Mesh;

      // Use actual geometry bounds when available
      if (meshObj.geometry) {
        if (!meshObj.geometry.boundingSphere) {
          meshObj.geometry.computeBoundingSphere();
        }
        const sphere = meshObj.geometry.boundingSphere;
        if (sphere) {
          point.set(
            tx[eid] + sphere.center.x,
            ty[eid] + sphere.center.y,
            tz[eid] + sphere.center.z
          );
          inFrustum = this.frustum.intersectsSphere(point, sphere.radius);
        } else {
          point.set(tx[eid], ty[eid], tz[eid]);
          inFrustum = this.frustum.containsPoint(point);
        }
      } else if (mesh.children.length > 0) {
        const box = this.getSubtreeWorldBox(eid, mesh);
        if (box) {
          aabb.min.set(box.min.x, box.min.y, box.min.z);
          aabb.max.set(box.max.x, box.max.y, box.max.z);
          inFrustum = this.frustum.intersectsAABB(aabb);
        } else {
          point.set(tx[eid], ty[eid], tz[eid]);
          inFrustum = this.frustum.containsPoint(point);
        }
      } else {
        // Fallback: point containment test
        point.set(tx[eid], ty[eid], tz[eid]);
        inFrustum = this.frustum.containsPoint(point);
      }

      // `visible` (checked above) is the single on/off switch shared by both draw paths.
      // `skipThreeDraw` only suppresses the THREE.js-side draw for meshes that already have
      // a GPU-native twin (see GLTFPipeline) — it must never affect GPUMeshRenderer visibility,
      // or the GPU-native path would never draw anything it was handed.
      mesh.visible = inFrustum && skipThreeDrawCol[eid] !== 1;
      this.setGPUVisible(eid, inFrustum);
      if (inFrustum) visible++;
    }
    this.visibleCount = visible;
  }

  private setGPUVisible(eid: number, visible: boolean): void {
    if (this.gpuMeshStore.has(eid)) {
      this.gpuMeshStore.set(eid, "visible", visible ? 1 : 0);
    }
  }

  // World-space AABB of the 8 NDC frustum corners, projected onto XZ. Works for
  // perspective and orthographic cameras alike since it goes through the projection
  // matrix inverse rather than assuming FOV/aspect.
  private updateFrustumXZBounds(): void {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let cx = -1; cx <= 1; cx += 2) {
      for (let cy = -1; cy <= 1; cy += 2) {
        for (let cz = -1; cz <= 1; cz += 2) {
          this.frustumCorner.set(cx, cy, cz).unproject(this.camera);
          if (this.frustumCorner.x < minX) minX = this.frustumCorner.x;
          if (this.frustumCorner.x > maxX) maxX = this.frustumCorner.x;
          if (this.frustumCorner.z < minZ) minZ = this.frustumCorner.z;
          if (this.frustumCorner.z > maxZ) maxZ = this.frustumCorner.z;
        }
      }
    }
    this.fMinX = minX;
    this.fMaxX = maxX;
    this.fMinZ = minZ;
    this.fMaxZ = maxZ;
  }

  private getSubtreeWorldBox(eid: number, mesh: THREE.Object3D): THREE.Box3 | null {
    const childCount = mesh.children.length;
    let entry = this.subtreeBoundsCache.get(eid);
    if (!entry || entry.mesh !== mesh || entry.childCount !== childCount) {
      entry = { mesh, localBox: new THREE.Box3(), childCount };
      this.computeLocalSubtreeBox(mesh, entry.localBox);
      this.subtreeBoundsCache.set(eid, entry);
    }
    if (entry.localBox.isEmpty()) return null;

    mesh.updateWorldMatrix(true, false);
    this.tmpBox.copy(entry.localBox).applyMatrix4(mesh.matrixWorld);
    return this.tmpBox;
  }

  // Bounds of `root`'s subtree expressed relative to root's own transform, so callers can
  // reapply root.matrixWorld (an O(1) box transform) every frame instead of re-walking every
  // descendant and geometry to rebuild the box from scratch.
  private computeLocalSubtreeBox(root: THREE.Object3D, target: THREE.Box3): void {
    target.makeEmpty();
    root.updateWorldMatrix(true, true);
    this.tmpInvRoot.copy(root.matrixWorld).invert();

    root.traverse((obj) => {
      const geometry = (obj as THREE.Mesh).geometry;
      if (!geometry) return;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingBox) return;

      this.tmpLocalBox.copy(geometry.boundingBox);
      this.tmpRelMatrix.multiplyMatrices(this.tmpInvRoot, obj.matrixWorld);
      this.tmpLocalBox.applyMatrix4(this.tmpRelMatrix);
      target.union(this.tmpLocalBox);
    });
  }
}
