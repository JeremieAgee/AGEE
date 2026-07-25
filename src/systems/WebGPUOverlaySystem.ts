import { System } from "../ecs";

export interface WebGPUOverlayAim {
  x: number;
  y: number;
  active: boolean;
  intensity?: number;
}

type AimProvider = () => WebGPUOverlayAim;

export class WebGPUOverlaySystem extends System {
  priority = 905;
  phase: "prePhysics" | "physics" | "postPhysics" | "render" = "render";

  readonly canvas: HTMLCanvasElement;

  private adapter: GPUAdapter | null = null;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private uniformData = new Float32Array(8);
  private format: GPUTextureFormat = "bgra8unorm";
  private time = 0;
  private initialized = false;
  private supported = false;
  private aimProvider: AimProvider = () => ({
    x: window.innerWidth * 0.5,
    y: window.innerHeight * 0.5,
    active: false,
    intensity: 0,
  });

  constructor() {
    super();
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = [
      "position:fixed",
      "inset:0",
      "width:100vw",
      "height:100vh",
      "pointer-events:none",
      "z-index:12",
    ].join(";");
  }

  async initGPU(device?: GPUDevice, format?: GPUTextureFormat): Promise<void> {
    if (!("gpu" in navigator) && !device) return;

    if (device) {
      this.device = device;
    } else {
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) return;

      this.device = await this.adapter.requestDevice();
    }

    this.context = this.canvas.getContext("webgpu");
    if (!this.context || !this.device) return;

    this.format = format ?? navigator.gpu.getPreferredCanvasFormat();
    document.body.appendChild(this.canvas);
    this.resize();
    this.context.configure({
      device: this.device,
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      alphaMode: "premultiplied",
    });

    const shader = this.device.createShaderModule({
      label: "AGEE native WebGPU overlay",
      code: `
struct Uniforms {
  resolution: vec2<f32>,
  time: f32,
  is_active: f32,
  aim: vec2<f32>,
  intensity: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0)
  );
  var out: VertexOut;
  let p = positions[vertexIndex];
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv = p * 0.5 + vec2<f32>(0.5);
  return out;
}

fn ring(distanceToAim: f32, radius: f32, width: f32) -> f32 {
  return 1.0 - smoothstep(width, width * 2.0, abs(distanceToAim - radius));
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  let pixel = in.uv * u.resolution;
  let aim = u.aim;
  let aspect = u.resolution.x / max(u.resolution.y, 1.0);
  let d = distance((pixel - aim) / vec2<f32>(aspect, 1.0), vec2<f32>(0.0));
  let pulse = 0.65 + 0.35 * sin(u.time * 8.0);
  let enabled = u.is_active;
  let power = max(u.intensity, enabled);

  let r1 = ring(d, 18.0 + pulse * 3.0, 1.3);
  let r2 = ring(d, 34.0 - pulse * 2.0, 1.0) * 0.7;
  let horizontal = 1.0 - smoothstep(0.8, 2.2, abs(pixel.y - aim.y));
  let vertical = 1.0 - smoothstep(0.8, 2.2, abs(pixel.x - aim.x));
  let armMask = 1.0 - smoothstep(42.0, 48.0, d);
  let cross = (horizontal + vertical) * armMask * 0.35;

  let grid = step(0.985, fract((pixel.x + sin(u.time) * 8.0) / 48.0)) * 0.025;
  let scanline = (0.55 + 0.45 * sin(pixel.y * 0.08 + u.time * 7.0)) * 0.018;
  let vignette = smoothstep(0.9, 0.2, distance(in.uv, vec2<f32>(0.5)));

  let reticle = (r1 + r2 + cross) * enabled;
  let aura = exp(-d * 0.022) * 0.16 * power;
  let color = vec3<f32>(
    reticle * 1.0 + aura * 0.7,
    reticle * 0.27 + scanline,
    reticle * 0.08 + aura * 0.35 + grid
  );
  let alpha = clamp((reticle * 0.72 + aura + scanline + grid) * vignette, 0.0, 0.78);
  return vec4<f32>(color, alpha);
}`,
    });

    this.uniformBuffer = this.device.createBuffer({
      label: "AGEE overlay uniforms",
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      }],
    });

    this.pipeline = this.device.createRenderPipeline({
      label: "AGEE native WebGPU overlay pipeline",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shader, entryPoint: "vs" },
      fragment: {
        module: shader,
        entryPoint: "fs",
        targets: [{
          format: this.format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    if (typeof shader.getCompilationInfo === "function") {
      const info = await shader.getCompilationInfo();

      const errors = info.messages.filter((message) => message.type === "error");
      const warnings = info.messages.filter((message) => message.type === "warning");

      for (const warning of warnings) {
        console.warn("WebGPU overlay shader warning:", warning.message, "line", warning.lineNum, "column", warning.linePos);
      }

      if (errors.length > 0) {
        for (const error of errors) {
          console.error("WebGPU overlay shader error:", error.message, "line", error.lineNum, "column", error.linePos);
        }
        return;
      }
    }

    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{
        binding: 0,
        resource: { buffer: this.uniformBuffer },
      }],
    });

    window.addEventListener("resize", this.resize);
    this.supported = true;
    this.initialized = true;
  }

  setAimProvider(provider: AimProvider): void {
    this.aimProvider = provider;
  }

  get isSupported(): boolean {
    return this.supported;
  }

  update(dt: number): void {
    if (!this.initialized || !this.device || !this.context || !this.pipeline || !this.bindGroup || !this.uniformBuffer) {
      return;
    }

    this.time += dt;
    const aim = this.aimProvider();
    this.uniformData[0] = this.canvas.width;
    this.uniformData[1] = this.canvas.height;
    this.uniformData[2] = this.time;
    this.uniformData[3] = aim.active ? 1 : 0;
    this.uniformData[4] = aim.x * window.devicePixelRatio;
    this.uniformData[5] = aim.y * window.devicePixelRatio;
    this.uniformData[6] = aim.intensity ?? 0;
    this.uniformData[7] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const view = this.context.getCurrentTexture().createView();
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    window.removeEventListener("resize", this.resize);
    this.canvas.remove();
    this.uniformBuffer?.destroy();
  }

  private resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    this.canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
  };
}
