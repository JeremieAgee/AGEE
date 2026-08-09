import { System, World, ComponentStore, defineComponent } from "../ecs";
import { Transform } from "../core/Components";
import { SpatialHash } from "../core/spatial/SpatialHash";
import { dsqrt, dsin, dcos, datan2, dmin, SeededRNG } from "../core/DeterministicMath";

export const SteeringAgent = defineComponent("SteeringAgent", {
  maxSpeed: "f32",
  maxForce: "f32",
  mass: "f32",
  vx: "f32",
  vy: "f32",
  vz: "f32",
  steerX: "f32",
  steerY: "f32",
  steerZ: "f32",
  behaviors: "i32",
  wanderAngle: "f32",
  wanderRadius: "f32",
  wanderDistance: "f32",
  wanderJitter: "f32",
  arriveRadius: "f32",
  slowRadius: "f32",
  targetX: "f32",
  targetY: "f32",
  targetZ: "f32",
  targetEid: "i32",
  avoidDistance: "f32",
  neighborRadius: "f32",
  separationWeight: "f32",
  alignmentWeight: "f32",
  cohesionWeight: "f32",
  groupId: "i32",
});

export const enum SteeringFlag {
  Seek          = 1 << 0,
  Flee          = 1 << 1,
  Arrive        = 1 << 2,
  Wander        = 1 << 3,
  Pursue        = 1 << 4,
  Evade         = 1 << 5,
  /** Declared but not implemented in SteeringSystem.update() — there's no obstacle data
   *  source (registry/spatial query) wired into this component yet for it to avoid against.
   *  Setting this flag currently has no effect; needs an obstacle-list/query design before
   *  it can do anything. */
  ObstacleAvoid = 1 << 6,
  Separation    = 1 << 7,
  Alignment     = 1 << 8,
  Cohesion      = 1 << 9,
}

export class SteeringSystem extends System {
  priority = 25;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "prePhysics";

  static reads = ["Transform", "SteeringAgent"];
  static writes = ["Transform", "SteeringAgent"];

  private steerStore!: ComponentStore;
  private transformStore!: ComponentStore;
  private query!: ReturnType<World["query"]>;

  // Spatial partition for the flocking (Separation/Alignment/Cohesion) neighbor search --
  // previously an all-pairs O(n^2) scan with no use of the engine's SpatialHash. Rebuilt
  // once per update() (positions move every frame) and queried per-entity instead of
  // looping over every other steering entity.
  private static readonly FLOCK_CELL_SIZE = 3;
  private flockHash = new SpatialHash(SteeringSystem.FLOCK_CELL_SIZE);
  private flockHashBuilt = false;
  private flockCandidates: number[] = [];

  // Fixed-timestep accumulator, matching PhysicsSystem's model: without this, steering
  // integrated position/velocity directly against the variable per-frame dt, so identical
  // elapsed wall-clock time produced different simulated results depending on how it was
  // chopped into frames — breaking determinism for anything relying on it (multiplayer
  // reconciliation, replays). Stepping in fixed FIXED_STEP increments makes the outcome only
  // depend on total elapsed time, not frame timing.
  private static readonly FIXED_STEP = 1 / 60;
  private static readonly MAX_SUBSTEPS = 8;
  private accumulator = 0;

  // Deterministic in place of Math.random(): the wander behavior mutates simulation
  // state, so an unseeded RNG source would make two clients replaying identical inputs
  // diverge. Seeded fixed so the same input stream reproduces the same wander path.
  private wanderRng = new SeededRNG(0x5eed1e5);

  init(): void {
    this.steerStore = this.world.getStore(SteeringAgent);
    this.transformStore = this.world.getStore(Transform);
    this.query = this.world.query(SteeringAgent, Transform);
  }

  update(dt: number): void {
    const entities = this.query.entities;
    if (entities.length === 0) return;

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= SteeringSystem.FIXED_STEP && steps < SteeringSystem.MAX_SUBSTEPS) {
      this.stepOnce(entities, SteeringSystem.FIXED_STEP);
      this.accumulator -= SteeringSystem.FIXED_STEP;
      steps++;
    }
  }

  private stepOnce(entities: number[], dt: number): void {
    this.flockHashBuilt = false;

    const tx = this.transformStore.getColumn("x");
    const ty = this.transformStore.getColumn("y");
    const tz = this.transformStore.getColumn("z");
    const ry = this.transformStore.getColumn("ry");

    const maxSpeeds = this.steerStore.getColumn("maxSpeed");
    const maxForces = this.steerStore.getColumn("maxForce");
    const masses = this.steerStore.getColumn("mass");
    const vxs = this.steerStore.getColumn("vx");
    const vys = this.steerStore.getColumn("vy");
    const vzs = this.steerStore.getColumn("vz");
    const sxs = this.steerStore.getColumn("steerX");
    const sys = this.steerStore.getColumn("steerY");
    const szs = this.steerStore.getColumn("steerZ");
    const behaviorFlags = this.steerStore.getColumn("behaviors");
    const wanderAngles = this.steerStore.getColumn("wanderAngle");
    const wanderRadii = this.steerStore.getColumn("wanderRadius");
    const wanderDists = this.steerStore.getColumn("wanderDistance");
    const wanderJitters = this.steerStore.getColumn("wanderJitter");
    const arriveRadii = this.steerStore.getColumn("arriveRadius");
    const slowRadii = this.steerStore.getColumn("slowRadius");
    const tgtXs = this.steerStore.getColumn("targetX");
    const tgtYs = this.steerStore.getColumn("targetY");
    const tgtZs = this.steerStore.getColumn("targetZ");
    const tgtEids = this.steerStore.getColumn("targetEid");
    const avoidDists = this.steerStore.getColumn("avoidDistance");
    const neighborRadii = this.steerStore.getColumn("neighborRadius");
    const sepWeights = this.steerStore.getColumn("separationWeight");
    const aliWeights = this.steerStore.getColumn("alignmentWeight");
    const cohWeights = this.steerStore.getColumn("cohesionWeight");
    const groupIds = this.steerStore.getColumn("groupId");

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const flags = behaviorFlags[eid];
      if (flags === 0) continue;

      let fx = 0, fy = 0, fz = 0;
      const px = tx[eid], py = ty[eid], pz = tz[eid];
      const maxF = maxForces[eid];
      const maxS = maxSpeeds[eid];

      if (flags & SteeringFlag.Seek) {
        const dx = tgtXs[eid] - px, dy = tgtYs[eid] - py, dz = tgtZs[eid] - pz;
        const dist = dsqrt(dx * dx + dy * dy + dz * dz);
        if (dist > 0.001) {
          const s = maxS / dist;
          fx += dx * s - vxs[eid];
          fy += dy * s - vys[eid];
          fz += dz * s - vzs[eid];
        }
      }

      if (flags & SteeringFlag.Flee) {
        const dx = px - tgtXs[eid], dy = py - tgtYs[eid], dz = pz - tgtZs[eid];
        const dist = dsqrt(dx * dx + dy * dy + dz * dz);
        if (dist > 0.001) {
          const s = maxS / dist;
          fx += dx * s - vxs[eid];
          fy += dy * s - vys[eid];
          fz += dz * s - vzs[eid];
        }
      }

      if (flags & SteeringFlag.Arrive) {
        const dx = tgtXs[eid] - px, dy = tgtYs[eid] - py, dz = tgtZs[eid] - pz;
        const dist = dsqrt(dx * dx + dy * dy + dz * dz);
        if (dist > arriveRadii[eid]) {
          let desiredSpeed = maxS;
          const slow = slowRadii[eid];
          if (dist < slow) desiredSpeed = maxS * (dist / slow);
          const s = desiredSpeed / dist;
          fx += dx * s - vxs[eid];
          fy += dy * s - vys[eid];
          fz += dz * s - vzs[eid];
        } else {
          fx -= vxs[eid];
          fy -= vys[eid];
          fz -= vzs[eid];
        }
      }

      if (flags & SteeringFlag.Wander) {
        wanderAngles[eid] += (this.wanderRng.next() - 0.5) * wanderJitters[eid];
        const wr = wanderRadii[eid];
        const wd = wanderDists[eid];
        const speed = dsqrt(vxs[eid] * vxs[eid] + vzs[eid] * vzs[eid]);
        let headX = 0, headZ = 1;
        if (speed > 0.001) {
          headX = vxs[eid] / speed;
          headZ = vzs[eid] / speed;
        }
        const circX = px + headX * wd;
        const circZ = pz + headZ * wd;
        const angle = wanderAngles[eid];
        const targX = circX + dcos(angle) * wr;
        const targZ = circZ + dsin(angle) * wr;
        const dx = targX - px, dz = targZ - pz;
        const d = dsqrt(dx * dx + dz * dz);
        if (d > 0.001) {
          fx += (dx / d) * maxS - vxs[eid];
          fz += (dz / d) * maxS - vzs[eid];
        }
      }

      if (flags & SteeringFlag.Pursue) {
        const tEid = tgtEids[eid];
        if (tEid >= 0) {
          const tpx = tx[tEid], tpy = ty[tEid], tpz = tz[tEid];
          let tvx = 0, tvz = 0;
          if (this.steerStore.has(tEid)) {
            tvx = vxs[tEid];
            tvz = vzs[tEid];
          }
          const dx = tpx - px, dz = tpz - pz;
          const dist = dsqrt(dx * dx + dz * dz);
          const lookAhead = dist / (maxS + dsqrt(tvx * tvx + tvz * tvz) + 0.001);
          const predX = tpx + tvx * lookAhead;
          const predZ = tpz + tvz * lookAhead;
          const ddx = predX - px, ddz = predZ - pz;
          const dd = dsqrt(ddx * ddx + ddz * ddz);
          if (dd > 0.001) {
            fx += (ddx / dd) * maxS - vxs[eid];
            fz += (ddz / dd) * maxS - vzs[eid];
          }
        }
      }

      if (flags & SteeringFlag.Evade) {
        const tEid = tgtEids[eid];
        if (tEid >= 0) {
          const tpx = tx[tEid], tpz = tz[tEid];
          let tvx = 0, tvz = 0;
          if (this.steerStore.has(tEid)) {
            tvx = vxs[tEid];
            tvz = vzs[tEid];
          }
          const dx = tpx - px, dz = tpz - pz;
          const dist = dsqrt(dx * dx + dz * dz);
          const lookAhead = dist / (maxS + dsqrt(tvx * tvx + tvz * tvz) + 0.001);
          const predX = tpx + tvx * lookAhead;
          const predZ = tpz + tvz * lookAhead;
          const ddx = px - predX, ddz = pz - predZ;
          const dd = dsqrt(ddx * ddx + ddz * ddz);
          if (dd > 0.001) {
            fx += (ddx / dd) * maxS - vxs[eid];
            fz += (ddz / dd) * maxS - vzs[eid];
          }
        }
      }

      if (flags & (SteeringFlag.Separation | SteeringFlag.Alignment | SteeringFlag.Cohesion)) {
        let sepX = 0, sepZ = 0;
        let aliX = 0, aliZ = 0;
        let cohX = 0, cohZ = 0;
        let neighborCount = 0;
        const nRadius = neighborRadii[eid];
        const nRadiusSq = nRadius * nRadius;
        const myGroup = groupIds[eid];

        // Build the spatial hash lazily, once per update(), only if some entity actually
        // needs flocking this frame -- rebuilt every frame since positions move.
        if (!this.flockHashBuilt) {
          this.flockHash.clear();
          for (let k = 0; k < entities.length; k++) {
            const e = entities[k];
            this.flockHash.insert(e, tx[e], tz[e]);
          }
          this.flockHashBuilt = true;
        }

        // Query only nearby cells instead of scanning every other steering entity. The
        // search radius is capped at the cell size so a pathologically large neighborRadius
        // can't blow up the number of cells visited; the exact distSq check below still
        // enforces the real neighborRadius against whatever candidates were found.
        const searchRadius = dmin(nRadius, SteeringSystem.FLOCK_CELL_SIZE);
        const candidates = this.flockHash.queryRadius(px, pz, searchRadius, this.flockCandidates);

        for (let j = 0; j < candidates.length; j++) {
          const other = candidates[j];
          if (other === eid) continue;
          if (groupIds[other] !== myGroup) continue;

          const dx = tx[other] - px, dz = tz[other] - pz;
          const distSq = dx * dx + dz * dz;
          if (distSq > nRadiusSq || distSq < 0.0001) continue;

          neighborCount++;
          const dist = dsqrt(distSq);

          if (flags & SteeringFlag.Separation) {
            // Unit vector (dx/dist) scaled again by 1/dist, so repulsion strength actually
            // falls off with distance — the previous dx/dist alone is just the unit vector,
            // making a neighbor at the edge of neighborRadius push exactly as hard as one
            // nearly overlapping.
            sepX -= dx / distSq;
            sepZ -= dz / distSq;
          }
          if (flags & SteeringFlag.Alignment) {
            aliX += vxs[other];
            aliZ += vzs[other];
          }
          if (flags & SteeringFlag.Cohesion) {
            cohX += tx[other];
            cohZ += tz[other];
          }
        }

        if (neighborCount > 0) {
          if (flags & SteeringFlag.Separation) {
            fx += sepX * sepWeights[eid];
            fz += sepZ * sepWeights[eid];
          }
          if (flags & SteeringFlag.Alignment) {
            aliX /= neighborCount;
            aliZ /= neighborCount;
            fx += (aliX - vxs[eid]) * aliWeights[eid];
            fz += (aliZ - vzs[eid]) * aliWeights[eid];
          }
          if (flags & SteeringFlag.Cohesion) {
            cohX = cohX / neighborCount - px;
            cohZ = cohZ / neighborCount - pz;
            fx += cohX * cohWeights[eid];
            fz += cohZ * cohWeights[eid];
          }
        }
      }

      // Truncate to max force
      const fMag = dsqrt(fx * fx + fy * fy + fz * fz);
      if (fMag > maxF) {
        const s = maxF / fMag;
        fx *= s; fy *= s; fz *= s;
      }

      sxs[eid] = fx;
      sys[eid] = fy;
      szs[eid] = fz;

      // Apply force: acceleration = force / mass
      const m = masses[eid] || 1;
      vxs[eid] += (fx / m) * dt;
      vys[eid] += (fy / m) * dt;
      vzs[eid] += (fz / m) * dt;

      // Clamp velocity to maxSpeed
      const speed = dsqrt(vxs[eid] * vxs[eid] + vys[eid] * vys[eid] + vzs[eid] * vzs[eid]);
      if (speed > maxS) {
        const clamp = maxS / speed;
        vxs[eid] *= clamp;
        vys[eid] *= clamp;
        vzs[eid] *= clamp;
      }

      // Update position
      tx[eid] += vxs[eid] * dt;
      ty[eid] += vys[eid] * dt;
      tz[eid] += vzs[eid] * dt;

      // Face movement direction
      if (speed > 0.01) {
        ry[eid] = datan2(vxs[eid], vzs[eid]);
      }
    }
  }
}
