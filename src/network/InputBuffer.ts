import { InputPayload, NETWORK_CONSTANTS } from "./NetworkTypes";

export class InputBuffer {
  private buffer: (InputPayload | null)[];
  private _oldest = 0;
  private _newest = -1;

  constructor(private size: number = NETWORK_CONSTANTS.INPUT_BUFFER_SIZE) {
    this.buffer = new Array(size).fill(null);
  }

  push(input: InputPayload): void {
    const idx = input.tick % this.size;
    const existing = this.buffer[idx];
    // A different tick occupying this slot that hasn't been acked yet (i.e. its tick is still
    // at or after the oldest tick we're tracking) is about to be silently destroyed by the
    // wraparound below. That's only safe once the tick has been acknowledged via
    // removeUpTo() — otherwise reconciliation replay would be missing an input it may need.
    if (existing && existing.tick !== input.tick && existing.tick >= this._oldest) {
      console.warn(
        `[InputBuffer] Overwriting unacknowledged input at tick ${existing.tick} with tick ` +
        `${input.tick} on ring-buffer wraparound (size=${this.size}). The input at tick ` +
        `${existing.tick} was never acked via removeUpTo() and is now lost.`
      );
    }
    this.buffer[idx] = input;
    if (this._newest < 0 || input.tick > this._newest) this._newest = input.tick;
    if (this._oldest === 0 && this._newest >= 0) this._oldest = input.tick;
  }

  get(tick: number): InputPayload | null {
    const slot = this.buffer[tick % this.size];
    if (slot && slot.tick === tick) return slot;
    return null;
  }

  getRange(fromTick: number, toTick: number): InputPayload[] {
    const result: InputPayload[] = [];
    for (let t = fromTick; t <= toTick; t++) {
      const input = this.get(t);
      if (input) result.push(input);
    }
    return result;
  }

  removeUpTo(tick: number): void {
    for (let t = this._oldest; t <= tick; t++) {
      const idx = t % this.size;
      if (this.buffer[idx] && this.buffer[idx]!.tick <= tick) {
        this.buffer[idx] = null;
      }
    }
    if (tick >= this._oldest) {
      this._oldest = tick + 1;
    }
  }

  clear(): void {
    this.buffer.fill(null);
    this._oldest = 0;
    this._newest = -1;
  }

  get oldestTick(): number { return this._oldest; }
  get newestTick(): number { return this._newest; }
  get count(): number {
    let n = 0;
    for (let i = 0; i < this.size; i++) {
      if (this.buffer[i] !== null) n++;
    }
    return n;
  }
}
