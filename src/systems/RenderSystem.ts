import * as THREE from "three";
import { System, World } from "../ecs";
import { Transform, MeshRenderer } from "../core/Components";
import { ComponentStore } from "../ecs";

export type RenderBackend = "webgl" | "webgpu";
export type AGRenderer = THREE.WebGLRenderer;

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
  // GPURenderSystem (WebGPU-native) is the active opaque-geometry draw path — a fully custom
  // pipeline built directly on navigator.gpu (see gpu/GPUContext.ts), with no dependency on
  // THREE.js at all. This system's canvas is only a transparent compositing overlay on top of
  // it, for anything not yet migrated to the native path (particles, world-space UI, debug
  // wireframes) — meshes that GLTFPipeline has handed to the GPU path get
  // MeshRenderer.skipThreeDraw=1 so CullingSystem forces mesh.visible=false for them without
  // touching the shared `visible` flag GPUMeshRenderer visibility is computed from.
  //
  // The overlay always renders through THREE.WebGLRenderer (regular "three"), never
  // three/webgpu's WebGPURenderer, even when `renderBackend: "webgpu"` is requested: "three"
  // and "three/webgpu" are separate module instances with separate class hierarchies (THREE
  // itself warns "Multiple instances of Three.js being imported" when both load), so a
  // THREE.Light/THREE.Mesh built anywhere else in the engine via plain "three" (LightingHelpers,
  // GLTFPipeline, CullingSystem, every example) fails WebGPURenderer's internal instanceof
  // checks — it doesn't recognize them as lights or meshes at all, so nothing renders and no
  // light reaches the scene. `renderBackend` is kept as a config option (and reported via
  // `requestedBackend`) purely for API compatibility; real WebGPU rendering is what
  // GPURenderSystem already provides, unconditionally, independent of this setting.
  active = true;

  constructor(canvas?: HTMLCanvasElement, backend: RenderBackend = "webgpu") {
    super();
    this.requestedBackend = backend;
    this.backend = "webgl";

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setClearColor(new THREE.Color(0x000000), 0);

    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
    this.ready = Promise.resolve();
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
      // Transform's rx/ry/rz round-trip through Quat.toEuler()/fromEuler() (and the
      // matching PhysicsSystem/DeterministicMath copies), which are all derived against
      // THREE's 'ZYX' Euler order convention, not its default 'XYZ' — mesh.rotation defaults
      // to 'XYZ', so without this the mesh would render a different orientation than the
      // quaternion math (physics, skeleton FK, etc.) actually computed whenever more than
      // one axis is non-zero.
      mesh.rotation.order = "ZYX";
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
