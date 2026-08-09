// Depth-only pass: renders scene geometry from the shadow-casting light's point of view into
// a depth texture that forward_opaque.wgsl later samples to determine occlusion. No fragment
// stage is needed -- only the rasterizer's depth write matters here.

struct ShadowFrame {
  lightViewProj: mat4x4<f32>,
};

struct ModelUniforms {
  model: mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> shadowFrame: ShadowFrame;
@group(1) @binding(0) var<uniform> model: ModelUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

@vertex
fn vs(input: VertexInput) -> @builtin(position) vec4<f32> {
  let worldPos = model.model * vec4<f32>(input.position, 1.0);
  return shadowFrame.lightViewProj * worldPos;
}
