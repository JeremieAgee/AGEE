import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { System } from "../ecs";

export interface PostProcessConfig {
  bloom?: { strength: number; radius: number; threshold: number };
  fxaa?: boolean;
}

export class PostProcessSystem extends System {
  priority = 910;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  private composer!: EffectComposer;
  private bloomPass?: UnrealBloomPass;
  private fxaaPass?: ShaderPass;
  private ppEnabled = false;

  setup(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    config: PostProcessConfig = {}
  ): void {
    // Dispose previous composer and its render targets to prevent leaks
    if (this.composer) {
      this.composer.dispose();
    }

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));

    if (config.bloom) {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        config.bloom.strength,
        config.bloom.radius,
        config.bloom.threshold
      );
      this.composer.addPass(this.bloomPass);
    }

    if (config.fxaa !== false) {
      this.fxaaPass = new ShaderPass(FXAAShader);
      this.fxaaPass.uniforms["resolution"].value.set(
        1 / window.innerWidth, 1 / window.innerHeight
      );
      this.composer.addPass(this.fxaaPass);
    }

    this.composer.addPass(new OutputPass());
    this.ppEnabled = true;

    window.addEventListener("resize", this.onResize);
  }

  setBloom(strength: number, radius: number, threshold: number): void {
    if (this.bloomPass) {
      this.bloomPass.strength = strength;
      this.bloomPass.radius = radius;
      this.bloomPass.threshold = threshold;
    }
  }

  private onResize = (): void => {
    if (!this.composer) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.composer.setSize(w, h);
    if (this.fxaaPass) {
      this.fxaaPass.uniforms["resolution"].value.set(1 / w, 1 / h);
    }
  };

  get isEnabled(): boolean {
    return this.ppEnabled;
  }

  render(): void {
    if (this.ppEnabled && this.composer) {
      this.composer.render();
    }
  }

  update(_dt: number): void {
    // Rendering is triggered by render(), called from the main RenderSystem
  }

  destroy(): void {
    window.removeEventListener("resize", this.onResize);
    this.composer?.dispose();
  }
}
