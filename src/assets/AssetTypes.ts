export type AssetId = string;

export const enum AssetType {
  Texture = 0,
  Mesh = 1,
  Material = 2,
  AnimationClip = 3,
  Audio = 4,
  GLTF = 5,
  Prefab = 6,
  Scene = 7,
}

export const enum LoadStatus {
  Unloaded = 0,
  Loading = 1,
  Loaded = 2,
  Failed = 3,
}

export type AssetHandle = number & { __brand: "asset" };

export const INVALID_ASSET: AssetHandle = -1 as AssetHandle;
