import type { GPUContext } from "./GPUContext";
import type { Handle } from "../core/handles/Handle";
import { HandleMap } from "../core/handles/Handle";

const MATERIAL_BUFFER_SIZE = 48; // 3x vec4<f32>

export type GPUBlendMode = "opaque" | "alpha" | "additive";

// Anything WebGPU's copyExternalImageToTexture() accepts as a source.
export type GPUTexImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | VideoFrame;

export interface GPUMaterialParams {
  r: number;
  g: number;
  b: number;
  a?: number;
  metalness?: number;
  roughness?: number;
  emissive?: [number, number, number];
  emissiveIntensity?: number;
  blend?: GPUBlendMode;
  doubleSided?: boolean;
  // Bridges MaterialDef.params.map/normalMap/aoMap (already-decoded via THREE's loaders, e.g.
  // standard.map.image) into the native WebGPU forward pass, which previously only ever saw a
  // flat color -- see GPUMaterialPool's binding-1..3 textures and forward_opaque.wgsl.
  map?: GPUTexImageSource | null;
  normalMap?: GPUTexImageSource | null;
  aoMap?: GPUTexImageSource | null;
}

export interface GPUMaterialInfo {
  blend: GPUBlendMode;
  doubleSided: boolean;
}

interface GPUMaterialEntry {
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  data: Float32Array<ArrayBuffer>;
  blend: GPUBlendMode;
  doubleSided: boolean;
  // Only set (and only owned/destroyed by this entry) for textures uploaded from real image
  // data -- entries that fall back to the pool's shared default textures must never destroy
  // them, since every other material referencing that default would go on sampling a
  // destroyed texture.
  ownedTextures: GPUTexture[];
}

function imageSize(source: GPUTexImageSource): { width: number; height: number } {
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height };
  }
  // HTMLVideoElement exposes videoWidth/videoHeight (its .width/.height are HTML display
  // attributes, commonly unset since video is usually sized via CSS — falling through to the
  // generic .width/.height read below would silently produce a degenerate 0x0/1x1 texture).
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  // VideoFrame exposes displayWidth/displayHeight, not .width/.height.
  if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) {
    return { width: source.displayWidth, height: source.displayHeight };
  }
  return { width: (source as { width: number }).width, height: (source as { height: number }).height };
}

export class GPUMaterialPool {
  private gpuCtx: GPUContext;
  private materialLayout: GPUBindGroupLayout;
  private entries = new HandleMap<GPUMaterialEntry>();
  private defaultHandle: Handle = 0 as Handle;

  private sampler: GPUSampler;
  private defaultMapTexture: GPUTexture;
  private defaultNormalTexture: GPUTexture;
  private defaultAoTexture: GPUTexture;

  constructor(gpuCtx: GPUContext, materialLayout: GPUBindGroupLayout) {
    this.gpuCtx = gpuCtx;
    this.materialLayout = materialLayout;

    this.sampler = gpuCtx.device.createSampler({
      label: "AGEE material sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    // Neutral 1x1 placeholders so every material's bind group can populate binding 1..3
    // regardless of whether it actually has a texture -- white leaves albedo/AO unaffected
    // when multiplied in, and (128,128,255) decodes to tangent-space (0,0,1), a flat normal.
    this.defaultMapTexture = this.createSolidTexture(255, 255, 255, 255);
    this.defaultNormalTexture = this.createSolidTexture(128, 128, 255, 255);
    this.defaultAoTexture = this.createSolidTexture(255, 255, 255, 255);

    this.defaultHandle = this.create({ r: 0.8, g: 0.8, b: 0.8, roughness: 0.7 });
  }

  private createSolidTexture(r: number, g: number, b: number, a: number): GPUTexture {
    const { device } = this.gpuCtx;
    const texture = device.createTexture({
      label: "AGEE material default texture",
      size: { width: 1, height: 1 },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture },
      new Uint8Array([r, g, b, a]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    return texture;
  }

  private uploadImageTexture(source: GPUTexImageSource): GPUTexture {
    const { device } = this.gpuCtx;
    const { width, height } = imageSize(source);
    const texture = device.createTexture({
      label: "AGEE material texture",
      size: { width: Math.max(1, width), height: Math.max(1, height) },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source: source as ImageBitmap },
      { texture },
      { width: Math.max(1, width), height: Math.max(1, height) },
    );
    return texture;
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

    const ownedTextures: GPUTexture[] = [];
    const resolveTexture = (source: GPUTexImageSource | null | undefined, fallback: GPUTexture): GPUTexture => {
      if (!source) return fallback;
      const texture = this.uploadImageTexture(source);
      ownedTextures.push(texture);
      return texture;
    };

    const mapTexture = resolveTexture(params.map, this.defaultMapTexture);
    const normalTexture = resolveTexture(params.normalMap, this.defaultNormalTexture);
    const aoTexture = resolveTexture(params.aoMap, this.defaultAoTexture);

    const bindGroup = device.createBindGroup({
      label: "AGEE material",
      layout: this.materialLayout,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: mapTexture.createView() },
        { binding: 2, resource: normalTexture.createView() },
        { binding: 3, resource: aoTexture.createView() },
        { binding: 4, resource: this.sampler },
      ],
    });

    return this.entries.alloc({
      buffer,
      bindGroup,
      data,
      blend: params.blend ?? "opaque",
      doubleSided: params.doubleSided ?? false,
      ownedTextures,
    });
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

  getMaterialInfo(handle: Handle): GPUMaterialInfo | null {
    const entry = this.entries.get(handle);
    return entry ? { blend: entry.blend, doubleSided: entry.doubleSided } : null;
  }

  // Non-allocating equivalents of getMaterialInfo() for the per-entity, per-frame draw loop
  // (GPURenderSystem.update()) — that call site doesn't need a wrapper object, just the two
  // fields, and building one there for every visible entity every frame was a measurable
  // amount of avoidable garbage at scale.
  getBlend(handle: Handle): GPUBlendMode {
    return this.entries.get(handle)?.blend ?? "opaque";
  }

  getDoubleSided(handle: Handle): boolean {
    return this.entries.get(handle)?.doubleSided ?? false;
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
      // No fence needed before releasing the material buffer — see GPUContext.resize()
      // for why an unawaited onSubmittedWorkDone() fence here would have been a no-op
      // anyway, and why destroy() is already spec-safe against in-flight work.
      entry.buffer.destroy();
      for (const texture of entry.ownedTextures) texture.destroy();
      this.entries.free(handle);
    }
  }

  dispose(): void {
    this.entries.forEach((entry) => {
      entry.buffer.destroy();
      for (const texture of entry.ownedTextures) texture.destroy();
    });
    this.defaultMapTexture.destroy();
    this.defaultNormalTexture.destroy();
    this.defaultAoTexture.destroy();
  }
}
