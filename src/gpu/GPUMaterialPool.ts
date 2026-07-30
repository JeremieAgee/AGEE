import type { GPUContext } from "./GPUContext";
import type { Handle } from "../core/handles/Handle";
import { HandleMap } from "../core/handles/Handle";

const MATERIAL_BUFFER_SIZE = 48; // 3x vec4<f32>

export interface GPUMaterialParams {
  r: number;
  g: number;
  b: number;
  a?: number;
  metalness?: number;
  roughness?: number;
  emissive?: [number, number, number];
  emissiveIntensity?: number;
}

interface GPUMaterialEntry {
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  data: Float32Array<ArrayBuffer>;
}

export class GPUMaterialPool {
  private gpuCtx: GPUContext;
  private materialLayout: GPUBindGroupLayout;
  private entries = new HandleMap<GPUMaterialEntry>();
  private defaultHandle: Handle = 0 as Handle;

  constructor(gpuCtx: GPUContext, materialLayout: GPUBindGroupLayout) {
    this.gpuCtx = gpuCtx;
    this.materialLayout = materialLayout;
    this.defaultHandle = this.create({ r: 0.8, g: 0.8, b: 0.8, roughness: 0.7 });
  }

  create(params: GPUMaterialParams): Handle {
    const { device } = this.gpuCtx;

    const data = new Float32Array([
      params.r, params.g, params.b, params.a ?? 1.0,
      params.metalness ?? 0.0, params.roughness ?? 0.7, params.emissiveIntensity ?? 0.0, 0.0,
      params.emissive?.[0] ?? 0.0, params.emissive?.[1] ?? 0.0, params.emissive?.[2] ?? 0.0, 0.0,
    ]);

    const buffer = device.createBuffer({
      label: "AGEE material",
      size: MATERIAL_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);

    const bindGroup = device.createBindGroup({
      label: "AGEE material",
      layout: this.materialLayout,
      entries: [
        { binding: 0, resource: { buffer } },
      ],
    });

    return this.entries.alloc({ buffer, bindGroup, data });
  }

  createFromHex(hex: number, roughness = 0.7, metalness = 0.0): Handle {
    return this.create({
      r: ((hex >> 16) & 0xff) / 255,
      g: ((hex >> 8) & 0xff) / 255,
      b: (hex & 0xff) / 255,
      roughness,
      metalness,
    });
  }

  update(handle: Handle, params: Partial<GPUMaterialParams>): void {
    const entry = this.entries.get(handle);
    if (!entry) return;

    if (params.r !== undefined) entry.data[0] = params.r;
    if (params.g !== undefined) entry.data[1] = params.g;
    if (params.b !== undefined) entry.data[2] = params.b;
    if (params.a !== undefined) entry.data[3] = params.a;
    if (params.metalness !== undefined) entry.data[4] = params.metalness;
    if (params.roughness !== undefined) entry.data[5] = params.roughness;
    if (params.emissiveIntensity !== undefined) entry.data[6] = params.emissiveIntensity;
    if (params.emissive) {
      entry.data[8] = params.emissive[0];
      entry.data[9] = params.emissive[1];
      entry.data[10] = params.emissive[2];
    }

    this.gpuCtx.device.queue.writeBuffer(entry.buffer, 0, entry.data);
  }

  getBindGroup(handle: Handle): GPUBindGroup | null {
    const entry = this.entries.get(handle);
    return entry ? entry.bindGroup : null;
  }

  get defaultBindGroup(): GPUBindGroup {
    return this.entries.get(this.defaultHandle)!.bindGroup;
  }

  get defaultMaterialHandle(): Handle {
    return this.defaultHandle;
  }

  free(handle: Handle): void {
    const entry = this.entries.get(handle);
    if (entry) {
      // AUDIT FIX (bug #3): fence before releasing the material buffer — see
      // GPUContext.resize() for the same pattern and its rationale.
      void this.gpuCtx.device.queue.onSubmittedWorkDone();
      entry.buffer.destroy();
      this.entries.free(handle);
    }
  }

  dispose(): void {
    this.entries.forEach((entry) => {
      entry.buffer.destroy();
    });
  }
}
