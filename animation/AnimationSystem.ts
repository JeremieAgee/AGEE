import * as THREE from "three";
import { System, World, ComponentStore } from "../ecs";
import { Animator } from "./AnimationComponents";
import { AnimationGraph } from "./AnimationGraph";
import { AssetSystem } from "../assets/AssetSystem";
import { AssetHandle } from "../assets/AssetTypes";

// SOA mixer storage: flat arrays indexed by mixer slot
const MAX_MIXERS = 512;
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
  private mixerObjects: (THREE.AnimationMixer | null)[] = new Array(MAX_MIXERS).fill(null);
  private mixerEntityMap: Int32Array = new Int32Array(MAX_MIXERS).fill(-1);
  private mixerClipNames: string[][] = new Array(MAX_MIXERS).fill(null).map(() => []);
  private mixerActions: (THREE.AnimationAction | null)[][] = new Array(MAX_MIXERS).fill(null).map(() => []);
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

  createMixer(eid: number, root: THREE.Object3D): number {
    const slot = this.mixerFree.length > 0 ? this.mixerFree.pop()! : this.mixerCount++;
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
          }
          graph.currentState = nextState;
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
