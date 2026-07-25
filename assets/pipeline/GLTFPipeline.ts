import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { AssetSystem } from "../AssetSystem";
import { AssetType, AssetHandle, AssetId } from "../AssetTypes";

export interface GLTFAsset {
  meshes: AssetHandle[];
  materials: AssetHandle[];
  animations: AssetHandle[];
  sceneRoot: THREE.Group;
  nodeMap: Map<string, THREE.Object3D>;
}

export class GLTFPipeline {
  private loader = new GLTFLoader();
  private assets: AssetSystem;

  constructor(assets: AssetSystem) {
    this.assets = assets;
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
}
