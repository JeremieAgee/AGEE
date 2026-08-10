import * as THREE from "three";
import { System, World, ComponentStore, defineComponent } from "../ecs";
import { Transform, MeshRenderer } from "../core/Components";

export const LODGroup = defineComponent("LODGroup", {
  levelsRef: "ref",
  currentLevel: "i32",
});

export interface LODLevel {
  mesh: THREE.Object3D;
  distance: number;
}

const LOD_HYSTERESIS = 0.1;

// Mirrors Engine.ts's disposeObject3D for MeshRenderer cleanup -- geometry/material aren't
// shared with anything else here (each LOD level owns its own mesh), so a plain traverse +
// dispose is safe without needing the assetOwned skip that GLTF-instanced meshes require.
function disposeLODObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) mat.dispose();
    }
  });
}

export class LODSystem extends System {
  priority = 810;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  static reads = ["Transform", "MeshRenderer", "LODGroup"];
  static writes = ["MeshRenderer"];

  private transformStore!: ComponentStore;
  private meshStore!: ComponentStore;
  private lodStore!: ComponentStore;
  private query!: ReturnType<World["query"]>;
  private camera!: THREE.Camera;

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
    this.meshStore = this.world.getStore(MeshRenderer);
    this.lodStore = this.world.getStore(LODGroup);
    this.query = this.world.query(Transform, LODGroup);

    // createLOD() adds every LOD level's Object3D straight into the THREE scene, bypassing
    // the MeshRenderer component that Engine.ts's entity-destroy hook checks for -- so without
    // this, destroying an LOD'd entity would leave every level (geometry/material/GPU buffers)
    // in the scene forever. This mirrors the same world.onEntityDestroy registry Engine.ts and
    // NetworkReceiveSystem already use for their own per-system cleanup (see World.ts).
    this.world.onEntityDestroy((eid) => this.disposeForEntity(eid));
  }

  createLOD(eid: number, levels: LODLevel[], scene: THREE.Scene): void {
    for (const level of levels) {
      level.mesh.visible = false;
      scene.add(level.mesh);
    }

    this.world.addComponent(eid, LODGroup, {
      levelsRef: levels,
      currentLevel: 0,
    });

    if (levels.length > 0) levels[0].mesh.visible = true;
  }

  /** Removes this entity's LOD levels from the scene and disposes their geometry/materials.
   * Called automatically on entity destroy (registered in init() above); safe to call directly
   * too. Runs before World.destroyEntity() clears component stores, so lodStore.get() below
   * still resolves. */
  private disposeForEntity(eid: number): void {
    if (!this.lodStore.has(eid)) return;
    const levels = this.lodStore.get(eid, "levelsRef") as LODLevel[] | null;
    if (!levels) return;
    for (const level of levels) {
      const mesh = level.mesh;
      if (mesh.parent) mesh.parent.remove(mesh);
      disposeLODObject3D(mesh);
    }
  }

  update(_dt: number): void {
    if (!this.camera) return;

    const entities = this.query.entities;
    const camPos = this.camera.position;
    const tx = this.transformStore.getColumn("x");
    const ty = this.transformStore.getColumn("y");
    const tz = this.transformStore.getColumn("z");

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const levels = this.lodStore.get(eid, "levelsRef") as LODLevel[];
      if (!levels || levels.length === 0) continue;

      const dx = tx[eid] - camPos.x;
      const dy = ty[eid] - camPos.y;
      const dz = tz[eid] - camPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const currentLevel = this.lodStore.get(eid, "currentLevel") as number;

      // Determine best LOD with hysteresis to prevent oscillation
      let bestLevel = levels.length - 1;
      for (let l = 0; l < levels.length; l++) {
        const threshold = levels[l].distance;
        if (l === currentLevel) {
          // Current level uses wider band — must move further to switch away
          if (dist <= threshold * (1 + LOD_HYSTERESIS)) {
            bestLevel = l;
            break;
          }
        } else if (l < currentLevel) {
          // Moving to higher detail: require moving closer past hysteresis band
          if (dist <= threshold * (1 - LOD_HYSTERESIS)) {
            bestLevel = l;
            break;
          }
        } else {
          if (dist <= threshold) {
            bestLevel = l;
            break;
          }
        }
      }

      if (bestLevel !== currentLevel) {
        levels[currentLevel].mesh.visible = false;
        levels[bestLevel].mesh.visible = true;
        this.lodStore.set(eid, "currentLevel", bestLevel);
      }

      const activeMesh = levels[bestLevel].mesh;
      activeMesh.position.set(tx[eid], ty[eid], tz[eid]);
      // See RenderSystem's identical fix: Transform's Euler angles are produced by this
      // engine's ZYX-convention Quat<->Euler math, not THREE's default XYZ order.
      activeMesh.rotation.order = "ZYX";
      activeMesh.rotation.set(
        this.transformStore.get(eid, "rx"),
        this.transformStore.get(eid, "ry"),
        this.transformStore.get(eid, "rz")
      );
      activeMesh.scale.set(
        this.transformStore.get(eid, "sx") || 1,
        this.transformStore.get(eid, "sy") || 1,
        this.transformStore.get(eid, "sz") || 1
      );
    }
  }
}
