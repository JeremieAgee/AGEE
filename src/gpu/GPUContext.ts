export interface GPUContextConfig {
  canvas?: HTMLCanvasElement;
  powerPreference?: GPUPowerPreference;
  requiredFeatures?: GPUFeatureName[];
}

export class GPUContext {
  readonly device: GPUDevice;
  readonly adapter: GPUAdapter;
  readonly format: GPUTextureFormat;
  readonly canvas: HTMLCanvasElement;
  readonly canvasContext: GPUCanvasContext;

  depthTexture!: GPUTexture;
  depthView!: GPUTextureView;

  private _width = 0;
  private _height = 0;
  private ownsCanvas = false;

  get width(): number { return this._width; }
  get height(): number { return this._height; }

  private constructor(
    adapter: GPUAdapter,
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    canvasContext: GPUCanvasContext,
    format: GPUTextureFormat,
  ) {
    this.adapter = adapter;
    this.device = device;
    this.canvas = canvas;
    this.canvasContext = canvasContext;
    this.format = format;
  }

  static async create(config: GPUContextConfig = {}): Promise<GPUContext> {
    if (!navigator.gpu) {
      throw new Error("[GPUContext] WebGPU is not supported in this browser");
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: config.powerPreference ?? "high-performance",
    });
    if (!adapter) {
      throw new Error("[GPUContext] Failed to obtain GPU adapter");
    }

    const device = await adapter.requestDevice({
      requiredFeatures: config.requiredFeatures,
    });

    device.lost.then((info) => {
      console.error("[GPUContext] Device lost:", info.message);
    });

    const canvas = config.canvas ?? document.createElement("canvas");
    if (!config.canvas) {
      canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;display:none;pointer-events:none;z-index:1;";
      document.body.appendChild(canvas);
    }

    const canvasContext = canvas.getContext("webgpu");
    if (!canvasContext) {
      throw new Error("[GPUContext] Failed to get WebGPU canvas context");
    }

    const format = navigator.gpu.getPreferredCanvasFormat();

    canvasContext.configure({
      device,
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      alphaMode: "premultiplied",
    });

    const ctx = new GPUContext(adapter, device, canvas, canvasContext, format);
    ctx.ownsCanvas = !config.canvas;

    const dpr = window.devicePixelRatio || 1;
    ctx.resize(
      Math.max(1, Math.floor(canvas.clientWidth * dpr)),
      Math.max(1, Math.floor(canvas.clientHeight * dpr)),
    );

    window.addEventListener("resize", ctx._onResize);

    return ctx;
  }

  resize(width: number, height: number): void {
    if (width === this._width && height === this._height) return;

    this._width = width;
    this._height = height;
    this.canvas.width = width;
    this.canvas.height = height;

    if (this.depthTexture) {
      // A prior "fence" here (`void this.device.queue.onSubmittedWorkDone()` called right
      // before destroy()) looked protective but wasn't: the call returns a Promise that
      // nothing awaits, so destroy() still ran on the very next line regardless of whether
      // any GPU work was still in flight — it changed nothing. No fence is actually needed:
      // per the WebGPU spec, destroy() invalidates the JS-side handle immediately, but the
      // underlying GPU resource stays alive at the implementation level until any commands
      // that already reference it have finished executing. Destroying a texture a submitted
      // (not-yet-completed) command buffer still reads from is spec-safe.
      this.depthTexture.destroy();
    }

    this.depthTexture = this.device.createTexture({
      label: "AGEE depth",
      size: [width, height],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();
  }

  beginFrame(): { encoder: GPUCommandEncoder; colorView: GPUTextureView } {
    const colorView = this.canvasContext.getCurrentTexture().createView();
    const encoder = this.device.createCommandEncoder({ label: "AGEE frame" });
    return { encoder, colorView };
  }

  endFrame(encoder: GPUCommandEncoder): void {
    this.device.queue.submit([encoder.finish()]);
  }

  private _onResize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    this.resize(
      Math.max(1, Math.floor(this.canvas.clientWidth * dpr)),
      Math.max(1, Math.floor(this.canvas.clientHeight * dpr)),
    );
  };

  destroy(): void {
    window.removeEventListener("resize", this._onResize);
    // See resize() above — no fence needed; destroy() is spec-safe against in-flight work.
    this.depthTexture?.destroy();
    this.device.destroy();
    // Only remove the canvas if this context created it itself — a host-supplied
    // config.canvas is the host's DOM node to manage, not ours to remove.
    if (this.ownsCanvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}
