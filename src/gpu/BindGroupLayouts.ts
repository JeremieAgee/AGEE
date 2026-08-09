import type { GPUContext } from "./GPUContext";

export interface FrameLayouts {
  perFrame: GPUBindGroupLayout;   // group 0: camera + lights + shadow map
  perMaterial: GPUBindGroupLayout; // group 1: material uniforms
  perObject: GPUBindGroupLayout;   // group 2: model matrix
  pipelineLayout: GPUPipelineLayout;
  shadowFrame: GPUBindGroupLayout; // group 0 of the shadow depth pass: light viewProj
  shadowPipelineLayout: GPUPipelineLayout;
}

export function createFrameLayouts(ctx: GPUContext): FrameLayouts {
  const { device } = ctx;

  const perFrame = device.createBindGroupLayout({
    label: "AGEE per-frame",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" }, // ShadowUniforms: light viewProj + params
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "depth", viewDimension: "2d" },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "comparison" },
      },
    ],
  });

  const perMaterial = device.createBindGroupLayout({
    label: "AGEE per-material",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      // MaterialDef's map/normalMap/aoMap only used to reach the Three.js overlay path --
      // GPUMaterialPool.create() now uploads them here too so the native forward pass can
      // sample them instead of always falling back to a flat color.
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
    ],
  });

  const perObject = device.createBindGroupLayout({
    label: "AGEE per-object",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform", hasDynamicOffset: true },
      },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    label: "AGEE forward",
    bindGroupLayouts: [perFrame, perMaterial, perObject],
  });

  const shadowFrame = device.createBindGroupLayout({
    label: "AGEE shadow frame",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" }, // light viewProj mat4x4
      },
    ],
  });

  const shadowPipelineLayout = device.createPipelineLayout({
    label: "AGEE shadow depth",
    // Reuses the same `perObject` layout (and, at draw time, the same bind group/buffer) as
    // the main forward pass -- both only need the model matrix at binding 0, so there's no
    // reason to duplicate the per-object uniform machinery for the depth-only pass.
    bindGroupLayouts: [shadowFrame, perObject],
  });

  return { perFrame, perMaterial, perObject, pipelineLayout, shadowFrame, shadowPipelineLayout };
}
