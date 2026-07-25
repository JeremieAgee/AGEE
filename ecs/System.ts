import type { World } from "./World";

export type SystemPhase = "prePhysics" | "physics" | "postPhysics" | "render";

export abstract class System {
  priority = 0;
  active = true;
  enabled = true;
  world!: World;
  phase: SystemPhase = "postPhysics";

  static reads: string[] = [];
  static writes: string[] = [];

  abstract update(dt: number): void;

  init?(): void;
  destroy?(): void;
}
