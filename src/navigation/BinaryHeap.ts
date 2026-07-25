export class BinaryHeap {
  private heap: Int32Array;
  private scores: Float32Array;
  private positions: Int32Array;
  private size = 0;

  constructor(capacity: number) {
    this.heap = new Int32Array(capacity);
    this.scores = new Float32Array(capacity);
    this.positions = new Int32Array(capacity).fill(-1);
  }

  get length(): number { return this.size; }

  push(value: number, score: number): void {
    const idx = this.size;
    this.heap[idx] = value;
    this.scores[idx] = score;
    this.positions[value] = idx;
    this.size++;
    this.bubbleUp(idx);
  }

  pop(): number {
    if (this.size === 0) return -1;
    const result = this.heap[0];
    this.positions[result] = -1;
    this.size--;

    if (this.size > 0) {
      this.heap[0] = this.heap[this.size];
      this.scores[0] = this.scores[this.size];
      this.positions[this.heap[0]] = 0;
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

  clear(): void {
    for (let i = 0; i < this.size; i++) {
      this.positions[this.heap[i]] = -1;
    }
    this.size = 0;
  }

  private bubbleUp(idx: number): void {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.scores[idx] >= this.scores[parent]) break;

      this.swap(idx, parent);
      idx = parent;
    }
  }

  private sinkDown(idx: number): void {
    while (true) {
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      let smallest = idx;

      if (left < this.size && this.scores[left] < this.scores[smallest]) {
        smallest = left;
      }
      if (right < this.size && this.scores[right] < this.scores[smallest]) {
        smallest = right;
      }

      if (smallest === idx) break;
      this.swap(idx, smallest);
      idx = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const tmpVal = this.heap[a];
    const tmpScore = this.scores[a];

    this.heap[a] = this.heap[b];
    this.scores[a] = this.scores[b];

    this.heap[b] = tmpVal;
    this.scores[b] = tmpScore;

    this.positions[this.heap[a]] = a;
    this.positions[this.heap[b]] = b;
  }
}
