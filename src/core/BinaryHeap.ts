// Generic binary min-heap over arbitrary values with a numeric score. No capacity bound and
// no decrease-key/contains support — for callers that only ever push newly-computed entries
// and never need to look one up or re-prioritize it once queued (e.g. GOAPPlanner's A* open
// set, which pushes a fresh node for every cheaper route to a state instead of mutating one
// already in the heap). Callers that DO need decrease-key/contains over a bounded integer key
// space (e.g. NavigationSystem's grid A*) should extend this and add positional tracking on
// top via the onSwap hook — see navigation/BinaryHeap.ts.
export class MinHeap<T> {
  protected values: T[] = [];
  protected scores: number[] = [];

  get length(): number {
    return this.values.length;
  }

  push(value: T, score: number): void {
    const idx = this.values.length;
    this.values.push(value);
    this.scores.push(score);
    this.bubbleUp(idx);
  }

  pop(): T | undefined {
    const values = this.values, scores = this.scores;
    if (values.length === 0) return undefined;
    const top = values[0];
    const lastValue = values.pop() as T;
    const lastScore = scores.pop() as number;
    if (values.length > 0) {
      values[0] = lastValue;
      scores[0] = lastScore;
      this.onSwap(0);
      this.sinkDown(0);
    }
    return top;
  }

  clear(): void {
    this.values.length = 0;
    this.scores.length = 0;
  }

  protected bubbleUp(idx: number): void {
    const scores = this.scores;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (scores[idx] >= scores[parent]) break;
      this.swap(idx, parent);
      idx = parent;
    }
  }

  protected sinkDown(idx: number): void {
    const scores = this.scores;
    const n = scores.length;
    while (true) {
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      let smallest = idx;
      if (left < n && scores[left] < scores[smallest]) smallest = left;
      if (right < n && scores[right] < scores[smallest]) smallest = right;
      if (smallest === idx) break;
      this.swap(idx, smallest);
      idx = smallest;
    }
  }

  protected swap(a: number, b: number): void {
    const values = this.values, scores = this.scores;
    const tv = values[a], ts = scores[a];
    values[a] = values[b]; scores[a] = scores[b];
    values[b] = tv; scores[b] = ts;
    this.onSwap(a);
    this.onSwap(b);
  }

  // Hook for subclasses that need to know a value's current heap index (e.g. to keep a
  // reverse lookup for decreaseKey/contains in sync). No-op here since the base heap never
  // looks a value up by identity.
  protected onSwap(_idx: number): void {}
}
