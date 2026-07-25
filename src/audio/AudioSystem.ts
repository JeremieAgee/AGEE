import * as THREE from "three";
import { System, World, ComponentStore } from "../ecs";
import { Transform, AudioSource } from "../core/Components";

const INITIAL_CAPACITY = 256;

export class AudioSystem extends System {
  priority = 800;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "postPhysics";

  static reads = ["Transform", "AudioSource"];
  static writes: string[] = [];

  readonly listener = new THREE.AudioListener();
  private transformStore!: ComponentStore;
  private audioStore!: ComponentStore;
  private query!: ReturnType<World["query"]>;

  // SOA: flat array indexed by entity ID
  private sounds: (THREE.Audio<GainNode | PannerNode> | null)[] = new Array(INITIAL_CAPACITY).fill(null);
  private capacity = INITIAL_CAPACITY;

  private ensureCapacity(eid: number): void {
    if (eid < this.capacity) return;
    while (this.capacity <= eid) this.capacity *= 2;
    const old = this.sounds;
    this.sounds = new Array(this.capacity).fill(null);
    for (let i = 0; i < old.length; i++) this.sounds[i] = old[i];
  }

  init(): void {
    this.transformStore = this.world.getStore(Transform);
    this.audioStore = this.world.getStore(AudioSource);
    this.query = this.world.query(Transform, AudioSource);

    this.audioStore.onRemove((eid) => {
      const sound = this.sounds[eid];
      if (sound) {
        if (sound.isPlaying) sound.stop();
        sound.disconnect();
        this.sounds[eid] = null;
      }
    });
  }

  attachToCamera(camera: THREE.Camera): void {
    camera.add(this.listener);
  }

  createSound(
    eid: number,
    buffer: AudioBuffer,
    options: { volume?: number; loop?: boolean; spatial?: boolean } = {}
  ): THREE.Audio<GainNode | PannerNode> {
    const spatial = options.spatial ?? true;
    let sound: THREE.Audio<GainNode | PannerNode>;

    if (spatial) {
      sound = new THREE.PositionalAudio(this.listener);
    } else {
      sound = new THREE.Audio(this.listener);
    }

    sound.setBuffer(buffer);
    sound.setVolume(options.volume ?? 1);
    sound.setLoop(options.loop ?? false);

    this.ensureCapacity(eid);
    this.sounds[eid] = sound;

    this.world.addComponent(eid, AudioSource, {
      bufferRef: buffer,
      sourceRef: sound,
      volume: options.volume ?? 1,
      loop: options.loop ? 1 : 0,
      playing: 0,
      spatial: spatial ? 1 : 0,
    });

    return sound;
  }

  play(eid: number): void {
    const sound = this.sounds[eid];
    if (sound && !sound.isPlaying) {
      sound.play();
      this.audioStore.set(eid, "playing", 1);
    }
  }

  stop(eid: number): void {
    const sound = this.sounds[eid];
    if (sound && sound.isPlaying) {
      sound.stop();
      this.audioStore.set(eid, "playing", 0);
    }
  }

  setVolume(eid: number, volume: number): void {
    const sound = this.sounds[eid];
    if (sound) {
      sound.setVolume(volume);
      this.audioStore.set(eid, "volume", volume);
    }
  }

  update(_dt: number): void {
    const entities = this.query.entities;
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      const sound = this.sounds[eid];
      if (!sound || !(sound instanceof THREE.PositionalAudio)) continue;

      const x = this.transformStore.get(eid, "x");
      const y = this.transformStore.get(eid, "y");
      const z = this.transformStore.get(eid, "z");
      sound.position.set(x, y, z);
    }
  }

  destroy(): void {
    for (let i = 0; i < this.capacity; i++) {
      const sound = this.sounds[i];
      if (sound) {
        if (sound.isPlaying) sound.stop();
        sound.disconnect();
        this.sounds[i] = null;
      }
    }
  }
}
