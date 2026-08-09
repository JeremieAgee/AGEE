import { System, World, ComponentStore } from "../ecs";
import { Transform, GPUMeshRenderer } from "../core/Components";
import { Mat4 } from "../core/math/Mat4";
import { Vec3 } from "../core/math/Vec3";
import { Quat } from "../core/math/Quat";
import { GPUContext } from "./GPUContext";
import { GPUMesh, VERTEX_BUFFER_LAYOUT } from "./GPUMesh";
import { GPUMaterialPool, type GPUBlendMode } from "./GPUMaterialPool";
import { createFrameLayouts, type FrameLayouts } from "./BindGroupLayouts";
import type { Handle } from "../core/handles/Handle";
import type { HandleMap } from "../core/handles/Handle";
import type { CameraSystem } from "../camera/CameraSystem";
import { LightSync } from "./LightSync";
import forwardOpaqueWGSL from "./shaders/forward_opaque.wgsl?raw";
import shadowDepthWGSL from "./shaders/shadow_depth.wgsl?raw";

// AUDIT FIX (bug #4): writes an Euler rotation directly into an existing Quat
// instead of allocating a new one, mirroring Quat.fromEuler's formula exactly.
// Used in the per-visible-entity draw loop below, where every other temporary
// (_pos, _quat, _scale, _modelMat, _normalMat) is pooled — calling the
// allocating Quat.fromEuler() once per entity per frame was the one exception.
function eulerToQuatInto(out: Quat, x: number, y: number, z: number): void {
  const cx = Math.cos(x * 0.5), sx = Math.sin(x * 0.5);
  const cy = Math.cos(y * 0.5), sy = Math.sin(y * 0.5);
  const cz = Math.cos(z * 0.5), sz = Math.sin(z * 0.5);
  out.x = sx * cy * cz - cx * sy * sz;
  out.y = cx * sy * cz + sx * cy * sz;
  out.z = cx * cy * sz - sx * sy * cz;
  out.w = cx * cy * cz + sx * sy * sz;
}

const MAX_ENTITIES = 16384;
const MODEL_UNIFORM_SIZE = 128;
const MODEL_UNIFORM_ALIGNMENT = 256;
const CAMERA_UNIFORM_SIZE = 128;
const LIGHT_STRIDE = 64;
const MAX_LIGHTS = 64;
const LIGHT_INFO_SIZE = 16;

// Single directional-light shadow map. The frustum is a fixed-size ortho box centered on the
// camera each frame (rather than tracked scene bounds) -- simple and camera-relative, at the
// cost of shadows outside SHADOW_HALF_EXTENT of the camera not being captured.
const SHADOW_MAP_SIZE = 2048;
const SHADOW_HALF_EXTENT = 40;
const SHADOW_DISTANCE = 60;
const SHADOW_NEAR = 0.1;
const SHADOW_UNIFORM_FLOATS = 20; // mat4x4 (16) + params vec4 (4)

interface DrawCall {
  mesh: GPUMesh;
  modelOffset: number;
  materialBindGroup: GPUBindGroup;
  materialKey: number;
  pipeline: GPURenderPipeline;
  distance: number;
}

// WebGPU bakes blend state and face culling into the pipeline object, so a material's blend
// mode (opaque/alpha/additive) and doubleSided flag select which of these six pre-built
// pipelines a draw call uses -- there is no per-draw blend/cull toggle available otherwise.
type PipelineKey = `${GPUBlendMode}:${"back" | "none"}`;

export class GPURenderSystem extends System {
  // AUDIT FIX (bug #6): this used to collide with RenderSystem's priority=900.
  // Per src/core/Engine.ts's doc comment where both are registered, this
  // WebGPU-native path is the primary opaque-geometry draw path and the Three.js
  // RenderSystem composites a transparent overlay on top of it afterward.
  // SystemScheduler sorts/executes systems by ascending priority (lower runs
  // first — see SystemScheduler.buildStagesForPhase), so this must run before
  // RenderSystem while still running after CullingSystem (priority 800), whose
  // visibility decisions it depends on.
  priority = 850;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  static reads = ["Transform", "GPUMeshRenderer"];
  static writes: string[] = [];

  private gpuCtx!: GPUContext;
  private layouts!: FrameLayouts;
  private pipelines = new Map<PipelineKey, GPURenderPipeline>();

  private transformStore!: ComponentStore;
  private meshRendererStore!: ComponentStore;
  private query!: ReturnType<World["query"]>;

  private cameraBuffer!: GPUBuffer;
  private lightBuffer!: GPUBuffer;
  private lightInfoBuffer!: GPUBuffer;
  private modelBuffer!: GPUBuffer;

  private perFrameBindGroup!: GPUBindGroup;
  private perObjectBindGroup!: GPUBindGroup;

  private cameraData = new Float32Array(CAMERA_UNIFORM_SIZE / 4);
  private modelData!: Float32Array<ArrayBuffer>;
  private lightData = new Float32Array(MAX_LIGHTS * LIGHT_STRIDE / 4);
  private lightInfoData = new Uint32Array(4);

  private shadowTexture!: GPUTexture;
  private shadowView!: GPUTextureView;
  private shadowSampler!: GPUSampler;
  private shadowUniformBuffer!: GPUBuffer;
  private shadowUniformData = new Float32Array(SHADOW_UNIFORM_FLOATS);
  private shadowFrameBindGroup!: GPUBindGroup;
  private shadowPipeline!: GPURenderPipeline;
  private readonly shadowViewMat = new Mat4();
  private readonly shadowProjMat = new Mat4();
  private readonly shadowViewProjMat = new Mat4();
  private readonly shadowEye = new Vec3();
  private readonly shadowUp = new Vec3();
  private readonly _shadowDir = new Vec3(0, -1, 0);
  private _hasShadowCaster = false;

  readonly viewMatrix = new Mat4();
  readonly projMatrix = new Mat4();
  readonly viewProjMatrix = new Mat4();
  readonly cameraPosition = new Vec3();

  private meshPool: HandleMap<GPUMesh> | null = null;
  private _materialPool: GPUMaterialPool | null = null;

  private readonly _quat = new Quat();
  private readonly _pos = new Vec3();
  private readonly _scale = new Vec3();
  private readonly _modelMat = new Mat4();
  private readonly _normalMat = new Mat4();

  private _lightCount = 0;
  private _cameraSystem: CameraSystem | null = null;
  private drawList: DrawCall[] = [];
  private transparentList: DrawCall[] = [];
  private _lightSync: LightSync | null = null;

  // Per-entity model/normal matrix cache, keyed by eid. Recomputing a full 4x4 invert() plus a
  // quaternion compose for every visible entity every frame (regardless of whether its Transform
  // actually changed) was a real, avoidable per-frame CPU cost at scale — this skips the rebuild
  // for any entity whose Transform is unchanged since last frame. The cached matrix is a pure
  // function of the 9 transform values, so it stays correct even across entity-id recycling.
  private matrixCacheCapacity = 0;
  private cachedTx: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedTy: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedTz: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedRx: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedRy: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedRz: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedSx: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedSy: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedSz: Float32Array<ArrayBuffer> = new Float32Array(0);
  private cachedValid: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  // 32 floats per eid: [0..16) = model matrix, [16..32) = normal matrix.
  private cachedModelNormal: Float32Array<ArrayBuffer> = new Float32Array(0);
  private drawCountWarned = false;

  setGPUContext(ctx: GPUContext): void {
    this.gpuCtx = ctx;
  }

  setMeshPool(pool: HandleMap<GPUMesh>): void {
    this.meshPool = pool;
  }

  setCameraSystem(cam: CameraSystem): void {
    this._cameraSystem = cam;
  }

  get materialPool(): GPUMaterialPool | null {
    return this._materialPool;
  }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
    this.meshRendererStore = this.world.getStore(GPUMeshRenderer);
    this.query = this.world.query(Transform, GPUMeshRenderer);

    const { device } = this.gpuCtx;

    this.layouts = createFrameLayouts(this.gpuCtx);

    this._materialPool = new GPUMaterialPool(this.gpuCtx, this.layouts.perMaterial);

    const shaderModule = device.createShaderModule({
      label: "AGEE forward opaque",
      code: forwardOpaqueWGSL,
    });

    // fs() outputs premultiplied color (`mapped * alpha, alpha`), so "alpha" blending uses
    // premultiplied-alpha blend factors, not the more common src-alpha/one-minus-src-alpha pair.
    const blendStates: Record<GPUBlendMode, GPUBlendState | undefined> = {
      opaque: undefined,
      alpha: {
        color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      },
      additive: {
        color: { srcFactor: "one", dstFactor: "one", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
      },
    };

    for (const blend of ["opaque", "alpha", "additive"] as const) {
      for (const cullMode of ["back", "none"] as const) {
        const key: PipelineKey = `${blend}:${cullMode}`;
        this.pipelines.set(key, device.createRenderPipeline({
          label: `AGEE forward ${key}`,
          layout: this.layouts.pipelineLayout,
          vertex: {
            module: shaderModule,
            entryPoint: "vs",
            buffers: [VERTEX_BUFFER_LAYOUT],
          },
          fragment: {
            module: shaderModule,
            entryPoint: "fs",
            targets: [{ format: this.gpuCtx.format, blend: blendStates[blend] }],
          },
          primitive: {
            topology: "triangle-list",
            cullMode,
            frontFace: "ccw",
          },
          depthStencil: {
            format: "depth24plus",
            // Blended surfaces don't write depth -- writing depth for a translucent
            // fragment would let it occlude whatever should still be visible behind it.
            depthWriteEnabled: blend === "opaque",
            depthCompare: "less",
          },
        }));
      }
    }

    this.cameraBuffer = device.createBuffer({
      label: "AGEE camera",
      size: CAMERA_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.lightBuffer = device.createBuffer({
      label: "AGEE lights",
      size: MAX_LIGHTS * LIGHT_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.lightInfoBuffer = device.createBuffer({
      label: "AGEE light info",
      size: LIGHT_INFO_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const modelBufSize = MAX_ENTITIES * MODEL_UNIFORM_ALIGNMENT;
    this.modelBuffer = device.createBuffer({
      label: "AGEE models",
      size: modelBufSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.modelData = new Float32Array(modelBufSize / 4);

    this.perObjectBindGroup = device.createBindGroup({
      label: "AGEE per-object",
      layout: this.layouts.perObject,
      entries: [
        { binding: 0, resource: { buffer: this.modelBuffer, size: MODEL_UNIFORM_SIZE } },
      ],
    });

    this.initShadowMap(device);
  }

  // depth32float (not depth24plus) because it's the one depth format guaranteed sampleable as a
  // regular texture across WebGPU implementations -- forward_opaque.wgsl's fs() binds this as
  // texture_depth_2d to PCF-sample it, which depth24plus doesn't universally support.
  private initShadowMap(device: GPUDevice): void {
    this.shadowTexture = device.createTexture({
      label: "AGEE shadow map",
      size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowView = this.shadowTexture.createView();

    this.shadowSampler = device.createSampler({
      label: "AGEE shadow sampler",
      compare: "less",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.shadowUniformBuffer = device.createBuffer({
      label: "AGEE shadow uniforms",
      size: SHADOW_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Rebuild perFrameBindGroup now that the layout includes the shadow uniform/texture/sampler.
    this.perFrameBindGroup = device.createBindGroup({
      label: "AGEE per-frame",
      layout: this.layouts.perFrame,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.lightBuffer } },
        { binding: 2, resource: { buffer: this.lightInfoBuffer } },
        { binding: 3, resource: { buffer: this.shadowUniformBuffer } },
        { binding: 4, resource: this.shadowView },
        { binding: 5, resource: this.shadowSampler },
      ],
    });

    // Shadow depth pass reads the same lightViewProj this buffer's first 64 bytes carry for
    // the main pass's shadow sampling -- one write, two consumers.
    this.shadowFrameBindGroup = device.createBindGroup({
      label: "AGEE shadow frame",
      layout: this.layouts.shadowFrame,
      entries: [
        { binding: 0, resource: { buffer: this.shadowUniformBuffer, size: 64 } },
      ],
    });

    const shadowModule = device.createShaderModule({
      label: "AGEE shadow depth",
      code: shadowDepthWGSL,
    });

    this.shadowPipeline = device.createRenderPipeline({
      label: "AGEE shadow depth",
      layout: this.layouts.shadowPipelineLayout,
      vertex: {
        module: shadowModule,
        entryPoint: "vs",
        buffers: [VERTEX_BUFFER_LAYOUT],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "back",
        frontFace: "ccw",
      },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  }

  // AUDIT FIX (bug #5): previously always wrote into slot 0 and hard-coded
  // _lightCount to 1 on every call, so a second light silently clobbered the
  // first instead of the count reflecting how many lights actually exist (the
  // storage buffer backing this supports up to MAX_LIGHTS=64). Now each call
  // appends into the next free slot and increments the count.
  //
  // shaderType follows forward_opaque.wgsl's LightData.positionType.w convention
  // (0=directional, 1=point, 2=spot) — distinct from, and not to be confused with,
  // the ECS Light component's lightType convention (0=point, 1=directional, 2=spot,
  // 3=ambient); LightSync is responsible for translating between the two.
  private pushLight(
    shaderType: 0 | 1 | 2,
    px: number, py: number, pz: number,
    dx: number, dy: number, dz: number,
    r: number, g: number, b: number, intensity: number,
    range: number, innerCone: number, outerCone: number, castShadow: number
  ): void {
    if (this._lightCount >= MAX_LIGHTS) return;
    const base = this._lightCount * (LIGHT_STRIDE / 4);
    this.lightData[base + 0] = px; this.lightData[base + 1] = py; this.lightData[base + 2] = pz; this.lightData[base + 3] = shaderType;
    this.lightData[base + 4] = dx; this.lightData[base + 5] = dy; this.lightData[base + 6] = dz; this.lightData[base + 7] = range;
    this.lightData[base + 8] = r * intensity; this.lightData[base + 9] = g * intensity; this.lightData[base + 10] = b * intensity; this.lightData[base + 11] = intensity;
    this.lightData[base + 12] = innerCone; this.lightData[base + 13] = outerCone; this.lightData[base + 14] = castShadow; this.lightData[base + 15] = 0;
    this._lightCount++;
  }

  setDirectionalLight(dirX: number, dirY: number, dirZ: number, r: number, g: number, b: number, intensity: number, castShadow: number = 0): void {
    this.pushLight(0, 0, 0, 0, dirX, dirY, dirZ, r, g, b, intensity, 0, 0, 0, castShadow);
  }

  // Called by LightSync for the first shadow-casting directional light found each frame.
  // Only one directional shadow map exists (see SHADOW_MAP_SIZE et al.), so later callers in
  // the same frame are ignored -- matches how MAX_LIGHTS overflow is handled in pushLight().
  setDirectionalShadowCaster(dirX: number, dirY: number, dirZ: number): void {
    if (this._hasShadowCaster) return;
    this._hasShadowCaster = true;
    this._shadowDir.set(dirX, dirY, dirZ);
  }

  setPointLight(px: number, py: number, pz: number, r: number, g: number, b: number, intensity: number, range: number, castShadow: number): void {
    this.pushLight(1, px, py, pz, 0, 0, 0, r, g, b, intensity, range, 0, 0, castShadow);
  }

  private ensureMatrixCache(minCapacity: number): void {
    if (minCapacity <= this.matrixCacheCapacity) return;
    let cap = this.matrixCacheCapacity || 256;
    while (cap < minCapacity) cap *= 2;

    const growF32 = (old: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> => {
      const fresh = new Float32Array(cap);
      fresh.set(old);
      return fresh;
    };
    this.cachedTx = growF32(this.cachedTx);
    this.cachedTy = growF32(this.cachedTy);
    this.cachedTz = growF32(this.cachedTz);
    this.cachedRx = growF32(this.cachedRx);
    this.cachedRy = growF32(this.cachedRy);
    this.cachedRz = growF32(this.cachedRz);
    this.cachedSx = growF32(this.cachedSx);
    this.cachedSy = growF32(this.cachedSy);
    this.cachedSz = growF32(this.cachedSz);

    const freshValid = new Uint8Array(cap);
    freshValid.set(this.cachedValid);
    this.cachedValid = freshValid;

    const freshModelNormal = new Float32Array(cap * 32);
    freshModelNormal.set(this.cachedModelNormal);
    this.cachedModelNormal = freshModelNormal;

    this.matrixCacheCapacity = cap;
  }

  setSpotLight(
    px: number, py: number, pz: number,
    dirX: number, dirY: number, dirZ: number,
    r: number, g: number, b: number, intensity: number,
    range: number, innerCone: number, outerCone: number, castShadow: number
  ): void {
    this.pushLight(2, px, py, pz, dirX, dirY, dirZ, r, g, b, intensity, range, innerCone, outerCone, castShadow);
  }

  /** Clears the accumulated light count so a fresh per-frame sync (LightSync)
   * can repopulate it without lights persisting across frames after removal. */
  resetLights(): void {
    this._lightCount = 0;
    this._hasShadowCaster = false;
  }

  update(_dt: number): void {
    if (!this.gpuCtx || !this.meshPool || !this._materialPool) return;
    if (this.gpuCtx.canvas.style.display === "none") return;

    if (this._cameraSystem) {
      this.viewMatrix.copy(this._cameraSystem.nativeViewMatrix);
      this.projMatrix.copy(this._cameraSystem.nativeProjMatrix);
      this.cameraPosition.copy(this._cameraSystem.nativeCameraPos);
    }

    const entities = this.query.entities;

    const { device } = this.gpuCtx;

    this.viewProjMatrix.copy(this.projMatrix).multiply(this.viewMatrix);
    this.cameraData.set(this.viewProjMatrix.elements, 0);
    this.cameraData[16] = this.cameraPosition.x;
    this.cameraData[17] = this.cameraPosition.y;
    this.cameraData[18] = this.cameraPosition.z;
    this.cameraData[19] = 1.0;
    device.queue.writeBuffer(this.cameraBuffer, 0, this.cameraData);

    // AUDIT FIX (bug #5): pull ECS Light components into the native light buffer
    // every frame. `this.world` is only populated once this system has been
    // added to a World (see System base class), so guard for standalone use.
    if (this.world) {
      if (!this._lightSync) this._lightSync = new LightSync();
      this._lightSync.sync(this.world, this);
    }

    this.lightInfoData[0] = this._lightCount;
    device.queue.writeBuffer(this.lightInfoBuffer, 0, this.lightInfoData);
    if (this._lightCount > 0) {
      device.queue.writeBuffer(this.lightBuffer, 0, this.lightData, 0, this._lightCount * LIGHT_STRIDE / 4);
    }

    if (this._hasShadowCaster) {
      // Frustum follows the camera each frame rather than tracking scene bounds -- eye sits
      // SHADOW_DISTANCE back along the light's travel direction from the camera, looking at it.
      const dir = this._shadowDir;
      this.shadowEye.set(
        this.cameraPosition.x - dir.x * SHADOW_DISTANCE,
        this.cameraPosition.y - dir.y * SHADOW_DISTANCE,
        this.cameraPosition.z - dir.z * SHADOW_DISTANCE,
      );
      // Avoid a degenerate lookAt when the light points (near-)parallel to the default up axis.
      this.shadowUp.set(0, 1, 0);
      if (Math.abs(dir.y) > 0.999) this.shadowUp.set(0, 0, 1);

      this.shadowViewMat.lookAt(this.shadowEye, this.cameraPosition, this.shadowUp);
      this.shadowProjMat.orthographic(
        -SHADOW_HALF_EXTENT, SHADOW_HALF_EXTENT,
        -SHADOW_HALF_EXTENT, SHADOW_HALF_EXTENT,
        SHADOW_NEAR, SHADOW_DISTANCE * 2,
      );
      this.shadowViewProjMat.copy(this.shadowProjMat).multiply(this.shadowViewMat);

      this.shadowUniformData.set(this.shadowViewProjMat.elements, 0);
      this.shadowUniformData[16] = 1.0; // params.x: shadow caster active
      this.shadowUniformData[17] = 1.0 / SHADOW_MAP_SIZE; // params.y: PCF texel size
      device.queue.writeBuffer(this.shadowUniformBuffer, 0, this.shadowUniformData);
    } else if (this.shadowUniformData[16] !== 0) {
      // Only re-write when the caster just went away this frame -- flips fs()'s sampleShadow()
      // back to its always-lit fallback without re-uploading every frame nothing changed.
      this.shadowUniformData[16] = 0.0;
      device.queue.writeBuffer(this.shadowUniformBuffer, 0, this.shadowUniformData);
    }

    const tx = this.transformStore.getColumn("x");
    const ty = this.transformStore.getColumn("y");
    const tz = this.transformStore.getColumn("z");
    const trx = this.transformStore.getColumn("rx");
    const trY = this.transformStore.getColumn("ry");
    const trz = this.transformStore.getColumn("rz");
    const tsx = this.transformStore.getColumn("sx");
    const tsy = this.transformStore.getColumn("sy");
    const tsz = this.transformStore.getColumn("sz");
    const meshHandles = this.meshRendererStore.getColumn("meshHandle");
    const matHandles = this.meshRendererStore.getColumn("materialHandle");
    const visibleCol = this.meshRendererStore.getColumn("visible");

    const floatsPerSlot = MODEL_UNIFORM_ALIGNMENT / 4;
    let drawCount = 0;
    this.drawList.length = 0;
    this.transparentList.length = 0;

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (visibleCol[eid] === 0) continue;

      const handle = meshHandles[eid] as number as Handle;
      const mesh = this.meshPool.get(handle);
      if (!mesh) continue;

      if (drawCount >= MAX_ENTITIES) {
        if (!this.drawCountWarned) {
          console.warn(`[AGEE] GPURenderSystem: visible entity count exceeds MAX_ENTITIES (${MAX_ENTITIES}); further entities are silently not drawn this frame.`);
          this.drawCountWarned = true;
        }
        break;
      }

      this.ensureMatrixCache(eid + 1);

      const px = tx[eid], py = ty[eid], pz = tz[eid];
      const prx = trx[eid], pry = trY[eid], prz = trz[eid];
      const psx = tsx[eid] || 1, psy = tsy[eid] || 1, psz = tsz[eid] || 1;

      const cacheBase = eid * 32;
      const dirty = this.cachedValid[eid] === 0
        || this.cachedTx[eid] !== px || this.cachedTy[eid] !== py || this.cachedTz[eid] !== pz
        || this.cachedRx[eid] !== prx || this.cachedRy[eid] !== pry || this.cachedRz[eid] !== prz
        || this.cachedSx[eid] !== psx || this.cachedSy[eid] !== psy || this.cachedSz[eid] !== psz;

      if (dirty) {
        this._pos.set(px, py, pz);
        eulerToQuatInto(this._quat, prx, pry, prz);
        this._scale.set(psx, psy, psz);

        this._modelMat.compose(this._pos, this._quat, this._scale);

        this._normalMat.copy(this._modelMat).invert();
        const ne = this._normalMat.elements;
        let tmp: number;
        tmp = ne[1]; ne[1] = ne[4]; ne[4] = tmp;
        tmp = ne[2]; ne[2] = ne[8]; ne[8] = tmp;
        tmp = ne[3]; ne[3] = ne[12]; ne[12] = tmp;
        tmp = ne[6]; ne[6] = ne[9]; ne[9] = tmp;
        tmp = ne[7]; ne[7] = ne[13]; ne[13] = tmp;
        tmp = ne[11]; ne[11] = ne[14]; ne[14] = tmp;

        this.cachedModelNormal.set(this._modelMat.elements, cacheBase);
        this.cachedModelNormal.set(this._normalMat.elements, cacheBase + 16);

        this.cachedTx[eid] = px; this.cachedTy[eid] = py; this.cachedTz[eid] = pz;
        this.cachedRx[eid] = prx; this.cachedRy[eid] = pry; this.cachedRz[eid] = prz;
        this.cachedSx[eid] = psx; this.cachedSy[eid] = psy; this.cachedSz[eid] = psz;
        this.cachedValid[eid] = 1;
      }

      const slotOffset = drawCount * floatsPerSlot;
      this.modelData.set(this.cachedModelNormal.subarray(cacheBase, cacheBase + 16), slotOffset);
      this.modelData.set(this.cachedModelNormal.subarray(cacheBase + 16, cacheBase + 32), slotOffset + 16);

      const matHandle = matHandles[eid] as number as Handle;
      const materialBG = this._materialPool.getBindGroup(matHandle) ?? this._materialPool.defaultBindGroup;
      const matInfo = this._materialPool.getMaterialInfo(matHandle);
      const blend: GPUBlendMode = matInfo?.blend ?? "opaque";
      const cullMode: "back" | "none" = matInfo?.doubleSided ? "none" : "back";
      const pipeline = this.pipelines.get(`${blend}:${cullMode}`)!;

      const call: DrawCall = {
        mesh,
        modelOffset: drawCount * MODEL_UNIFORM_ALIGNMENT,
        materialBindGroup: materialBG,
        materialKey: matHandle,
        pipeline,
        distance: 0,
      };

      if (blend === "opaque") {
        this.drawList.push(call);
      } else {
        const dx = px - this.cameraPosition.x, dy = py - this.cameraPosition.y, dz = pz - this.cameraPosition.z;
        call.distance = dx * dx + dy * dy + dz * dz;
        this.transparentList.push(call);
      }
      drawCount++;
    }

    // AUDIT FIX (bug #2): previously returned here (and earlier, when
    // entities.length===0) without calling beginFrame()/endFrame() at all, so a
    // zero-draw frame left the prior frame's contents on screen uncleared.
    // Always present/clear; only the draw-specific work below is conditional.
    if (drawCount > 0) {
      // Opaque: sort by material to minimize bind group switches. Transparent: sort
      // back-to-front (farthest first) so nearer translucent surfaces blend on top of
      // farther ones in the correct order.
      this.drawList.sort((a, b) => a.materialKey - b.materialKey);
      this.transparentList.sort((a, b) => b.distance - a.distance);
      device.queue.writeBuffer(this.modelBuffer, 0, this.modelData, 0, drawCount * floatsPerSlot);
    }

    const { encoder, colorView } = this.gpuCtx.beginFrame();

    // Only opaque geometry casts shadows -- alpha/additive surfaces are skipped, matching how
    // most forward renderers scope shadow casting to keep the depth-only pass cheap.
    if (this._hasShadowCaster && this.drawList.length > 0) {
      const shadowPass = encoder.beginRenderPass({
        label: "AGEE shadow depth",
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.shadowView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      shadowPass.setPipeline(this.shadowPipeline);
      shadowPass.setBindGroup(0, this.shadowFrameBindGroup);
      for (let i = 0; i < this.drawList.length; i++) {
        const { mesh, modelOffset } = this.drawList[i];
        shadowPass.setBindGroup(1, this.perObjectBindGroup, [modelOffset]);
        shadowPass.setVertexBuffer(0, mesh.vertexBuffer);
        if (mesh.indexBuffer) {
          shadowPass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
          shadowPass.drawIndexed(mesh.indexCount);
        } else {
          shadowPass.draw(mesh.vertexCount);
        }
      }
      shadowPass.end();
    }

    const pass = encoder.beginRenderPass({
      label: "AGEE forward",
      colorAttachments: [{
        view: colorView,
        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: this.gpuCtx.depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    if (drawCount > 0) {
      pass.setBindGroup(0, this.perFrameBindGroup);

      let currentPipeline: GPURenderPipeline | null = null;
      let currentMaterialKey = -1;

      // Opaque first (depth-writing, sorted by material), then transparent back-to-front
      // (depth-testing but not writing) on top -- the standard forward-rendering split,
      // since a single pipeline/blend state can't express both in one pass.
      for (const list of [this.drawList, this.transparentList]) {
        for (let i = 0; i < list.length; i++) {
          const { mesh, modelOffset, materialBindGroup, materialKey, pipeline } = list[i];

          if (pipeline !== currentPipeline) {
            pass.setPipeline(pipeline);
            currentPipeline = pipeline;
            currentMaterialKey = -1; // bind group 1 must be re-set after any pipeline change
          }

          if (materialKey !== currentMaterialKey) {
            pass.setBindGroup(1, materialBindGroup);
            currentMaterialKey = materialKey;
          }

          pass.setBindGroup(2, this.perObjectBindGroup, [modelOffset]);
          pass.setVertexBuffer(0, mesh.vertexBuffer);

          if (mesh.indexBuffer) {
            pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
            pass.drawIndexed(mesh.indexCount);
          } else {
            pass.draw(mesh.vertexCount);
          }
        }
      }
    }

    pass.end();
    this.gpuCtx.endFrame(encoder);
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.lightBuffer?.destroy();
    this.lightInfoBuffer?.destroy();
    this.modelBuffer?.destroy();
    this.shadowTexture?.destroy();
    this.shadowUniformBuffer?.destroy();
    this._materialPool?.dispose();
  }
}
