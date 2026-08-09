export class SpatialHash {
  private cellSize: number;
  private invCellSize: number;
  private cells = new Map<string, number[]>();
  private entityCell = new Map<number, string>();
  private entityPos = new Map<number, { x: number; z: number }>();

  constructor(cellSize: number = 16) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
  }

  // A lossy 32-bit XOR-merge of (cx,cz) can collide for cell coordinates that are nowhere
  // near each other (e.g. (-387,48) and (-374,-25) collide despite being ~1186 world units
  // apart at cellSize=16), silently leaking entities from an unrelated cell into a query.
  // A string key built from the exact integer coordinates has no such collisions.
  private hash(cx: number, cz: number): string {
    return cx + "," + cz;
  }

  private cellCoord(v: number): number {
    return Math.floor(v * this.invCellSize);
  }

  insert(eid: number, x: number, z: number): void {
    this.remove(eid);
    const cx = this.cellCoord(x);
    const cz = this.cellCoord(z);
    const h = this.hash(cx, cz);
    let cell = this.cells.get(h);
    if (!cell) {
      cell = [];
      this.cells.set(h, cell);
    }
    cell.push(eid);
    this.entityCell.set(eid, h);
    this.entityPos.set(eid, { x, z });
  }

  remove(eid: number): void {
    const h = this.entityCell.get(eid);
    if (h === undefined) return;
    const cell = this.cells.get(h);
    if (cell) {
      const idx = cell.indexOf(eid);
      if (idx !== -1) {
        cell[idx] = cell[cell.length - 1];
        cell.pop();
      }
      if (cell.length === 0) this.cells.delete(h);
    }
    this.entityCell.delete(eid);
    this.entityPos.delete(eid);
  }

  update(eid: number, x: number, z: number): void {
    this.insert(eid, x, z);
  }

  queryRadius(cx: number, cz: number, radius: number, results: number[] = []): number[] {
    results.length = 0;
    const r2 = radius * radius;
    const minCX = this.cellCoord(cx - radius);
    const maxCX = this.cellCoord(cx + radius);
    const minCZ = this.cellCoord(cz - radius);
    const maxCZ = this.cellCoord(cz + radius);

    for (let gx = minCX; gx <= maxCX; gx++) {
      for (let gz = minCZ; gz <= maxCZ; gz++) {
        const cell = this.cells.get(this.hash(gx, gz));
        if (cell) {
          for (let i = 0; i < cell.length; i++) {
            const eid = cell[i];
            const pos = this.entityPos.get(eid);
            if (!pos) continue;
            const dx = pos.x - cx, dz = pos.z - cz;
            if (dx * dx + dz * dz <= r2) results.push(eid);
          }
        }
      }
    }
    return results;
  }

  queryAABB(minX: number, minZ: number, maxX: number, maxZ: number, results: number[] = []): number[] {
    results.length = 0;
    const gMinX = this.cellCoord(minX);
    const gMaxX = this.cellCoord(maxX);
    const gMinZ = this.cellCoord(minZ);
    const gMaxZ = this.cellCoord(maxZ);

    for (let gx = gMinX; gx <= gMaxX; gx++) {
      for (let gz = gMinZ; gz <= gMaxZ; gz++) {
        const cell = this.cells.get(this.hash(gx, gz));
        if (cell) {
          for (let i = 0; i < cell.length; i++) {
            results.push(cell[i]);
          }
        }
      }
    }
    return results;
  }

  clear(): void {
    this.cells.clear();
    this.entityCell.clear();
    this.entityPos.clear();
  }
}
