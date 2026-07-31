import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";

// RenderSystem's WebGPURenderer comes from "three/webgpu" — a separate build with its own
// copy of every core class (Object3D, Scene, Light, MeshStandardMaterial, ...). Everywhere
// else in the engine (LightingHelpers, GLTFPipeline, the examples, ...) imports plain
// "three". Left alone, that's two different module instances: a THREE.DirectionalLight
// built from the classic bundle doesn't match the class identity WebGPURenderer's node
// system checks against, so it silently fails to light anything (console warning:
// "LightsNode.setupNodeLights: Light node not found") and MeshStandardMaterial renders flat
// black. Redirecting "three" to "three/webgpu" — the pattern three.js's own WebGPU examples
// use — makes those resolve to the same module graph.
//
// Two carve-outs, both left on the classic build because they don't need to interoperate
// with WebGPURenderer's node-material identity checks and redirecting them breaks the build
// outright:
//   - The legacy WebGL-era postprocessing addons (EffectComposer & friends, used by
//     PostProcessSystem) import symbols like UniformsUtils that three/webgpu's node-based
//     build doesn't export at all.
//   - RenderSystem.ts itself imports WebGPURenderer directly from "three/webgpu" already
//     (see its own import line) — it doesn't need its bare "three" import aliased for that.
//     It also constructs THREE.WebGLRenderer as the non-WebGPU fallback, which — like
//     UniformsUtils above — doesn't exist in the webgpu build at all.
function threeWebgpuAlias(): Plugin {
  return {
    name: "three-webgpu-alias",
    enforce: "pre",
    resolveId(source, importer) {
      if (source !== "three") return null;
      if (
        importer &&
        (/[\\/]examples[\\/]jsm[\\/](postprocessing|shaders)[\\/]/.test(importer) ||
          /[\\/]systems[\\/]RenderSystem\.ts$/.test(importer))
      ) {
        return null;
      }
      return this.resolve("three/webgpu", importer, { skipSelf: true });
    },
  };
}

// Multi-page dev/build setup: the landing page plus one HTML entry per example under
// examples/*/index.html. `vite dev` serves any of these by path with no extra config; `vite
// build` needs each one listed explicitly as a rollup input.
const exampleEntries = [
  "lighting",
  "destructible-brick-house",
  "basic-scene",
  "physics-ragdoll",
  "ai-agent",
  "networking",
];

export default defineConfig({
  root: __dirname,
  plugins: [threeWebgpuAlias()],
  define: {
    // Build-time flag gating editor-only code (scene builder, gizmos, inspector UI).
    // Rollup dead-code-eliminates any `if (__EDITOR__)` branch when this resolves to false,
    // and drops dynamic imports inside those branches from the production bundle entirely.
    __EDITOR__: JSON.stringify(process.env.EDITOR === "true"),
  },
  optimizeDeps: {
    // rapier3d-compat ships its own WASM loading; letting esbuild's dep pre-bundler touch it
    // in dev mode is a common source of "unreachable code" / WASM instantiation errors.
    exclude: ["@dimforge/rapier3d-compat"],
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        ...Object.fromEntries(
          exampleEntries.map((name) => [
            name,
            resolve(__dirname, `examples/${name}/index.html`),
          ])
        ),
      },
    },
  },
});
