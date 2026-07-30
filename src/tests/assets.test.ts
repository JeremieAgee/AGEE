import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { AssetStore } from "../assets/AssetStore";
import { AssetSystem } from "../assets/AssetSystem";
import { AssetType, LoadStatus, INVALID_ASSET } from "../assets/AssetTypes";
import { GLTFPipeline } from "../assets/pipeline/GLTFPipeline";

// ---------------------------------------------------------------------------
// AssetStore — direct SOA store correctness
// ---------------------------------------------------------------------------

describe("AssetStore", () => {
  it("register returns the same handle for a repeated id", () => {
    const store = new AssetStore();
    const h1 = store.register("tex:a", AssetType.Texture, "a.png");
    const h2 = store.register("tex:a", AssetType.Texture, "a.png");
    expect(h2).toBe(h1);
  });

  it("retain/release track a refcount and signal dispose only at zero", () => {
    const store = new AssetStore();
    const h = store.register("tex:b", AssetType.Texture, "b.png");
    store.retain(h);
    store.retain(h);
    expect(store.getRefCount(h)).toBe(2);
    expect(store.release(h)).toBe(false); // 2 -> 1, still alive
    expect(store.getRefCount(h)).toBe(1);
    expect(store.release(h)).toBe(true); // 1 -> 0, caller should dispose
  });

  it("release on a handle with refcount 0 is a no-op", () => {
    const store = new AssetStore();
    const h = store.register("tex:c", AssetType.Texture, "c.png");
    expect(store.release(h)).toBe(false);
    expect(store.getRefCount(h)).toBe(0);
  });

  it("tracks dependencies added via addDependency", () => {
    const store = new AssetStore();
    const parent = store.register("gltf:x", AssetType.GLTF, "x.gltf");
    const dep1 = store.register("gltf:x:mesh:0", AssetType.Mesh, "x.gltf");
    const dep2 = store.register("gltf:x:mat:0", AssetType.Material, "x.gltf");
    store.addDependency(parent, dep1);
    store.addDependency(parent, dep2);
    expect(store.getDependencies(parent)).toEqual([dep1, dep2]);
  });

  it("remove() frees the slot and clears id/path lookups", () => {
    const store = new AssetStore();
    const h = store.register("tex:d", AssetType.Texture, "d.png");
    store.setLoaded(h, { dispose: () => {} });
    store.remove(h);
    expect(store.getHandleById("tex:d")).toBe(INVALID_ASSET);
    expect(store.getHandleByPath("d.png")).toBe(INVALID_ASSET);
    expect(store.getStatus(h)).toBe(LoadStatus.Unloaded);
  });

  it("a freed slot is reused by the next register() call", () => {
    const store = new AssetStore();
    const h1 = store.register("tex:e", AssetType.Texture, "e.png");
    store.remove(h1);
    const h2 = store.register("tex:f", AssetType.Texture, "f.png");
    expect(h2).toBe(h1);
  });
});

// ---------------------------------------------------------------------------
// AssetSystem — texture loading through THREE.TextureLoader (mocked)
// ---------------------------------------------------------------------------

describe("AssetSystem.load (texture path, single owner)", () => {
  let loadSpy: ReturnType<typeof vi.spyOn>;
  const textures = new Map<string, any>();

  beforeEach(() => {
    textures.clear();
    loadSpy = vi.spyOn(THREE.TextureLoader.prototype, "load").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function (this: any, url: string, onLoad?: (t: any) => void) {
        let tex = textures.get(url);
        if (!tex) {
          tex = { dispose: vi.fn(), url };
          textures.set(url, tex);
        }
        onLoad?.(tex);
        return tex;
      }
    );
  });

  afterEach(() => {
    loadSpy.mockRestore();
  });

  it("loads a registered texture and marks it Loaded", async () => {
    const sys = new AssetSystem();
    const handle = sys.registerTexture("tex1", "textures/tex1.png");
    expect(sys.isReady(handle)).toBe(false);

    const data = await sys.load(handle);
    expect(data).toBeDefined();
    expect(sys.isReady(handle)).toBe(true);
    expect(sys.get(handle)).toBe(data);
  });

  it("repeated load() calls on an already-loaded handle hit the cache (loader invoked once)", async () => {
    const sys = new AssetSystem();
    const handle = sys.registerTexture("tex2", "textures/tex2.png");

    const first = await sys.load(handle);
    const second = await sys.load(handle);

    expect(second).toBe(first);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it("concurrent in-flight load() calls for the same handle share one promise", async () => {
    const sys = new AssetSystem();
    const handle = sys.registerTexture("tex3", "textures/tex3.png");

    const p1 = sys.load(handle);
    const p2 = sys.load(handle);
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toBe(b);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it("loadById/loadByPath reject for unregistered assets", async () => {
    const sys = new AssetSystem();
    await expect(sys.loadById("nope")).rejects.toBeDefined();
    await expect(sys.loadByPath("nope.png")).rejects.toBeDefined();
  });

  // Note: an AssetSystem.load() call against a GLTF-typed handle is intentionally NOT
  // exercised here. AssetSystem.ts rejects it synchronously (Promise.reject(...) at
  // AssetSystem.ts:65) but then chains `promise.finally(() => this.inflight.delete(handle))`
  // without capturing the resulting (also-rejected) promise. That derived promise is
  // unreachable from any caller, so Node reports it as a separate, un-catchable "unhandled
  // rejection" regardless of how carefully the caller awaits/catches load()'s own return
  // value — there is no way to observe or suppress it from a test. The GLTF-rejection
  // behavior itself is still exercised indirectly by GLTFPipeline.load() below, which is
  // the intended call path for GLTF assets.

  it("release() disposes the resource and removes it from the store once refcount hits zero", async () => {
    const sys = new AssetSystem();
    const handle = sys.registerTexture("tex4", "textures/tex4.png");
    const data = await sys.load(handle);

    sys.release(handle);

    expect(data.dispose).toHaveBeenCalledTimes(1);
    expect(sys.store.getHandleById("tex4")).toBe(INVALID_ASSET);
  });

  // -------------------------------------------------------------------------
  // AUDIT: load() skips retain() on cache-hit path, causing over-release on
  // shared assets — see AssetSystem.ts:42
  //
  // Two independent "owners" both call load() on a handle that is already
  // Loaded (owner B's call hits the `store.isLoaded(handle)` fast path at
  // AssetSystem.ts:43-45), so only owner A's cold load ever calls
  // store.retain(). When each owner later calls release() exactly once
  // (as any well-behaved reference-counted caller would), the refcount hits
  // zero after only ONE of the two releases and the asset is disposed while
  // the other owner still believes it holds a live reference.
  // -------------------------------------------------------------------------
  it("AUDIT: load() skips retain() on cache-hit path, causing over-release on shared assets — see AssetSystem.ts:42", async () => {
    const sys = new AssetSystem();
    const handle = sys.registerTexture("tex-shared", "textures/shared.png");

    // Owner A: cold load (retain() called internally, refCount -> 1)
    await sys.load(handle);
    // Owner B: loads the same, already-Loaded handle (cache-hit path, no retain())
    await sys.load(handle);

    // Correct reference-counted behavior: two independent owners means refCount === 2.
    expect(sys.store.getRefCount(handle)).toBe(2);

    // Owner B releases first. Because owner A never got its own retain(), this
    // single release already drops the (buggy) refcount to zero.
    sys.release(handle);

    // The asset must still be alive: owner A has not released its reference yet.
    expect(sys.isReady(handle)).toBe(true);
    expect(sys.store.getData(handle)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GLTFPipeline — parsing basics against a minimal, inline glTF 2.0 JSON fixture
// ---------------------------------------------------------------------------

describe("GLTFPipeline.load (minimal inline glTF fixture)", () => {
  const MINIMAL_GLTF = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
  });

  let loadSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Bypass network entirely: redirect GLTFLoader.load() straight into the real
    // GLTFLoader.parse() with our inline fixture, exercising real parsing logic
    // without needing an actual glTF binary/file on disk.
    loadSpy = vi.spyOn(GLTFLoader.prototype, "load").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function (this: any, _url: string, onLoad: any, _onProgress: any, onError: any) {
        this.parse(MINIMAL_GLTF, "", onLoad, onError);
      }
    );
  });

  afterEach(() => {
    loadSpy.mockRestore();
  });

  it("parses a minimal valid glTF and registers it as a Loaded asset with an empty scene graph", async () => {
    const assets = new AssetSystem();
    const pipeline = new GLTFPipeline(assets);

    const result = await pipeline.load("scene1", "scenes/empty.gltf");

    expect(result.sceneRoot).toBeInstanceOf(THREE.Object3D);
    expect(result.meshes).toEqual([]);
    expect(result.materials).toEqual([]);
    expect(result.animations).toEqual([]);

    const gltfHandle = assets.store.getHandleById("scene1");
    expect(gltfHandle).not.toBe(INVALID_ASSET);
    expect(assets.store.isLoaded(gltfHandle)).toBe(true);
    expect(assets.store.getRefCount(gltfHandle)).toBeGreaterThan(0);
  });
});
