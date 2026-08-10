export type FSMTransitionGuard = (eid: number, blackboard: Map<string, any>) => boolean;
export type FSMStateCallback = (eid: number, dt: number, blackboard: Map<string, any>) => void;

export interface FSMTransition {
  to: string;
  guard: FSMTransitionGuard;
  priority?: number;
}

export interface FSMState {
  name: string;
  onEnter?: FSMStateCallback;
  onUpdate?: FSMStateCallback;
  onExit?: FSMStateCallback;
  transitions: FSMTransition[];
}

export interface FSMDefinition {
  name: string;
  initialState: string;
  states: Map<string, FSMState>;
}

export class FSMBuilder {
  private name: string;
  private initial = "";
  private states = new Map<string, FSMState>();

  constructor(name: string) {
    this.name = name;
  }

  state(
    name: string,
    callbacks?: {
      onEnter?: FSMStateCallback;
      onUpdate?: FSMStateCallback;
      onExit?: FSMStateCallback;
    }
  ): FSMStateBuilder {
    const state: FSMState = {
      name,
      onEnter: callbacks?.onEnter,
      onUpdate: callbacks?.onUpdate,
      onExit: callbacks?.onExit,
      transitions: [],
    };
    this.states.set(name, state);
    if (!this.initial) this.initial = name;
    return new FSMStateBuilder(this, state);
  }

  setInitial(name: string): this {
    this.initial = name;
    return this;
  }

  build(): FSMDefinition {
    if (!this.states.has(this.initial)) {
      throw new Error(`[AGEE] FSM "${this.name}": initial state "${this.initial}" not found`);
    }
    return { name: this.name, initialState: this.initial, states: this.states };
  }
}

export class FSMStateBuilder {
  constructor(
    private builder: FSMBuilder,
    private stateRef: FSMState
  ) {}

  transition(to: string, guard: FSMTransitionGuard, priority = 0): this {
    this.stateRef.transitions.push({ to, guard, priority });
    this.stateRef.transitions.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return this;
  }

  state(
    name: string,
    callbacks?: {
      onEnter?: FSMStateCallback;
      onUpdate?: FSMStateCallback;
      onExit?: FSMStateCallback;
    }
  ): FSMStateBuilder {
    return this.builder.state(name, callbacks);
  }

  setInitial(name: string): FSMBuilder {
    return this.builder.setInitial(name);
  }

  build(): FSMDefinition {
    return this.builder.build();
  }
}

export interface FSMInstance {
  definition: FSMDefinition;
  currentState: string;
  previousState: string;
  timeInState: number;
  blackboard: Map<string, any>;
  stateChangeCount: number;
}

export class FSMRunner {
  createInstance(definition: FSMDefinition): FSMInstance {
    return {
      definition,
      currentState: definition.initialState,
      previousState: "",
      timeInState: 0,
      blackboard: new Map(),
      stateChangeCount: 0,
    };
  }

  tick(eid: number, instance: FSMInstance, dt: number): string {
    const state = instance.definition.states.get(instance.currentState);
    if (!state) return instance.currentState;

    for (const transition of state.transitions) {
      if (transition.guard(eid, instance.blackboard)) {
        // A transition targeting the state we're already in is a no-op, not a real state
        // change: without this guard, a persistent self-transition guard would fire
        // onExit -> onEnter -> onUpdate and reset timeInState every single tick it stays true,
        // even though nothing about the FSM's state actually changed. Fall through to the
        // normal "no transition matched" handling below instead (still runs onUpdate, keeps
        // accumulating timeInState).
        if (transition.to === instance.currentState) break;

        const nextState = instance.definition.states.get(transition.to);
        if (!nextState) continue;

        state.onExit?.(eid, dt, instance.blackboard);
        instance.previousState = instance.currentState;
        instance.currentState = transition.to;
        instance.timeInState = 0;
        instance.stateChangeCount++;
        nextState.onEnter?.(eid, dt, instance.blackboard);

        nextState.onUpdate?.(eid, dt, instance.blackboard);
        return instance.currentState;
      }
    }

    instance.timeInState += dt;
    state.onUpdate?.(eid, dt, instance.blackboard);
    return instance.currentState;
  }

  forceState(eid: number, instance: FSMInstance, stateName: string, dt: number = 0): void {
    const oldState = instance.definition.states.get(instance.currentState);
    const newState = instance.definition.states.get(stateName);
    if (!newState) return;

    oldState?.onExit?.(eid, dt, instance.blackboard);
    instance.previousState = instance.currentState;
    instance.currentState = stateName;
    instance.timeInState = 0;
    instance.stateChangeCount++;
    newState.onEnter?.(eid, dt, instance.blackboard);
    // Matches tick()'s guard-driven transition, which also runs onUpdate right after
    // onEnter on the tick a transition happens -- forceState skipping it was inconsistent.
    newState.onUpdate?.(eid, dt, instance.blackboard);
  }
}
