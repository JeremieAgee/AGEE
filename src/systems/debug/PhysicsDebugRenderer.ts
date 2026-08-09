import * as THREE from "three";
import { System } from "../../ecs";
import { PhysicsSystem } from "../PhysicsSystem";

// Rapier's debugRender() output size varies frame to frame with the live collider/joint
// count, unlike DebugDraw's fixed MAX_LINES budget — so instead of a fixed cap, the
// position/color attributes start at this size and only reallocate (doubling) when a
// frame's data actually exceeds current capacity; the common case is a plain .set() into
// the existing typed array.
const INITIAL_VERTEX_CAPACITY = 4096;

export class PhysicsDebugRenderer extends System {
  priority = 850;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  private mesh!: THREE.LineSegments;
  private scene!: THREE.Scene;
  private physics!: PhysicsSystem;
  private debugVisible = false;

  private positionAttr!: THREE.BufferAttribute;
  private colorAttr!: THREE.BufferAttribute;

  setup(scene: THREE.Scene, physics: PhysicsSystem): void {
    this.scene = scene;
    this.physics = physics;

    const geo = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(new Float32Array(INITIAL_VERTEX_CAPACITY * 3), 3);
    this.colorAttr = new THREE.BufferAttribute(new Float32Array(INITIAL_VERTEX_CAPACITY * 4), 4);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.positionAttr);
    geo.setAttribute("color", this.colorAttr);
    geo.setDrawRange(0, 0);

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

    if (vertices.length > this.positionAttr.array.length) {
      this.positionAttr = new THREE.BufferAttribute(
        new Float32Array(Math.max(vertices.length, this.positionAttr.array.length * 2)), 3
      );
      this.positionAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("position", this.positionAttr);
    }
    if (colors.length > this.colorAttr.array.length) {
      this.colorAttr = new THREE.BufferAttribute(
        new Float32Array(Math.max(colors.length, this.colorAttr.array.length * 2)), 4
      );
      this.colorAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("color", this.colorAttr);
    }

    (this.positionAttr.array as Float32Array).set(vertices);
    (this.colorAttr.array as Float32Array).set(colors);
    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    geo.setDrawRange(0, vertices.length / 3);
  }

  destroy(): void {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.scene?.remove(this.mesh);
    }
  }
}
