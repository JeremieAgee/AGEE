import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { World } from "../../ecs";
import { Transform, MeshRenderer, GPUMeshRenderer } from "../../core/Components";
import { LocalTransform, WorldTransform, Parent, Children } from "../../core/HierarchyComponents";
import type { GPUContext } from "../../gpu/GPUContext";
import type { HandleMap } from "../../core/handles/Handle";
import { GPUMesh } from "../../gpu/GPUMesh";
import type { GPUMaterialPool } from "../../gpu/GPUMaterialPool";
import { extractGeometry } from "../../gpu/ThreeGeometryAdapter";
import { AssetSystem } from "../AssetSystem";
import { AssetType, AssetHandle, AssetId } from "../AssetTypes";

export interface GLTFAsset {
  meshes: AssetHandle[];
  materials: AssetHandle[];
  animations: AssetHandle[];
  sceneRoot: THREE.Group;
  nodeMap: Map<string, THREE.Object3D>;
}

export interface GLTFInstantiateResult {
  entityIds: number[];
  rootEntity: number;
}

export interface GPUTarget {
  ctx: GPUContext;
  meshPool: HandleMap<GPUMesh>;
  materialPool: GPUMaterialPool;
}

export class GLTFPipeline {
  private loader = new GLTFLoader();
  private assets: AssetSystem;
  private gpuTarget: GPUTarget | null = null;

  constructor(assets: AssetSystem) {
    this.assets = assets;
  }

  /** Configure GPU-native mesh/material upload for entities created via instantiate(). Pass null to disable (e.g. headless). */
  setGPUTarget(target: GPUTarget | null): void {
    this.gpuTarget = target;
  }

  async load(id: AssetId, path: string): Promise<GLTFAsset> {
    const gltfHandle = this.assets.registerGLTF(id, path);
    this.assets.store.setLoading(gltfHandle);

    const gltf = await this.loadRaw(path);

    const result: GLTFAsset = {
      meshes: [],
      materials: [],
      animations: [],
      sceneRoot: gltf.scene,
      nodeMap: new Map(),
    };

    // Extract and register meshes + materials as separate assets
    const materialCache = new Map<THREE.Material, AssetHandle>();

    gltf.scene.traverse((node) => {
      if (node.name) result.nodeMap.set(node.name, node);

      if (node instanceof THREE.Mesh) {
        // Register geometry
        const meshId = `${id}:mesh:${node.name || node.uuid}`;
        const meshHandle = this.assets.store.register(meshId, AssetType.Mesh, path);
        this.assets.store.setLoaded(meshHandle, node.geometry);
        this.assets.store.retain(meshHandle);
        this.assets.store.addDependency(gltfHandle, meshHandle);
        result.meshes.push(meshHandle);

        // Register material(s)
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        for (const mat of mats) {
          if (!materialCache.has(mat)) {
            const matId = `${id}:mat:${mat.name || mat.uuid}`;
            const matHandle = this.assets.store.register(matId, AssetType.Material, path);
            this.assets.store.setLoaded(matHandle, mat);
            this.assets.store.retain(matHandle);
            this.assets.store.addDependency(gltfHandle, matHandle);
            materialCache.set(mat, matHandle);
            result.materials.push(matHandle);
          }
        }

        node.castShadow = true;
        node.receiveShadow = true;
      }
    });

    // Register animations
    for (const clip of gltf.animations) {
      const clipId = `${id}:anim:${clip.name || clip.uuid}`;
      const clipHandle = this.assets.store.register(clipId, AssetType.AnimationClip, path);
      this.assets.store.setLoaded(clipHandle, clip);
      this.assets.store.retain(clipHandle);
      this.assets.store.addDependency(gltfHandle, clipHandle);
      result.animations.push(clipHandle);
    }

    this.assets.store.setLoaded(gltfHandle, result);
    this.assets.store.retain(gltfHandle);

    return result;
  }

  private loadRaw(url: string): Promise<GLTF> {
    return new Promise((resolve, reject) => {
      this.loader.load(url, resolve, undefined, reject);
    });
  }

  /**
   * Walk a loaded GLTF's scene graph and create ECS entities for it (Transform hierarchy +
   * MeshRenderer for the Three.js scene, plus GPUMeshRenderer when a GPU target is configured).
   */
  instantiate(
    asset: GLTFAsset,
    world: World,
    parentScene: THREE.Scene,
    position?: { x: number; y: number; z: number }
  ): GLTFInstantiateResult {
    const result: GLTFInstantiateResult = { entityIds: [], rootEntity: -1 };

    const rootEid = this.createEntityFromObject(asset.sceneRoot, world, parentScene, result, null);
    result.rootEntity = rootEid;

    if (position && rootEid >= 0) {
      const store = world.getStore(Transform);
      store.set(rootEid, "x", position.x);
      store.set(rootEid, "y", position.y);
      store.set(rootEid, "z", position.z);
    }

    return result;
  }

  private createEntityFromObject(
    obj: THREE.Object3D,
    world: World,
    parentScene: THREE.Scene,
    result: GLTFInstantiateResult,
    parentEid: number | null
  ): number {
    const eid = world.createEntity();
    result.entityIds.push(eid);

    const pos = obj.position;
    const rot = obj.quaternion;
    const scl = obj.scale;

    world.addComponent(eid, Transform, {
      x: pos.x, y: pos.y, z: pos.z,
      rx: 0, ry: 0, rz: 0,
      sx: scl.x, sy: scl.y, sz: scl.z,
    });

    world.addComponent(eid, LocalTransform, {
      x: pos.x, y: pos.y, z: pos.z,
      rx: rot.x, ry: rot.y, rz: rot.z, rw: rot.w,
      sx: scl.x, sy: scl.y, sz: scl.z,
    });

    world.addComponent(eid, WorldTransform, {
      m00: 1, m01: 0, m02: 0, m03: 0,
      m10: 0, m11: 1, m12: 0, m13: 0,
      m20: 0, m21: 0, m22: 1, m23: 0,
      m30: 0, m31: 0, m32: 0, m33: 1,
      dirty: 1,
    });

    if (parentEid !== null) {
      world.addComponent(eid, Parent, { entity: parentEid });
      if (!world.hasComponent(parentEid, Children)) {
        world.addComponent(parentEid, Children, { entities: [] });
      }
      const childList = world.getStore(Children).get(parentEid, "entities") as number[];
      childList.push(eid);
    }

    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      parentScene.add(obj);

      // Try to hand this mesh's geometry/material to the GPU-native pipeline. Three.js's
      // copy of the mesh is kept as a fallback (and for physics/culling bookkeeping that
      // still reads MeshRenderer), but its `visible` flag is cleared so it doesn't get
      // double-drawn once the GPU-native path is active for it.
      let gpuAttached = false;
      if (this.gpuTarget) {
        try {
          const desc = extractGeometry(obj.geometry);
          const gpuMesh = GPUMesh.create(this.gpuTarget.ctx, desc);
          const meshHandle = this.gpuTarget.meshPool.alloc(gpuMesh);

          const srcMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
          const standard = srcMat as THREE.MeshStandardMaterial | undefined;
          const color = standard?.color ?? { r: 0.8, g: 0.8, b: 0.8 };
          const materialHandle = this.gpuTarget.materialPool.create({
            r: color.r, g: color.g, b: color.b,
            metalness: standard?.metalness,
            roughness: standard?.roughness,
          });

          world.addComponent(eid, GPUMeshRenderer, {
            meshHandle,
            materialHandle,
            visible: 1,
            castShadow: 1,
            receiveShadow: 1,
          });
          gpuAttached = true;
        } catch (e) {
          console.warn("[GLTFPipeline] Failed to upload GPU-native mesh, falling back to Three.js rendering:", e);
        }
      }

      world.addComponent(eid, MeshRenderer, {
        meshRef: obj,
        visible: gpuAttached ? 0 : 1,
        castShadow: 1,
        receiveShadow: 1,
      });
    }

    const childObjects = [...obj.children];
    for (const child of childObjects) {
      this.createEntityFromObject(child, world, parentScene, result, eid);
    }

    return eid;
  }
}
