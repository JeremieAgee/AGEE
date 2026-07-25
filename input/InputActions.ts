import { InputSystem } from "./InputSystem";

export interface ActionBinding {
  keys?: string[];
  mouseButtons?: number[];
  gamepadButtons?: number[];
  gamepadAxis?: { index: number; threshold: number; positive: boolean };
}

export class InputActions {
  private actions = new Map<string, ActionBinding[]>();
  private input: InputSystem;

  constructor(input: InputSystem) {
    this.input = input;
  }

  bind(action: string, ...bindings: ActionBinding[]): void {
    const existing = this.actions.get(action) ?? [];
    existing.push(...bindings);
    this.actions.set(action, existing);
  }

  unbind(action: string): void {
    this.actions.delete(action);
  }

  isDown(action: string): boolean {
    const bindings = this.actions.get(action);
    if (!bindings) return false;

    for (const b of bindings) {
      if (b.keys) {
        for (const k of b.keys) {
          if (this.input.isKeyDown(k)) return true;
        }
      }
      if (b.mouseButtons) {
        for (const btn of b.mouseButtons) {
          if (this.input.isMouseDown(btn)) return true;
        }
      }
      if (b.gamepadButtons) {
        const pad = this.input.getGamepad(0);
        if (pad) {
          for (const btn of b.gamepadButtons) {
            if (pad.buttons[btn]) return true;
          }
        }
      }
      if (b.gamepadAxis) {
        const pad = this.input.getGamepad(0);
        if (pad) {
          const val = pad.axes[b.gamepadAxis.index] ?? 0;
          if (b.gamepadAxis.positive && val > b.gamepadAxis.threshold) return true;
          if (!b.gamepadAxis.positive && val < -b.gamepadAxis.threshold) return true;
        }
      }
    }
    return false;
  }

  isPressed(action: string): boolean {
    const bindings = this.actions.get(action);
    if (!bindings) return false;

    for (const b of bindings) {
      if (b.keys) {
        for (const k of b.keys) {
          if (this.input.isKeyPressed(k)) return true;
        }
      }
      if (b.mouseButtons) {
        for (const btn of b.mouseButtons) {
          if (this.input.isMousePressed(btn)) return true;
        }
      }
    }
    return false;
  }

  getAxis(negative: string, positive: string): number {
    let val = 0;
    if (this.isDown(negative)) val -= 1;
    if (this.isDown(positive)) val += 1;
    return val;
  }

  getAxis2D(
    negX: string, posX: string,
    negY: string, posY: string
  ): { x: number; y: number } {
    let x = 0, y = 0;
    if (this.isDown(negX)) x -= 1;
    if (this.isDown(posX)) x += 1;
    if (this.isDown(negY)) y -= 1;
    if (this.isDown(posY)) y += 1;

    const len = Math.sqrt(x * x + y * y);
    if (len > 1) { x /= len; y /= len; }

    return { x, y };
  }

  static defaultBindings(actions: InputActions): void {
    actions.bind("moveForward", { keys: ["w", "arrowup"] });
    actions.bind("moveBackward", { keys: ["s", "arrowdown"] });
    actions.bind("moveLeft", { keys: ["a", "arrowleft"] });
    actions.bind("moveRight", { keys: ["d", "arrowright"] });
    actions.bind("jump", { keys: [" "] });
    actions.bind("interact", { keys: ["e", "f"] });
    actions.bind("attack", { mouseButtons: [0] });
    actions.bind("aim", { mouseButtons: [2] });
    actions.bind("sprint", { keys: ["shift"] });
    actions.bind("crouch", { keys: ["control", "c"] });
    actions.bind("inventory", { keys: ["i", "tab"] });
    actions.bind("pause", { keys: ["escape"] });
  }
}
