import { ComponentSchema, ComponentDef } from "./Component";

export const CHUNK_SIZE = 128;

function createColumnForChunk(type: string, size: number): any {
  switch (type) {
    case "f32": return new Float32Array(size);
    case "f64": return new Float64Array(size);
    case "i32": return new Int32Array(size);
    case "u8":
    case "bool": return new Uint8Array(size);
    case "ref": return new Array(size).fill(null);
    default: return new Float32Array(size);
  }
}

export class Chunk {
  readonly archetypeId: bigint;
  readonly entityIds: Int32Array;
  readonly columns: Map<string, Map<string, any>>;
  private _count = 0;
  readonly capacity: number;

  constructor(archetypeId: bigint, componentDefs: ComponentDef[], capacity: number = CHUNK_SIZE) {
    this.archetypeId = archetypeId;
    this.capacity = capacity;
    this.entityIds = new Int32Array(capacity).fill(-1);
    this.columns = new Map();

    for (const def of componentDefs) {
      const cols = new Map<string, any>();
      for (const [field, type] of Object.entries(def.schema)) {
        cols.set(field, createColumnForChunk(type, capacity));
      }
      this.columns.set(def.name, cols);
    }
  }

  get count(): number { return this._count; }
  get isFull(): boolean { return this._count >= this.capacity; }
  get isEmpty(): boolean { return this._count === 0; }

  add(entityId: number): number {
    if (this._count >= this.capacity) return -1;
    const row = this._count;
    this.entityIds[row] = entityId;
    this._count++;
    return row;
  }

  remove(row: number): { swappedEntity: number; swappedFrom: number } | null {
    if (row < 0 || row >= this._count) return null;

    const lastRow = this._count - 1;

    if (row === lastRow) {
      this.entityIds[row] = -1;
      this.clearRow(row);
      this._count--;
      return null;
    }

    const swappedEntity = this.entityIds[lastRow];
    this.entityIds[row] = swappedEntity;
    this.entityIds[lastRow] = -1;

    for (const [, cols] of this.columns) {
      for (const [, arr] of cols) {
        arr[row] = arr[lastRow];
        if (arr instanceof Array) {
          arr[lastRow] = null;
        } else {
          arr[lastRow] = 0;
        }
      }
    }

    this._count--;
    return { swappedEntity, swappedFrom: lastRow };
  }

  setComponentData(componentName: string, row: number, field: string, value: any): void {
    const cols = this.columns.get(componentName);
    if (!cols) return;
    const arr = cols.get(field);
    if (!arr) return;
    arr[row] = value;
  }

  getComponentData(componentName: string, row: number, field: string): any {
    const cols = this.columns.get(componentName);
    if (!cols) return undefined;
    const arr = cols.get(field);
    if (!arr) return undefined;
    return arr[row];
  }

  getColumn(componentName: string, field: string): any {
    return this.columns.get(componentName)?.get(field);
  }

  private clearRow(row: number): void {
    for (const [, cols] of this.columns) {
      for (const [, arr] of cols) {
        if (arr instanceof Array) {
          arr[row] = null;
        } else {
          arr[row] = 0;
        }
      }
    }
  }
}
