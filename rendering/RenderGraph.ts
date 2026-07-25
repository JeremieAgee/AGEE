import * as THREE from "three";

export const enum PassType {
  DepthPrepass = 0,
  Shadow = 1,
  Opaque = 2,
  Transparent = 3,
  PostProcess = 4,
  Overlay = 5,
  Debug = 6,
}

export interface RenderPass {
  name: string;
  type: PassType;
  priority: number;
  enabled: boolean;
  execute(ctx: RenderContext): void;
  resize?(width: number, height: number): void;
  dispose?(): void;
}

export interface RenderContext {
  renderer: THREE.WebGLRenderer | any;
  scene: THREE.Scene;
  camera: THREE.Camera;
  width: number;
  height: number;
  dt: number;
  frameCount: number;
}

export class RenderGraph {
  private passes: RenderPass[] = [];
  private sorted = false;

  addPass(pass: RenderPass): void {
    this.passes.push(pass);
    this.sorted = false;
  }

  removePass(name: string): void {
    const idx = this.passes.findIndex(p => p.name === name);
    if (idx !== -1) {
      this.passes[idx].dispose?.();
      this.passes.splice(idx, 1);
    }
  }

  getPass(name: string): RenderPass | undefined {
    return this.passes.find(p => p.name === name);
  }

  setPassEnabled(name: string, enabled: boolean): void {
    const pass = this.passes.find(p => p.name === name);
    if (pass) pass.enabled = enabled;
  }

  execute(ctx: RenderContext): void {
    if (!this.sorted) {
      this.passes.sort((a, b) => a.priority - b.priority);
      this.sorted = true;
    }

    for (let i = 0; i < this.passes.length; i++) {
      const pass = this.passes[i];
      if (!pass.enabled) continue;
      pass.execute(ctx);
    }
  }

  resize(width: number, height: number): void {
    for (const pass of this.passes) {
      pass.resize?.(width, height);
    }
  }

  dispose(): void {
    for (const pass of this.passes) {
      pass.dispose?.();
    }
    this.passes.length = 0;
  }
}

export class MainScenePass implements RenderPass {
  name = "main_scene";
  type = PassType.Opaque;
  priority = 100;
  enabled = true;

  execute(ctx: RenderContext): void {
    ctx.renderer.render(ctx.scene, ctx.camera);
  }
}

export class ShadowPass implements RenderPass {
  name = "shadows";
  type = PassType.Shadow;
  priority = 50;
  enabled = true;

  execute(ctx: RenderContext): void {
    ctx.renderer.shadowMap.needsUpdate = true;
  }
}

export class DebugWireframePass implements RenderPass {
  name = "debug_wireframe";
  type = PassType.Debug;
  priority = 900;
  enabled = false;
  private debugScene: THREE.Scene | null = null;

  setDebugScene(scene: THREE.Scene): void {
    this.debugScene = scene;
  }

  execute(ctx: RenderContext): void {
    if (this.debugScene) {
      ctx.renderer.autoClear = false;
      ctx.renderer.render(this.debugScene, ctx.camera);
      ctx.renderer.autoClear = true;
    }
  }
}
