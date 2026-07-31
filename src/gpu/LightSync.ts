import type { World } from "../ecs";
import { Transform, Light } from "../core/Components";
import type { GPURenderSystem } from "./GPURenderSystem";

// ECS Light.lightType convention (Components.ts): 0=point, 1=directional, 2=spot, 3=ambient.
const ECS_LIGHT_POINT = 0;
const ECS_LIGHT_DIRECTIONAL = 1;
const ECS_LIGHT_SPOT = 2;
const ECS_LIGHT_AMBIENT = 3;

// AUDIT FIX (bug #5): GPURenderSystem.setDirectionalLight() previously had no
// caller anywhere in the engine, so ECS Light components never reached the
// WebGPU-native draw path and the light count stayed hard-coded at whatever a
// single manual call last set (at most 1), even though the light storage
// buffer supports MAX_LIGHTS. LightSync pulls every Light component out of the
// ECS each frame and forwards it into GPURenderSystem's native light buffer,
// so the accumulated count reflects however many lights actually exist in the
// world (see GPURenderSystem.update(), which owns and calls an instance of
// this class).
//
// AUDIT FIX: this originally only forwarded lightType===1 (directional) —
// point and spot lights were silently dropped even though forward_opaque.wgsl
// fully supports them. All three light-emitting types are now forwarded;
// ambient (lightType 3) has no per-light representation in this shader (it
// applies one flat ambient term) so it's intentionally skipped.
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
    const distance = this.lightStore!.getColumn("distance");
    const angle = this.lightStore!.getColumn("angle");
    const penumbra = this.lightStore!.getColumn("penumbra");
    const castShadow = this.lightStore!.getColumn("castShadow");
    const tx = this.transformStore!.getColumn("x");
    const ty = this.transformStore!.getColumn("y");
    const tz = this.transformStore!.getColumn("z");

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const type = lightType[eid];
      if (type === ECS_LIGHT_AMBIENT) continue;

      const hex = color[eid];
      const r = ((hex >> 16) & 0xff) / 255;
      const g = ((hex >> 8) & 0xff) / 255;
      const b = (hex & 0xff) / 255;
      const shadow = castShadow[eid] ? 1 : 0;

      if (type === ECS_LIGHT_POINT) {
        gpu.setPointLight(tx[eid], ty[eid], tz[eid], r, g, b, intensity[eid], distance[eid], shadow);
        continue;
      }

      // Directional and spot lights carry no explicit "direction" field on the Light
      // component; LightingHelpers.addDirectionalLight() sets a world position and
      // leaves the THREE target at the origin (matching how THREE.js itself derives
      // DirectionalLight direction), so mirror that: point from the light's position
      // toward the origin.
      let dx = -tx[eid], dy = -ty[eid], dz = -tz[eid];
      const lenSq = dx * dx + dy * dy + dz * dz;
      if (lenSq > 1e-8) {
        const inv = 1 / Math.sqrt(lenSq);
        dx *= inv; dy *= inv; dz *= inv;
      } else {
        dx = 0; dy = -1; dz = 0; // degenerate (light at the origin) — fall back to straight down
      }

      if (type === ECS_LIGHT_SPOT) {
        const outerCone = Math.cos(angle[eid]);
        const innerCone = Math.cos(angle[eid] * (1 - penumbra[eid]));
        gpu.setSpotLight(
          tx[eid], ty[eid], tz[eid],
          dx, dy, dz,
          r, g, b, intensity[eid],
          distance[eid], innerCone, outerCone, shadow
        );
      } else if (type === ECS_LIGHT_DIRECTIONAL) {
        gpu.setDirectionalLight(dx, dy, dz, r, g, b, intensity[eid]);
      }
    }
  }
}
