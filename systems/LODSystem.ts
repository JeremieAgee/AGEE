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
