import * as THREE from "three";

// RGBA8 plus ~33% headroom for mipmaps, matching the same rule of thumb ResourceManager uses
// elsewhere in the engine for GPU texture memory estimates. Shared by AssetSystem (direct
// texture loads) and GLTFPipeline (textures pulled in through a GLTF's materials) so both
// feed MemoryBudget consistent byte counts regardless of load path.
export function estimateTextureBytes(tex: THREE.Texture): number {
  const img = tex.image as { width?: number; height?: number } | undefined;
  const w = img?.width ?? 0, h = img?.height ?? 0;
  return Math.round(w * h * 4 * 1.33);
}
