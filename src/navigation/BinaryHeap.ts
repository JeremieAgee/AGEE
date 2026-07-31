import { MinHeap } from "../core/BinaryHeap";

// Specializes the shared MinHeap for A* over a bounded integer node-ID space (grid cell
// indices): adds an O(1) positions lookup so the pathfinder can ask "is this cell already
// queued?" (contains) and re-prioritize one already in the heap (decreaseKey) without a linear
// scan. Sized to a fixed capacity and reused across every findPath() call by NavigationSystem
// instead of being reallocated per call.
export class BinaryHeap extends MinHeap<number> {
  private positions: Int32Array;

  constructor(capacity: number) {
    super();
    this.positions = new Int32Array(capacity).fill(-1);
  }

  override push(value: number, score: number): void {
    const idx = this.values.length;
    this.values.push(value);
    this.scores.push(score);
    this.positions[value] = idx;
    this.bubbleUp(idx);
  }

  override pop(): number {
    const values = this.values, scores = this.scores;
    if (values.length === 0) return -1;
    const result = values[0];
    this.positions[result] = -1;

    const lastValue = values.pop() as number;
    const lastScore = scores.pop() as number;
    if (values.length > 0) {
      values[0] = lastValue;
      scores[0] = lastScore;
      this.positions[lastValue] = 0;
      this.sinkDown(0);
    }

    return result;
  }

  contains(value: number): boolean {
    return value < this.positions.length && this.positions[value] >= 0;
  }

  decreaseKey(value: number, newScore: number): void {
    const idx = this.positions[value];
    if (idx < 0) return;
    this.scores[idx] = newScore;
    this.bubbleUp(idx);
  }

  override clear(): void {
    for (let i = 0; i < this.values.length; i++) {
      this.positions[this.values[i]] = -1;
    }
    super.clear();
  }

  protected override onSwap(idx: number): void {
    this.positions[this.values[idx]] = idx;
  }
}
