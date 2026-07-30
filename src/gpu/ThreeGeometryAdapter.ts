import type * as THREE from "three";
import type { GPUMeshDescriptor } from "./GPUMesh";

export function extractGeometry(geo: THREE.BufferGeometry): GPUMeshDescriptor {
  if (!geo.attributes.position) {
    throw new Error("[ThreeGeometryAdapter] Geometry has no position attribute");
  }

  geo.computeBoundingSphere();

  const positions = new Float32Array(geo.attributes.position.array);

  let normals: Float32Array | undefined;
  if (!geo.attributes.normal) {
    geo.computeVertexNormals();
  }
  const normalAttr = geo.attributes.normal;
  if (normalAttr) {
    normals = new Float32Array(normalAttr.array);
  }

  let uvs: Float32Array | undefined;
  if (geo.attributes.uv) {
    uvs = new Float32Array(geo.attributes.uv.array);
  }

  let indices: Uint16Array | Uint32Array | undefined;
  if (geo.index) {
    const src = geo.index.array;
    const vertexCount = geo.attributes.position.count;
    if (vertexCount > 65535) {
      indices = new Uint32Array(src);
    } else {
      indices = new Uint16Array(src);
    }
  }

  const bs = geo.boundingSphere;
  const boundingSphereCenter: [number, number, number] = bs
    ? [bs.center.x, bs.center.y, bs.center.z]
    : [0, 0, 0];
  const boundingSphereRadius = bs?.radius ?? 0;

  return { positions, normals, uvs, indices, boundingSphereRadius, boundingSphereCenter };
}
