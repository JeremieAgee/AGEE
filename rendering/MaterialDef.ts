import * as THREE from "three";
import { Handle, HandleMap, ResourceType } from "../core/handles/Handle";
import { defineComponent } from "../ecs";

export type MaterialHandle = Handle & { __brand: "material_def" };

export const enum BlendMode {
  Opaque = 0,
  AlphaBlend = 1,
  Additive = 2,
  Multiply = 3,
}

export const enum RenderQueue {
  Background = 0,
  Opaque = 1000,
  AlphaTest = 2000,
  Transparent = 3000,
  Overlay = 4000,
}

export interface MaterialParams {
  color?: number;
  opacity?: number;
  metalness?: number;
  roughness?: number;
  emissive?: number;
  emissiveIntensity?: number;
  map?: string;
  normalMap?: string;
  aoMap?: string;
  envMapIntensity?: number;
}

export interface MaterialDef {
  name: string;
  shader: "standard" | "basic" | "phong" | "toon" | "unlit";
  params: MaterialParams;
  blendMode: BlendMode;
  renderQueue: RenderQueue;
  doubleSided: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  wireframe: boolean;
}

export const MaterialComponent = defineComponent("Material", {
  materialHandle: "i32",
  colorOverride: "i32",
  opacityOverride: "f32",
  emissiveOverride: "i32",
  dirty: "bool",
});

export class MaterialSystem {
  private pool = new HandleMap<MaterialDef>();
  private nameToHandle = new Map<string, MaterialHandle>();
  private threeCache = new Map<number, THREE.Material>();

  register(def: MaterialDef): MaterialHandle {
    const existing = this.nameToHandle.get(def.name);
    if (existing !== undefined) {
      this.pool.set(existing, def);
      this.threeCache.delete(existing);
      return existing;
    }
    const handle = this.pool.alloc(def) as MaterialHandle;
    this.nameToHandle.set(def.name, handle);
    return handle;
  }

  get(handle: MaterialHandle): MaterialDef | null {
    return this.pool.get(handle);
  }

  getByName(name: string): MaterialHandle | undefined {
    return this.nameToHandle.get(name);
  }

  resolve(handle: MaterialHandle): THREE.Material | null {
    const cached = this.threeCache.get(handle);
    if (cached) return cached;

    const def = this.pool.get(handle);
    if (!def) return null;

    const mat = this.createThreeMaterial(def);
    this.threeCache.set(handle, mat);
    return mat;
  }

  resolveWithOverrides(
    handle: MaterialHandle,
    colorOverride: number,
    opacityOverride: number,
    emissiveOverride: number
  ): THREE.Material | null {
    const base = this.resolve(handle);
    if (!base) return null;

    if (colorOverride === -1 && opacityOverride <= 0 && emissiveOverride === -1) {
      return base;
    }

    const clone = base.clone();
    const standard = clone as THREE.MeshStandardMaterial;

    if (colorOverride !== -1 && 'color' in standard) {
      standard.color.setHex(colorOverride);
    }
    if (opacityOverride > 0 && 'opacity' in standard) {
      standard.opacity = opacityOverride;
      standard.transparent = opacityOverride < 1;
    }
    if (emissiveOverride !== -1 && 'emissive' in standard) {
      standard.emissive.setHex(emissiveOverride);
    }

    return clone;
  }

  private createThreeMaterial(def: MaterialDef): THREE.Material {
    const p = def.params;

    let mat: THREE.Material;
    switch (def.shader) {
      case "basic":
        mat = new THREE.MeshBasicMaterial({
          color: p.color ?? 0xffffff,
          opacity: p.opacity ?? 1,
          transparent: (p.opacity ?? 1) < 1,
          wireframe: def.wireframe,
        });
        break;
      case "phong":
        mat = new THREE.MeshPhongMaterial({
          color: p.color ?? 0xffffff,
          emissive: p.emissive ?? 0x000000,
          opacity: p.opacity ?? 1,
          transparent: (p.opacity ?? 1) < 1,
          wireframe: def.wireframe,
        });
        break;
      case "toon":
        mat = new THREE.MeshToonMaterial({
          color: p.color ?? 0xffffff,
          emissive: p.emissive ?? 0x000000,
          opacity: p.opacity ?? 1,
          transparent: (p.opacity ?? 1) < 1,
          wireframe: def.wireframe,
        });
        break;
      case "unlit":
        mat = new THREE.MeshBasicMaterial({
          color: p.color ?? 0xffffff,
          opacity: p.opacity ?? 1,
          transparent: (p.opacity ?? 1) < 1,
          wireframe: def.wireframe,
        });
        break;
      default:
        mat = new THREE.MeshStandardMaterial({
          color: p.color ?? 0xffffff,
          metalness: p.metalness ?? 0,
          roughness: p.roughness ?? 1,
          emissive: p.emissive ?? 0x000000,
          emissiveIntensity: p.emissiveIntensity ?? 1,
          envMapIntensity: p.envMapIntensity ?? 1,
          opacity: p.opacity ?? 1,
          transparent: (p.opacity ?? 1) < 1,
          wireframe: def.wireframe,
        });
    }

    mat.side = def.doubleSided ? THREE.DoubleSide : THREE.FrontSide;

    switch (def.blendMode) {
      case BlendMode.Additive:
        mat.blending = THREE.AdditiveBlending;
        mat.transparent = true;
        break;
      case BlendMode.Multiply:
        mat.blending = THREE.MultiplyBlending;
        mat.transparent = true;
        break;
    }

    return mat;
  }

  unregister(name: string): void {
    const h = this.nameToHandle.get(name);
    if (h !== undefined) {
      const cached = this.threeCache.get(h);
      if (cached) cached.dispose();
      this.threeCache.delete(h);
      this.pool.free(h);
      this.nameToHandle.delete(name);
    }
  }

  dispose(): void {
    for (const mat of this.threeCache.values()) {
      mat.dispose();
    }
    this.threeCache.clear();
    this.nameToHandle.clear();
    this.pool = new HandleMap<MaterialDef>();
  }
}

export function createDefaultMaterial(): MaterialDef {
  return {
    name: "default",
    shader: "standard",
    params: { color: 0xcccccc, roughness: 0.7, metalness: 0.0 },
    blendMode: BlendMode.Opaque,
    renderQueue: RenderQueue.Opaque,
    doubleSided: false,
    castShadow: true,
    receiveShadow: true,
    wireframe: false,
  };
}
