import * as THREE from "three";
import { System, World, ComponentStore } from "../ecs";
import { Transform, MeshRenderer, GPUMeshRenderer } from "../core/Components";
import { Frustum } from "../core/math/Frustum";
import { Vec3 } from "../core/math/Vec3";
import { AABB } from "../core/math/AABB";

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

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const mesh = meshRefs[eid] as THREE.Object3D | null;
      if (!mesh) continue;

      if (visibleCol[eid] === 0) {
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
        const box = this.tmpBox.setFromObject(mesh);
        if (!box.isEmpty()) {
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
}
