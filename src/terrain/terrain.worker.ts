import { buildChunkData, ChunkBuildRequest } from "./TerrainChunkBuilder";

export interface TerrainWorkerRequest extends ChunkBuildRequest {
  requestId: number;
}

export interface TerrainWorkerResponse {
  requestId: number;
  heightmap: Float32Array;
  positions: Float32Array;
  uvs: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  colliderVertices: Float32Array | null;
  colliderIndices: Uint32Array | null;
}

// Runs entirely off the main thread: TerrainSystem posts a ChunkBuildRequest here instead of
// calling buildChunkData() itself, so the noise sampling + vertex/normal/index generation for a
// chunk (the actual CPU cost — see TerrainChunkBuilder) never blocks rendering/input/physics.
self.onmessage = (e: MessageEvent<TerrainWorkerRequest>) => {
  const { requestId, ...req } = e.data;
  const result = buildChunkData(req);

  const response: TerrainWorkerResponse = { requestId, ...result };
  const transfer = [
    result.heightmap.buffer,
    result.positions.buffer,
    result.uvs.buffer,
    result.normals.buffer,
    result.indices.buffer,
  ];
  if (result.colliderVertices) transfer.push(result.colliderVertices.buffer);
  if (result.colliderIndices) transfer.push(result.colliderIndices.buffer);

  (self as unknown as Worker).postMessage(response, transfer);
};
