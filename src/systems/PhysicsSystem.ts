import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { System, World, ComponentStore } from "../ecs";
import { Transform, RigidBody, Collider, MeshRenderer, Velocity } from "../core/Components";
import { Quat } from "../core/math/Quat";

export interface RaycastHit {
  entityId: number;
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  distance: number;
}

export interface CollisionEvent {
  entityA: number;
  entityB: number;
  started: boolean;
}

export type CollisionCallback = (event: CollisionEvent) => void;
export type TriggerCallback = (entityA: number, entityB: number) => void;

export const enum CollisionLayer {
  Default    = 0x0001,
  Static     = 0x0002,
  Dynamic    = 0x0004,
  Kinematic  = 0x0008,
  Player     = 0x0010,
  Enemy      = 0x0020,
  Projectile = 0x0040,
  Trigger    = 0x0080,
  Terrain    = 0x0100,
  UI         = 0x0200,
  Debris     = 0x0400,
  Custom1    = 0x1000,
  Custom2    = 0x2000,
  Custom3    = 0x4000,
  Custom4    = 0x8000,
  All        = 0xFFFF,
}

export interface CollisionFilter {
  membership: number;
  filter: number;
}

export interface CharacterControllerConfig {
  height: number;
  radius: number;
  stepHeight: number;
  maxSlope: number;
  skinWidth: number;
}

export interface CharacterMoveResult {
  grounded: boolean;
}

const INITIAL_CAPACITY = 256;

export class PhysicsSystem extends System {
  priority = 100;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "physics";

  static reads = ["Transform"];
  static writes = ["Transform", "RigidBody", "Velocity"];

  rapierWorld!: RAPIER.World;
  private initialized = false;
  private accumulator = 0;
  private fixedStep = 1 / 60;
  // Safety cap on how many fixed substeps a single update() call will run, so a genuine
  // spiral-of-death (e.g. a long debugger pause) can't block the main thread simulating
  // thousands of steps synchronously. Deliberately generous relative to a single dropped
  // frame at 60Hz (a ~12fps single frame needs 5 substeps) so ordinary frame-rate variance
  // never gets truncated — see the AUDIT fix below for what happens when it IS hit.
  private maxSubSteps = 8;
  private eventQueue!: RAPIER.EventQueue;

  private transformStore!: ComponentStore;
  private rigidBodyStore!: ComponentStore;
  private colliderStore!: ComponentStore;
  private meshStore!: ComponentStore;
  private velocityStore!: ComponentStore;
  private bodyQuery!: ReturnType<World["query"]>;
  private collidableMeshQuery!: ReturnType<World["query"]>;

  // SOA: flat arrays indexed by entity ID
  private bodies: (RAPIER.RigidBody | null)[] = new Array(INITIAL_CAPACITY).fill(null);
  private colliders: (RAPIER.Collider | null)[] = new Array(INITIAL_CAPACITY).fill(null);
  private controllers: (RAPIER.KinematicCharacterController | null)[] = new Array(INITIAL_CAPACITY).fill(null);
  private entityColliderHandles: (number[] | null)[] = new Array(INITIAL_CAPACITY).fill(null);
  private capacity = INITIAL_CAPACITY;

  // Interpolation: previous frame positions for smooth rendering
  private prevPosX: Float32Array = new Float32Array(INITIAL_CAPACITY);
  private prevPosY: Float32Array = new Float32Array(INITIAL_CAPACITY);
  private prevPosZ: Float32Array = new Float32Array(INITIAL_CAPACITY);
  private currPosX: Float32Array = new Float32Array(INITIAL_CAPACITY);
  private currPosY: Float32Array = new Float32Array(INITIAL_CAPACITY);
  private currPosZ: Float32Array = new Float32Array(INITIAL_CAPACITY);

  // Interpolation: previous/current-step rotations, mirroring prevPos/currPos so rotation is
  // slerped by the same alpha instead of snapping straight to the latest body.rotation().
  private prevRotX: Float32Array = new Float32Array(INITIAL_CAPACITY);
  private prevRotY: Float32Array = new Float32Array(INITIAL_CAPACITY);
  private prevRotZ: Float32Array = new Float32Array(INITIAL_CAPACITY);
  private prevRotW: Float32Array = new Float32Array(INITIAL_CAPACITY).fill(1);
  private currRotX: Float32Array = new Float32Array(INITIAL_CAPACITY);
  private currRotY: Float32Array = new Float32Array(INITIAL_CAPACITY);
  private currRotZ: Float32Array = new Float32Array(INITIAL_CAPACITY);
  private currRotW: Float32Array = new Float32Array(INITIAL_CAPACITY).fill(1);
  private _interpolationAlpha = 0;
  private _tmpPrevQuat = new Quat();
  private _tmpCurrQuat = new Quat();

  // Reverse index: collider handle → entity ID (derived, not authoritative)
  private colliderToEntity = new Map<number, number>();

  private jointMap = new Map<number, RAPIER.ImpulseJoint>();
  private nextJointId = 0;

  private collisionStartCallbacks: CollisionCallback[] = [];
  private collisionEndCallbacks: CollisionCallback[] = [];
  private triggerEnterCallbacks: TriggerCallback[] = [];
  private triggerExitCallbacks: TriggerCallback[] = [];
  private autoBounds = new THREE.Box3();
  private autoSize = new THREE.Vector3();

  get interpolationAlpha(): number {
    return this._interpolationAlpha;
  }

  private ensureCapacity(eid: number): void {
    if (eid < this.capacity) return;
    while (this.capacity <= eid) this.capacity *= 2;
    const oldBodies = this.bodies;
    const oldColliders = this.colliders;
    const oldControllers = this.controllers;
    const oldHandles = this.entityColliderHandles;
    this.bodies = new Array(this.capacity).fill(null);
    this.colliders = new Array(this.capacity).fill(null);
    this.controllers = new Array(this.capacity).fill(null);
    this.entityColliderHandles = new Array(this.capacity).fill(null);
    for (let i = 0; i < oldBodies.length; i++) {
      this.bodies[i] = oldBodies[i];
      this.colliders[i] = oldColliders[i];
      this.controllers[i] = oldControllers[i];
      this.entityColliderHandles[i] = oldHandles[i];
    }

    const oldPrevX = this.prevPosX, oldPrevY = this.prevPosY, oldPrevZ = this.prevPosZ;
    const oldCurrX = this.currPosX, oldCurrY = this.currPosY, oldCurrZ = this.currPosZ;
    this.prevPosX = new Float32Array(this.capacity); this.prevPosX.set(oldPrevX);
    this.prevPosY = new Float32Array(this.capacity); this.prevPosY.set(oldPrevY);
    this.prevPosZ = new Float32Array(this.capacity); this.prevPosZ.set(oldPrevZ);
    this.currPosX = new Float32Array(this.capacity); this.currPosX.set(oldCurrX);
    this.currPosY = new Float32Array(this.capacity); this.currPosY.set(oldCurrY);
    this.currPosZ = new Float32Array(this.capacity); this.currPosZ.set(oldCurrZ);

    const oldPrevRX = this.prevRotX, oldPrevRY = this.prevRotY, oldPrevRZ = this.prevRotZ, oldPrevRW = this.prevRotW;
    const oldCurrRX = this.currRotX, oldCurrRY = this.currRotY, oldCurrRZ = this.currRotZ, oldCurrRW = this.currRotW;
    this.prevRotX = new Float32Array(this.capacity); this.prevRotX.set(oldPrevRX);
    this.prevRotY = new Float32Array(this.capacity); this.prevRotY.set(oldPrevRY);
    this.prevRotZ = new Float32Array(this.capacity); this.prevRotZ.set(oldPrevRZ);
    this.prevRotW = new Float32Array(this.capacity).fill(1); this.prevRotW.set(oldPrevRW);
    this.currRotX = new Float32Array(this.capacity); this.currRotX.set(oldCurrRX);
    this.currRotY = new Float32Array(this.capacity); this.currRotY.set(oldCurrRY);
    this.currRotZ = new Float32Array(this.capacity); this.currRotZ.set(oldCurrRZ);
    this.currRotW = new Float32Array(this.capacity).fill(1); this.currRotW.set(oldCurrRW);
  }

  async initRapier(): Promise<void> {
    await RAPIER.init();
    this.rapierWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.eventQueue = new RAPIER.EventQueue(true);
    this.initialized = true;
  }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
    this.rigidBodyStore = this.world.getStore(RigidBody);
    this.colliderStore = this.world.getStore(Collider);
    this.meshStore = this.world.getStore(MeshRenderer);
    this.velocityStore = this.world.getStore(Velocity);
    this.bodyQuery = this.world.query(Transform, RigidBody);
    this.collidableMeshQuery = this.world.query(Transform, MeshRenderer);

    this.rigidBodyStore.onRemove((eid) => {
      this.cleanupBody(eid);
    });
  }

  private cleanupBody(eid: number): void {
    const handles = this.entityColliderHandles[eid];
    if (handles) {
      for (let i = 0; i < handles.length; i++) {
        this.colliderToEntity.delete(handles[i]);
      }
      this.entityColliderHandles[eid] = null;
    }

    const body = this.bodies[eid];
    if (body) {
      this.rapierWorld.removeRigidBody(body);
      this.bodies[eid] = null;
    }
    this.colliders[eid] = null;

    const controller = this.controllers[eid];
    if (controller) {
      this.rapierWorld.removeCharacterController(controller);
      this.controllers[eid] = null;
    }
  }

  private trackCollider(eid: number, collider: RAPIER.Collider): void {
    let handles = this.entityColliderHandles[eid];
    if (!handles) {
      handles = [];
      this.entityColliderHandles[eid] = handles;
    }
    handles.push(collider.handle);
    this.colliderToEntity.set(collider.handle, eid);
  }

  addBody(
    eid: number,
    type: "dynamic" | "fixed" | "kinematic" = "dynamic",
    options: { canSleep?: boolean } = {}
  ): RAPIER.RigidBody {
    if (!this.initialized) throw new Error("PhysicsSystem not initialized");
    this.ensureCapacity(eid);

    const tx = this.transformStore.get(eid, "x");
    const ty = this.transformStore.get(eid, "y");
    const tz = this.transformStore.get(eid, "z");

    let desc: RAPIER.RigidBodyDesc;
    let bodyType: number;
    switch (type) {
      case "fixed":
        desc = RAPIER.RigidBodyDesc.fixed().setTranslation(tx, ty, tz);
        bodyType = 1;
        break;
      case "kinematic":
        desc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(tx, ty, tz);
        bodyType = 2;
        break;
      default:
        desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(tx, ty, tz);
        bodyType = 0;
    }

    if (options.canSleep === false) {
      desc.setCanSleep(false);
    }

    const body = this.rapierWorld.createRigidBody(desc);
    this.bodies[eid] = body;

    // Initialize interpolation state
    this.prevPosX[eid] = tx; this.prevPosY[eid] = ty; this.prevPosZ[eid] = tz;
    this.currPosX[eid] = tx; this.currPosY[eid] = ty; this.currPosZ[eid] = tz;
    const initialRot = body.rotation();
    this.prevRotX[eid] = initialRot.x; this.prevRotY[eid] = initialRot.y;
    this.prevRotZ[eid] = initialRot.z; this.prevRotW[eid] = initialRot.w;
    this.currRotX[eid] = initialRot.x; this.currRotY[eid] = initialRot.y;
    this.currRotZ[eid] = initialRot.z; this.currRotW[eid] = initialRot.w;

    // AUDIT fix: this used to unconditionally (re-)write mass/restitution/friction with
    // hardcoded defaults via world.addComponent(), which — because ComponentStore.add() only
    // writes fields the FIRST time an entity is registered — permanently locked in those
    // defaults whenever addBody() happened to be the thing that first created the RigidBody
    // component. A caller's later, more specific world.addComponent(eid, RigidBody, {...})
    // call would then silently no-op, so intents like mass:0 (density-derived) or a custom
    // restitution/friction could never actually take effect.
    //
    // Fix: never let addBody() be the one to "lock in" caller-owned physical values. If the
    // component already exists (the normal/expected flow — callers add RigidBody with their
    // intended values before calling addBody()), only update the fields addBody() itself
    // owns (bodyHandle/bodyType) via direct store.set(), which writes regardless of prior
    // registration. If it doesn't exist yet, DON'T create it with hardcoded values here —
    // leave that to the caller (or ensureMeshColliders(), which now creates it explicitly)
    // so their first, real world.addComponent() call is the one that sticks.
    if (this.rigidBodyStore.has(eid)) {
      this.rigidBodyStore.set(eid, "bodyHandle", body.handle);
      this.rigidBodyStore.set(eid, "bodyType", bodyType);
    }

    return body;
  }

  addCollider(
    eid: number,
    shape: "box" | "sphere" | "capsule" | "cylinder",
    params: { halfX?: number; halfY?: number; halfZ?: number; radius?: number; halfHeight?: number },
    collisionFilter?: CollisionFilter
  ): RAPIER.Collider {
    const body = this.bodies[eid];
    if (!body) throw new Error(`No rigid body on entity ${eid}`);

    let colliderDesc: RAPIER.ColliderDesc;
    let shapeType: number;

    switch (shape) {
      case "sphere":
        colliderDesc = RAPIER.ColliderDesc.ball(params.radius ?? 0.5);
        shapeType = 1;
        break;
      case "capsule":
        colliderDesc = RAPIER.ColliderDesc.capsule(params.halfHeight ?? 0.5, params.radius ?? 0.25);
        shapeType = 2;
        break;
      case "cylinder":
        colliderDesc = RAPIER.ColliderDesc.cylinder(params.halfHeight ?? 0.5, params.radius ?? 0.5);
        shapeType = 3;
        break;
      default:
        colliderDesc = RAPIER.ColliderDesc.cuboid(
          params.halfX ?? 0.5,
          params.halfY ?? 0.5,
          params.halfZ ?? 0.5
        );
        shapeType = 0;
    }

    const restitution = this.rigidBodyStore.has(eid) ? this.rigidBodyStore.get(eid, "restitution") : 0.3;
    const friction = this.rigidBodyStore.has(eid) ? this.rigidBodyStore.get(eid, "friction") : 0.5;
    const mass = this.rigidBodyStore.has(eid) ? (this.rigidBodyStore.get(eid, "mass") as number) : 0;

    colliderDesc.setRestitution(restitution);
    colliderDesc.setFriction(friction);
    colliderDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    // Without this, Rapier derives mass purely from collider volume x default density (1.0),
    // silently ignoring RigidBody.mass (e.g. per-bone ragdoll mass tuning in HumanoidFactory).
    if (mass > 0) {
      colliderDesc.setMass(mass);
    }

    if (collisionFilter) {
      colliderDesc.setCollisionGroups(
        (collisionFilter.membership & 0xFFFF) << 16 | (collisionFilter.filter & 0xFFFF)
      );
      colliderDesc.setSolverGroups(
        (collisionFilter.membership & 0xFFFF) << 16 | (collisionFilter.filter & 0xFFFF)
      );
    }

    const collider = this.rapierWorld.createCollider(colliderDesc, body);
    this.ensureCapacity(eid);
    // AUDIT fix: colliders[eid] is a single-slot "primary collider" pointer used by
    // getCollider(); trackCollider() already maintains the full per-entity handle list for
    // everything Rapier-facing (raycasts, overlaps, etc). Previously this unconditionally
    // overwrote the slot, so adding a second collider/trigger to an entity silently orphaned
    // the first one from getCollider()'s point of view even though Rapier kept simulating it.
    // Only claim the slot if nothing is there yet, so the first collider added stays the one
    // getCollider() resolves to.
    if (!this.colliders[eid]) {
      this.colliders[eid] = collider;
    }
    this.trackCollider(eid, collider);

    this.world.addComponent(eid, Collider, {
      colliderHandle: collider.handle,
      shapeType,
      halfX: params.halfX ?? 0.5,
      halfY: params.halfY ?? 0.5,
      halfZ: params.halfZ ?? 0.5,
      radius: params.radius ?? 0.5,
    });

    return collider;
  }

  ensureMeshColliders(): void {
    const entities = this.collidableMeshQuery.entities;
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (this.colliderStore.has(eid)) continue;
      if (this.meshStore.get(eid, "visible") === 0) continue;

      const meshRef = this.meshStore.get(eid, "meshRef") as THREE.Object3D | null;
      const bounds = this.getObjectHalfExtents(meshRef);
      if (!bounds) continue;

      if (!this.rigidBodyStore.has(eid)) {
        // addBody() no longer creates the RigidBody component with hardcoded defaults on
        // behalf of a caller (see AUDIT fix in addBody()) — since this is the one legitimate
        // "no one else will ever add it" path (auto-derived mesh colliders), create it here.
        this.world.addComponent(eid, RigidBody, {
          bodyType: 1, mass: 1, restitution: 0.3, friction: 0.5,
        });
        this.addBody(eid, "fixed");
      } else if (!this.bodies[eid]) {
        const bodyType = this.rigidBodyStore.get(eid, "bodyType");
        this.addBody(eid, bodyType === 0 ? "dynamic" : bodyType === 2 ? "kinematic" : "fixed");
      }

      this.addCollider(eid, "box", bounds);
    }
  }

  private getObjectHalfExtents(obj: THREE.Object3D | null): { halfX: number; halfY: number; halfZ: number } | null {
    if (!obj) return null;

    this.autoBounds.setFromObject(obj);
    if (this.autoBounds.isEmpty()) {
      const mesh = obj as THREE.Mesh;
      const geometry = mesh.geometry;
      if (!geometry) return null;

      if (!geometry.boundingBox) {
        geometry.computeBoundingBox();
      }
      if (!geometry.boundingBox) return null;
      this.autoBounds.copy(geometry.boundingBox);
    }

    this.autoBounds.getSize(this.autoSize);
    const halfX = Math.max(this.autoSize.x * 0.5, 0.01);
    const halfY = Math.max(this.autoSize.y * 0.5, 0.01);
    const halfZ = Math.max(this.autoSize.z * 0.5, 0.01);

    return { halfX, halfY, halfZ };
  }

  getBody(eid: number): RAPIER.RigidBody | undefined {
    return this.bodies[eid] ?? undefined;
  }

  getCollider(eid: number): RAPIER.Collider | undefined {
    return this.colliders[eid] ?? undefined;
  }

  removeBody(eid: number): void {
    this.cleanupBody(eid);
    if (this.world.hasComponent(eid, RigidBody)) {
      this.world.removeComponent(eid, RigidBody);
    }
    if (this.world.hasComponent(eid, Collider)) {
      this.world.removeComponent(eid, Collider);
    }
  }

  // ── Raycasting ──

  raycast(
    originX: number, originY: number, originZ: number,
    dirX: number, dirY: number, dirZ: number,
    maxDist: number,
    excludeEid?: number
  ): RaycastHit | null {
    if (!this.initialized) return null;
    const ray = new RAPIER.Ray({ x: originX, y: originY, z: originZ }, { x: dirX, y: dirY, z: dirZ });

    const excludeCollider = excludeEid !== undefined ? this.colliders[excludeEid] ?? undefined : undefined;

    const hit = this.rapierWorld.castRayAndGetNormal(
      ray, maxDist, true,
      undefined, undefined, excludeCollider, undefined, undefined
    );
    if (!hit) return null;

    const hitPoint = ray.pointAt(hit.timeOfImpact);
    const eid = this.colliderToEntity.get(hit.collider.handle) ?? -1;

    return {
      entityId: eid,
      point: hitPoint,
      normal: hit.normal,
      distance: hit.timeOfImpact,
    };
  }

  raycastAll(
    originX: number, originY: number, originZ: number,
    dirX: number, dirY: number, dirZ: number,
    maxDist: number
  ): RaycastHit[] {
    if (!this.initialized) return [];
    const results: RaycastHit[] = [];
    const ray = new RAPIER.Ray({ x: originX, y: originY, z: originZ }, { x: dirX, y: dirY, z: dirZ });

    this.rapierWorld.intersectionsWithRay(ray, maxDist, true, (hit) => {
      const hitPoint = ray.pointAt(hit.timeOfImpact);
      const eid = this.colliderToEntity.get(hit.collider.handle) ?? -1;
      results.push({
        entityId: eid,
        point: hitPoint,
        normal: hit.normal,
        distance: hit.timeOfImpact,
      });
      return true;
    });

    return results;
  }

  // ── Shape queries ──

  overlapSphere(cx: number, cy: number, cz: number, radius: number): number[] {
    if (!this.initialized) return [];
    const results: number[] = [];
    const shape = new RAPIER.Ball(radius);
    const pos = { x: cx, y: cy, z: cz };
    const rot = { x: 0, y: 0, z: 0, w: 1 };

    this.rapierWorld.intersectionsWithShape(pos, rot, shape, (collider) => {
      const eid = this.colliderToEntity.get(collider.handle);
      if (eid !== undefined) results.push(eid);
      return true;
    });

    return results;
  }

  overlapBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): number[] {
    if (!this.initialized) return [];
    const results: number[] = [];
    const shape = new RAPIER.Cuboid(hx, hy, hz);
    const pos = { x: cx, y: cy, z: cz };
    const rot = { x: 0, y: 0, z: 0, w: 1 };

    this.rapierWorld.intersectionsWithShape(pos, rot, shape, (collider) => {
      const eid = this.colliderToEntity.get(collider.handle);
      if (eid !== undefined) results.push(eid);
      return true;
    });

    return results;
  }

  // ── Collision callbacks ──

  onCollisionStart(cb: CollisionCallback): () => void {
    this.collisionStartCallbacks.push(cb);
    return () => {
      const idx = this.collisionStartCallbacks.indexOf(cb);
      if (idx !== -1) this.collisionStartCallbacks.splice(idx, 1);
    };
  }

  onCollisionEnd(cb: CollisionCallback): () => void {
    this.collisionEndCallbacks.push(cb);
    return () => {
      const idx = this.collisionEndCallbacks.indexOf(cb);
      if (idx !== -1) this.collisionEndCallbacks.splice(idx, 1);
    };
  }

  onTriggerEnter(cb: TriggerCallback): () => void {
    this.triggerEnterCallbacks.push(cb);
    return () => {
      const idx = this.triggerEnterCallbacks.indexOf(cb);
      if (idx !== -1) this.triggerEnterCallbacks.splice(idx, 1);
    };
  }

  onTriggerExit(cb: TriggerCallback): () => void {
    this.triggerExitCallbacks.push(cb);
    return () => {
      const idx = this.triggerExitCallbacks.indexOf(cb);
      if (idx !== -1) this.triggerExitCallbacks.splice(idx, 1);
    };
  }

  // ── Triggers ──

  addTrigger(
    eid: number,
    shape: "box" | "sphere",
    params: { halfX?: number; halfY?: number; halfZ?: number; radius?: number },
    collisionFilter?: CollisionFilter
  ): RAPIER.Collider {
    const body = this.bodies[eid];
    if (!body) throw new Error(`No rigid body on entity ${eid}`);

    let desc: RAPIER.ColliderDesc;
    if (shape === "sphere") {
      desc = RAPIER.ColliderDesc.ball(params.radius ?? 1);
    } else {
      desc = RAPIER.ColliderDesc.cuboid(params.halfX ?? 1, params.halfY ?? 1, params.halfZ ?? 1);
    }
    desc.setSensor(true);
    desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    if (collisionFilter) {
      desc.setCollisionGroups(
        (collisionFilter.membership & 0xFFFF) << 16 | (collisionFilter.filter & 0xFFFF)
      );
    }

    const collider = this.rapierWorld.createCollider(desc, body);
    this.trackCollider(eid, collider);
    return collider;
  }

  // ── Joints ──

  createFixedJoint(
    eidA: number, eidB: number,
    anchorA: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
    anchorB: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }
  ): number {
    const bodyA = this.bodies[eidA];
    const bodyB = this.bodies[eidB];
    if (!bodyA || !bodyB) throw new Error("Both entities must have rigid bodies");

    const params = RAPIER.JointData.fixed(
      anchorA, { x: 0, y: 0, z: 0, w: 1 },
      anchorB, { x: 0, y: 0, z: 0, w: 1 }
    );
    const joint = this.rapierWorld.createImpulseJoint(params, bodyA, bodyB, true);
    const id = this.nextJointId++;
    this.jointMap.set(id, joint);
    return id;
  }

  createRevoluteJoint(
    eidA: number, eidB: number,
    axisX: number, axisY: number, axisZ: number,
    anchorA: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
    anchorB: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }
  ): number {
    const bodyA = this.bodies[eidA];
    const bodyB = this.bodies[eidB];
    if (!bodyA || !bodyB) throw new Error("Both entities must have rigid bodies");

    const params = RAPIER.JointData.revolute(anchorA, anchorB, { x: axisX, y: axisY, z: axisZ });
    const joint = this.rapierWorld.createImpulseJoint(params, bodyA, bodyB, true);
    const id = this.nextJointId++;
    this.jointMap.set(id, joint);
    return id;
  }

  createPrismaticJoint(
    eidA: number, eidB: number,
    axisX: number, axisY: number, axisZ: number,
    anchorA: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
    anchorB: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }
  ): number {
    const bodyA = this.bodies[eidA];
    const bodyB = this.bodies[eidB];
    if (!bodyA || !bodyB) throw new Error("Both entities must have rigid bodies");

    const params = RAPIER.JointData.prismatic(anchorA, anchorB, { x: axisX, y: axisY, z: axisZ });
    const joint = this.rapierWorld.createImpulseJoint(params, bodyA, bodyB, true);
    const id = this.nextJointId++;
    this.jointMap.set(id, joint);
    return id;
  }

  createSphericalJoint(
    eidA: number, eidB: number,
    anchorA: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
    anchorB: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }
  ): number {
    const bodyA = this.bodies[eidA];
    const bodyB = this.bodies[eidB];
    if (!bodyA || !bodyB) throw new Error("Both entities must have rigid bodies");

    const params = RAPIER.JointData.spherical(anchorA, anchorB);
    const joint = this.rapierWorld.createImpulseJoint(params, bodyA, bodyB, true);
    const id = this.nextJointId++;
    this.jointMap.set(id, joint);
    return id;
  }

  getJoint(jointId: number): RAPIER.ImpulseJoint | undefined {
    return this.jointMap.get(jointId);
  }

  getBodyByHandle(handle: number): RAPIER.RigidBody | undefined {
    return this.rapierWorld?.getRigidBody(handle) ?? undefined;
  }

  removeJoint(jointId: number): void {
    const joint = this.jointMap.get(jointId);
    if (joint) {
      this.rapierWorld.removeImpulseJoint(joint, true);
      this.jointMap.delete(jointId);
    }
  }

  // ── Character controller ──

  createCharacterController(eid: number, config: CharacterControllerConfig): void {
    if (!this.initialized) throw new Error("PhysicsSystem not initialized");
    this.ensureCapacity(eid);
    const controller = this.rapierWorld.createCharacterController(config.skinWidth);
    controller.setMaxSlopeClimbAngle(config.maxSlope);
    controller.setMinSlopeSlideAngle(config.maxSlope + 0.1);
    if (config.stepHeight > 0) {
      controller.enableAutostep(config.stepHeight, 0, false);
    }
    controller.enableSnapToGround(config.stepHeight * 2);
    this.controllers[eid] = controller;
  }

  moveCharacter(eid: number, dx: number, dy: number, dz: number, dt: number): CharacterMoveResult {
    const controller = this.controllers[eid];
    const collider = this.colliders[eid];
    if (!controller || !collider) return { grounded: false };

    controller.computeColliderMovement(collider, { x: dx, y: dy, z: dz });

    const movement = controller.computedMovement();
    const body = this.bodies[eid];
    if (body) {
      const pos = body.translation();
      const newX = pos.x + movement.x;
      const newY = pos.y + movement.y;
      const newZ = pos.z + movement.z;
      body.setNextKinematicTranslation({ x: newX, y: newY, z: newZ });

      // Sync character controller position back to ECS Transform
      const tx = this.transformStore.getColumn("x");
      const ty = this.transformStore.getColumn("y");
      const tz = this.transformStore.getColumn("z");
      tx[eid] = newX;
      ty[eid] = newY;
      tz[eid] = newZ;
    }

    return {
      grounded: controller.computedGrounded(),
    };
  }

  removeCharacterController(eid: number): void {
    const controller = this.controllers[eid];
    if (controller) {
      this.rapierWorld.removeCharacterController(controller);
      this.controllers[eid] = null;
    }
  }

  wakeNearby(x: number, y: number, z: number, radius: number): void {
    const entities = this.bodyQuery.entities;
    for (let i = 0; i < entities.length; i++) {
      const body = this.bodies[entities[i]];
      if (!body || !body.isDynamic()) continue;
      const pos = body.translation();
      const dx = pos.x - x;
      const dy = pos.y - y;
      const dz = pos.z - z;
      if (dx * dx + dy * dy + dz * dz < radius * radius) {
        body.wakeUp();
      }
    }
  }

  getInterpolatedPosition(eid: number): { x: number; y: number; z: number } {
    const a = this._interpolationAlpha;
    return {
      x: this.prevPosX[eid] + (this.currPosX[eid] - this.prevPosX[eid]) * a,
      y: this.prevPosY[eid] + (this.currPosY[eid] - this.prevPosY[eid]) * a,
      z: this.prevPosZ[eid] + (this.currPosZ[eid] - this.prevPosZ[eid]) * a,
    };
  }

  update(dt: number): void {
    if (!this.initialized) return;

    const entities = this.bodyQuery.entities;
    const tx = this.transformStore.getColumn("x");
    const ty = this.transformStore.getColumn("y");
    const tz = this.transformStore.getColumn("z");
    const trx = this.transformStore.getColumn("rx");
    const trY = this.transformStore.getColumn("ry");
    const trz = this.transformStore.getColumn("rz");

    // ECS → Rapier: sync kinematic bodies from ECS Transform
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const body = this.bodies[eid];
      if (!body) continue;

      if (body.isKinematic() && !this.controllers[eid]) {
        body.setNextKinematicTranslation({ x: tx[eid], y: ty[eid], z: tz[eid] });
        const rot = eulerToQuaternion(trx[eid], trY[eid], trz[eid]);
        body.setNextKinematicRotation(rot);
      }
    }

    // Fixed timestep accumulation
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      // Snapshot current positions/rotations as "previous" before stepping
      for (let i = 0; i < entities.length; i++) {
        const eid = entities[i];
        const body = this.bodies[eid];
        if (!body || body.isFixed() || !body.isEnabled() || body.isSleeping()) continue;
        this.ensureCapacity(eid);
        const pos = body.translation();
        this.prevPosX[eid] = pos.x;
        this.prevPosY[eid] = pos.y;
        this.prevPosZ[eid] = pos.z;
        const rot = body.rotation();
        this.prevRotX[eid] = rot.x;
        this.prevRotY[eid] = rot.y;
        this.prevRotZ[eid] = rot.z;
        this.prevRotW[eid] = rot.w;
      }

      this.rapierWorld.step(this.eventQueue);
      this.accumulator -= this.fixedStep;
      steps++;

      // Snapshot new positions/rotations as "current"
      for (let i = 0; i < entities.length; i++) {
        const eid = entities[i];
        const body = this.bodies[eid];
        if (!body || body.isFixed() || !body.isEnabled() || body.isSleeping()) continue;
        const pos = body.translation();
        this.currPosX[eid] = pos.x;
        this.currPosY[eid] = pos.y;
        this.currPosZ[eid] = pos.z;
        const rot = body.rotation();
        this.currRotX[eid] = rot.x;
        this.currRotY[eid] = rot.y;
        this.currRotZ[eid] = rot.z;
        this.currRotW[eid] = rot.w;
      }
    }
    // AUDIT fix: this used to unconditionally zero the accumulator whenever the substep cap
    // was hit (`if (steps >= this.maxSubSteps) this.accumulator = 0;`), silently discarding
    // whatever leftover simulation time hadn't been consumed yet. That made the same total
    // elapsed wall-clock time simulate a different number of physics steps depending on how
    // it was chopped into frames/calls — not reproducible / not frame-rate independent.
    // Simply leaving the leftover in place (instead of resetting it) carries it into the
    // next update() call so it still eventually gets simulated, converging on the same
    // result regardless of call granularity.

    // Compute interpolation alpha from remaining accumulator
    this._interpolationAlpha = this.accumulator / this.fixedStep;

    // Process collision events with entity validation
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      const eidA = this.colliderToEntity.get(h1) ?? -1;
      const eidB = this.colliderToEntity.get(h2) ?? -1;

      // Skip events where either entity is unmapped or destroyed
      if (eidA < 0 || eidB < 0) return;
      if (!this.world.isAlive(eidA) || !this.world.isAlive(eidB)) return;

      const c1 = this.rapierWorld.getCollider(h1);
      const c2 = this.rapierWorld.getCollider(h2);
      const isTrigger = (c1 && c1.isSensor()) || (c2 && c2.isSensor());

      if (isTrigger) {
        const cbs = started ? this.triggerEnterCallbacks : this.triggerExitCallbacks;
        for (let i = 0; i < cbs.length; i++) {
          try { cbs[i](eidA, eidB); } catch (e) {
            console.error("[AGEE] Trigger callback threw:", e);
          }
        }
      } else {
        const cbs = started ? this.collisionStartCallbacks : this.collisionEndCallbacks;
        const event: CollisionEvent = { entityA: eidA, entityB: eidB, started };
        for (let i = 0; i < cbs.length; i++) {
          try { cbs[i](event); } catch (e) {
            console.error("[AGEE] Collision callback threw:", e);
          }
        }
      }
    });

    // Rapier → ECS: sync dynamic and kinematic body state
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const body = this.bodies[eid];
      if (!body || body.isFixed() || !body.isEnabled() || body.isSleeping()) continue;

      // Interpolated position for rendering
      const a = this._interpolationAlpha;
      tx[eid] = this.prevPosX[eid] + (this.currPosX[eid] - this.prevPosX[eid]) * a;
      ty[eid] = this.prevPosY[eid] + (this.currPosY[eid] - this.prevPosY[eid]) * a;
      tz[eid] = this.prevPosZ[eid] + (this.currPosZ[eid] - this.prevPosZ[eid]) * a;

      // AUDIT fix: rotation used to be assigned straight from the latest body.rotation(),
      // ignoring interpolationAlpha entirely — a rotating body's Transform would visibly
      // "pop" between physics steps instead of interpolating smoothly like position does.
      // Slerp between the previous and current step's rotation by the same alpha used above.
      this._tmpPrevQuat.set(this.prevRotX[eid], this.prevRotY[eid], this.prevRotZ[eid], this.prevRotW[eid]);
      this._tmpCurrQuat.set(this.currRotX[eid], this.currRotY[eid], this.currRotZ[eid], this.currRotW[eid]);
      this._tmpPrevQuat.slerp(this._tmpCurrQuat, a);
      quaternionToEuler(this._tmpPrevQuat.x, this._tmpPrevQuat.y, this._tmpPrevQuat.z, this._tmpPrevQuat.w, eulerOut);
      trx[eid] = eulerOut[0];
      trY[eid] = eulerOut[1];
      trz[eid] = eulerOut[2];

      // Populate Velocity component if present
      if (this.velocityStore.has(eid)) {
        const linvel = body.linvel();
        const angvel = body.angvel();
        this.velocityStore.set(eid, "vx", linvel.x);
        this.velocityStore.set(eid, "vy", linvel.y);
        this.velocityStore.set(eid, "vz", linvel.z);
        this.velocityStore.set(eid, "ax", angvel.x);
        this.velocityStore.set(eid, "ay", angvel.y);
        this.velocityStore.set(eid, "az", angvel.z);
      }
    }
  }

  destroy(): void {
    if (this.initialized) {
      this.rapierWorld.free();
    }
  }
}

const eulerOut = new Float32Array(3);

function quaternionToEuler(
  qx: number, qy: number, qz: number, qw: number,
  out: Float32Array
): void {
  const sinrCosp = 2 * (qw * qx + qy * qz);
  const cosrCosp = 1 - 2 * (qx * qx + qy * qy);
  out[0] = Math.atan2(sinrCosp, cosrCosp);

  const sinp = 2 * (qw * qy - qz * qx);
  out[1] = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);

  const sinyCosp = 2 * (qw * qz + qx * qy);
  const cosyCosp = 1 - 2 * (qy * qy + qz * qz);
  out[2] = Math.atan2(sinyCosp, cosyCosp);
}

function eulerToQuaternion(
  rx: number, ry: number, rz: number
): { x: number; y: number; z: number; w: number } {
  const cx = Math.cos(rx * 0.5), sx = Math.sin(rx * 0.5);
  const cy = Math.cos(ry * 0.5), sy = Math.sin(ry * 0.5);
  const cz = Math.cos(rz * 0.5), sz = Math.sin(rz * 0.5);
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}
