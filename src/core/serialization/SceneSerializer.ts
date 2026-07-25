import { World } from "../../ecs";
import { ComponentDef, ComponentSchema } from "../../ecs/Component";

export interface SerializedEntity {
  id: number;
  components: Record<string, Record<string, any>>;
}

export interface SerializedScene {
  version: number;
  name: string;
  entities: SerializedEntity[];
  metadata?: Record<string, any>;
}

type MigrationFn = (data: SerializedScene) => SerializedScene;

export class SceneSerializer {
  private registeredDefs: ComponentDef[] = [];
  private migrations = new Map<number, MigrationFn>();
  private currentVersion = 1;
  // Fields known to contain entity references (keyed by component name)
  private entityRefFields = new Map<string, string[]>();

  register(...defs: ComponentDef[]): void {
    for (const def of defs) {
      if (!this.registeredDefs.find((d) => d.name === def.name)) {
        this.registeredDefs.push(def);
      }
    }
  }

  registerEntityRefFields(componentName: string, fields: string[]): void {
    this.entityRefFields.set(componentName, fields);
  }

  registerMigration(fromVersion: number, fn: MigrationFn): void {
    this.migrations.set(fromVersion, fn);
  }

  serialize(world: World, name: string = "scene", metadata?: Record<string, any>): SerializedScene {
    const entityMap = new Map<number, SerializedEntity>();

    for (const def of this.registeredDefs) {
      const store = world.getStore(def);
      for (const eid of store.entities) {
        let entry = entityMap.get(eid);
        if (!entry) {
          entry = { id: eid, components: {} };
          entityMap.set(eid, entry);
        }
        const compData: Record<string, any> = {};
        for (const field of Object.keys(def.schema)) {
          const type = def.schema[field];
          if (type === "ref") continue;
          compData[field] = store.get(eid, field);
        }
        entry.components[def.name] = compData;
      }
    }

    return {
      version: this.currentVersion,
      name,
      entities: Array.from(entityMap.values()),
      metadata,
    };
  }

  serializePartial(world: World, entityIds: number[], name: string = "partial"): SerializedScene {
    const entities: SerializedEntity[] = [];
    const eidSet = new Set(entityIds);

    for (const eid of eidSet) {
      const entry: SerializedEntity = { id: eid, components: {} };
      for (const def of this.registeredDefs) {
        const store = world.getStore(def);
        if (!store.has(eid)) continue;
        const compData: Record<string, any> = {};
        for (const field of Object.keys(def.schema)) {
          if (def.schema[field] === "ref") continue;
          compData[field] = store.get(eid, field);
        }
        entry.components[def.name] = compData;
      }
      if (Object.keys(entry.components).length > 0) {
        entities.push(entry);
      }
    }

    return { version: this.currentVersion, name, entities };
  }

  deserialize(world: World, scene: SerializedScene): number[] {
    if (!scene || !scene.entities || !Array.isArray(scene.entities)) {
      console.error("[AGEE] Invalid scene data: missing or malformed entities array");
      return [];
    }

    let data = scene;

    // Apply migrations
    while (data.version < this.currentVersion) {
      const migrate = this.migrations.get(data.version);
      if (!migrate) {
        console.warn(`[AGEE] No migration found for scene version ${data.version}`);
        break;
      }
      data = migrate(data);
    }

    const defMap = new Map<string, ComponentDef>();
    for (const def of this.registeredDefs) {
      defMap.set(def.name, def);
    }

    const createdIds: number[] = [];
    const idRemap = new Map<number, number>();

    // Phase 1: Create entities and add components
    for (const entityData of data.entities) {
      const eid = world.createEntity();
      createdIds.push(eid);

      // A corrupted/malicious scene with two entities sharing the same id would otherwise
      // silently overwrite the first id -> entity mapping here, so any earlier entity's
      // back-reference (Parent.entity, registered entity-ref fields) to that id would
      // silently get rewired onto whichever occurrence happened to be processed last.
      // First occurrence wins; later duplicates still get their own entity + components,
      // they just aren't a valid remap target for back-references to that id.
      if (idRemap.has(entityData.id)) {
        console.error(`[AGEE] Duplicate entity id ${entityData.id} in scene data; ignoring the duplicate for reference remapping.`);
      } else {
        idRemap.set(entityData.id, eid);
      }

      for (const [compName, compData] of Object.entries(entityData.components)) {
        const def = defMap.get(compName);
        if (!def) continue;

        // Malformed data could set a component's value to a primitive instead of an
        // object -- `field in compData` throws for anything that isn't an object.
        if (typeof compData !== "object" || compData === null) {
          console.warn(`[AGEE] Skipping malformed "${compName}" data on entity ${entityData.id}: expected an object`);
          continue;
        }

        // Validate component data against schema
        const validatedData: Record<string, any> = {};
        for (const field of Object.keys(def.schema)) {
          if (field in compData) {
            validatedData[field] = compData[field];
          }
        }

        world.addComponent(eid, def, validatedData);
      }
    }

    // Phase 2: Remap all known entity reference fields
    // Always remap Parent.entity
    const parentDef = defMap.get("Parent");
    if (parentDef) {
      const parentStore = world.getStore(parentDef);
      for (let i = 0; i < data.entities.length; i++) {
        const entityData = data.entities[i];
        const parentData = entityData.components["Parent"];
        if (parentData && parentData.entity !== undefined) {
          // This entity's own freshly-created eid — indexed from createdIds (which always
          // has exactly one entry per data.entities element), not looked up by the
          // possibly-duplicated source id, since a duplicate-id entity still needs its own
          // Parent reference resolved even though it isn't a valid remap *target*.
          const newEid = createdIds[i];
          const newParent = idRemap.get(parentData.entity);
          if (newParent !== undefined) {
            parentStore.set(newEid, "entity", newParent);
          }
        }
      }
    }

    // Remap registered entity reference fields in other components
    for (const [compName, fields] of this.entityRefFields) {
      const def = defMap.get(compName);
      if (!def) continue;
      const store = world.getStore(def);
      for (let i = 0; i < data.entities.length; i++) {
        const entityData = data.entities[i];
        const compData = entityData.components[compName];
        if (!compData) continue;
        const newEid = createdIds[i];
        for (const field of fields) {
          const oldRef = compData[field];
          if (oldRef !== undefined && oldRef >= 0) {
            const newRef = idRemap.get(oldRef);
            if (newRef !== undefined) {
              store.set(newEid, field, newRef);
            }
          }
        }
      }
    }

    // Phase 3: Detect circular parent hierarchies
    if (parentDef) {
      const parentStore = world.getStore(parentDef);
      for (const eid of createdIds) {
        if (!parentStore.has(eid)) continue;
        const visited = new Set<number>();
        let current = eid;
        let hasCycle = false;
        while (parentStore.has(current)) {
          if (visited.has(current)) {
            hasCycle = true;
            break;
          }
          visited.add(current);
          current = parentStore.get(current, "entity") as number;
          if (current < 0) break;
        }
        if (hasCycle) {
          console.error(`[AGEE] Circular parent hierarchy detected involving entity ${eid}. Breaking cycle.`);
          parentStore.set(eid, "entity", -1);
        }
      }
    }

    return createdIds;
  }

  toJSON(scene: SerializedScene): string {
    return JSON.stringify(scene, null, 2);
  }

  fromJSON(json: string): SerializedScene {
    return JSON.parse(json) as SerializedScene;
  }
}
