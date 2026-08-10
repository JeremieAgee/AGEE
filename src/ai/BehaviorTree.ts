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

  get size(): number {
    return this.data.size;
  }

  /** Read-only view of every key/value currently on the blackboard, for debugging/inspection
   *  tools (e.g. AIDebugPanel) that need to enumerate arbitrary runtime-set entries without
   *  reaching into the private `data` map directly via `as any`. Iterating the returned
   *  iterable does not mutate the blackboard. */
  entries(): IterableIterator<[string, any]> {
    return this.data.entries();
  }
}

export type ActionFn = (eid: number, bb: Blackboard, dt: number) => BTStatus;
export type ConditionFn = (eid: number, bb: Blackboard) => boolean;

export class BehaviorTreeRunner {
  private actions = new Map<string, ActionFn>();
  private conditions = new Map<string, ConditionFn>();
  private subtrees = new Map<string, BTNode>();
  private runningChildKey = "__bt_running_";

  // Per-node-instance identity: two structurally distinct BTNode objects that happen to
  // share the same `name` (e.g. two independently-authored "patrol" sequences nested under
  // a Parallel) must never collide on the same blackboard key. Ids are assigned lazily,
  // first-seen node for a given name keeps the bare name (so existing single-instance
  // trees keep their familiar "__bt_running_<name>" keys); any later node sharing that name
  // gets a disambiguating suffix.
  private nodeIds = new WeakMap<BTNode, string>();
  private claimedNames = new Set<string>();
  private nameCollisions = new Map<string, number>();

  private getNodeId(node: BTNode): string {
    let id = this.nodeIds.get(node);
    if (id !== undefined) return id;
    const base = node.name;
    if (!this.claimedNames.has(base)) {
      this.claimedNames.add(base);
      id = base;
    } else {
      const n = (this.nameCollisions.get(base) ?? 1) + 1;
      this.nameCollisions.set(base, n);
      id = `${base}#${n}`;
    }
    this.nodeIds.set(node, id);
    return id;
  }

  private runningKey(node: BTNode): string {
    return this.runningChildKey + this.getNodeId(node);
  }

  private shadowKey(node: BTNode): string {
    return this.runningKey(node) + "$shadow";
  }

  private resetFlagKey(node: BTNode): string {
    return this.runningKey(node) + "$reset";
  }

  // If `node` has been marked for reset (because its parent moved on from it without it
  // ever naturally completing -- e.g. an external abort/interrupt switched a Selector to a
  // different branch), clear its own running/shadow state so it starts fresh next tick, and
  // cascade the mark down to its children so any nested running-state is cleared too, lazily,
  // as each of them is next reached.
  private consumeResetFlag(node: BTNode, bb: Blackboard): void {
    const flag = this.resetFlagKey(node);
    if (!bb.get<boolean>(flag)) return;
    bb.delete(flag);
    bb.delete(this.runningKey(node));
    bb.delete(this.shadowKey(node));
    if (node.children) {
      for (const child of node.children) this.markForReset(child, bb);
    }
  }

  private markForReset(node: BTNode, bb: Blackboard): void {
    bb.set(this.resetFlagKey(node), true);
  }

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
    this.consumeResetFlag(node, bb);
    const key = this.runningKey(node);
    const shadow = this.shadowKey(node);
    let startIdx = bb.get<number>(key) ?? 0;

    // Detect an external change to `key` between ticks (e.g. something outside the tree
    // forcing a resume point) that skips past the child we ourselves last recorded as
    // running -- that child's own nested running-state is now stale and needs clearing.
    const prevOwn = bb.get<number>(shadow);
    if (prevOwn !== undefined && prevOwn !== startIdx && node.children[prevOwn]) {
      this.markForReset(node.children[prevOwn], bb);
    }

    for (let i = startIdx; i < node.children.length; i++) {
      const status = this.tick(eid, node.children[i], bb, dt);
      if (status === "running") {
        bb.set(key, i);
        bb.set(shadow, i);
        return "running";
      }
      if (status === "failure") {
        bb.delete(key);
        bb.delete(shadow);
        return "failure";
      }
    }
    bb.delete(key);
    bb.delete(shadow);
    return "success";
  }

  private tickSelector(eid: number, node: BTNode, bb: Blackboard, dt: number): BTStatus {
    if (!node.children) return "failure";
    this.consumeResetFlag(node, bb);
    const key = this.runningKey(node);
    const shadow = this.shadowKey(node);
    let startIdx = bb.get<number>(key) ?? 0;

    // Same interrupt detection as tickSequence: if something switched us to a different
    // resume index than the one we last recorded ourselves, the branch we abandoned still
    // has stale nested running-state that needs to be cleared (lazily, on its next tick).
    const prevOwn = bb.get<number>(shadow);
    if (prevOwn !== undefined && prevOwn !== startIdx && node.children[prevOwn]) {
      this.markForReset(node.children[prevOwn], bb);
    }

    for (let i = startIdx; i < node.children.length; i++) {
      const status = this.tick(eid, node.children[i], bb, dt);
      if (status === "running") {
        bb.set(key, i);
        bb.set(shadow, i);
        return "running";
      }
      if (status === "success") {
        bb.delete(key);
        bb.delete(shadow);
        return "success";
      }
    }
    bb.delete(key);
    bb.delete(shadow);
    return "failure";
  }

  private tickParallel(eid: number, node: BTNode, bb: Blackboard, dt: number): BTStatus {
    if (!node.children) return "success";
    this.consumeResetFlag(node, bb);
    const key = this.runningKey(node);

    // Per-child completed status, so a child that already returned success/failure isn't
    // re-ticked (re-running its side effects) every frame just because a sibling is still
    // running — unlike Sequence/Selector, Parallel ticks every child, so it needs its own
    // completion memory rather than a single startIdx.
    let completed = bb.get<(BTStatus | undefined)[]>(key);
    if (!completed) {
      completed = new Array(node.children.length).fill(undefined);
      bb.set(key, completed);
    }

    let anyRunning = false;
    let anyFailed = false;

    for (let i = 0; i < node.children.length; i++) {
      let status = completed[i];
      if (status === undefined) {
        status = this.tick(eid, node.children[i], bb, dt);
        if (status !== "running") completed[i] = status;
      }
      if (status === "running") anyRunning = true;
      if (status === "failure") anyFailed = true;
    }

    if (anyRunning) return "running";

    bb.delete(key);
    return anyFailed ? "failure" : "success";
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
