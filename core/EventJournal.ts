type EventId = number;

interface EventDef<T = unknown> {
  readonly id: EventId;
  readonly name: string;
  readonly _phantom?: T;
}

let nextEventId = 0;

export function defineEvent<T = void>(name: string): EventDef<T> {
  return { id: nextEventId++, name };
}

type Listener<T> = (payload: T) => void;

interface QueuedEvent {
  eventId: EventId;
  payload: unknown;
  frame: number;
}

interface ListenerEntry<T = unknown> {
  fn: Listener<T>;
  priority: number;
  once: boolean;
}

export class EventJournal {
  private listeners = new Map<EventId, ListenerEntry[]>();
  private queue: QueuedEvent[] = [];
  private swapQueue: QueuedEvent[] = [];
  private journal: QueuedEvent[] = [];
  private journalEnabled = false;
  private currentFrame = 0;
  private flushing = false;

  enableJournal(enabled: boolean): void {
    this.journalEnabled = enabled;
    if (!enabled) this.journal.length = 0;
  }

  on<T>(event: EventDef<T>, fn: Listener<T>, priority: number = 0): () => void {
    let arr = this.listeners.get(event.id);
    if (!arr) {
      arr = [];
      this.listeners.set(event.id, arr);
    }
    const entry: ListenerEntry<T> = { fn, priority, once: false };
    arr.push(entry as ListenerEntry);
    arr.sort((a, b) => a.priority - b.priority);
    return () => this.removeListener(event.id, fn as Listener<unknown>);
  }

  once<T>(event: EventDef<T>, fn: Listener<T>, priority: number = 0): () => void {
    let arr = this.listeners.get(event.id);
    if (!arr) {
      arr = [];
      this.listeners.set(event.id, arr);
    }
    const entry: ListenerEntry<T> = { fn, priority, once: true };
    arr.push(entry as ListenerEntry);
    arr.sort((a, b) => a.priority - b.priority);
    return () => this.removeListener(event.id, fn as Listener<unknown>);
  }

  private removeListener(eventId: EventId, fn: Listener<unknown>): void {
    const arr = this.listeners.get(eventId);
    if (!arr) return;
    const idx = arr.findIndex(e => e.fn === fn);
    if (idx !== -1) arr.splice(idx, 1);
  }

  emit<T>(event: EventDef<T>, payload: T): void {
    const entry: QueuedEvent = {
      eventId: event.id,
      payload,
      frame: this.currentFrame,
    };

    if (this.flushing) {
      this.swapQueue.push(entry);
    } else {
      this.queue.push(entry);
    }

    if (this.journalEnabled) {
      this.journal.push(entry);
    }
  }

  emitImmediate<T>(event: EventDef<T>, payload: T): void {
    if (this.journalEnabled) {
      this.journal.push({ eventId: event.id, payload, frame: this.currentFrame });
    }
    this.dispatch(event.id, payload);
  }

  flush(): void {
    this.flushing = true;

    while (this.queue.length > 0) {
      const batch = this.queue;
      this.queue = this.swapQueue;
      this.swapQueue = [];

      for (let i = 0; i < batch.length; i++) {
        this.dispatch(batch[i].eventId, batch[i].payload);
      }

      batch.length = 0;
      this.swapQueue = batch;
    }

    if (this.swapQueue.length > 0) {
      const remaining = this.swapQueue;
      this.swapQueue = [];
      for (let i = 0; i < remaining.length; i++) {
        this.queue.push(remaining[i]);
      }
    }

    this.flushing = false;
  }

  advanceFrame(): void {
    this.currentFrame++;
  }

  private dispatch(eventId: EventId, payload: unknown): void {
    const arr = this.listeners.get(eventId);
    if (!arr || arr.length === 0) return;

    const snapshot = arr.slice();
    for (let i = 0; i < snapshot.length; i++) {
      const entry = snapshot[i];
      try {
        entry.fn(payload);
      } catch (e) {
        console.error(`[AGEE] EventJournal listener threw:`, e);
      }
      if (entry.once) {
        this.removeListener(eventId, entry.fn);
      }
    }
  }

  getJournal(): readonly QueuedEvent[] {
    return this.journal;
  }

  getJournalForEvent(eventId: EventId): QueuedEvent[] {
    return this.journal.filter(e => e.eventId === eventId);
  }

  clearJournal(): void {
    this.journal.length = 0;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get frame(): number {
    return this.currentFrame;
  }

  clear(): void {
    this.listeners.clear();
    this.queue.length = 0;
    this.swapQueue.length = 0;
    this.journal.length = 0;
    this.currentFrame = 0;
  }
}
