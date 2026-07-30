import { describe, it, expect, vi, beforeAll } from "vitest";
import * as THREE from "three";

import { AudioSystem } from "../audio/AudioSystem";
import { AudioMixer } from "../audio/AudioMixer";
import { World } from "../ecs";
import { Transform, AudioSource } from "../core/Components";

// ---------------------------------------------------------------------------
// Web Audio API is not available under Node/vitest's "node" environment.
// THREE.AudioListener lazily calls `AudioContext.getContext()`, which reads
// `window.AudioContext`, so we hand-roll the minimal subset of the Web Audio
// API that AudioSystem.ts and AudioMixer.ts actually call: createGain(),
// createPanner(), createBufferSource(), and GainNode/PannerNode's `.connect`/
// `.disconnect`/`.gain` automation methods.
// ---------------------------------------------------------------------------

class FakeAudioParam {
  value = 1;
  setTargetAtTime(target: number): this { this.value = target; return this; }
  setValueAtTime(target: number): this { this.value = target; return this; }
  linearRampToValueAtTime(target: number): this { this.value = target; return this; }
}

class FakeGainNode {
  gain = new FakeAudioParam();
  connect(): this { return this; }
  disconnect(): this { return this; }
}

class FakePannerNode {
  panningModel = "";
  connect(): this { return this; }
  disconnect(): this { return this; }
  setPosition(): void {}
  setOrientation(): void {}
}

class FakeAudioBufferSourceNode {
  buffer: any = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  playbackRate = new FakeAudioParam();
  detune = new FakeAudioParam();
  connect(): this { return this; }
  disconnect(): this { return this; }
  start(): void {}
  stop(): void {}
}

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  createGain(): FakeGainNode { return new FakeGainNode(); }
  createPanner(): FakePannerNode { return new FakePannerNode(); }
  createBufferSource(): FakeAudioBufferSourceNode { return new FakeAudioBufferSourceNode(); }
}

beforeAll(() => {
  (globalThis as any).window = globalThis;
  (globalThis as any).AudioContext = FakeAudioContext;
});

function fakeAudioBuffer(): AudioBuffer {
  return { duration: 1, length: 1, numberOfChannels: 1, sampleRate: 44100 } as unknown as AudioBuffer;
}

// ---------------------------------------------------------------------------
// AudioSystem
// ---------------------------------------------------------------------------

describe("AudioSystem", () => {
  function makeSystem() {
    const world = new World();
    const audio = new AudioSystem();
    world.addSystem(audio);
    return { world, audio };
  }

  it("createSound() registers an AudioSource component with the requested options", () => {
    const { world, audio } = makeSystem();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });

    const sound = audio.createSound(eid, fakeAudioBuffer(), { volume: 0.6, loop: true, spatial: false });

    expect(sound).toBeInstanceOf(THREE.Audio);
    expect(sound).not.toBeInstanceOf(THREE.PositionalAudio);
    const store = world.getStore(AudioSource);
    // The AudioSource component stores volume in an f32 column, so exact float64
    // equality doesn't hold; compare with float32-appropriate tolerance.
    expect(store.get(eid, "volume")).toBeCloseTo(0.6, 5);
    expect(store.get(eid, "loop")).toBe(1);
    expect(store.get(eid, "spatial")).toBe(0);
    expect(store.get(eid, "playing")).toBe(0);
  });

  it("createSound() defaults to spatial PositionalAudio", () => {
    const { world, audio } = makeSystem();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });

    const sound = audio.createSound(eid, fakeAudioBuffer());
    expect(sound).toBeInstanceOf(THREE.PositionalAudio);
  });

  it("play()/stop() toggle isPlaying and mirror it into the AudioSource component", () => {
    const { world, audio } = makeSystem();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    audio.createSound(eid, fakeAudioBuffer(), { spatial: false });
    const store = world.getStore(AudioSource);

    audio.play(eid);
    expect(store.get(eid, "playing")).toBe(1);

    audio.stop(eid);
    expect(store.get(eid, "playing")).toBe(0);
  });

  it("setVolume() updates both the THREE.Audio node and the AudioSource component", () => {
    const { world, audio } = makeSystem();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    const sound = audio.createSound(eid, fakeAudioBuffer(), { spatial: false });

    audio.setVolume(eid, 0.25);

    expect(sound.getVolume()).toBe(0.25);
    expect(world.getStore(AudioSource).get(eid, "volume")).toBe(0.25);
  });

  it("update() writes entity Transform position into a spatial sound's Object3D position", () => {
    const { world, audio } = makeSystem();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 1, y: 2, z: 3, sx: 1, sy: 1, sz: 1 });
    const sound = audio.createSound(eid, fakeAudioBuffer(), { spatial: true });

    audio.update(0);

    expect(sound.position.x).toBe(1);
    expect(sound.position.y).toBe(2);
    expect(sound.position.z).toBe(3);
  });

  it("destroy() stops and disconnects all active sounds", () => {
    const { world, audio } = makeSystem();
    const eid = world.createEntity();
    world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    const sound = audio.createSound(eid, fakeAudioBuffer(), { spatial: false });
    audio.play(eid);
    expect(sound.isPlaying).toBe(true);

    audio.destroy();

    expect(sound.isPlaying).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AudioMixer
// ---------------------------------------------------------------------------

describe("AudioMixer", () => {
  function makeMixer() {
    const listener = new THREE.AudioListener();
    const mixer = new AudioMixer(listener);
    return { listener, mixer };
  }

  it("creates the default bus set with documented default volumes", () => {
    const { mixer } = makeMixer();
    expect(mixer.getBus("master")?.volume).toBe(1);
    expect(mixer.getBus("music")?.volume).toBe(0.7);
    expect(mixer.getBus("sfx")?.volume).toBe(1.0);
    expect(mixer.getBus("ambient")?.volume).toBe(0.5);
    expect(mixer.getBus("ui")?.volume).toBe(0.8);
  });

  it("createBus() returns the existing bus for a repeated name instead of replacing it", () => {
    const { mixer } = makeMixer();
    const first = mixer.getBus("sfx")!;
    const second = mixer.createBus("sfx", 0.1);
    expect(second).toBe(first);
    expect(second.volume).toBe(1.0); // unchanged by the redundant createBus() call
  });

  it("setBusVolume() clamps to [0, 1] and updates the bus gain", () => {
    const { mixer } = makeMixer();
    mixer.setBusVolume("music", 1.5);
    expect(mixer.getBus("music")!.volume).toBe(1);
    expect(mixer.getBus("music")!.gain.gain.value).toBe(1);

    mixer.setBusVolume("music", -1);
    expect(mixer.getBus("music")!.volume).toBe(0);
    expect(mixer.getBus("music")!.gain.gain.value).toBe(0);

    mixer.setBusVolume("music", 0.42);
    expect(mixer.getBus("music")!.volume).toBeCloseTo(0.42);
    expect(mixer.getBus("music")!.gain.gain.value).toBeCloseTo(0.42);
  });

  it("muteBus(true) zeroes gain without changing the stored volume; unmuting restores it", () => {
    const { mixer } = makeMixer();
    mixer.setBusVolume("sfx", 0.8);

    mixer.muteBus("sfx", true);
    expect(mixer.getBus("sfx")!.gain.gain.value).toBe(0);
    expect(mixer.getBus("sfx")!.volume).toBe(0.8);

    mixer.muteBus("sfx", false);
    expect(mixer.getBus("sfx")!.gain.gain.value).toBe(0.8);
  });

  it("a muted bus does not react to setBusVolume() until unmuted", () => {
    const { mixer } = makeMixer();
    mixer.muteBus("sfx", true);
    mixer.setBusVolume("sfx", 0.3);

    expect(mixer.getBus("sfx")!.volume).toBe(0.3); // the stored volume still updates...
    expect(mixer.getBus("sfx")!.gain.gain.value).toBe(0); // ...but audible gain stays muted
  });

  it("setMasterVolume()/getMasterVolume() clamp to [0, 1]", () => {
    const { mixer } = makeMixer();
    mixer.setMasterVolume(2);
    expect(mixer.getMasterVolume()).toBe(1);
    mixer.setMasterVolume(-3);
    expect(mixer.getMasterVolume()).toBe(0);
    mixer.setMasterVolume(0.55);
    expect(mixer.getMasterVolume()).toBeCloseTo(0.55);
  });

  it("connectToBus() connects the given node to the named bus's gain node", () => {
    const { mixer } = makeMixer();
    const bus = mixer.getBus("ambient")!;
    const fakeSource = { connect: vi.fn() } as any;

    mixer.connectToBus(fakeSource, "ambient");

    expect(fakeSource.connect).toHaveBeenCalledWith(bus.gain);
  });

  it("playSfx() creates a buffer source routed through a gain node into the target bus and starts it", () => {
    const { mixer } = makeMixer();
    const bus = mixer.getBus("sfx")!;
    // playSfx() wires: bufferSource -> its own gain node -> connectToBus() -> bus.gain.
    // Spy on the gain-node class since the intermediate gain node is internal to playSfx().
    const gainConnectSpy = vi.spyOn(FakeGainNode.prototype, "connect");
    const startSpy = vi.spyOn(FakeAudioBufferSourceNode.prototype, "start");

    mixer.playSfx(fakeAudioBuffer(), 0.9, "sfx");

    expect(gainConnectSpy).toHaveBeenCalledWith(bus.gain);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("playMusic() routes into the music bus, sets loop, and returns the buffer source", () => {
    const { mixer } = makeMixer();
    const buffer = fakeAudioBuffer();

    const source = mixer.playMusic(buffer, 0.5, true, 1);

    expect(source.buffer).toBe(buffer);
    expect(source.loop).toBe(true);
  });
});
