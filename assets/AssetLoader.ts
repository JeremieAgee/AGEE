import * as THREE from "three";

export type AssetType = "texture" | "model" | "audio" | "cubeTexture";

interface AssetEntry {
  type: AssetType;
  data: any;
}

export class AssetLoader {
  private cache = new Map<string, AssetEntry>();
  private textureLoader = new THREE.TextureLoader();
  private audioLoader = new THREE.AudioLoader();
  private cubeTextureLoader = new THREE.CubeTextureLoader();
  private loading = new Map<string, Promise<any>>();

  async loadTexture(key: string, url: string): Promise<THREE.Texture> {
    if (this.cache.has(key)) return this.cache.get(key)!.data;
    if (this.loading.has(key)) return this.loading.get(key)!;

    const promise = new Promise<THREE.Texture>((resolve, reject) => {
      this.textureLoader.load(
        url,
        (texture) => {
          this.cache.set(key, { type: "texture", data: texture });
          this.loading.delete(key);
          resolve(texture);
        },
        undefined,
        reject
      );
    });
    this.loading.set(key, promise);
    return promise;
  }

  async loadCubeTexture(key: string, urls: string[]): Promise<THREE.CubeTexture> {
    if (this.cache.has(key)) return this.cache.get(key)!.data;
    if (this.loading.has(key)) return this.loading.get(key)!;

    const promise = new Promise<THREE.CubeTexture>((resolve, reject) => {
      this.cubeTextureLoader.load(
        urls,
        (texture) => {
          this.cache.set(key, { type: "cubeTexture", data: texture });
          this.loading.delete(key);
          resolve(texture);
        },
        undefined,
        reject
      );
    });
    this.loading.set(key, promise);
    return promise;
  }

  async loadAudioBuffer(key: string, url: string): Promise<AudioBuffer> {
    if (this.cache.has(key)) return this.cache.get(key)!.data;
    if (this.loading.has(key)) return this.loading.get(key)!;

    const promise = new Promise<AudioBuffer>((resolve, reject) => {
      this.audioLoader.load(
        url,
        (buffer) => {
          this.cache.set(key, { type: "audio", data: buffer });
          this.loading.delete(key);
          resolve(buffer);
        },
        undefined,
        reject
      );
    });
    this.loading.set(key, promise);
    return promise;
  }

  get<T = any>(key: string): T | undefined {
    return this.cache.get(key)?.data;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  dispose(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    if (entry.data?.dispose) entry.data.dispose();
    this.cache.delete(key);
  }

  disposeAll(): void {
    for (const [key] of this.cache) {
      this.dispose(key);
    }
  }
}
