import * as THREE from "three";
import { System } from "../../ecs";
import { PhysicsSystem } from "../PhysicsSystem";

export class PhysicsDebugRenderer extends System {
  priority = 850;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  private mesh!: THREE.LineSegments;
  private scene!: THREE.Scene;
  private physics!: PhysicsSystem;
  private debugVisible = false;

  setup(scene: THREE.Scene, physics: PhysicsSystem): void {
    this.scene = scene;
    this.physics = physics;

    const geo = new THREE.BufferGeometry();
    const mat = new THREE.LineBasicMaterial({
      color: 0x00ff00,
      vertexColors: true,
      depthTest: false,
      transparent: true,
      opacity: 0.6,
    });
    this.mesh = new THREE.LineSegments(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 999;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  get showDebug(): boolean { return this.debugVisible; }
  set showDebug(v: boolean) {
    this.debugVisible = v;
    if (this.mesh) this.mesh.visible = v;
  }

  toggle(): void {
    this.showDebug = !this.debugVisible;
  }

  update(_dt: number): void {
    if (!this.debugVisible || !this.physics?.rapierWorld) return;

    const buffers = this.physics.rapierWorld.debugRender();
    const vertices = buffers.vertices;
    const colors = buffers.colors;

    const geo = this.mesh.geometry;
    geo.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 4));
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  destroy(): void {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.scene?.remove(this.mesh);
    }
  }
}
