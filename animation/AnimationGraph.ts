import * as THREE from "three";
import { AnimClipHandle } from "../core/handles/ResourceManager";

export interface AnimationStateConfig {
  name: string;
  clipHandle: AnimClipHandle;
  speed: number;
  loop: boolean;
}

export interface AnimationTransitionConfig {
  from: string;
  to: string;
  duration: number;
  condition: (params: Map<string, number>) => boolean;
}

export class AnimationGraph {
  readonly states = new Map<string, AnimationStateConfig>();
  readonly transitions: AnimationTransitionConfig[] = [];
  readonly parameters = new Map<string, number>();
  currentState: string = "";

  addState(config: AnimationStateConfig): this {
    this.states.set(config.name, config);
    if (!this.currentState) this.currentState = config.name;
    return this;
  }

  addTransition(config: AnimationTransitionConfig): this {
    this.transitions.push(config);
    return this;
  }

  setParam(name: string, value: number): void {
    this.parameters.set(name, value);
  }

  getParam(name: string): number {
    return this.parameters.get(name) ?? 0;
  }

  evaluate(): string | null {
    for (const t of this.transitions) {
      if (t.from === this.currentState && t.condition(this.parameters)) {
        return t.to;
      }
    }
    return null;
  }
}
