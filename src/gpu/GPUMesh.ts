import type { GPUContext } from "./GPUContext";

export interface GPUMeshDescriptor {
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  indices?: Uint16Array | Uint32Array;
  boundingSphereRadius?: number;
  boundingSphereCenter?: [number, number, number];
}

// Interleaved layout: position(3) + normal(3) + uv(2) = 8 floats = 32 bytes
const VERTEX_STRIDE = 32;

export const VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_STRIDE,
  stepMode: "vertex",
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },  // position
    { shaderLocation: 1, offset: 12, format: "float32x3" }, // normal
    { shaderLocation: 2, offset: 24, format: "float32x2" }, // uv
  ],
};

export class GPUMesh {
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer | null;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly indexFormat: GPUIndexFormat;
  readonly boundingSphereRadius: number;
  readonly boundingSphereCenter: Float32Array;

  // Retained solely so destroy() can fence before releasing buffers (AUDIT bug #3).
  private readonly device: GPUDevice;

  private constructor(
    device: GPUDevice,
    vertexBuffer: GPUBuffer,
    indexBuffer: GPUBuffer | null,
    vertexCount: number,
    indexCount: number,
    indexFormat: GPUIndexFormat,
    boundingSphereRadius: number,
    boundingSphereCenter: Float32Array,
  ) {
    this.device = device;
    this.vertexBuffer = vertexBuffer;
    this.indexBuffer = indexBuffer;
    this.vertexCount = vertexCount;
    this.indexCount = indexCount;
    this.indexFormat = indexFormat;
    this.boundingSphereRadius = boundingSphereRadius;
    this.boundingSphereCenter = boundingSphereCenter;
  }

  static create(ctx: GPUContext, desc: GPUMeshDescriptor): GPUMesh {
    const vertexCount = desc.positions.length / 3;
    const floatsPerVertex = 8; // pos(3) + normal(3) + uv(2)
    const interleaved = new Float32Array(vertexCount * floatsPerVertex);

    for (let i = 0; i < vertexCount; i++) {
      const vOff = i * floatsPerVertex;
      const p3 = i * 3;
      const u2 = i * 2;

      interleaved[vOff]     = desc.positions[p3];
      interleaved[vOff + 1] = desc.positions[p3 + 1];
      interleaved[vOff + 2] = desc.positions[p3 + 2];

      if (desc.normals) {
        interleaved[vOff + 3] = desc.normals[p3];
        interleaved[vOff + 4] = desc.normals[p3 + 1];
        interleaved[vOff + 5] = desc.normals[p3 + 2];
      } else {
        interleaved[vOff + 4] = 1; // default normal = (0,1,0)
      }

      if (desc.uvs) {
        interleaved[vOff + 6] = desc.uvs[u2];
        interleaved[vOff + 7] = desc.uvs[u2 + 1];
      }
    }

    const vertexBuffer = ctx.device.createBuffer({
      label: "AGEE vertex",
      size: interleaved.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(vertexBuffer.getMappedRange()).set(interleaved);
    vertexBuffer.unmap();

    let indexBuffer: GPUBuffer | null = null;
    let indexCount = 0;
    let indexFormat: GPUIndexFormat = "uint16";

    if (desc.indices) {
      indexCount = desc.indices.length;
      indexFormat = desc.indices instanceof Uint32Array ? "uint32" : "uint16";
      const byteLength = desc.indices.byteLength;

      // WebGPU requires buffer sizes to be multiples of 4
      const alignedSize = Math.ceil(byteLength / 4) * 4;
      indexBuffer = ctx.device.createBuffer({
        label: "AGEE index",
        size: alignedSize,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      const mapped = indexBuffer.getMappedRange();
      if (desc.indices instanceof Uint32Array) {
        new Uint32Array(mapped, 0, indexCount).set(desc.indices);
      } else {
        new Uint16Array(mapped, 0, indexCount).set(desc.indices);
      }
      indexBuffer.unmap();
    }

    let center: Float32Array;
    if (desc.boundingSphereCenter) {
      center = new Float32Array(desc.boundingSphereCenter);
    } else {
      // Compute the actual centroid rather than defaulting to the origin — for off-origin
      // geometry, treating (0,0,0) as "center" both misplaces the sphere and inflates its
      // radius by the distance from the origin to the geometry, on top of its real extent.
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < vertexCount; i++) {
        const p3 = i * 3;
        cx += desc.positions[p3];
        cy += desc.positions[p3 + 1];
        cz += desc.positions[p3 + 2];
      }
      center = vertexCount > 0
        ? new Float32Array([cx / vertexCount, cy / vertexCount, cz / vertexCount])
        : new Float32Array([0, 0, 0]);
    }
    let radius = desc.boundingSphereRadius ?? 0;

    if (radius === 0) {
      let maxDistSq = 0;
      for (let i = 0; i < vertexCount; i++) {
        const p3 = i * 3;
        const dx = desc.positions[p3] - center[0];
        const dy = desc.positions[p3 + 1] - center[1];
        const dz = desc.positions[p3 + 2] - center[2];
        maxDistSq = Math.max(maxDistSq, dx * dx + dy * dy + dz * dz);
      }
      radius = Math.sqrt(maxDistSq);
    }

    return new GPUMesh(
      ctx.device, vertexBuffer, indexBuffer, vertexCount, indexCount,
      indexFormat, radius, center,
    );
  }

  destroy(): void {
    // AUDIT FIX (bug #3): fence before releasing buffers that in-flight command
    // buffers may still reference — see GPUContext.resize() for the same pattern.
    void this.device.queue.onSubmittedWorkDone();
    this.vertexBuffer.destroy();
    this.indexBuffer?.destroy();
  }
}
