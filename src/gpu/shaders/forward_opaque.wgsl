// Per-frame camera (group 0)
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  viewPos: vec4<f32>,
  params: vec4<f32>,
};

struct LightData {
  positionType: vec4<f32>,
  directionRange: vec4<f32>,
  colorIntensity: vec4<f32>,
  params: vec4<f32>,
};

struct LightInfo {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

// Per-material (group 1)
struct MaterialUniforms {
  color: vec4<f32>,
  pbrParams: vec4<f32>,
  emissive: vec4<f32>,
};

// Per-object (group 2)
struct ModelUniforms {
  model: mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
};

// params: x = 1.0 if a shadow caster is active this frame (0.0 disables sampling entirely so an
// unconfigured shadow map can't darken the scene), y = texel size (1/shadowMapSize) used to jitter
// the 3x3 PCF taps below.
struct ShadowUniforms {
  lightViewProj: mat4x4<f32>,
  params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> lights: array<LightData>;
@group(0) @binding(2) var<uniform> lightInfo: LightInfo;
@group(0) @binding(3) var<uniform> shadow: ShadowUniforms;
@group(0) @binding(4) var shadowMap: texture_depth_2d;
@group(0) @binding(5) var shadowSampler: sampler_comparison;

@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(1) @binding(1) var materialMap: texture_2d<f32>;
@group(1) @binding(2) var materialNormalMap: texture_2d<f32>;
@group(1) @binding(3) var materialAoMap: texture_2d<f32>;
@group(1) @binding(4) var materialSampler: sampler;

@group(2) @binding(0) var<uniform> model: ModelUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

@vertex
fn vs(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let worldPos = model.model * vec4<f32>(input.position, 1.0);
  out.clipPos = camera.viewProj * worldPos;
  out.worldPos = worldPos.xyz;
  out.worldNormal = normalize((model.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
  out.uv = input.uv;
  return out;
}

const PI: f32 = 3.14159265359;

fn fresnelSchlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom + 0.0001);
}

fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  let ggx1 = NdotV / (NdotV * (1.0 - k) + k);
  let ggx2 = NdotL / (NdotL * (1.0 - k) + k);
  return ggx1 * ggx2;
}

// 3x3 PCF against the directional-light shadow map. shadow.params.x is 0.0 whenever
// GPURenderSystem has no active shadow caster this frame -- returning 1.0 (fully lit) in that
// case means the shadow bind group can stay populated with stale/default data with no visual
// effect, rather than requiring every caller to special-case "no shadows configured yet".
fn sampleShadow(worldPos: vec3<f32>) -> f32 {
  if (shadow.params.x < 0.5) {
    return 1.0;
  }

  let clip = shadow.lightViewProj * vec4<f32>(worldPos, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || ndc.z < 0.0 || ndc.z > 1.0) {
    return 1.0;
  }

  let bias = 0.0015;
  let depth = ndc.z - bias;
  let texel = shadow.params.y;

  var sum = 0.0;
  for (var oy = -1; oy <= 1; oy++) {
    for (var ox = -1; ox <= 1; ox++) {
      let offset = vec2<f32>(f32(ox), f32(oy)) * texel;
      sum += textureSampleCompare(shadowMap, shadowSampler, uv + offset, depth);
    }
  }
  return sum / 9.0;
}

// Derives a per-pixel TBN basis from screen-space derivatives of worldPos/uv instead of a
// precomputed tangent vertex attribute -- the vertex format here only carries position/normal/
// uv, and adding a tangent attribute would mean changing the vertex buffer layout everywhere
// (GPUMesh, ThreeGeometryAdapter, every mesh source). Standard technique, see Christian
// Schuler's "Normal Mapping without Precomputed Tangents".
fn perturbNormal(N: vec3<f32>, worldPos: vec3<f32>, uv: vec2<f32>, normalSample: vec3<f32>) -> vec3<f32> {
  let dp1 = dpdx(worldPos);
  let dp2 = dpdy(worldPos);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);

  let dp2perp = cross(dp2, N);
  let dp1perp = cross(N, dp1);
  let T = dp2perp * duv1.x + dp1perp * duv2.x;
  let B = dp2perp * duv1.y + dp1perp * duv2.y;
  let invmax = inverseSqrt(max(dot(T, T), dot(B, B)) + 0.0001);

  let mapVec = normalSample * 2.0 - 1.0;
  return normalize(mapVec.x * (T * invmax) + mapVec.y * (B * invmax) + mapVec.z * N);
}

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
  let albedoSample = textureSample(materialMap, materialSampler, input.uv).rgb;
  let albedo = material.color.rgb * albedoSample;
  let metalness = material.pbrParams.x;
  let roughness = max(material.pbrParams.y, 0.04);
  let emissive = material.emissive.rgb * material.pbrParams.z;
  let ao = textureSample(materialAoMap, materialSampler, input.uv).r;

  let geometricN = normalize(input.worldNormal);
  let normalSample = textureSample(materialNormalMap, materialSampler, input.uv).rgb;
  let N = perturbNormal(geometricN, input.worldPos, input.uv, normalSample);
  let V = normalize(camera.viewPos.xyz - input.worldPos);
  let NdotV = max(dot(N, V), 0.0);

  let f0 = mix(vec3<f32>(0.04), albedo, metalness);

  var Lo = vec3<f32>(0.0);

  for (var i = 0u; i < lightInfo.count; i++) {
    let light = lights[i];
    let lightType = u32(light.positionType.w);

    var L: vec3<f32>;
    var attenuation: f32 = 1.0;

    if (lightType == 0u) {
      // Directional
      L = normalize(-light.directionRange.xyz);
    } else {
      // Point / Spot
      let toLight = light.positionType.xyz - input.worldPos;
      let dist = length(toLight);
      L = toLight / max(dist, 0.0001);
      let range = light.directionRange.w;
      if (range > 0.0) {
        attenuation = max(1.0 - (dist * dist) / (range * range), 0.0);
        attenuation *= attenuation;
      }

      if (lightType == 2u) {
        let spotDir = normalize(light.directionRange.xyz);
        let theta = dot(L, -spotDir);
        let inner = light.params.x;
        let outer = light.params.y;
        attenuation *= clamp((theta - outer) / max(inner - outer, 0.0001), 0.0, 1.0);
      }
    }

    let H = normalize(V + L);
    let NdotL = max(dot(N, L), 0.0);
    let NdotH = max(dot(N, H), 0.0);
    let HdotV = max(dot(H, V), 0.0);

    let D = distributionGGX(NdotH, roughness);
    let G = geometrySmith(NdotV, NdotL, roughness);
    let F = fresnelSchlick(HdotV, f0);

    let specular = (D * G * F) / max(4.0 * NdotV * NdotL, 0.001);
    let kD = (vec3<f32>(1.0) - F) * (1.0 - metalness);
    let diffuse = kD * albedo / PI;

    // Only the directional light has a shadow map bound (see GPURenderSystem) -- point/spot
    // lights fall back to unshadowed, matching their pre-existing behavior.
    var shadowFactor = 1.0;
    if (lightType == 0u) {
      shadowFactor = sampleShadow(input.worldPos);
    }

    let radiance = light.colorIntensity.rgb * attenuation * shadowFactor;
    Lo += (diffuse + specular) * radiance * NdotL;
  }

  // Ambient
  let ambient = vec3<f32>(0.15) * albedo * ao;
  let color = ambient + Lo + emissive;

  // Reinhard tonemapping
  let mapped = color / (color + vec3<f32>(1.0));

  let alpha = material.color.a;
  return vec4<f32>(mapped * alpha, alpha);
}
