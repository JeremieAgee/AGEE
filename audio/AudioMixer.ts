import * as THREE from "three";

export interface AudioBus {
  name: string;
  gain: GainNode;
  volume: number;
  muted: boolean;
}

export class AudioMixer {
  private listener: THREE.AudioListener;
  private ctx: AudioContext;
  private masterGain: GainNode;
  private buses = new Map<string, AudioBus>();
  private masterVolume = 1;

  constructor(listener: THREE.AudioListener) {
    this.listener = listener;
    this.ctx = listener.context;
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);

    // Default buses
    this.createBus("master");
    this.createBus("music", 0.7);
    this.createBus("sfx", 1.0);
    this.createBus("ambient", 0.5);
    this.createBus("ui", 0.8);
  }

  createBus(name: string, volume: number = 1): AudioBus {
    if (this.buses.has(name)) return this.buses.get(name)!;

    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    gain.connect(this.masterGain);

    const bus: AudioBus = { name, gain, volume, muted: false };
    this.buses.set(name, bus);
    return bus;
  }

  getBus(name: string): AudioBus | undefined {
    return this.buses.get(name);
  }

  setBusVolume(name: string, volume: number): void {
    const bus = this.buses.get(name);
    if (!bus) return;
    bus.volume = Math.max(0, Math.min(1, volume));
    if (!bus.muted) {
      bus.gain.gain.setTargetAtTime(bus.volume, this.ctx.currentTime, 0.05);
    }
  }

  muteBus(name: string, muted: boolean): void {
    const bus = this.buses.get(name);
    if (!bus) return;
    bus.muted = muted;
    bus.gain.gain.setTargetAtTime(muted ? 0 : bus.volume, this.ctx.currentTime, 0.05);
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    this.masterGain.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.05);
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  connectToBus(source: AudioNode, busName: string = "sfx"): void {
    const bus = this.buses.get(busName);
    if (bus) {
      source.connect(bus.gain);
    }
  }

  playSfx(buffer: AudioBuffer, volume: number = 1, busName: string = "sfx"): void {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    const gainNode = this.ctx.createGain();
    gainNode.gain.value = volume;
    source.connect(gainNode);

    this.connectToBus(gainNode, busName);
    source.start();
  }

  playMusic(
    buffer: AudioBuffer,
    volume: number = 1,
    loop: boolean = true,
    fadeIn: number = 1
  ): AudioBufferSourceNode {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;

    const gainNode = this.ctx.createGain();
    gainNode.gain.value = 0;
    gainNode.gain.linearRampToValueAtTime(volume, this.ctx.currentTime + fadeIn);
    source.connect(gainNode);

    this.connectToBus(gainNode, "music");
    source.start();
    return source;
  }

  get context(): AudioContext {
    return this.ctx;
  }
}
