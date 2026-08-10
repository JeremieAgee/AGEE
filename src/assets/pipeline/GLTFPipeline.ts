import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { World } from "../../ecs";
import { Transform, MeshRenderer, GPUMeshRenderer } from "../../core/Components";
import { LocalTransform, WorldTransform, Parent, Children } from "../../core/HierarchyComponents";
import type { GPUContext } from "../../gpu/GPUContext";
import type { Handle, HandleMap } from "../../core/handles/Handle";
import { GPUMesh } from "../../gpu/GPUMesh";
import type { GPUMaterialPool } from "../../gpu/GPUMaterialPool";
import { extractGeometry } from "../../gpu/ThreeGeometryAdapter";
import { AssetSystem } from "../AssetSystem";
import { AssetType, AssetHandle, AssetId, INVALID_ASSET } from "../AssetTypes";
import { estimateTextureBytes } from "../MemoryEstimates";
import { ResourceType } from "../../core/handles/Handle";

// THREE.Material property names that may hold a texture map, checked when registering a
// material's textures as its own AssetStore dependencies (see loadAndRegister). Not exhaustive
// of every material type's texture slots, but covers what GLTFLoader actually populates on the
// MeshStandardMaterial/MeshPhysicalMaterial instances it produces.
const TEXTURE_MAP_KEYS = [
  "map", "normalMap", "aoMap", "metalnessMap", "roughnessMap", "emissiveMap",
  "bumpMap", "displacementMap", "alphaMap", "lightMap", "specularMap",
] as const;

function estimateGeometryBytes(geo: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const key in geo.attributes) {
    bytes += geo.attributes[key].array.byteLength;
  }
  if (geo.index) bytes += geo.index.array.byteLength;
  return bytes;
}

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
  // Tracks a load() call already in flight for a given id, mirroring AssetSystem.load()'s own
  // cache-hit/inflight handling for plain assets (see AssetSystem.ts). Without this, a second
  // caller loading the same GLTF id before (or after) the first has finished re-runs the whole
  // fetch/parse/register pass: every mesh/material/animation dependency gets registered again
  // under the same id (a no-op, register() dedupes by id) but is still retain()'d and pushed
  // into the dependency list a second time, and setLoaded() overwrites the previously-parsed
  // geometry/material data with the freshly-parsed one without disposing the original —
  // leaking it, since nothing else held a reference to dispose it. Routing repeat/concurrent
  // callers through this cache instead makes a shared GLTF asset retain-counted like every
  // other asset type: N callers means N retains on the one real load, not N independent loads.
  private inflight = new Map<AssetId, Promise<GLTFAsset>>();

  // AUDIT FIX: createEntityFromObject() used to call GPUMesh.create()/meshPool.alloc() fresh
  // for every instance instantiate() produced, so N instances of one asset uploaded N
  // independent GPU vertex/index buffers instead of sharing one. instantiate() clones share
  // the source geometry by reference (see instantiate()'s cloneSkeleton comment — every clone's
  // Mesh.geometry is literally the same THREE.BufferGeometry object as the original asset's),
  // so caching the resulting GPUMesh handle by that geometry identity and meshPool.retain()-ing
  // it on a cache hit gives the standard shared-resource-instancing pattern for free, using the
  // engine's existing ref-counted HandleMap (meshPool) rather than new infrastructure. Engine.ts's
  // per-entity destroy path already free()s/getRefCount()-gates destroy() on meshPool handles
  // correctly (see its GPUMeshRenderer cleanup), so a shared handle is released safely as
  // instances are destroyed.
  //
  // Materials are deliberately NOT cached/shared the same way: GPUMaterialPool.free() (src/gpu/,
  // out of scope for this pass) unconditionally destroys the material's buffer and owned
  // textures on every free() call regardless of how many handles/entities still reference it —
  // unlike meshPool, it isn't refcount-gated and exposes no retain(). Sharing a materialHandle
  // across entities under that behavior would mean destroying any one sharing entity frees GPU
  // resources every other entity referencing the same handle is still drawing from — a
  // use-after-free, not a fix. Fixing that would require ref-counted destroy in
  // GPUMaterialPool.free() (and Engine.ts's cleanup to gate on it, mirroring the mesh path),
  // which is out of scope here.
  private gpuMeshCache = new Map<THREE.BufferGeometry, Handle>();

  constructor(assets: AssetSystem) {
    this.assets = assets;
  }

  /** Configure GPU-native mesh/material upload for entities created via instantiate(). Pass null to disable (e.g. headless). */
  setGPUTarget(target: GPUTarget | null): void {
    this.gpuTarget = target;
  }

  async load(id: AssetId, path: string): Promise<GLTFAsset> {
    const existingHandle = this.assets.store.getHandleById(id);
    if (existingHandle !== INVALID_ASSET && this.assets.store.isLoaded(existingHandle)) {
      // Cache-hit: this caller is a distinct owner and must retain just like a cold load
      // does, or its later release() would over-release an asset another owner still holds.
      this.assets.store.retain(existingHandle);
      return this.assets.store.getData<GLTFAsset>(existingHandle) as GLTFAsset;
    }

    const inflightLoad = this.inflight.get(id);
    if (inflightLoad) {
      // Another caller's load of this same id is already in progress; this caller becomes a
      // second owner of the same eventual result and must retain too. loadAndRegister() only
      // retains once (for whichever call actually performs it), so this call must retain on
      // its own behalf rather than skip it.
      if (existingHandle !== INVALID_ASSET) this.assets.store.retain(existingHandle);
      return inflightLoad;
    }

    const gltfHandle = this.assets.registerGLTF(id, path);
    this.assets.store.setLoading(gltfHandle);

    const promise = this.loadAndRegister(gltfHandle, id, path).catch((err) => {
      // Without this, a failed fetch/parse leaves the asset stuck in LoadStatus.Loading
      // forever — isReady()/getStatus() callers never see it transition to Failed.
      this.assets.store.setFailed(gltfHandle, err instanceof Error ? err.message : String(err));
      throw err;
    });
    this.inflight.set(id, promise);
    // See AssetSystem.load()'s identical fix: `.then(cleanup, cleanup)` rather than
    // `.finally(cleanup)` so a failed load's rejection doesn't also surface as a second,
    // uncatchable "unhandled rejection" from the discarded derived promise `.finally()` would
    // produce.
    promise.then(
      () => this.inflight.delete(id),
      () => this.inflight.delete(id)
    );
    return promise;
  }

  private async loadAndRegister(gltfHandle: AssetHandle, id: AssetId, path: string): Promise<GLTFAsset> {
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
    const textureCache = new Map<THREE.Texture, AssetHandle>();

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

        const meshBytes = estimateGeometryBytes(node.geometry);
        this.assets.store.setMemorySize(meshHandle, meshBytes);
        this.assets.memoryBudget.trackAllocation(ResourceType.Mesh, meshBytes);

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

            // THREE.Material.dispose() does NOT dispose the textures it references, so without
            // registering them as the material's own dependencies here, every load/unload cycle
            // of a textured material leaked its GPU texture memory permanently — nothing else in
            // the engine ever called .dispose() on these THREE.Texture instances.
            for (const key of TEXTURE_MAP_KEYS) {
              const tex = (mat as unknown as Record<string, unknown>)[key];
              if (!(tex instanceof THREE.Texture)) continue;
              let texHandle = textureCache.get(tex);
              if (texHandle === undefined) {
                const texId = `${id}:tex:${tex.name || tex.uuid}`;
                texHandle = this.assets.store.register(texId, AssetType.Texture, path);
                this.assets.store.setLoaded(texHandle, tex);
                this.assets.store.retain(texHandle);
                const texBytes = estimateTextureBytes(tex);
                this.assets.store.setMemorySize(texHandle, texBytes);
                this.assets.memoryBudget.trackAllocation(ResourceType.Texture, texBytes);
                textureCache.set(tex, texHandle);
              } else {
                this.assets.store.retain(texHandle);
              }
              this.assets.store.addDependency(matHandle, texHandle);
            }
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

    // createEntityFromObject reparents whatever Object3D it's handed (parentScene.add(obj) —
    // THREE.Object3D.add() removes the child from its previous parent first). Without cloning,
    // a second instantiate() of the same cached asset.sceneRoot rips its meshes out of the
    // first instance's scene instead of creating an independent instance. SkeletonUtils.clone()
    // shares geometry/material by reference (the expensive GPU-side data) and only deep-copies
    // the lightweight Object3D transform hierarchy, so this doesn't duplicate any asset memory —
    // unlike plain Object3D.clone(true), it also rebinds any SkinnedMesh's skeleton to the
    // cloned Bone hierarchy instead of leaving it pointed at the original instance's bones.
    const instanceRoot = cloneSkeleton(asset.sceneRoot) as THREE.Object3D;
    const rootEid = this.createEntityFromObject(instanceRoot, world, parentScene, result, null);
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
      // Geometry/material are shared by reference across every instance cloned from the same
      // GLTFAsset (see instantiate()) and are owned by the AssetSystem's retain/release cycle
      // on the GLTF asset itself -- Engine.ts's per-entity destroy cleanup must not dispose()
      // them, or destroying one instance would free the GPU buffers every other live instance
      // is still drawing from.
      obj.userData.assetOwned = true;
      parentScene.add(obj);

      // Try to hand this mesh's geometry/material to the GPU-native pipeline. Three.js's
      // copy of the mesh is kept as a fallback (and for physics/culling bookkeeping that
      // still reads MeshRenderer), with `skipThreeDraw` set so CullingSystem/RenderSystem
      // suppress the THREE-side draw without touching `visible` (which stays the shared
      // on/off switch for both the THREE and GPU-native draw paths).
      let gpuAttached = false;
      // GPUMesh/extractGeometry only ever reads position/normal/uv -- it has no skinIndex/
      // skinWeight extraction and GPURenderSystem has no bone-palette uniform or vertex
      // skinning in forward_opaque.wgsl, so a SkinnedMesh uploaded here would render its
      // static bind pose forever while skipThreeDraw silenced the Three.js AnimationMixer
      // path that actually animates it. Leaving the Three.js draw path live for skinned
      // meshes means they keep animating correctly instead of rendering frozen.
      if (this.gpuTarget && !(obj instanceof THREE.SkinnedMesh)) {
        try {
          // Reuse an already-uploaded GPUMesh for this exact (shared) geometry when one
          // exists and is still live — see gpuMeshCache above. retain() returns false for a
          // stale cache entry (e.g. every previous instance sharing it was already destroyed
          // and the handle freed), in which case we fall through and re-upload/re-cache.
          const cachedMeshHandle = this.gpuMeshCache.get(obj.geometry);
          let meshHandle: Handle;
          if (cachedMeshHandle !== undefined && this.gpuTarget.meshPool.retain(cachedMeshHandle)) {
            meshHandle = cachedMeshHandle;
          } else {
            const desc = extractGeometry(obj.geometry);
            const gpuMesh = GPUMesh.create(this.gpuTarget.ctx, desc);
            meshHandle = this.gpuTarget.meshPool.alloc(gpuMesh);
            this.gpuMeshCache.set(obj.geometry, meshHandle);

            // Only counted here, on the cache miss that actually allocates the GPU buffers —
            // not once per instance — so MemoryBudget reflects the real (shared) GPU
            // allocation instead of over-counting by a factor of instance count. This is the
            // GPU-native buffer size (vertexBuffer/indexBuffer.size), separate from the
            // CPU-side geometry byte estimate already tracked once at load time in
            // loadAndRegister().
            const gpuBytes = gpuMesh.vertexBuffer.size + (gpuMesh.indexBuffer?.size ?? 0);
            this.assets.memoryBudget.trackAllocation(ResourceType.Mesh, gpuBytes);
          }

          const srcMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
          const standard = srcMat as THREE.MeshStandardMaterial | undefined;
          const color = standard?.color ?? { r: 0.8, g: 0.8, b: 0.8 };
          const blend = standard?.transparent
            ? (standard.blending === THREE.AdditiveBlending ? "additive" : "alpha")
            : "opaque";
          const materialHandle = this.gpuTarget.materialPool.create({
            r: color.r, g: color.g, b: color.b,
            a: standard?.opacity,
            metalness: standard?.metalness,
            roughness: standard?.roughness,
            blend,
            doubleSided: standard?.side === THREE.DoubleSide,
            map: standard?.map?.image ?? null,
            normalMap: standard?.normalMap?.image ?? null,
            aoMap: standard?.aoMap?.image ?? null,
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
        visible: 1,
        skipThreeDraw: gpuAttached ? 1 : 0,
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
