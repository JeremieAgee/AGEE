import { World } from "../ecs/World";
import { PhysicsSystem } from "../systems/PhysicsSystem";
import { SkeletonSystem } from "./SkeletonSystem";
import { Transform } from "../core/Components";
import {
  createHumanoid,
  animateHumanoidWalk,
  startHumanoidRagdoll,
  updateHumanoidRagdoll,
  cleanupHumanoid,
  HumanoidBone,
} from "./HumanoidFactory";

export interface SkeletonRuntime {
  world: World;
  physics: PhysicsSystem;
  skeleton: SkeletonSystem;
  step: (dt: number) => void;
}

export interface PhysicsBallHandle {
  eid: number;
  getPosition(): { x: number; y: number; z: number };
  getVelocity(): { x: number; y: number; z: number };
  setVelocity(x: number, y: number, z: number): void;
  setPosition(x: number, y: number, z: number): void;
  setRestitution(value: number): void;
  setFriction(value: number): void;
  destroy(): void;
}

// A plain dynamic sphere rigid body in the same Rapier world the humanoid
// skeleton runs in - gravity and integration are handled by Rapier, callers
// are responsible for their own collision/bounce logic against custom
// world geometry (this doesn't add any colliders besides the ball itself).
function createPhysicsBall(
  runtime: SkeletonRuntime,
  radius: number,
  position: { x: number; y: number; z: number }
): PhysicsBallHandle {
  const eid = runtime.world.createEntity();
  runtime.world.addComponent(eid, Transform, { x: position.x, y: position.y, z: position.z });
  const body = runtime.physics.addBody(eid, "dynamic", { canSleep: false });
  const collider = runtime.physics.addCollider(eid, "sphere", { radius });
  collider.setRestitution(0.6);
  collider.setFriction(0.4);

  return {
    eid,
    getPosition() {
      const t = body.translation();
      return { x: t.x, y: t.y, z: t.z };
    },
    getVelocity() {
      const v = body.linvel();
      return { x: v.x, y: v.y, z: v.z };
    },
    setVelocity(x: number, y: number, z: number) {
      body.setLinvel({ x, y, z }, true);
    },
    setPosition(x: number, y: number, z: number) {
      body.setTranslation({ x, y, z }, true);
    },
    setRestitution(value: number) {
      collider.setRestitution(value);
    },
    setFriction(value: number) {
      collider.setFriction(value);
    },
    destroy() {
      runtime.physics.removeBody(eid);
      runtime.world.destroyEntity(eid);
    },
  };
}

async function create(): Promise<SkeletonRuntime> {
  const world = new World();

  const physics = new PhysicsSystem();
  await physics.initRapier();
  world.addSystem(physics);

  const skeleton = new SkeletonSystem();
  skeleton.setPhysics(physics);
  world.addSystem(skeleton);

  return {
    world,
    physics,
    skeleton,
    step(dt: number) {
      world.update(dt);
    },
  };
}

// Synchronous, physics-free variant — for games that only need the humanoid
// rig (mesh + kinematic pose) and have no async bootstrap point to hook into.
// No ragdoll support: SkeletonSystem.activate() requires a PhysicsSystem.
function createSkeletonOnly(): SkeletonSystem {
  return new SkeletonSystem();
}

const SkeletonEngine = {
  create,
  createSkeletonOnly,
  createHumanoid,
  animateHumanoidWalk,
  startHumanoidRagdoll,
  updateHumanoidRagdoll,
  cleanupHumanoid,
  HumanoidBone,
  createPhysicsBall,
};

(window as any).SkeletonEngine = SkeletonEngine;

export default SkeletonEngine;
export { SkeletonEngine, create };
