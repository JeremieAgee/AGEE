type Listener = (...args: any[]) => void;

export class EventBus {
  private listeners = new Map<string, Listener[]>();

  on(event: string, fn: Listener): () => void {
    let arr = this.listeners.get(event);
    if (!arr) {
      arr = [];
      this.listeners.set(event, arr);
    }
    arr.push(fn);
    return () => this.off(event, fn);
  }

  once(event: string, fn: Listener): () => void {
    const wrapper = (...args: any[]) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, fn: Listener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }

  emit(event: string, ...args: any[]): void {
    const arr = this.listeners.get(event);
    if (!arr || arr.length === 0) return;
    const snapshot = arr.slice();
    for (let i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i](...args);
      } catch (e) {
        console.error(`[AGEE] EventBus listener for "${event}" threw:`, e);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
