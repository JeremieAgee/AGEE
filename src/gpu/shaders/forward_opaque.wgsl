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

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> lights: array<LightData>;
@group(0) @binding(2) var<uniform> lightInfo: LightInfo;

@group(1) @binding(0) var<uniform> material: MaterialUniforms;

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

@fragment
fn fs(input: VertexOutput) -> @location(0) vec4<f32> {
  let albedo = material.color.rgb;
  let metalness = material.pbrParams.x;
  let roughness = max(material.pbrParams.y, 0.04);
  let emissive = material.emissive.rgb * material.pbrParams.z;

  let N = normalize(input.worldNormal);
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

    let radiance = light.colorIntensity.rgb * attenuation;
    Lo += (diffuse + specular) * radiance * NdotL;
  }

  // Ambient
  let ambient = vec3<f32>(0.15) * albedo;
  let color = ambient + Lo + emissive;

  // Reinhard tonemapping
  let mapped = color / (color + vec3<f32>(1.0));

  let alpha = material.color.a;
  return vec4<f32>(mapped * alpha, alpha);
}
