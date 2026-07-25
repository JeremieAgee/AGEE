import { World } from "../ecs";
import { ComponentDef } from "../ecs/Component";
import { Handle, HandleMap } from "../core/handles/Handle";

export interface PrefabComponent {
  def: ComponentDef;
  data: Record<string, any>;
}

export interface PrefabEntity {
  components: PrefabComponent[];
  children?: PrefabEntity[];
}

export interface PrefabDef {
  name: string;
  root: PrefabEntity;
}

export interface PrefabVariant {
  base: string;
  overrides: Map<string, Partial<Record<string, any>>>;
}

// SOA prefab storage: definitions behind handles, not a Map<string, object>
// Batch instantiation writes directly into ECS stores

export class PrefabSystem {
  private world: World;
  private pool = new HandleMap<PrefabDef>();
  private nameToHandle = new Map<string, Handle>();

  constructor(world: World) {
    this.world = world;
  }

  register(def: PrefabDef): Handle {
    const existing = this.nameToHandle.get(def.name);
    if (existing !== undefined) {
      this.pool.set(existing, def);
      return existing;
    }
    const handle = this.pool.alloc(def);
    this.nameToHandle.set(def.name, handle);
    return handle;
  }

  get(name: string): PrefabDef | null {
    const h = this.nameToHandle.get(name);
    if (h === undefined) return null;
    return this.pool.get(h);
  }

  instantiate(name: string, position?: { x: number; y: number; z: number }): number[] {
    const def = this.get(name);
    if (!def) throw new Error(`Prefab "${name}" not found`);
    const created: number[] = [];
    this.spawnEntity(def.root, created, position);
    return created;
  }

  instantiateByHandle(handle: Handle, position?: { x: number; y: number; z: number }): number[] {
    const def = this.pool.get(handle);
    if (!def) throw new Error(`Prefab handle invalid`);
    const created: number[] = [];
    this.spawnEntity(def.root, created, position);
    return created;
  }

  // SOA batch spawn: instantiate N copies at given positions, bulk-adding to ECS stores
  instantiateBatch(
    name: string,
    positions: ArrayLike<number>,
    stride: number = 3
  ): number[] {
    const def = this.get(name);
    if (!def) throw new Error(`Prefab "${name}" not found`);

    const count = positions.length / stride;
    const allCreated: number[] = [];

    for (let i = 0; i < count; i++) {
      const pos = {
        x: positions[i * stride],
        y: positions[i * stride + 1],
        z: positions[i * stride + 2],
      };
      this.spawnEntity(def.root, allCreated, pos);
    }

    return allCreated;
  }

  instantiateVariant(
    variant: PrefabVariant,
    position?: { x: number; y: number; z: number }
  ): number[] {
    const baseDef = this.get(variant.base);
    if (!baseDef) throw new Error(`Base prefab "${variant.base}" not found`);

    const modified = this.applyOverrides(baseDef, variant.overrides);
    const created: number[] = [];
    this.spawnEntity(modified.root, created, position);
    return created;
  }

  private spawnEntity(
    entityDef: PrefabEntity,
    created: number[],
    posOverride?: { x: number; y: number; z: number }
  ): number {
    const eid = this.world.createEntity();
    created.push(eid);

    for (const comp of entityDef.components) {
      const data = { ...comp.data };
      if (posOverride && comp.def.name === "Transform") {
        data.x = posOverride.x;
        data.y = posOverride.y;
        data.z = posOverride.z;
      }
      this.world.addComponent(eid, comp.def, data);
    }

    if (entityDef.children) {
      for (const child of entityDef.children) {
        this.spawnEntity(child, created);
      }
    }

    return eid;
  }

  private applyOverrides(
    def: PrefabDef,
    overrides: Map<string, Partial<Record<string, any>>>
  ): PrefabDef {
    const root: PrefabEntity = {
      components: def.root.components.map((c) => {
        const override = overrides.get(c.def.name);
        return {
          def: c.def,
          data: override ? { ...c.data, ...override } : { ...c.data },
        };
      }),
      children: def.root.children?.map((c) => this.cloneEntity(c)),
    };
    return { name: def.name + "_variant", root };
  }

  private cloneEntity(entity: PrefabEntity): PrefabEntity {
    return {
      components: entity.components.map((c) => ({ def: c.def, data: { ...c.data } })),
      children: entity.children?.map((c) => this.cloneEntity(c)),
    };
  }

  unregister(name: string): void {
    const h = this.nameToHandle.get(name);
    if (h !== undefined) {
      this.pool.free(h);
      this.nameToHandle.delete(name);
    }
  }
}
