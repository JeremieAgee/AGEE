import { System, World, ComponentStore, defineComponent } from "../ecs";
import { Transform } from "../core/Components";
import { BinaryHeap } from "./BinaryHeap";

// SOA component — all nav data in typed arrays
export const NavAgent = defineComponent("NavAgent", {
  speed: "f32",
  stoppingDistance: "f32",
  targetX: "f32",
  targetY: "f32",
  targetZ: "f32",
  hasTarget: "bool",
  pathHandle: "i32",
  pathIndex: "i32",
  pathLength: "i32",
});

// Path storage: flat Float32Array pools instead of Vec3[] per entity
// Each path is a contiguous slice of [x,y,z, x,y,z, ...] in a shared buffer

const MAX_PATH_NODES = 128;
const PATH_STRIDE = MAX_PATH_NODES * 3;

export interface NavGrid {
  width: number;
  depth: number;
  cellSize: number;
  walkable: Uint8Array;
  costs: Float32Array;
}

export class NavigationSystem extends System {
  priority = 40;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "prePhysics";

  static reads = ["Transform", "NavAgent"];
  static writes = ["Transform", "NavAgent"];

  private grid: NavGrid | null = null;
  private navStore!: ComponentStore;
  private transformStore!: ComponentStore;
  private query!: ReturnType<World["query"]>;

  // SOA path storage: flat buffer holding all paths, indexed by pathHandle
  private pathData: Float32Array;
  private pathLengths: Int32Array;
  private pathFreeList: number[] = [];
  private nextPathSlot = 0;
  private maxPaths: number;

  constructor(maxPaths: number = 256) {
    super();
    this.maxPaths = maxPaths;
    this.pathData = new Float32Array(maxPaths * PATH_STRIDE);
    this.pathLengths = new Int32Array(maxPaths);
  }

  init(): void {
    this.navStore = this.world.getStore(NavAgent);
    this.transformStore = this.world.getStore(Transform);
    this.query = this.world.query(NavAgent, Transform);
  }

  createGrid(width: number, depth: number, cellSize: number): NavGrid {
    const cells = width * depth;
    this.grid = {
      width, depth, cellSize,
      walkable: new Uint8Array(cells).fill(1),
      costs: new Float32Array(cells).fill(1),
    };
    return this.grid;
  }

  setWalkable(gridX: number, gridZ: number, walkable: boolean): void {
    if (!this.grid) return;
    if (gridX < 0 || gridX >= this.grid.width || gridZ < 0 || gridZ >= this.grid.depth) return;
    this.grid.walkable[gridZ * this.grid.width + gridX] = walkable ? 1 : 0;
  }

  private allocPath(): number {
    if (this.pathFreeList.length > 0) return this.pathFreeList.pop()!;
    if (this.nextPathSlot >= this.maxPaths) {
      this.growPaths();
    }
    return this.nextPathSlot++;
  }

  private freePath(slot: number): void {
    this.pathLengths[slot] = 0;
    this.pathFreeList.push(slot);
  }

  private growPaths(): void {
    const newMax = this.maxPaths * 2;
    const newData = new Float32Array(newMax * PATH_STRIDE);
    newData.set(this.pathData);
    const newLengths = new Int32Array(newMax);
    newLengths.set(this.pathLengths);
    this.pathData = newData;
    this.pathLengths = newLengths;
    this.maxPaths = newMax;
  }

  private worldToGrid(wx: number, wz: number): { x: number; z: number } | null {
    if (!this.grid) return null;
    return { x: Math.floor(wx / this.grid.cellSize), z: Math.floor(wz / this.grid.cellSize) };
  }

  findPath(fromX: number, fromZ: number, toX: number, toZ: number): number {
    if (!this.grid) return -1;
    const g = this.grid;
    const start = this.worldToGrid(fromX, fromZ);
    const end = this.worldToGrid(toX, toZ);
    if (!start || !end) return -1;
    if (start.x < 0 || start.x >= g.width || start.z < 0 || start.z >= g.depth) return -1;
    if (end.x < 0 || end.x >= g.width || end.z < 0 || end.z >= g.depth) return -1;
    if (!g.walkable[end.z * g.width + end.x]) return -1;

    const totalCells = g.width * g.depth;
    const gScore = new Float32Array(totalCells).fill(Infinity);
    const cameFrom = new Int32Array(totalCells).fill(-1);
    const openSet = new BinaryHeap(totalCells);

    const startIdx = start.z * g.width + start.x;
    const endIdx = end.z * g.width + end.x;
    gScore[startIdx] = 0;
    const startH = Math.abs(end.x - start.x) + Math.abs(end.z - start.z);
    openSet.push(startIdx, startH);

    const DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
    const COSTS = [1,1,1,1,1.414,1.414,1.414,1.414];

    while (openSet.length > 0) {
      const current = openSet.pop();
      if (current === endIdx) break;

      const cx = current % g.width;
      const cz = (current / g.width) | 0;

      for (let d = 0; d < 8; d++) {
        const nx = cx + DIRS[d][0];
        const nz = cz + DIRS[d][1];
        if (nx < 0 || nx >= g.width || nz < 0 || nz >= g.depth) continue;
        const nIdx = nz * g.width + nx;
        if (!g.walkable[nIdx]) continue;

        const tentG = gScore[current] + COSTS[d] * g.costs[nIdx];
        if (tentG < gScore[nIdx]) {
          cameFrom[nIdx] = current;
          gScore[nIdx] = tentG;
          const f = tentG + Math.abs(end.x - nx) + Math.abs(end.z - nz);
          if (openSet.contains(nIdx)) {
            openSet.decreaseKey(nIdx, f);
          } else {
            openSet.push(nIdx, f);
          }
        }
      }
    }

    if (cameFrom[endIdx] === -1 && startIdx !== endIdx) return -1;

    // Trace path backwards, write into flat SOA buffer
    const slot = this.allocPath();
    const offset = slot * PATH_STRIDE;
    let pathLen = 0;
    const tempPath: number[] = [];

    let cur = endIdx;
    while (cur !== -1 && pathLen < MAX_PATH_NODES) {
      tempPath.push(cur);
      cur = cameFrom[cur];
    }

    // Reverse into SOA buffer
    pathLen = tempPath.length;
    for (let i = 0; i < pathLen; i++) {
      const cell = tempPath[pathLen - 1 - i];
      const px = (cell % g.width) * g.cellSize + g.cellSize * 0.5;
      const pz = ((cell / g.width) | 0) * g.cellSize + g.cellSize * 0.5;
      this.pathData[offset + i * 3] = px;
      this.pathData[offset + i * 3 + 1] = 0;
      this.pathData[offset + i * 3 + 2] = pz;
    }
    this.pathLengths[slot] = pathLen;
    return slot;
  }

  setTarget(eid: number, x: number, y: number, z: number): void {
    const tx = this.transformStore.get(eid, "x");
    const tz = this.transformStore.get(eid, "z");

    // Free old path
    const oldHandle = this.navStore.get(eid, "pathHandle") as number;
    if (oldHandle >= 0) this.freePath(oldHandle);

    const pathHandle = this.findPath(tx, tz, x, z);
    this.navStore.set(eid, "targetX", x);
    this.navStore.set(eid, "targetY", y);
    this.navStore.set(eid, "targetZ", z);
    this.navStore.set(eid, "hasTarget", pathHandle >= 0 ? 1 : 0);
    this.navStore.set(eid, "pathHandle", pathHandle);
    this.navStore.set(eid, "pathIndex", 0);
    this.navStore.set(eid, "pathLength", pathHandle >= 0 ? this.pathLengths[pathHandle] : 0);
  }

  // Hot loop — pure SOA column reads for movement
  update(dt: number): void {
    const entities = this.query.entities;
    const hasTargets = this.navStore.getColumn("hasTarget");
    const speeds = this.navStore.getColumn("speed");
    const stopDists = this.navStore.getColumn("stoppingDistance");
    const pathHandles = this.navStore.getColumn("pathHandle");
    const pathIndices = this.navStore.getColumn("pathIndex");
    const pathLengths = this.navStore.getColumn("pathLength");

    const px = this.transformStore.getColumn("x");
    const pz = this.transformStore.getColumn("z");
    const ry = this.transformStore.getColumn("ry");

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (hasTargets[eid] === 0) continue;

      const handle = pathHandles[eid];
      let idx = pathIndices[eid];
      const len = pathLengths[eid];
      if (handle < 0 || idx >= len) {
        hasTargets[eid] = 0;
        continue;
      }

      // Read target waypoint from flat SOA path buffer
      const offset = handle * PATH_STRIDE + idx * 3;
      const wpX = this.pathData[offset];
      const wpZ = this.pathData[offset + 2];

      const dx = wpX - px[eid];
      const dz = wpZ - pz[eid];
      const dist = Math.sqrt(dx * dx + dz * dz);
      const stopDist = stopDists[eid] || 0.5;

      if (dist < stopDist) {
        idx++;
        pathIndices[eid] = idx;
        if (idx >= len) {
          hasTargets[eid] = 0;
          if (handle >= 0) this.freePath(handle);
          pathHandles[eid] = -1;
        }
        continue;
      }

      const speed = speeds[eid];
      const moveSpeed = Math.min(speed * dt, dist);
      const nx = dx / dist;
      const nz = dz / dist;
      px[eid] += nx * moveSpeed;
      pz[eid] += nz * moveSpeed;
      ry[eid] = Math.atan2(nx, nz);
    }
  }
}
