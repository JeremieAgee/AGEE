export type BTStatus = "success" | "failure" | "running";

export type BTNodeType = "action" | "condition" | "sequence" | "selector" | "parallel" | "decorator" | "subtree";

export interface BTNode {
  type: BTNodeType;
  name: string;
  children?: BTNode[];
  decorator?: "invert" | "repeat" | "succeedAlways";
  treeId?: string;
}

export class Blackboard {
  private data = new Map<string, any>();

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  set(key: string, value: any): void {
    this.data.set(key, value);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

export type ActionFn = (eid: number, bb: Blackboard, dt: number) => BTStatus;
export type ConditionFn = (eid: number, bb: Blackboard) => boolean;

export class BehaviorTreeRunner {
  private actions = new Map<string, ActionFn>();
  private conditions = new Map<string, ConditionFn>();
  private subtrees = new Map<string, BTNode>();
  private runningChildKey = "__bt_running_";

  registerAction(name: string, fn: ActionFn): void {
    this.actions.set(name, fn);
  }

  registerCondition(name: string, fn: ConditionFn): void {
    this.conditions.set(name, fn);
  }

  registerSubtree(id: string, tree: BTNode): void {
    this.subtrees.set(id, tree);
  }

  tick(eid: number, node: BTNode, bb: Blackboard, dt: number): BTStatus {
    switch (node.type) {
      case "action": return this.tickAction(eid, node, bb, dt);
      case "condition": return this.tickCondition(eid, node, bb);
      case "sequence": return this.tickSequence(eid, node, bb, dt);
      case "selector": return this.tickSelector(eid, node, bb, dt);
      case "parallel": return this.tickParallel(eid, node, bb, dt);
      case "decorator": return this.tickDecorator(eid, node, bb, dt);
      case "subtree": return this.tickSubtree(eid, node, bb, dt);
      default: return "failure";
    }
  }

  private tickAction(eid: number, node: BTNode, bb: Blackboard, dt: number): BTStatus {
    const fn = this.actions.get(node.name);
    return fn ? fn(eid, bb, dt) : "failure";
  }

  private tickCondition(eid: number, node: BTNode, bb: Blackboard): BTStatus {
    const fn = this.conditions.get(node.name);
    return fn && fn(eid, bb) ? "success" : "failure";
  }

  private tickSequence(eid: number, node: BTNode, bb: Blackboard, dt: number): BTStatus {
    if (!node.children) return "success";
    const key = this.runningChildKey + node.name;
    let startIdx = bb.get<number>(key) ?? 0;

    for (let i = startIdx; i < node.children.length; i++) {
      const status = this.tick(eid, node.children[i], bb, dt);
      if (status === "running") {
        bb.set(key, i);
        return "running";
      }
      if (status === "failure") {
        bb.delete(key);
        return "failure";
      }
    }
    bb.delete(key);
    return "success";
  }

  private tickSelector(eid: number, node: BTNode, bb: Blackboard, dt: number): BTStatus {
    if (!node.children) return "failure";
    const key = this.runningChildKey + node.name;
    let startIdx = bb.get<number>(key) ?? 0;

    for (let i = startIdx; i < node.children.length; i++) {
      const status = this.tick(eid, node.children[i], bb, dt);
      if (status === "running") {
        bb.set(key, i);
        return "running";
      }
      if (status === "success") {
        bb.delete(key);
        return "success";
      }
    }
    bb.delete(key);
    return "failure";
  }

  private tickParallel(eid: number, node: BTNode, bb: Blackboard, dt: number): BTStatus {
    if (!node.children) return "success";
    let anyRunning = false;
    let anyFailed = false;
    for (const child of node.children) {
      const status = this.tick(eid, child, bb, dt);
      if (status === "running") anyRunning = true;
      if (status === "failure") anyFailed = true;
    }
    if (anyFailed) return "failure";
    if (anyRunning) return "running";
    return "success";
  }

  private tickDecorator(eid: number, node: BTNode, bb: Blackboard, dt: number): BTStatus {
    if (!node.children || node.children.length === 0) return "failure";
    const childStatus = this.tick(eid, node.children[0], bb, dt);

    switch (node.decorator) {
      case "invert":
        if (childStatus === "success") return "failure";
        if (childStatus === "failure") return "success";
        return "running";
      case "succeedAlways":
        return childStatus === "running" ? "running" : "success";
      case "repeat":
        if (childStatus === "success") return "running";
        return childStatus;
      default:
        return childStatus;
    }
  }

  private tickSubtree(eid: number, node: BTNode, bb: Blackboard, dt: number): BTStatus {
    const treeId = node.treeId ?? node.name;
    const subtree = this.subtrees.get(treeId);
    if (!subtree) return "failure";
    return this.tick(eid, subtree, bb, dt);
  }
}
