import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { System, World } from "../ecs";
import { Transform, MeshRenderer } from "../core/Components";
import { ComponentStore } from "../ecs";

export type RenderBackend = "webgl" | "webgpu";
export type AGRenderer = THREE.WebGLRenderer | WebGPURenderer;

export class RenderSystem extends System {
  priority = 900;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  static reads = ["Transform", "MeshRenderer"];
  static writes: string[] = [];

  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: AGRenderer;
  readonly requestedBackend: RenderBackend;
  readonly backend: RenderBackend;
  readonly ready: Promise<void>;

  private transformStore!: ComponentStore;
  private meshStore!: ComponentStore;
  private query!: ReturnType<World["query"]>;
  private postProcessActive = false;
  // GPURenderSystem (WebGPU-native) is the active opaque-geometry draw path. This system's
  // canvas renders transparent on top of it as a compositing overlay, so anything not yet
  // migrated to the native path (particles, world-space UI, debug wireframes) still shows up;
  // meshes that GLTFPipeline has handed to the GPU path get MeshRenderer.visible=0 so they
  // aren't drawn twice. `active` is a manual kill-switch for the overlay pass itself.
  active = true;

  constructor(canvas?: HTMLCanvasElement, backend: RenderBackend = "webgpu") {
    super();
    this.requestedBackend = backend;

    const useWebGPU = backend === "webgpu" && "gpu" in navigator;
    this.backend = useWebGPU ? "webgpu" : "webgl";
    this.renderer = useWebGPU
      ? new WebGPURenderer({ canvas, antialias: true, alpha: true })
      : new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setClearColor(new THREE.Color(0x000000), 0);

    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    if (useWebGPU) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.BasicShadowMap;
    } else {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    if (!canvas) {
      document.body.appendChild(this.renderer.domElement);
    }

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    this.camera.position.set(0, 8, 15);
    this.camera.lookAt(0, 0, 0);

    window.addEventListener("resize", this.onResize);
    this.ready = this.initRenderer();
  }

  private async initRenderer(): Promise<void> {
    if (this.backend === "webgpu") {
      await (this.renderer as WebGPURenderer).init();
    }
  }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
    this.meshStore = this.world.getStore(MeshRenderer);
    this.query = this.world.query(Transform, MeshRenderer);
  }

  setPostProcessActive(active: boolean): void {
    this.postProcessActive = active;
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  update(_dt: number): void {
    const entities = this.query.entities;
    const tx = this.transformStore.getColumn("x");
    const ty = this.transformStore.getColumn("y");
    const tz = this.transformStore.getColumn("z");
    const trx = this.transformStore.getColumn("rx");
    const trY = this.transformStore.getColumn("ry");
    const trz = this.transformStore.getColumn("rz");
    const meshRefs = this.meshStore.getColumn("meshRef");
    const visibleCol = this.meshStore.getColumn("visible");

    const tsx = this.transformStore.getColumn("sx");
    const tsy = this.transformStore.getColumn("sy");
    const tsz = this.transformStore.getColumn("sz");

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const mesh = meshRefs[eid] as THREE.Object3D | null;
      if (!mesh) continue;

      mesh.position.set(tx[eid], ty[eid], tz[eid]);
      mesh.rotation.set(trx[eid], trY[eid], trz[eid]);
      mesh.scale.set(tsx[eid] || 1, tsy[eid] || 1, tsz[eid] || 1);
      // AUDIT FIX (bug #1): CullingSystem (priority 800) runs before this system
      // (priority 900, same "render" phase) and computes real frustum-culling
      // visibility into mesh.visible. Previously this line unconditionally
      // overwrote that decision with the raw ECS MeshRenderer.visible flag every
      // frame, discarding whatever CullingSystem had just decided. Combine both:
      // the mesh is only shown when the raw flag AND the culling result agree.
      mesh.visible = mesh.visible && visibleCol[eid] !== 0;
    }

    if (this.active && !this.postProcessActive) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  destroy(): void {
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
  }
}
