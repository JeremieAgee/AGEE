import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    // Same build-time flag as vite.config.ts — tests run against the non-editor code path.
    __EDITOR__: JSON.stringify(false),
  },
  optimizeDeps: {
    exclude: ["@dimforge/rapier3d-compat"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 15000,
  },
});
