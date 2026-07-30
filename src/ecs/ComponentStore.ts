import { ComponentSchema, ComponentDef } from "./Component";
import { BitSet } from "./BitSet";

type SchemaToArrayType = {
  f32: Float32Array;
  f64: Float64Array;
  i32: Int32Array;
  u8: Uint8Array;
  bool: Uint8Array;
  ref: any[];
};

const INITIAL_CAPACITY = 256;
const GROWTH_FACTOR = 2;

function createArray(type: string, capacity: number): any {
  switch (type) {
    case "f32": return new Float32Array(capacity);
    case "f64": return new Float64Array(capacity);
    case "i32": return new Int32Array(capacity);
    case "u8":
    case "bool": return new Uint8Array(capacity);
    case "ref": return new Array(capacity).fill(null);
    default: return new Float32Array(capacity);
  }
}

function growArray(old: any, type: string, newCapacity: number): any {
  if (type === "ref") {
    const arr = new Array(newCapacity).fill(null);
    for (let i = 0; i < old.length; i++) arr[i] = old[i];
    return arr;
  }
  const fresh = createArray(type, newCapacity);
  fresh.set(old);
  return fresh;
}

type ComponentCallback = (entityId: number) => void;

export class ComponentStore<S extends ComponentSchema = ComponentSchema> {
  readonly def: ComponentDef<S>;
  readonly entities = new BitSet();
  private columns: Record<string, any> = {};
  private capacity = INITIAL_CAPACITY;
  private addCallbacks: ComponentCallback[] = [];
  private removeCallbacks: ComponentCallback[] = [];

  constructor(def: ComponentDef<S>) {
    this.def = def;
    for (const [field, type] of Object.entries(def.schema)) {
      this.columns[field] = createArray(type, this.capacity);
    }
  }

  onAdd(callback: ComponentCallback): () => void {
    this.addCallbacks.push(callback);
    return () => {
      const idx = this.addCallbacks.indexOf(callback);
      if (idx !== -1) this.addCallbacks.splice(idx, 1);
    };
  }

  onRemove(callback: ComponentCallback): () => void {
    this.removeCallbacks.push(callback);
    return () => {
      const idx = this.removeCallbacks.indexOf(callback);
      if (idx !== -1) this.removeCallbacks.splice(idx, 1);
    };
  }

  private grow(): void {
    this.capacity *= GROWTH_FACTOR;
    for (const [field, type] of Object.entries(this.def.schema)) {
      this.columns[field] = growArray(this.columns[field], type, this.capacity);
    }
  }

  add(entityId: number, data?: Partial<Record<keyof S, number | boolean | any>>): void {
    const alreadyPresent = this.entities.has(entityId);

    while (entityId >= this.capacity) {
      this.grow();
    }

    if (!alreadyPresent) {
      this.entities.add(entityId);
    }

    if (data) {
      for (const [field, value] of Object.entries(data)) {
        if (field in this.columns) {
          this.columns[field][entityId] = this.def.schema[field] === "bool" ? (value ? 1 : 0) : value;
        }
      }
    }

    // Only fire onAdd for genuinely new rows — calling add() again on an entity that already
    // has this component is an upsert (new `data` overwrites the existing fields) rather than
    // a fresh add, so it must not re-trigger add-callbacks or re-run add-time side effects.
    if (!alreadyPresent) {
      for (let i = 0; i < this.addCallbacks.length; i++) {
        this.addCallbacks[i](entityId);
      }
    }
  }

  remove(entityId: number): void {
    if (!this.entities.has(entityId)) return;

    for (let i = 0; i < this.removeCallbacks.length; i++) {
      this.removeCallbacks[i](entityId);
    }

    this.entities.remove(entityId);

    for (const [field, type] of Object.entries(this.def.schema)) {
      if (type === "ref") {
        this.columns[field][entityId] = null;
      } else {
        this.columns[field][entityId] = 0;
      }
    }
  }

  has(entityId: number): boolean {
    return this.entities.has(entityId);
  }

  getColumn<K extends keyof S>(field: K): SchemaToArrayType[S[K]] {
    return this.columns[field as string];
  }

  get<K extends keyof S>(entityId: number, field: K): number | any {
    return this.columns[field as string][entityId];
  }

  set<K extends keyof S>(entityId: number, field: K, value: number | boolean | any): void {
    while (entityId >= this.capacity) {
      this.grow();
    }
    this.columns[field as string][entityId] = this.def.schema[field as string] === "bool" ? (value ? 1 : 0) : value;
  }
}
