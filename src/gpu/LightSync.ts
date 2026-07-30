import type { World } from "../ecs";
import { Transform, Light } from "../core/Components";
import type { GPURenderSystem } from "./GPURenderSystem";

// AUDIT FIX (bug #5): GPURenderSystem.setDirectionalLight() previously had no
// caller anywhere in the engine, so ECS Light components never reached the
// WebGPU-native draw path and the light count stayed hard-coded at whatever a
// single manual call last set (at most 1), even though the light storage
// buffer supports MAX_LIGHTS. LightSync pulls every directional Light
// component out of the ECS each frame and forwards it into GPURenderSystem's
// native light buffer, so the accumulated count reflects however many lights
// actually exist in the world (see GPURenderSystem.update(), which owns and
// calls an instance of this class).
export class LightSync {
  private cachedWorld: World | null = null;
  private query: ReturnType<World["query"]> | null = null;
  private lightStore: ReturnType<World["getStore"]> | null = null;
  private transformStore: ReturnType<World["getStore"]> | null = null;

  sync(world: World, gpu: GPURenderSystem): void {
    if (this.cachedWorld !== world) {
      this.cachedWorld = world;
      this.query = world.query(Transform, Light);
      this.lightStore = world.getStore(Light);
      this.transformStore = world.getStore(Transform);
    }

    gpu.resetLights();

    const entities = this.query!.entities;
    const lightType = this.lightStore!.getColumn("lightType");
    const color = this.lightStore!.getColumn("color");
    const intensity = this.lightStore!.getColumn("intensity");
    const tx = this.transformStore!.getColumn("x");
    const ty = this.transformStore!.getColumn("y");
    const tz = this.transformStore!.getColumn("z");

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (lightType[eid] !== 1) continue; // only directional lights map onto the native path today

      const hex = color[eid];
      const r = ((hex >> 16) & 0xff) / 255;
      const g = ((hex >> 8) & 0xff) / 255;
      const b = (hex & 0xff) / 255;

      // Directional lights carry no explicit "direction" field on the Light
      // component; LightingHelpers.addDirectionalLight() sets a world position
      // and leaves the THREE target at the origin (matching how THREE.js itself
      // derives DirectionalLight direction), so mirror that: point from the
      // light's position toward the origin.
      let dx = -tx[eid], dy = -ty[eid], dz = -tz[eid];
      const lenSq = dx * dx + dy * dy + dz * dz;
      if (lenSq > 1e-8) {
        const inv = 1 / Math.sqrt(lenSq);
        dx *= inv; dy *= inv; dz *= inv;
      } else {
        dx = 0; dy = -1; dz = 0; // degenerate (light at the origin) — fall back to straight down
      }

      gpu.setDirectionalLight(dx, dy, dz, r, g, b, intensity[eid]);
    }
  }
}
