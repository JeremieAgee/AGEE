import { System } from "./System";
import type { SystemPhase } from "./System";
import type { EngineProfiler } from "../core/EngineProfiler";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SystemConstraint {
  system: string; // constructor name
  before?: string[];
  after?: string[];
}

export interface ExecutionStage {
  index: number;
  systems: System[];
}

export interface ExecutionPlan {
  phases: Map<SystemPhase, ExecutionStage[]>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return the static reads/writes arrays for a System instance. */
function getDeclarations(sys: System): { reads: string[]; writes: string[] } {
  const ctor = sys.constructor as typeof System;
  return {
    reads: ctor.reads ?? [],
    writes: ctor.writes ?? [],
  };
}

/** True when two systems conflict on at least one component. */
function hasConflict(a: System, b: System): boolean {
  const da = getDeclarations(a);
  const db = getDeclarations(b);

  const aOpaque = da.reads.length === 0 && da.writes.length === 0;
  const bOpaque = db.reads.length === 0 && db.writes.length === 0;

  // Opaque systems conflict with everything (conservative).
  if (aOpaque || bOpaque) return true;

  // write/write or read/write on same component = conflict.
  for (const w of da.writes) {
    if (db.writes.includes(w)) return true;
    if (db.reads.includes(w)) return true;
  }
  for (const w of db.writes) {
    if (da.reads.includes(w)) return true;
    // write/write already checked above
  }

  return false;
}

// ---------------------------------------------------------------------------
// SystemScheduler
// ---------------------------------------------------------------------------

// Builds a dependency-ordered, conflict-free stage plan from each system's declared
// reads/writes (plus explicit before/after constraints), then executes it sequentially on the
// main thread. The stage partition is not a concurrency mechanism today: every system here
// holds live references to the World, Three.js objects, the GPU device, and/or the Rapier WASM
// instance, none of which can cross a Web Worker boundary without those systems first being
// restructured into pure, transferable-data kernels — a much larger change than this scheduler.
// What the partition buys instead: systems within the same stage are provably safe to run in
// any order (or, if that restructuring ever happens, concurrently) because buildStagesForPhase
// guarantees no two of them read/write the same component. `execute()` runs them in a plain
// nested loop deliberately, not as a stand-in for real parallelism.
export class SystemScheduler {
  private constraints: SystemConstraint[] = [];
  private plan: ExecutionPlan | null = null;
  private dirty = true;
  private profiler: EngineProfiler | null = null;

  // Track the last system set so we can detect changes.
  private lastSystemIds: string | null = null;

  setProfiler(profiler: EngineProfiler): void {
    this.profiler = profiler;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  addConstraint(constraint: SystemConstraint): void {
    this.constraints.push(constraint);
    this.dirty = true;
  }

  buildPlan(systems: System[], phaseOrder: SystemPhase[]): ExecutionPlan {
    const phases = new Map<SystemPhase, ExecutionStage[]>();

    // Bucket systems by phase.
    const buckets = new Map<SystemPhase, System[]>();
    for (const ph of phaseOrder) buckets.set(ph, []);
    for (const sys of systems) {
      let bucket = buckets.get(sys.phase);
      if (!bucket) {
        bucket = [];
        buckets.set(sys.phase, bucket);
      }
      bucket.push(sys);
    }

    for (const ph of phaseOrder) {
      const phaseSystems = buckets.get(ph) ?? [];
      phases.set(ph, this.buildStagesForPhase(phaseSystems));
    }

    this.plan = { phases };
    this.dirty = false;
    this.lastSystemIds = this.systemFingerprint(systems);
    return this.plan;
  }

  getPlan(systems: System[], phaseOrder: SystemPhase[]): ExecutionPlan {
    const fp = this.systemFingerprint(systems);
    if (!this.dirty && this.plan && this.lastSystemIds === fp) {
      return this.plan;
    }
    return this.buildPlan(systems, phaseOrder);
  }

  // Sequential by design — see the class comment above for why stages don't dispatch to
  // workers. Systems within a stage are conflict-free, so this loop's ordering among them is
  // arbitrary and safe; it does not need to be (and today cannot safely be) concurrent.
  execute(plan: ExecutionPlan, dt: number): void {
    const p = this.profiler;
    for (const [, stages] of plan.phases) {
      for (const stage of stages) {
        for (const sys of stage.systems) {
          if (!sys.active || !sys.enabled) continue;
          const name = sys.constructor.name;
          try {
            if (p) p.beginSystem(name);
            sys.update(dt);
            if (p) p.endSystem(name);
          } catch (err) {
            if (p) p.endSystem(name);
            console.error(
              `[SystemScheduler] Error in system "${name}" (stage ${stage.index}):`,
              err,
            );
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Build execution stages for a single phase.
   *
   * 1. Sort by priority (ascending).
   * 2. Build a DAG from data-dependency conflicts + explicit constraints.
   * 3. Topological sort (Kahn's) with cycle detection.
   * 4. Partition the linear order into stages where systems within the same
   *    stage have no data conflicts.
   */
  private buildStagesForPhase(systems: System[]): ExecutionStage[] {
    if (systems.length === 0) return [];

    // 1. Sort by priority (stable) ------------------------------------------
    systems = [...systems].sort((a, b) => a.priority - b.priority);

    // Build name -> index lookup for constraint resolution.
    const nameToIndices = new Map<string, number[]>();
    for (let i = 0; i < systems.length; i++) {
      const name = systems[i].constructor.name;
      let arr = nameToIndices.get(name);
      if (!arr) {
        arr = [];
        nameToIndices.set(name, arr);
      }
      arr.push(i);
    }

    const n = systems.length;

    // 2. Build DAG (adjacency list + in-degree) -----------------------------
    // Edge u -> v means "u must run before v".
    const adj: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
    const inDeg: number[] = new Array(n).fill(0);

    const addEdge = (from: number, to: number): void => {
      if (from === to) return;
      if (adj[from].has(to)) return;
      adj[from].add(to);
      inDeg[to]++;
    };

    // Data-dependency edges: if two systems conflict, the one with lower
    // priority-index (earlier in the priority-sorted list) goes first.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (hasConflict(systems[i], systems[j])) {
          addEdge(i, j);
        }
      }
    }

    // Explicit constraints.
    for (const c of this.constraints) {
      const fromIndices = nameToIndices.get(c.system);
      if (!fromIndices) continue; // system not in this phase

      if (c.before) {
        for (const targetName of c.before) {
          const toIndices = nameToIndices.get(targetName);
          if (!toIndices) continue;
          for (const fi of fromIndices) {
            for (const ti of toIndices) {
              addEdge(fi, ti); // "system" runs before "target"
            }
          }
        }
      }

      if (c.after) {
        for (const targetName of c.after) {
          const toIndices = nameToIndices.get(targetName);
          if (!toIndices) continue;
          for (const fi of fromIndices) {
            for (const ti of toIndices) {
              addEdge(ti, fi); // "target" runs before "system"
            }
          }
        }
      }
    }

    // 3. Topological sort (Kahn's algorithm) --------------------------------
    const queue: number[] = [];
    for (let i = 0; i < n; i++) {
      if (inDeg[i] === 0) queue.push(i);
    }

    const topoOrder: number[] = [];
    // Track depth (longest-path from a root) for stage assignment.
    const depth: number[] = new Array(n).fill(0);

    while (queue.length > 0) {
      // Among zero-in-degree nodes pick the one with smallest original index
      // (priority-stable tie-break).
      let bestIdx = 0;
      for (let k = 1; k < queue.length; k++) {
        if (queue[k] < queue[bestIdx]) bestIdx = k;
      }
      const u = queue[bestIdx];
      queue.splice(bestIdx, 1);

      topoOrder.push(u);

      for (const v of adj[u]) {
        depth[v] = Math.max(depth[v], depth[u] + 1);
        inDeg[v]--;
        if (inDeg[v] === 0) queue.push(v);
      }
    }

    if (topoOrder.length !== n) {
      // Cycle detected -- find the cycle path for a helpful message.
      const cyclePath = this.findCycle(systems, adj, inDeg);
      throw new Error(
        `[SystemScheduler] Cycle detected among systems: ${cyclePath}`,
      );
    }

    // 4. Assign stages -------------------------------------------------------
    // The depth array already gives us the earliest possible stage each system
    // can be placed in while respecting all edges. Systems at the same depth
    // have no ordering edges between them, but we additionally verify they
    // have no data conflicts before merging them into the same stage.
    //
    // Build tentative stages from depth, then split within a depth level when
    // two systems conflict.

    const maxDepth = Math.max(...depth);
    const stageGroups: number[][] = Array.from(
      { length: maxDepth + 1 },
      () => [],
    );
    for (const idx of topoOrder) {
      stageGroups[depth[idx]].push(idx);
    }

    // Now split each depth-level group to ensure no intra-stage conflicts.
    const finalStages: System[][] = [];
    for (const group of stageGroups) {
      if (group.length === 0) continue;
      // Greedily pack systems into sub-stages within this depth level.
      const subStages: number[][] = [];
      for (const sysIdx of group) {
        let placed = false;
        for (const sub of subStages) {
          const conflicts = sub.some((existing) =>
            hasConflict(systems[existing], systems[sysIdx]),
          );
          if (!conflicts) {
            sub.push(sysIdx);
            placed = true;
            break;
          }
        }
        if (!placed) {
          subStages.push([sysIdx]);
        }
      }
      for (const sub of subStages) {
        finalStages.push(sub.map((i) => systems[i]));
      }
    }

    return finalStages.map((sysList, i) => ({
      index: i,
      systems: sysList,
    }));
  }

  /**
   * Attempt to extract a readable cycle path from the remaining graph after
   * Kahn's algorithm has stalled.
   */
  private findCycle(
    systems: System[],
    adj: Set<number>[],
    residualInDeg: number[],
  ): string {
    const n = systems.length;

    // Only nodes still in the graph (inDeg > 0 after Kahn's) participate.
    const inGraph = new Set<number>();
    for (let i = 0; i < n; i++) {
      if (residualInDeg[i] > 0) inGraph.add(i);
    }

    // DFS from any remaining node to find a back-edge.
    const visited = new Set<number>();
    const onStack = new Set<number>();
    const parent = new Map<number, number>();
    let cycleStart = -1;
    let cycleEnd = -1;

    const dfs = (u: number): boolean => {
      visited.add(u);
      onStack.add(u);
      for (const v of adj[u]) {
        if (!inGraph.has(v)) continue;
        if (!visited.has(v)) {
          parent.set(v, u);
          if (dfs(v)) return true;
        } else if (onStack.has(v)) {
          cycleStart = v;
          cycleEnd = u;
          return true;
        }
      }
      onStack.delete(u);
      return false;
    };

    for (const node of inGraph) {
      if (!visited.has(node)) {
        if (dfs(node)) break;
      }
    }

    if (cycleStart === -1) {
      // Fallback: just list the stuck systems.
      return [...inGraph].map((i) => systems[i].constructor.name).join(" -> ");
    }

    // Reconstruct path from cycleStart to cycleEnd via parent links.
    const path: string[] = [systems[cycleStart].constructor.name];
    let cur = cycleEnd;
    while (cur !== cycleStart) {
      path.push(systems[cur].constructor.name);
      cur = parent.get(cur)!;
    }
    path.push(systems[cycleStart].constructor.name); // close the loop
    path.reverse();
    return path.join(" -> ");
  }

  /** Produce a fingerprint string for a system set to detect changes. */
  private systemFingerprint(systems: System[]): string {
    return systems
      .map((s) => {
        const d = getDeclarations(s);
        return `${s.constructor.name}:${s.phase}:${s.priority}:${d.reads.join(",")}:${d.writes.join(",")}:${s.active}`;
      })
      .join("|");
  }
}
