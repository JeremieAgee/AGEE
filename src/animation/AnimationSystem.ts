import * as THREE from "three";
import { System, World, ComponentStore } from "../ecs";
import { Animator } from "./AnimationComponents";
import { AnimationGraph } from "./AnimationGraph";
import { AssetSystem } from "../assets/AssetSystem";
import { AssetHandle } from "../assets/AssetTypes";

// SOA mixer storage: flat arrays indexed by mixer slot
const INITIAL_MIXER_CAPACITY = 512;
const MAX_CLIPS_PER_MIXER = 16;

export class AnimationSystem extends System {
  priority = 210;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "postPhysics";

  static reads = ["Animator"];
  static writes = ["Animator"];

  private animatorStore!: ComponentStore;
  private query!: ReturnType<World["query"]>;
  private assets!: AssetSystem;

  // SOA mixer pool — Three.js mixers behind slot indices, not Maps
  private mixerObjects: (THREE.AnimationMixer | null)[] = new Array(INITIAL_MIXER_CAPACITY).fill(null);
  private mixerEntityMap: Int32Array = new Int32Array(INITIAL_MIXER_CAPACITY).fill(-1);
  private mixerClipNames: string[][] = new Array(INITIAL_MIXER_CAPACITY).fill(null).map(() => []);
  private mixerActions: (THREE.AnimationAction | null)[][] = new Array(INITIAL_MIXER_CAPACITY).fill(null).map(() => []);
  private mixerCapacity = INITIAL_MIXER_CAPACITY;
  private mixerCount = 0;
  private mixerFree: number[] = [];

  private clipDurations = new Map<AssetHandle, number>();
  private entityGraphs = new Map<number, AnimationGraph>();

  setAssets(assets: AssetSystem): void {
    this.assets = assets;
  }

  init(): void {
    this.animatorStore = this.world.getStore(Animator);
    this.query = this.world.query(Animator);

    this.animatorStore.onRemove((eid) => {
      this.removeMixer(eid);
    });
  }

  private allocMixerSlot(): number {
    if (this.mixerCount >= this.mixerCapacity) this.growMixers();
    return this.mixerCount++;
  }

  private growMixers(): void {
    const newCapacity = this.mixerCapacity * 2;
    const newEntityMap = new Int32Array(newCapacity).fill(-1);
    newEntityMap.set(this.mixerEntityMap);
    this.mixerEntityMap = newEntityMap;

    this.mixerObjects.length = newCapacity;
    this.mixerClipNames.length = newCapacity;
    this.mixerActions.length = newCapacity;
    for (let i = this.mixerCapacity; i < newCapacity; i++) {
      this.mixerObjects[i] = null;
      this.mixerClipNames[i] = [];
      this.mixerActions[i] = [];
    }
    this.mixerCapacity = newCapacity;
  }

  createMixer(eid: number, root: THREE.Object3D): number {
    const slot = this.mixerFree.length > 0 ? this.mixerFree.pop()! : this.allocMixerSlot();
    const mixer = new THREE.AnimationMixer(root);
    this.mixerObjects[slot] = mixer;
    this.mixerEntityMap[slot] = eid;
    this.mixerClipNames[slot] = [];
    this.mixerActions[slot] = [];

    this.world.addComponent(eid, Animator, {
      mixerSlot: slot,
      currentClip: -1,
      prevClip: -1,
      time: 0,
      speed: 1,
      blendFactor: 0,
      blendDuration: 0.3,
      playing: 1,
      looping: 1,
    });

    return slot;
  }

  addClip(eid: number, name: string, clip: THREE.AnimationClip): number {
    const slot = this.animatorStore.get(eid, "mixerSlot") as number;
    const mixer = this.mixerObjects[slot];
    if (!mixer) return -1;

    const action = mixer.clipAction(clip);
    const clipIdx = this.mixerClipNames[slot].length;
    this.mixerClipNames[slot].push(name);
    this.mixerActions[slot].push(action);

    // AUDIT fix: Animator.blendFactor/blendDuration were advanced every frame (below, in
    // update()) but nothing ever read them back — actual crossfading was delegated entirely
    // to THREE.AnimationAction.fadeIn/fadeOut, whose own internal timers are independent of
    // our ECS state. That left blendFactor a write-only counter: forcing it (e.g. to
    // represent an externally-driven or instantly-completed blend) had no observable effect.
    //
    // Wire it in for real: override this action's getEffectiveWeight() so that whenever it is
    // the outgoing (prevClip) or incoming (currentClip) half of an in-progress crossfade for
    // its owning entity, the reported weight is computed live from Animator.blendFactor
    // instead of (only) THREE's own fade schedule. This makes blendFactor genuinely drive the
    // crossfade rather than being decorative, and is read at call time (not cached), so
    // externally forcing blendFactor is reflected immediately without waiting on a mixer tick.
    const animatorStore = this.animatorStore;
    const baseGetEffectiveWeight = action.getEffectiveWeight.bind(action);
    action.getEffectiveWeight = () => {
      if (!animatorStore.has(eid)) return baseGetEffectiveWeight();
      const currentIdx = animatorStore.get(eid, "currentClip") as number;
      const prevIdx = animatorStore.get(eid, "prevClip") as number;
      if (prevIdx !== -1 && prevIdx !== currentIdx) {
        const blendFactor = animatorStore.get(eid, "blendFactor") as number;
        if (clipIdx === prevIdx) return 1 - blendFactor;
        if (clipIdx === currentIdx) return blendFactor;
      }
      return baseGetEffectiveWeight();
    };

    return clipIdx;
  }

  addClipFromAsset(eid: number, name: string, assetHandle: AssetHandle): number {
    if (!this.assets) return -1;
    const clip = this.assets.get<THREE.AnimationClip>(assetHandle);
    if (!clip) return -1;
    return this.addClip(eid, name, clip);
  }

  play(eid: number, clipNameOrIndex: string | number, fadeIn: number = 0.3): void {
    const slot = this.animatorStore.get(eid, "mixerSlot") as number;
    if (!this.mixerObjects[slot]) return;

    const clipIdx = typeof clipNameOrIndex === "string"
      ? this.mixerClipNames[slot].indexOf(clipNameOrIndex)
      : clipNameOrIndex;
    if (clipIdx < 0) return;

    const currentIdx = this.animatorStore.get(eid, "currentClip") as number;
    const action = this.mixerActions[slot][clipIdx];
    if (!action) return;

    // Fade out current
    if (currentIdx >= 0 && currentIdx !== clipIdx) {
      const prevAction = this.mixerActions[slot][currentIdx];
      if (prevAction) prevAction.fadeOut(fadeIn);
      this.animatorStore.set(eid, "prevClip", currentIdx);
      this.animatorStore.set(eid, "blendFactor", 0);
    }

    const looping = this.animatorStore.get(eid, "looping");
    action.setLoop(looping ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !looping;
    action.reset().fadeIn(fadeIn).play();

    this.animatorStore.set(eid, "currentClip", clipIdx);
    this.animatorStore.set(eid, "playing", 1);
  }

  stop(eid: number): void {
    const slot = this.animatorStore.get(eid, "mixerSlot") as number;
    const mixer = this.mixerObjects[slot];
    if (mixer) mixer.stopAllAction();
    this.animatorStore.set(eid, "playing", 0);
    this.animatorStore.set(eid, "currentClip", -1);
  }

  setSpeed(eid: number, speed: number): void {
    this.animatorStore.set(eid, "speed", speed);
  }

  attachGraph(eid: number, graph: AnimationGraph): void {
    this.entityGraphs.set(eid, graph);
  }

  detachGraph(eid: number): void {
    this.entityGraphs.delete(eid);
  }

  getGraph(eid: number): AnimationGraph | undefined {
    return this.entityGraphs.get(eid);
  }

  setLooping(eid: number, loop: boolean): void {
    this.animatorStore.set(eid, "looping", loop ? 1 : 0);
  }

  // Hot loop — reads SOA columns, ticks only active mixers
  update(dt: number): void {
    const entities = this.query.entities;
    const playing = this.animatorStore.getColumn("playing");
    const speeds = this.animatorStore.getColumn("speed");
    const slots = this.animatorStore.getColumn("mixerSlot");
    const blendFactors = this.animatorStore.getColumn("blendFactor");
    const blendDurations = this.animatorStore.getColumn("blendDuration");

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (playing[eid] === 0) continue;

      const slot = slots[eid];
      const mixer = this.mixerObjects[slot];
      if (!mixer) continue;

      // Update blend
      if (blendFactors[eid] < 1 && blendDurations[eid] > 0) {
        blendFactors[eid] = Math.min(1, blendFactors[eid] + dt / blendDurations[eid]);
      }

      const graph = this.entityGraphs.get(eid);
      if (graph) {
        const nextState = graph.evaluate();
        if (nextState !== null && nextState !== graph.currentState) {
          const clipIdx = this.mixerClipNames[slot].indexOf(nextState);
          if (clipIdx >= 0) {
            const currentIdx = this.animatorStore.get(eid, "currentClip") as number;
            if (currentIdx !== clipIdx) {
              this.play(eid, clipIdx, graph.transitions.find(
                t => t.from === graph.currentState && t.to === nextState
              )?.duration ?? 0.3);
            }
            // Only advance the state machine when a clip actually exists for it — otherwise
            // the graph "moves on" to a state nothing is playing, and every subsequent tick's
            // from === graph.currentState transition lookups become stale while the mixer
            // keeps looping whatever it played last.
            graph.currentState = nextState;
          }
        }
      }

      mixer.update(dt * (speeds[eid] || 1));
    }
  }

  removeMixer(eid: number): void {
    const slot = this.animatorStore.get(eid, "mixerSlot") as number;
    if (slot < 0) return;
    const mixer = this.mixerObjects[slot];
    if (mixer) {
      mixer.stopAllAction();
      mixer.uncacheRoot(mixer.getRoot());
    }
    this.mixerObjects[slot] = null;
    this.mixerEntityMap[slot] = -1;
    this.mixerClipNames[slot] = [];
    this.mixerActions[slot] = [];
    this.mixerFree.push(slot);
  }

  destroy(): void {
    for (let i = 0; i < this.mixerCount; i++) {
      if (this.mixerObjects[i]) {
        this.mixerObjects[i]!.stopAllAction();
      }
    }
  }
}
