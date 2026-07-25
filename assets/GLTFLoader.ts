import * as THREE from "three";
import { GLTFLoader as ThreeGLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { World } from "../ecs";
import { Transform, MeshRenderer } from "../core/Components";
import { LocalTransform, WorldTransform, Parent, Children } from "../core/HierarchyComponents";
import { ResourceManager, MeshHandle, MaterialHandle, AnimClipHandle } from "../core/handles/ResourceManager";

export interface GLTFResult {
  entityIds: number[];
  rootEntity: number;
  meshHandles: MeshHandle[];
  materialHandles: MaterialHandle[];
  animClipHandles: AnimClipHandle[];
  threeScene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export class GLTFAssetLoader {
  private loader = new ThreeGLTFLoader();

  async load(
    url: string,
    world: World,
    resources: ResourceManager,
    parentScene: THREE.Scene,
    position?: { x: number; y: number; z: number }
  ): Promise<GLTFResult> {
    const gltf = await this.loadRaw(url);

    const result: GLTFResult = {
      entityIds: [],
      rootEntity: -1,
      meshHandles: [],
      materialHandles: [],
      animClipHandles: [],
      threeScene: gltf.scene,
      animations: gltf.animations,
    };

    // Register animation clips
    for (const clip of gltf.animations) {
      result.animClipHandles.push(resources.addAnimClip(clip));
    }

    // Walk the GLTF scene graph and create ECS entities
    const rootEid = this.createEntityFromObject(
      gltf.scene, world, resources, parentScene, result, null
    );
    result.rootEntity = rootEid;

    // Apply position offset to root
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
    resources: ResourceManager,
    parentScene: THREE.Scene,
    result: GLTFResult,
    parentEid: number | null
  ): number {
    const eid = world.createEntity();
    result.entityIds.push(eid);

    // Transform
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

    // Parent/child hierarchy
    if (parentEid !== null) {
      world.addComponent(eid, Parent, { entity: parentEid });
      if (!world.hasComponent(parentEid, Children)) {
        world.addComponent(parentEid, Children, { entities: [] });
      }
      const childList = world.getStore(Children).get(parentEid, "entities") as number[];
      childList.push(eid);
    }

    // Mesh
    if (obj instanceof THREE.Mesh) {
      const geo = obj.geometry;
      const mat = obj.material as THREE.Material;

      const mh = resources.addMesh(geo);
      result.meshHandles.push(mh);

      const matH = resources.addMaterial(mat);
      result.materialHandles.push(matH);

      obj.castShadow = true;
      obj.receiveShadow = true;
      parentScene.add(obj);

      world.addComponent(eid, MeshRenderer, {
        meshRef: obj,
        visible: 1,
        castShadow: 1,
        receiveShadow: 1,
      });
    } else if (obj.children.length === 0) {
      // Empty node — just transform, no mesh
    }

    // Recurse children
    const childObjects = [...obj.children];
    for (const child of childObjects) {
      this.createEntityFromObject(child, world, resources, parentScene, result, eid);
    }

    return eid;
  }

  private loadRaw(url: string): Promise<GLTF> {
    return new Promise((resolve, reject) => {
      this.loader.load(url, resolve, undefined, reject);
    });
  }
}
