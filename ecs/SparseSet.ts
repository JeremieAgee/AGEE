export class SparseSet {
  private sparse: (number | undefined)[] = [];
  private dense: number[] = [];

  get size(): number {
    return this.dense.length;
  }

  has(id: number): boolean {
    const idx = this.sparse[id];
    return idx !== undefined && idx < this.dense.length && this.dense[idx] === id;
  }

  add(id: number): void {
    if (this.has(id)) return;
    this.sparse[id] = this.dense.length;
    this.dense.push(id);
  }

  remove(id: number): void {
    if (!this.has(id)) return;
    const idx = this.sparse[id]!;
    const last = this.dense[this.dense.length - 1];
    this.dense[idx] = last;
    this.sparse[last] = idx;
    this.dense.pop();
    this.sparse[id] = undefined;
  }

  [Symbol.iterator](): Iterator<number> {
    let i = 0;
    const dense = this.dense;
    return {
      next(): IteratorResult<number> {
        if (i < dense.length) {
          return { value: dense[i++], done: false };
        }
        return { value: undefined as any, done: true };
      },
    };
  }

  toArray(): number[] {
    return this.dense.slice();
  }

  clear(): void {
    this.sparse.length = 0;
    this.dense.length = 0;
  }
}
