import { defineConfig } from "vite";
import { resolve } from "node:path";

// Multi-page dev/build setup: the landing page plus one HTML entry per example under
// examples/*/index.html. `vite dev` serves any of these by path with no extra config; `vite
// build` needs each one listed explicitly as a rollup input.
const exampleEntries = [
  "basic-scene",
  "physics-ragdoll",
  "ai-agent",
  "networking",
];

export default defineConfig({
  root: __dirname,
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
