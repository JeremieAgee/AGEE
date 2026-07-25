import { ComponentDef } from "./Component";
import { World } from "./World";

const enum CmdType {
  Spawn,
  Despawn,
  AddComponent,
  RemoveComponent,
}

interface SpawnCmd {
  type: CmdType.Spawn;
  tempId: number;
  components: { def: ComponentDef; data?: any }[];
}

interface DespawnCmd {
  type: CmdType.Despawn;
  eid: number;
}

interface AddComponentCmd {
  type: CmdType.AddComponent;
  eid: number;
  def: ComponentDef;
  data?: any;
}

interface RemoveComponentCmd {
  type: CmdType.RemoveComponent;
  eid: number;
  def: ComponentDef;
}

type Command = SpawnCmd | DespawnCmd | AddComponentCmd | RemoveComponentCmd;

export class CommandBuffer {
  private commands: Command[] = [];
  private nextTempId = -1;
  private resolvedIds = new Map<number, number>();

  spawn(...components: { def: ComponentDef; data?: any }[]): number {
    const tempId = this.nextTempId--;
    this.commands.push({ type: CmdType.Spawn, tempId, components });
    return tempId;
  }

  despawn(eid: number): void {
    this.commands.push({ type: CmdType.Despawn, eid });
  }

  addComponent(eid: number, def: ComponentDef, data?: any): void {
    this.commands.push({ type: CmdType.AddComponent, eid, def, data });
  }

  removeComponent(eid: number, def: ComponentDef): void {
    this.commands.push({ type: CmdType.RemoveComponent, eid, def });
  }

  resolveId(tempId: number): number | undefined {
    return this.resolvedIds.get(tempId);
  }

  flush(world: World): void {
    this.resolvedIds.clear();

    for (const cmd of this.commands) {
      switch (cmd.type) {
        case CmdType.Spawn: {
          const eid = world.createEntity();
          this.resolvedIds.set(cmd.tempId, eid);
          for (const { def, data } of cmd.components) {
            world.addComponent(eid, def, data);
          }
          break;
        }
        case CmdType.Despawn: {
          const eid = cmd.eid < 0 ? this.resolvedIds.get(cmd.eid) ?? cmd.eid : cmd.eid;
          if (eid >= 0) world.destroyEntity(eid);
          break;
        }
        case CmdType.AddComponent: {
          const eid = cmd.eid < 0 ? this.resolvedIds.get(cmd.eid) ?? cmd.eid : cmd.eid;
          if (eid >= 0) world.addComponent(eid, cmd.def, cmd.data);
          break;
        }
        case CmdType.RemoveComponent: {
          const eid = cmd.eid < 0 ? this.resolvedIds.get(cmd.eid) ?? cmd.eid : cmd.eid;
          if (eid >= 0) world.removeComponent(eid, cmd.def);
          break;
        }
      }
    }
    this.commands.length = 0;
    this.nextTempId = -1;
  }

  get pending(): number {
    return this.commands.length;
  }

  clear(): void {
    this.commands.length = 0;
    this.resolvedIds.clear();
    this.nextTempId = -1;
  }
}
