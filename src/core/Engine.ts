import { World } from "../ecs";
import { CommandBuffer } from "../ecs/CommandBuffer";
import { Clock } from "./Clock";
import { EventBus } from "./EventBus";
import { ResourceManager } from "./handles/ResourceManager";
import { EngineProfiler } from "./EngineProfiler";
import { RenderSystem } from "../systems/RenderSystem";
import type { RenderBackend } from "../systems/RenderSystem";
import { WebGPUOverlaySystem } from "../systems/WebGPUOverlaySystem";
import { PhysicsSystem } from "../systems/PhysicsSystem";
import { TransformHierarchySystem } from "../systems/TransformHierarchySystem";
import { CullingSystem } from "../systems/CullingSystem";
import { PostProcessSystem } from "../systems/PostProcessSystem";
import { PhysicsDebugRenderer } from "../systems/debug/PhysicsDebugRenderer";
import { DebugOverlay } from "../systems/debug/DebugOverlay";
import { DevConsole } from "../systems/debug/DevConsole";
import { DebugDraw } from "../systems/debug/DebugDraw";
import { InputSystem } from "../input/InputSystem";
import { InputActions } from "../input/InputActions";
import { CameraSystem } from "../camera/CameraSystem";
import { AudioSystem } from "../audio/AudioSystem";
import { AudioMixer } from "../audio/AudioMixer";
import { AnimationSystem } from "../animation/AnimationSystem";
import { ParticleSystemEngine } from "../particles/ParticleSystem";
import { UISystem } from "../ui/UISystem";
import { AssetSystem } from "../assets/AssetSystem";
import { GLTFPipeline } from "../assets/pipeline/GLTFPipeline";
import { LightingHelpers } from "../lighting/LightingHelpers";
import { SkeletonSystem } from "../skeleton/SkeletonSystem";
import { SceneSerializer } from "./serialization/SceneSerializer";
import { SpatialHash } from "./spatial/SpatialHash";
import { Transform, MeshRenderer, Light, GPUMeshRenderer } from "./Components";
import { GPUContext } from "../gpu/GPUContext";
import { GPURenderSystem } from "../gpu/GPURenderSystem";
import { GPUMesh } from "../gpu/GPUMesh";
import { HandleMap, type Handle } from "./handles/Handle";
import { NetworkManager } from "../network/NetworkManager";
import type { NetworkConfig } from "../network/NetworkManager";
import * as THREE from "three";

export type EngineState = "uninitialized" | "initializing" | "initialized" | "running" | "error" | "destroyed";

export interface AGEEConfig {
  canvas?: HTMLCanvasElement;
  uiOverlayId?: string;
  headless?: boolean;
  renderBackend?: RenderBackend;
  postProcess?: {
    bloom?: { strength: number; radius: number; threshold: number };
    fxaa?: boolean;
  };
  profiler?: boolean;
  memoryBudget?: number;
  initTimeout?: number;
  network?: NetworkConfig;
}

export class AGEE {
  readonly world = new World();
  readonly clock = new Clock();
  readonly events = new EventBus();
  readonly commands = new CommandBuffer();
  readonly resources = new ResourceManager();
  readonly serializer = new SceneSerializer();
  readonly spatialHash = new SpatialHash(16);
  readonly profiler: EngineProfiler;

  readonly assetSystem: AssetSystem;
  readonly gltfPipeline!: GLTFPipeline;

  readonly render!: RenderSystem;
  readonly webgpuOverlay!: WebGPUOverlaySystem;
  readonly physics: PhysicsSystem;
  readonly input!: InputSystem;
  readonly actions!: InputActions;
  readonly camera!: CameraSystem;
  readonly audio!: AudioSystem;
  readonly mixer!: AudioMixer;
  readonly animation!: AnimationSystem;
  readonly particles!: ParticleSystemEngine;
  readonly ui!: UISystem;
  readonly skeleton: SkeletonSystem;
  readonly transformHierarchy: TransformHierarchySystem;
  readonly culling!: CullingSystem;
  readonly postProcess!: PostProcessSystem;
  readonly physicsDebug!: PhysicsDebugRenderer;
  readonly debugOverlay!: DebugOverlay;
  readonly devConsole!: DevConsole;
  readonly debugDraw!: DebugDraw;
  lighting!: LightingHelpers;

  // Networking
  readonly network?: NetworkManager;

  // GPU-native render pipeline (Phase 1)
  gpuContext!: GPUContext;
  readonly gpuRender!: GPURenderSystem;
  readonly gpuMeshPool = new HandleMap<GPUMesh>();

  private running = false;
  private rafId = 0;
  private headless: boolean;
  private config: AGEEConfig;
  private _state: EngineState = "uninitialized";
  private initSteps: string[] = [];

  get state(): EngineState { return this._state; }

  constructor(config: AGEEConfig = {}) {
    this.config = config;
    this.headless = config.headless ?? false;

    this.profiler = new EngineProfiler({
      enabled: config.profiler ?? false,
      historyLength: 120,
      trackSystems: true,
      trackMemory: true,
      trackRendering: true,
    });

    this.assetSystem = new AssetSystem();

    if (config.memoryBudget) {
      this.resources.setMemoryBudget(config.memoryBudget);
      this.assetSystem.memoryBudget.setTotalBudget(config.memoryBudget);
    }

    this.physics = new PhysicsSystem();
    this.skeleton = new SkeletonSystem();
    this.transformHierarchy = new TransformHierarchySystem();

    this.world.setProfiler(this.profiler);

    if (!this.headless) {
      (this as any).input = new InputSystem(config.canvas);
      (this as any).actions = new InputActions((this as any).input);
      (this as any).render = new RenderSystem(config.canvas, config.renderBackend ?? "webgpu");
      (this as any).webgpuOverlay = new WebGPUOverlaySystem();
      (this as any).camera = new CameraSystem();
      (this as any).audio = new AudioSystem();
      (this as any).animation = new AnimationSystem();
      (this as any).particles = new ParticleSystemEngine();
      (this as any).ui = new UISystem(config.uiOverlayId);
      (this as any).culling = new CullingSystem();
      (this as any).postProcess = new PostProcessSystem();
      (this as any).physicsDebug = new PhysicsDebugRenderer();
      if (__EDITOR__) {
        (this as any).debugOverlay = new DebugOverlay();
        (this as any).devConsole = new DevConsole();
      }
      (this as any).debugDraw = new DebugDraw();
      (this as any).gltfPipeline = new GLTFPipeline(this.assetSystem);
    }
  }

  async init(): Promise<void> {
    if (this._state !== "uninitialized") {
      throw new Error(`[AGEE] Cannot init engine in state "${this._state}"`);
    }
    this._state = "initializing";
    this.initSteps = [];

    const timeout = this.config.initTimeout ?? 30000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[AGEE] Init timed out after ${timeout}ms. Completed steps: ${this.initSteps.join(", ")}`)), timeout)
    );

    try {
      await Promise.race([this.doInit(), timeoutPromise]);
      this._state = "initialized";
    } catch (e) {
      this._state = "error";
      console.error("[AGEE] Initialization failed:", e);
      this.rollbackInit();
      throw e;
    }
  }

  private async doInit(): Promise<void> {
    // Phase 1: Parallel async — independent heavy loads run concurrently
    const parallelInits: Promise<void>[] = [];
    parallelInits.push(this.initStep("rapier", () => this.physics.initRapier()));
    if (!this.headless) {
      parallelInits.push(this.initStep("renderer", () => this.render.ready));
      parallelInits.push(this.initStep("gpuContext", async () => {
        this.gpuContext = await GPUContext.create();
        (this as any).gpuRender = new GPURenderSystem();
      }));
    }
    await Promise.all(parallelInits);

    // Phase 2: Independent system registration (no cross-dependencies)
    this.initStep("assetSystem", () => {
      this.assetSystem.setEvents(this.events);
      this.world.addSystem(this.assetSystem);
    });
    this.initStep("physics", () => this.world.addSystem(this.physics));

    if (!this.headless) {
      this.initStep("input", () => {
        this.world.addSystem(this.input);
        InputActions.defaultBindings(this.actions);
      });
    }

    // Phase 3: Dependent system registration
    this.initStep("skeleton", () => {
      this.skeleton.setPhysics(this.physics);
      this.world.addSystem(this.skeleton);
    });
    this.initStep("transformHierarchy", () => this.world.addSystem(this.transformHierarchy));

    if (!this.headless) {
      const webgpuRenderer = this.render.renderer as unknown as { backend?: { device?: GPUDevice; utils?: { getPreferredCanvasFormat?: () => GPUTextureFormat } } };
      const device = webgpuRenderer.backend?.device;
      const format = webgpuRenderer.backend?.utils?.getPreferredCanvasFormat?.();

      await this.initStep("webgpuOverlay", () => {
        const gpuDevice = this.gpuContext?.device ?? device;
        const gpuFormat = this.gpuContext?.format ?? format;
        return this.webgpuOverlay.initGPU(gpuDevice, gpuFormat);
      });

      this.initStep("camera", () => {
        this.camera.setCamera(this.render.camera);
        this.world.addSystem(this.camera);
      });

      this.initStep("animation", () => {
        this.animation.setAssets(this.assetSystem);
        this.world.addSystem(this.animation);
      });

      this.initStep("systems", () => {
        this.world.addSystem(this.particles);
        this.world.addSystem(this.audio);
        this.world.addSystem(this.culling);
        this.world.addSystem(this.physicsDebug);
        this.world.addSystem(this.render);
        this.world.addSystem(this.webgpuOverlay);
        this.world.addSystem(this.postProcess);
        this.world.addSystem(this.ui);
        if (__EDITOR__) {
          this.world.addSystem(this.debugOverlay);
          this.world.addSystem(this.devConsole);
        }
        this.world.addSystem(this.debugDraw);
      });

      this.initStep("wiring", () => {
        this.particles.setScene(this.render.scene);
        this.audio.attachToCamera(this.render.camera);
        this.culling.setCamera(this.render.camera);
        this.lighting = new LightingHelpers(this.world, this.render.scene);
        this.physicsDebug.setup(this.render.scene, this.physics);
        (this as any).mixer = new AudioMixer(this.audio.listener);
        if (__EDITOR__) {
          this.debugOverlay.setProfiler(this.profiler);
        }
        this.debugDraw.setup(this.render.scene);
      });

      // GPU-native render pipeline — this is now the active opaque-geometry draw path.
      // The Three.js RenderSystem keeps running as a transparent overlay (see its
      // constructor) so particles/world-space UI/debug wireframes — which aren't on the
      // GPU-native path yet — still render, composited on top of the native path's output.
      if (this.gpuContext && this.gpuRender) {
        this.initStep("gpuRender", () => {
          this.gpuRender.setGPUContext(this.gpuContext);
          this.gpuRender.setMeshPool(this.gpuMeshPool);
          this.gpuRender.setCameraSystem(this.camera);
          this.world.addSystem(this.gpuRender);

          if (this.gpuRender.materialPool) {
            this.gltfPipeline.setGPUTarget({
              ctx: this.gpuContext,
              meshPool: this.gpuMeshPool,
              materialPool: this.gpuRender.materialPool,
            });
          }
        });

        this.initStep("gpuCanvas", () => {
          // Only take over canvas layering when we own both canvases (i.e. the host didn't
          // hand us an explicit AGEEConfig.canvas to render into directly).
          if (!this.config.canvas) {
            this.gpuContext.canvas.style.display = "block";
            const overlay = this.render.renderer.domElement;
            overlay.style.position = "fixed";
            overlay.style.inset = "0";
            overlay.style.zIndex = "2";
            overlay.style.pointerEvents = "none";
          }
        });
      }

      if (this.config.postProcess && this.render.backend === "webgl") {
        this.initStep("postProcess", () => {
          this.postProcess.setup(
            this.render.renderer as THREE.WebGLRenderer,
            this.render.scene,
            this.render.camera,
            this.config.postProcess!
          );
          this.render.setPostProcessActive(true);
        });
      }
    }

    // Networking (works in both headless and non-headless modes)
    if (this.config.network) {
      this.initStep("network", () => {
        (this as any).network = new NetworkManager(this.world, this.config.network!);
        this.network!.init();
      });
    }

    if (__EDITOR__ && !this.headless) {
      await this.initStep("editor", async () => {
        const { EditorOverlay } = await import("../editor/EditorOverlay");
        EditorOverlay.init(this);
      });
    }

    // Register entity destroy cleanup for Three.js objects
    this.world.onEntityDestroy((eid) => {
      const meshStore = this.world.getStore(MeshRenderer);
      if (meshStore.has(eid)) {
        const mesh = meshStore.get(eid, "meshRef") as THREE.Object3D | null;
        if (mesh) {
          if (mesh.parent) mesh.parent.remove(mesh);
          disposeObject3D(mesh);
        }
      }
      const lightStore = this.world.getStore(Light);
      if (lightStore.has(eid)) {
        const light = lightStore.get(eid, "lightRef") as THREE.Light | null;
        if (light) {
          if (light.parent) light.parent.remove(light);
          light.dispose();
        }
      }
      // GLTFPipeline allocates a GPUMesh (vertex/index buffers) and a GPU material buffer
      // per spawned instance (see createEntityFromObject) but had no matching release path —
      // every despawn leaked both. free() returns the pooled resource so it can be destroyed;
      // it doesn't destroy it itself, since not every HandleMap holds GPU resources.
      const gpuMeshStore = this.world.getStore(GPUMeshRenderer);
      if (gpuMeshStore.has(eid)) {
        const meshHandle = gpuMeshStore.get(eid, "meshHandle") as number as Handle;
        const materialHandle = gpuMeshStore.get(eid, "materialHandle") as number as Handle;
        const mesh = this.gpuMeshPool.free(meshHandle);
        mesh?.destroy();
        this.gpuRender?.materialPool?.free(materialHandle);
      }
    });

    this.events.emit("init");
  }

  private async initStep(name: string, fn: () => void | Promise<void>): Promise<void> {
    const result = fn();
    if (result instanceof Promise) await result;
    this.initSteps.push(name);
  }

  private rollbackInit(): void {
    try {
      this.world.clear();
      this.resources.disposeAll();
      this.events.clear();
    } catch (e) {
      console.error("[AGEE] Error during init rollback:", e);
    }
  }

  start(): void {
    if (this.running) return;
    if (this._state !== "initialized" && this._state !== "running") {
      throw new Error(`[AGEE] Cannot start engine in state "${this._state}"`);
    }
    this.running = true;
    this._state = "running";
    this.clock.reset();
    this.events.emit("start");
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    if (this._state === "running") this._state = "initialized";
    cancelAnimationFrame(this.rafId);
    this.events.emit("stop");
  }

  private loop = (timestamp: number): void => {
    if (!this.running) return;

    this.profiler.beginFrame();
    const dt = this.clock.tick(timestamp);
    if (dt > 0) {
      this.events.emit("preUpdate", dt);

      // Update profiler stats
      this.profiler.setEntityCount(this.world.entityCount);
      this.profiler.setComponentStoreCount(this.world.storeCount);
      this.profiler.setQueryCount(this.world.queryCount);

      // Sync camera matrices to GPU render system before world update
      if (this.gpuRender && this.camera) {
        this.gpuRender.viewMatrix.copy(this.camera.nativeViewMatrix);
        this.gpuRender.projMatrix.copy(this.camera.nativeProjMatrix);
        this.gpuRender.cameraPosition.copy(this.camera.nativeCameraPos);
      }

      this.world.update(dt);
      this.commands.flush(this.world);

      if (!this.headless && this.postProcess?.isEnabled) {
        this.postProcess.render();
      }

      if (!this.headless) {
        this.profiler.setVisibleCount(this.culling.visibleCount, this.culling.totalCount - this.culling.visibleCount);
        this.profiler.setActiveParticles(this.particles.activeParticleCount);

        const stats = this.resources.getStats();
        this.profiler.setTextureCount(stats.textures);
        this.profiler.setGeometryCount(stats.meshes);
        this.profiler.setVRAMEstimate(this.resources.getTotalMemory());
      }

      this.events.emit("postUpdate", dt);
      if (!this.headless) this.input.endFrame();
      this.world.clearFrameFlags();
    }

    this.profiler.endFrame();
    this.rafId = requestAnimationFrame(this.loop);
  };

  destroy(): void {
    this.stop();
    this._state = "destroyed";
    this.world.clear();
    this.resources.disposeAll();
    this.events.clear();
  }
}

function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    // GLTFPipeline-instantiated meshes share geometry/material by reference across every clone
    // of the same asset and flag themselves accordingly (see createEntityFromObject) — those
    // are owned by the AssetSystem's retain/release cycle on the GLTF asset, not by this entity,
    // so disposing them here would free GPU buffers any other live instance still draws from.
    if (child.userData?.assetOwned) return;

    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        for (const key of Object.keys(mat)) {
          const value = (mat as any)[key];
          if (value && typeof value.dispose === "function") {
            value.dispose();
          }
        }
        mat.dispose();
      }
    }
  });
}
