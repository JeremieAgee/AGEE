export class BitSet {
  private words: Uint32Array;
  private _size = 0;

  constructor(capacity = 1024) {
    this.words = new Uint32Array((capacity + 31) >>> 5);
  }

  private grow(wordCount: number): void {
    if (wordCount <= this.words.length) return;
    let newLen = this.words.length * 2;
    while (newLen < wordCount) newLen *= 2;
    const fresh = new Uint32Array(newLen);
    fresh.set(this.words);
    this.words = fresh;
  }

  has(id: number): boolean {
    const w = id >>> 5;
    return w < this.words.length && (this.words[w] & (1 << (id & 31))) !== 0;
  }

  add(id: number): void {
    const w = id >>> 5;
    this.grow(w + 1);
    const bit = 1 << (id & 31);
    if (!(this.words[w] & bit)) {
      this.words[w] |= bit;
      this._size++;
    }
  }

  remove(id: number): void {
    const w = id >>> 5;
    if (w >= this.words.length) return;
    const bit = 1 << (id & 31);
    if (this.words[w] & bit) {
      this.words[w] &= ~bit;
      this._size--;
    }
  }

  get size(): number {
    return this._size;
  }

  get rawWords(): Uint32Array {
    return this.words;
  }

  get rawWordCount(): number {
    return this.words.length;
  }

  [Symbol.iterator](): Iterator<number> {
    let wIdx = 0;
    let word = 0;
    const words = this.words;
    const len = words.length;

    while (wIdx < len && words[wIdx] === 0) wIdx++;
    if (wIdx < len) word = words[wIdx];

    return {
      next(): IteratorResult<number> {
        while (wIdx < len) {
          if (word !== 0) {
            const lsb = word & (-word);
            const bitIndex = 31 - Math.clz32(lsb);
            word &= word - 1;
            return { value: (wIdx << 5) + bitIndex, done: false };
          }
          wIdx++;
          if (wIdx < len) word = words[wIdx];
        }
        return { value: undefined as any, done: true };
      },
    };
  }

  toArray(): number[] {
    const result: number[] = [];
    for (const id of this) result.push(id);
    return result;
  }

  clear(): void {
    this.words.fill(0);
    this._size = 0;
  }
}
