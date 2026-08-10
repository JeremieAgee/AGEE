import * as THREE from "three";
import { Handle, HandleMap, ResourceType, INVALID_HANDLE } from "./Handle";
import type { ValidationLayer } from "../ValidationLayer";

export type TextureHandle = Handle & { __brand: "texture" };
export type MeshHandle = Handle & { __brand: "mesh" };
export type MaterialHandle = Handle & { __brand: "material" };
export type AudioHandle = Handle & { __brand: "audio" };
export type AnimClipHandle = Handle & { __brand: "animclip" };

export interface ResourceStats {
  textures: number;
  meshes: number;
  materials: number;
  audio: number;
  animClips: number;
  totalRefs: number;
  totalMemory: number;
}

export class ResourceManager {
  private resources = new HandleMap<any>();
  private memoryBudget = Infinity;
  private _peakMemory = 0;
  private validation: ValidationLayer | null = null;

  get peakMemory(): number { return this._peakMemory; }

  setMemoryBudget(bytes: number): void {
    this.memoryBudget = bytes;
  }

  setValidation(validation: ValidationLayer | null): void {
    this.validation = validation;
  }

  // ── Textures ──
  addTexture(tex: THREE.Texture, memorySize: number = 0): TextureHandle {
    const h = this.resources.alloc(tex, ResourceType.Texture, memorySize) as TextureHandle;
    this.validation?.trackAllocation(h, "texture");
    this.trackPeakMemory();
    return h;
  }

  getTexture(h: TextureHandle): THREE.Texture | null {
    return this.resources.get(h);
  }

  // ── Meshes (BufferGeometry) ──
  addMesh(geo: THREE.BufferGeometry, memorySize: number = 0): MeshHandle {
    const h = this.resources.alloc(geo, ResourceType.Mesh, memorySize) as MeshHandle;
    this.validation?.trackAllocation(h, "mesh");
    this.trackPeakMemory();
    return h;
  }

  getMesh(h: MeshHandle): THREE.BufferGeometry | null {
    return this.resources.get(h);
  }

  // ── Materials ──
  addMaterial(mat: THREE.Material, memorySize: number = 0): MaterialHandle {
    const h = this.resources.alloc(mat, ResourceType.Material, memorySize) as MaterialHandle;
    this.validation?.trackAllocation(h, "material");
    this.trackPeakMemory();
    return h;
  }

  getMaterial(h: MaterialHandle): THREE.Material | null {
    return this.resources.get(h);
  }

  // ── Audio ──
  addAudio(buf: AudioBuffer, memorySize: number = 0): AudioHandle {
    const h = this.resources.alloc(buf, ResourceType.Audio, memorySize || estimateAudioSize(buf)) as AudioHandle;
    this.validation?.trackAllocation(h, "audio");
    this.trackPeakMemory();
    return h;
  }

  getAudio(h: AudioHandle): AudioBuffer | null {
    return this.resources.get(h);
  }

  // ── Animation Clips ──
  addAnimClip(clip: THREE.AnimationClip): AnimClipHandle {
    const h = this.resources.alloc(clip, ResourceType.AnimClip, 0) as AnimClipHandle;
    this.validation?.trackAllocation(h, "animClip");
    return h;
  }

  getAnimClip(h: AnimClipHandle): THREE.AnimationClip | null {
    return this.resources.get(h);
  }

  // ── Unified reference counting (single source of truth) ──
  retain(h: Handle): void {
    if (!this.resources.retain(h)) {
      console.warn(`[AGEE] ResourceManager.retain() called on invalid handle ${h}`);
    }
  }

  release(h: Handle): void {
    this.validation?.checkNoDoubleRelease(h, "ResourceManager.release");
    const remaining = this.resources.release(h);
    if (remaining < 0) {
      console.warn(`[AGEE] ResourceManager.release() called on invalid handle ${h}`);
      return;
    }
    if (remaining === 0) {
      this.validation?.trackDeallocation(h);
      this.disposeHandle(h);
    }
  }

  getRefCount(h: Handle): number {
    return this.resources.getRefCount(h);
  }

  isAlive(h: Handle): boolean {
    return this.resources.isValid(h);
  }

  private disposeHandle(h: Handle): void {
    const entry = this.resources.getEntry(h);
    if (!entry || !entry.data) {
      this.resources.free(h);
      return;
    }

    const data = entry.data;
    switch (entry.resourceType) {
      case ResourceType.Texture:
        (data as THREE.Texture).dispose();
        break;
      case ResourceType.Mesh:
        (data as THREE.BufferGeometry).dispose();
        break;
      case ResourceType.Material:
        (data as THREE.Material).dispose();
        break;
    }
    this.resources.free(h);
  }

  private trackPeakMemory(): void {
    const current = this.resources.getTotalMemory();
    if (current > this._peakMemory) this._peakMemory = current;
    if (current > this.memoryBudget) {
      console.warn(`[AGEE] GPU memory budget exceeded: ${(current / 1024 / 1024).toFixed(1)}MB / ${(this.memoryBudget / 1024 / 1024).toFixed(1)}MB`);
    }
  }

  // ── Diagnostics ──
  getStats(): ResourceStats {
    let textures = 0, meshes = 0, materials = 0, audio = 0, animClips = 0, totalRefs = 0;
    this.resources.forEachEntry((entry) => {
      switch (entry.resourceType) {
        case ResourceType.Texture: textures++; break;
        case ResourceType.Mesh: meshes++; break;
        case ResourceType.Material: materials++; break;
        case ResourceType.Audio: audio++; break;
        case ResourceType.AnimClip: animClips++; break;
      }
      totalRefs += entry.refCount;
    });
    return {
      textures, meshes, materials, audio, animClips, totalRefs,
      totalMemory: this.resources.getTotalMemory(),
    };
  }

  getTotalMemory(): number {
    return this.resources.getTotalMemory();
  }

  disposeAll(): void {
    if (this.validation) {
      this.resources.forEachEntry((_entry, index) => {
        const h = this.resources.handleAt(index);
        if (h !== null) this.validation!.trackDeallocation(h);
      });
    }
    this.resources.forEach((data) => {
      if (data && typeof data.dispose === "function") data.dispose();
    });
    this.resources = new HandleMap<any>();
  }
}

function estimateAudioSize(buf: AudioBuffer): number {
  return buf.length * buf.numberOfChannels * 4;
}
