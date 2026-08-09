export abstract class GameState {
  abstract enter(): void;
  abstract exit(): void;
  abstract update(dt: number): void;
  pause?(): void;
  resume?(): void;
}

export class GameStateManager {
  private stack: GameState[] = [];

  get current(): GameState | null {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
  }

  push(state: GameState): void {
    this.current?.pause?.();
    this.stack.push(state);
    state.enter();
  }

  pop(): GameState | null {
    const state = this.stack.pop() ?? null;
    state?.exit();
    this.current?.resume?.();
    return state;
  }

  switch(state: GameState): void {
    this.current?.exit();
    if (this.stack.length > 0) {
      this.stack[this.stack.length - 1] = state;
    } else {
      this.stack.push(state);
    }
    state.enter();
  }

  replace(state: GameState): void {
    while (this.stack.length > 0) {
      this.stack.pop()!.exit();
    }
    this.stack.push(state);
    state.enter();
  }

  update(dt: number): void {
    this.current?.update(dt);
  }

  clear(): void {
    while (this.stack.length > 0) {
      this.stack.pop()!.exit();
    }
  }
}
