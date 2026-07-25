import type { GPUContext } from "./GPUContext";

export interface FrameLayouts {
  perFrame: GPUBindGroupLayout;   // group 0: camera + lights
  perMaterial: GPUBindGroupLayout; // group 1: material uniforms
  perObject: GPUBindGroupLayout;   // group 2: model matrix
  pipelineLayout: GPUPipelineLayout;
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

  return { perFrame, perMaterial, perObject, pipelineLayout };
}
