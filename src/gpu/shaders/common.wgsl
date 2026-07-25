struct CameraUniforms {
  viewProj: mat4x4<f32>,
  viewPos: vec4<f32>,
  // x = near, y = far, z = aspect, w = fov
  params: vec4<f32>,
};

struct LightData {
  // xyz = position/direction, w = type (0=dir, 1=point, 2=spot)
  positionType: vec4<f32>,
  // xyz = direction (for dir/spot), w = range
  directionRange: vec4<f32>,
  // rgb = color * intensity, w = intensity
  colorIntensity: vec4<f32>,
  // x = innerCone, y = outerCone, z = castShadow, w = unused
  params: vec4<f32>,
};

struct MaterialUniforms {
  color: vec4<f32>,
  // x = metalness, y = roughness, z = emissiveIntensity, w = unused
  pbrParams: vec4<f32>,
  emissive: vec4<f32>,
};
