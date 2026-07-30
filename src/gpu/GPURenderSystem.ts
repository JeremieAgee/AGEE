import { System, World, ComponentStore } from "../ecs";
import { Transform, GPUMeshRenderer } from "../core/Components";
import { Mat4 } from "../core/math/Mat4";
import { Vec3 } from "../core/math/Vec3";
import { Quat } from "../core/math/Quat";
import { GPUContext } from "./GPUContext";
import { GPUMesh, VERTEX_BUFFER_LAYOUT } from "./GPUMesh";
import { GPUMaterialPool } from "./GPUMaterialPool";
import { createFrameLayouts, type FrameLayouts } from "./BindGroupLayouts";
import type { Handle } from "../core/handles/Handle";
import type { HandleMap } from "../core/handles/Handle";
import type { CameraSystem } from "../camera/CameraSystem";
import { LightSync } from "./LightSync";
import forwardOpaqueWGSL from "./shaders/forward_opaque.wgsl?raw";

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

interface DrawCall {
  mesh: GPUMesh;
  modelOffset: number;
  materialBindGroup: GPUBindGroup;
  materialKey: number;
}

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
  private pipeline!: GPURenderPipeline;

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
  private _lightSync: LightSync | null = null;

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

    this.pipeline = device.createRenderPipeline({
      label: "AGEE forward opaque",
      layout: this.layouts.pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs",
        buffers: [VERTEX_BUFFER_LAYOUT],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs",
        targets: [{ format: this.gpuCtx.format }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: "back",
        frontFace: "ccw",
      },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

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

    this.perFrameBindGroup = device.createBindGroup({
      label: "AGEE per-frame",
      layout: this.layouts.perFrame,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.lightBuffer } },
        { binding: 2, resource: { buffer: this.lightInfoBuffer } },
      ],
    });

    this.perObjectBindGroup = device.createBindGroup({
      label: "AGEE per-object",
      layout: this.layouts.perObject,
      entries: [
        { binding: 0, resource: { buffer: this.modelBuffer, size: MODEL_UNIFORM_SIZE } },
      ],
    });
  }

  // AUDIT FIX (bug #5): previously always wrote into slot 0 and hard-coded
  // _lightCount to 1 on every call, so a second light silently clobbered the
  // first instead of the count reflecting how many lights actually exist (the
  // storage buffer backing this supports up to MAX_LIGHTS=64). Now each call
  // appends into the next free slot and increments the count.
  setDirectionalLight(dirX: number, dirY: number, dirZ: number, r: number, g: number, b: number, intensity: number): void {
    if (this._lightCount >= MAX_LIGHTS) return;
    const base = this._lightCount * (LIGHT_STRIDE / 4);
    this.lightData[base + 0] = 0; this.lightData[base + 1] = 0; this.lightData[base + 2] = 0; this.lightData[base + 3] = 0;
    this.lightData[base + 4] = dirX; this.lightData[base + 5] = dirY; this.lightData[base + 6] = dirZ; this.lightData[base + 7] = 0;
    this.lightData[base + 8] = r * intensity; this.lightData[base + 9] = g * intensity; this.lightData[base + 10] = b * intensity; this.lightData[base + 11] = intensity;
    this.lightData[base + 12] = 0; this.lightData[base + 13] = 0; this.lightData[base + 14] = 0; this.lightData[base + 15] = 0;
    this._lightCount++;
  }

  /** Clears the accumulated light count so a fresh per-frame sync (LightSync)
   * can repopulate it without lights persisting across frames after removal. */
  resetLights(): void {
    this._lightCount = 0;
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

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (visibleCol[eid] === 0) continue;

      const handle = meshHandles[eid] as number as Handle;
      const mesh = this.meshPool.get(handle);
      if (!mesh) continue;

      if (drawCount >= MAX_ENTITIES) break;

      this._pos.set(tx[eid], ty[eid], tz[eid]);
      eulerToQuatInto(this._quat, trx[eid], trY[eid], trz[eid]);
      this._scale.set(tsx[eid] || 1, tsy[eid] || 1, tsz[eid] || 1);

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

      const slotOffset = drawCount * floatsPerSlot;
      this.modelData.set(this._modelMat.elements, slotOffset);
      this.modelData.set(this._normalMat.elements, slotOffset + 16);

      const matHandle = matHandles[eid] as number as Handle;
      const materialBG = this._materialPool.getBindGroup(matHandle) ?? this._materialPool.defaultBindGroup;

      this.drawList.push({
        mesh,
        modelOffset: drawCount * MODEL_UNIFORM_ALIGNMENT,
        materialBindGroup: materialBG,
        materialKey: matHandle,
      });
      drawCount++;
    }

    // AUDIT FIX (bug #2): previously returned here (and earlier, when
    // entities.length===0) without calling beginFrame()/endFrame() at all, so a
    // zero-draw frame left the prior frame's contents on screen uncleared.
    // Always present/clear; only the draw-specific work below is conditional.
    if (drawCount > 0) {
      // Sort by material to minimize bind group switches
      this.drawList.sort((a, b) => a.materialKey - b.materialKey);
      device.queue.writeBuffer(this.modelBuffer, 0, this.modelData, 0, drawCount * floatsPerSlot);
    }

    const { encoder, colorView } = this.gpuCtx.beginFrame();

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
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.perFrameBindGroup);

      let currentMaterialKey = -1;

      for (let i = 0; i < this.drawList.length; i++) {
        const { mesh, modelOffset, materialBindGroup, materialKey } = this.drawList[i];

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

    pass.end();
    this.gpuCtx.endFrame(encoder);
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.lightBuffer?.destroy();
    this.lightInfoBuffer?.destroy();
    this.modelBuffer?.destroy();
    this._materialPool?.dispose();
  }
}
