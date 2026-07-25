import { System } from "../ecs";

export interface MouseState {
  x: number;
  y: number;
  dx: number;
  dy: number;
  buttons: Set<number>;
  wheel: number;
  locked: boolean;
}

export interface GamepadState {
  connected: boolean;
  axes: number[];
  buttons: boolean[];
}

const DEFAULT_DEAD_ZONE = 0.15;

export class InputSystem extends System {
  priority = 0;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "prePhysics";

  static reads: string[] = [];
  static writes: string[] = [];

  private keysDown = new Set<string>();
  private keysPressed = new Set<string>();
  private keysReleased = new Set<string>();
  private mousePressed = new Set<number>();
  private mouseReleased = new Set<number>();

  // Input buffering: store presses for configurable frame count
  private keyPressBuffer = new Map<string, number>();
  private bufferFrames = 2;

  readonly mouse: MouseState = {
    x: 0, y: 0, dx: 0, dy: 0,
    buttons: new Set(),
    wheel: 0,
    locked: false,
  };

  readonly gamepads: GamepadState[] = [];
  deadZone = DEFAULT_DEAD_ZONE;
  private element: HTMLElement;

  constructor(element?: HTMLElement) {
    super();
    this.element = element ?? document.body;
  }

  setBufferFrames(frames: number): void {
    this.bufferFrames = Math.max(0, Math.floor(frames));
  }

  init(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.element.addEventListener("mousedown", this.onMouseDown);
    this.element.addEventListener("mouseup", this.onMouseUp);
    this.element.addEventListener("mousemove", this.onMouseMove);
    this.element.addEventListener("wheel", this.onWheel, { passive: true });
    this.element.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
  }

  isKeyDown(key: string): boolean {
    return this.keysDown.has(key.toLowerCase());
  }

  isKeyPressed(key: string): boolean {
    return this.keysPressed.has(key.toLowerCase());
  }

  isKeyBuffered(key: string): boolean {
    const remaining = this.keyPressBuffer.get(key.toLowerCase());
    return remaining !== undefined && remaining > 0;
  }

  isKeyReleased(key: string): boolean {
    return this.keysReleased.has(key.toLowerCase());
  }

  isMouseDown(button: number = 0): boolean {
    return this.mouse.buttons.has(button);
  }

  isMousePressed(button: number = 0): boolean {
    return this.mousePressed.has(button);
  }

  isMouseReleased(button: number = 0): boolean {
    return this.mouseReleased.has(button);
  }

  requestPointerLock(): void {
    this.element.requestPointerLock();
  }

  exitPointerLock(): void {
    document.exitPointerLock();
  }

  getGamepad(index: number = 0): GamepadState | null {
    return this.gamepads[index] ?? null;
  }

  private applyDeadZone(value: number): number {
    if (Math.abs(value) < this.deadZone) return 0;
    // Remap remaining range to 0–1 for smooth response
    const sign = Math.sign(value);
    return sign * (Math.abs(value) - this.deadZone) / (1 - this.deadZone);
  }

  update(_dt: number): void {
    const pads = navigator.getGamepads();

    // Mark all tracked gamepads as disconnected first, then reconnect found ones
    for (let i = 0; i < this.gamepads.length; i++) {
      if (this.gamepads[i]) {
        this.gamepads[i].connected = false;
      }
    }

    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad) continue;
      if (!this.gamepads[i]) {
        this.gamepads[i] = { connected: true, axes: [], buttons: [] };
      }
      this.gamepads[i].connected = true;
      this.gamepads[i].axes = Array.from(pad.axes).map((v) => this.applyDeadZone(v));
      this.gamepads[i].buttons = pad.buttons.map((b) => b.pressed);
    }

    // Clear stale state on disconnected gamepads
    for (let i = 0; i < this.gamepads.length; i++) {
      if (this.gamepads[i] && !this.gamepads[i].connected) {
        this.gamepads[i].axes = this.gamepads[i].axes.map(() => 0);
        this.gamepads[i].buttons = this.gamepads[i].buttons.map(() => false);
      }
    }
  }

  endFrame(): void {
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;

    // Decrement buffer counters
    for (const [key, remaining] of this.keyPressBuffer) {
      if (remaining <= 1) {
        this.keyPressBuffer.delete(key);
      } else {
        this.keyPressBuffer.set(key, remaining - 1);
      }
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const key = e.key.toLowerCase();
    if (!this.keysDown.has(key)) {
      this.keysPressed.add(key);
      this.keyPressBuffer.set(key, this.bufferFrames);
    }
    this.keysDown.add(key);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const key = e.key.toLowerCase();
    this.keysDown.delete(key);
    this.keysReleased.add(key);
  };

  private onMouseDown = (e: MouseEvent): void => {
    this.mouse.buttons.add(e.button);
    this.mousePressed.add(e.button);
  };

  private onMouseUp = (e: MouseEvent): void => {
    this.mouse.buttons.delete(e.button);
    this.mouseReleased.add(e.button);
  };

  private onMouseMove = (e: MouseEvent): void => {
    this.mouse.dx += e.movementX;
    this.mouse.dy += e.movementY;
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
  };

  private onWheel = (e: WheelEvent): void => {
    this.mouse.wheel += e.deltaY;
  };

  private onPointerLockChange = (): void => {
    this.mouse.locked = document.pointerLockElement === this.element;
  };

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.element.removeEventListener("mousedown", this.onMouseDown);
    this.element.removeEventListener("mouseup", this.onMouseUp);
    this.element.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
  }
}
