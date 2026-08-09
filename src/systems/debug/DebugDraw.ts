import * as THREE from "three";
import { System } from "../../ecs";

const MAX_LINES = 16384;
const MAX_POINTS = 4096;

const FLOATS_PER_LINE = 6;
const FLOATS_PER_POINT = 3;
const COLOR_FLOATS_PER_LINE = 8;
const COLOR_FLOATS_PER_POINT = 4;

export class DebugDraw extends System {
  priority = 851;
  phase = "render" as const;

  // SOA storage: flat typed arrays indexed by draw index
  private linePositions = new Float32Array(MAX_LINES * FLOATS_PER_LINE);
  private lineColors = new Float32Array(MAX_LINES * COLOR_FLOATS_PER_LINE);
  private lineLifetimes = new Float32Array(MAX_LINES);
  private lineCount = 0;

  private pointPositions = new Float32Array(MAX_POINTS * FLOATS_PER_POINT);
  private pointColors = new Float32Array(MAX_POINTS * COLOR_FLOATS_PER_POINT);
  private pointLifetimes = new Float32Array(MAX_POINTS);
  private pointCount = 0;

  private lineMesh!: THREE.LineSegments;
  private pointMesh!: THREE.Points;
  private scene!: THREE.Scene;
  private visible = true;

  setup(scene: THREE.Scene): void {
    this.scene = scene;

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_LINES * FLOATS_PER_LINE), 3));
    lineGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_LINES * COLOR_FLOATS_PER_LINE), 4));
    lineGeo.setDrawRange(0, 0);

    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: false,
      transparent: true,
    });
    this.lineMesh = new THREE.LineSegments(lineGeo, lineMat);
    this.lineMesh.frustumCulled = false;
    this.lineMesh.renderOrder = 998;
    scene.add(this.lineMesh);

    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_POINTS * FLOATS_PER_POINT), 3));
    pointGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_POINTS * COLOR_FLOATS_PER_POINT), 4));
    pointGeo.setDrawRange(0, 0);

    const pointMat = new THREE.PointsMaterial({
      vertexColors: true,
      size: 6,
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    });
    this.pointMesh = new THREE.Points(pointGeo, pointMat);
    this.pointMesh.frustumCulled = false;
    this.pointMesh.renderOrder = 998;
    scene.add(this.pointMesh);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.lineMesh.visible = this.visible;
    this.pointMesh.visible = this.visible;
  }

  line(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    r = 0, g = 1, b = 0, a = 1,
    duration = 0
  ): void {
    if (this.lineCount >= MAX_LINES) return;

    const pi = this.lineCount * FLOATS_PER_LINE;
    this.linePositions[pi] = x0;
    this.linePositions[pi + 1] = y0;
    this.linePositions[pi + 2] = z0;
    this.linePositions[pi + 3] = x1;
    this.linePositions[pi + 4] = y1;
    this.linePositions[pi + 5] = z1;

    const ci = this.lineCount * COLOR_FLOATS_PER_LINE;
    this.lineColors[ci] = r; this.lineColors[ci + 1] = g;
    this.lineColors[ci + 2] = b; this.lineColors[ci + 3] = a;
    this.lineColors[ci + 4] = r; this.lineColors[ci + 5] = g;
    this.lineColors[ci + 6] = b; this.lineColors[ci + 7] = a;

    this.lineLifetimes[this.lineCount] = duration;
    this.lineCount++;
  }

  ray(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    length: number,
    r = 1, g = 1, b = 0, a = 1,
    duration = 0
  ): void {
    this.line(
      ox, oy, oz,
      ox + dx * length, oy + dy * length, oz + dz * length,
      r, g, b, a, duration
    );
  }

  point(
    x: number, y: number, z: number,
    r = 1, g = 0, b = 0, a = 1,
    duration = 0
  ): void {
    if (this.pointCount >= MAX_POINTS) return;

    const pi = this.pointCount * FLOATS_PER_POINT;
    this.pointPositions[pi] = x;
    this.pointPositions[pi + 1] = y;
    this.pointPositions[pi + 2] = z;

    const ci = this.pointCount * COLOR_FLOATS_PER_POINT;
    this.pointColors[ci] = r;
    this.pointColors[ci + 1] = g;
    this.pointColors[ci + 2] = b;
    this.pointColors[ci + 3] = a;

    this.pointLifetimes[this.pointCount] = duration;
    this.pointCount++;
  }

  box(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    r = 0, g = 1, b = 0, a = 1,
    duration = 0
  ): void {
    const x0 = cx - hx, y0 = cy - hy, z0 = cz - hz;
    const x1 = cx + hx, y1 = cy + hy, z1 = cz + hz;

    // Bottom face
    this.line(x0, y0, z0, x1, y0, z0, r, g, b, a, duration);
    this.line(x1, y0, z0, x1, y0, z1, r, g, b, a, duration);
    this.line(x1, y0, z1, x0, y0, z1, r, g, b, a, duration);
    this.line(x0, y0, z1, x0, y0, z0, r, g, b, a, duration);

    // Top face
    this.line(x0, y1, z0, x1, y1, z0, r, g, b, a, duration);
    this.line(x1, y1, z0, x1, y1, z1, r, g, b, a, duration);
    this.line(x1, y1, z1, x0, y1, z1, r, g, b, a, duration);
    this.line(x0, y1, z1, x0, y1, z0, r, g, b, a, duration);

    // Vertical edges
    this.line(x0, y0, z0, x0, y1, z0, r, g, b, a, duration);
    this.line(x1, y0, z0, x1, y1, z0, r, g, b, a, duration);
    this.line(x1, y0, z1, x1, y1, z1, r, g, b, a, duration);
    this.line(x0, y0, z1, x0, y1, z1, r, g, b, a, duration);
  }

  sphere(
    cx: number, cy: number, cz: number,
    radius: number,
    segments = 16,
    r = 0, g = 1, b = 1, a = 1,
    duration = 0
  ): void {
    const step = (Math.PI * 2) / segments;

    for (let i = 0; i < segments; i++) {
      const a0 = i * step;
      const a1 = (i + 1) * step;

      // XY circle
      this.line(
        cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius, cz,
        cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius, cz,
        r, g, b, a, duration
      );
      // XZ circle
      this.line(
        cx + Math.cos(a0) * radius, cy, cz + Math.sin(a0) * radius,
        cx + Math.cos(a1) * radius, cy, cz + Math.sin(a1) * radius,
        r, g, b, a, duration
      );
      // YZ circle
      this.line(
        cx, cy + Math.cos(a0) * radius, cz + Math.sin(a0) * radius,
        cx, cy + Math.cos(a1) * radius, cz + Math.sin(a1) * radius,
        r, g, b, a, duration
      );
    }
  }

  cross(
    x: number, y: number, z: number,
    size = 0.5,
    duration = 0
  ): void {
    this.line(x - size, y, z, x + size, y, z, 1, 0, 0, 1, duration);
    this.line(x, y - size, z, x, y + size, z, 0, 1, 0, 1, duration);
    this.line(x, y, z - size, x, y, z + size, 0, 0, 1, 1, duration);
  }

  path(
    points: ArrayLike<number>,
    r = 1, g = 0.5, b = 0, a = 1,
    duration = 0
  ): void {
    for (let i = 0; i < points.length - 3; i += 3) {
      this.line(
        points[i], points[i + 1], points[i + 2],
        points[i + 3], points[i + 4], points[i + 5],
        r, g, b, a, duration
      );
    }
  }

  clear(): void {
    this.lineCount = 0;
    this.pointCount = 0;
  }

  update(dt: number): void {
    if (!this.visible) return;

    this.tickLifetimes(dt);
    this.flush();
  }

  private tickLifetimes(dt: number): void {
    // Lines: decrement lifetimes, compact survivors
    let writeIdx = 0;
    for (let i = 0; i < this.lineCount; i++) {
      if (this.lineLifetimes[i] <= 0) continue; // one-frame (already drawn)

      this.lineLifetimes[i] -= dt;
      if (this.lineLifetimes[i] <= 0) continue; // expired this frame

      if (writeIdx !== i) {
        const srcP = i * FLOATS_PER_LINE;
        const dstP = writeIdx * FLOATS_PER_LINE;
        for (let j = 0; j < FLOATS_PER_LINE; j++) this.linePositions[dstP + j] = this.linePositions[srcP + j];

        const srcC = i * COLOR_FLOATS_PER_LINE;
        const dstC = writeIdx * COLOR_FLOATS_PER_LINE;
        for (let j = 0; j < COLOR_FLOATS_PER_LINE; j++) this.lineColors[dstC + j] = this.lineColors[srcC + j];

        this.lineLifetimes[writeIdx] = this.lineLifetimes[i];
      }
      writeIdx++;
    }
    this.lineCount = writeIdx;

    // Points
    writeIdx = 0;
    for (let i = 0; i < this.pointCount; i++) {
      if (this.pointLifetimes[i] <= 0) continue;

      this.pointLifetimes[i] -= dt;
      if (this.pointLifetimes[i] <= 0) continue;

      if (writeIdx !== i) {
        const srcP = i * FLOATS_PER_POINT;
        const dstP = writeIdx * FLOATS_PER_POINT;
        for (let j = 0; j < FLOATS_PER_POINT; j++) this.pointPositions[dstP + j] = this.pointPositions[srcP + j];

        const srcC = i * COLOR_FLOATS_PER_POINT;
        const dstC = writeIdx * COLOR_FLOATS_PER_POINT;
        for (let j = 0; j < COLOR_FLOATS_PER_POINT; j++) this.pointColors[dstC + j] = this.pointColors[srcC + j];

        this.pointLifetimes[writeIdx] = this.pointLifetimes[i];
      }
      writeIdx++;
    }
    this.pointCount = writeIdx;
  }

  private flush(): void {
    // Lines
    const lineGeo = this.lineMesh.geometry;
    const posAttr = lineGeo.getAttribute("position") as THREE.BufferAttribute;
    const colAttr = lineGeo.getAttribute("color") as THREE.BufferAttribute;

    (posAttr.array as Float32Array).set(this.linePositions.subarray(0, this.lineCount * FLOATS_PER_LINE));
    (colAttr.array as Float32Array).set(this.lineColors.subarray(0, this.lineCount * COLOR_FLOATS_PER_LINE));
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    lineGeo.setDrawRange(0, this.lineCount * 2);

    // Points
    const pointGeo = this.pointMesh.geometry;
    const pPosAttr = pointGeo.getAttribute("position") as THREE.BufferAttribute;
    const pColAttr = pointGeo.getAttribute("color") as THREE.BufferAttribute;

    (pPosAttr.array as Float32Array).set(this.pointPositions.subarray(0, this.pointCount * FLOATS_PER_POINT));
    (pColAttr.array as Float32Array).set(this.pointColors.subarray(0, this.pointCount * COLOR_FLOATS_PER_POINT));
    pPosAttr.needsUpdate = true;
    pColAttr.needsUpdate = true;
    pointGeo.setDrawRange(0, this.pointCount);
  }

  destroy(): void {
    if (this.lineMesh) {
      this.lineMesh.geometry.dispose();
      (this.lineMesh.material as THREE.Material).dispose();
      this.scene?.remove(this.lineMesh);
    }
    if (this.pointMesh) {
      this.pointMesh.geometry.dispose();
      (this.pointMesh.material as THREE.Material).dispose();
      this.scene?.remove(this.pointMesh);
    }
  }
}
