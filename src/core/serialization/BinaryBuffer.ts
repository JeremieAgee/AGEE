export class BinaryWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private offset = 0;

  constructor(initialSize: number = 4096) {
    this.buffer = new ArrayBuffer(initialSize);
    this.view = new DataView(this.buffer);
  }

  private ensure(bytes: number): void {
    if (this.offset + bytes <= this.buffer.byteLength) return;
    let newSize = this.buffer.byteLength * 2;
    while (newSize < this.offset + bytes) newSize *= 2;
    const newBuf = new ArrayBuffer(newSize);
    new Uint8Array(newBuf).set(new Uint8Array(this.buffer));
    this.buffer = newBuf;
    this.view = new DataView(this.buffer);
  }

  private align(n: number): void {
    const rem = this.offset % n;
    if (rem !== 0) {
      const pad = n - rem;
      this.ensure(pad);
      this.offset += pad;
    }
  }

  writeU8(v: number): void { this.ensure(1); this.view.setUint8(this.offset, v); this.offset += 1; }
  writeU16(v: number): void { this.ensure(2); this.view.setUint16(this.offset, v, true); this.offset += 2; }
  writeU32(v: number): void { this.ensure(4); this.view.setUint32(this.offset, v, true); this.offset += 4; }
  writeI32(v: number): void { this.ensure(4); this.view.setInt32(this.offset, v, true); this.offset += 4; }
  writeF32(v: number): void { this.ensure(4); this.view.setFloat32(this.offset, v, true); this.offset += 4; }
  writeF64(v: number): void { this.ensure(8); this.view.setFloat64(this.offset, v, true); this.offset += 8; }

  writeString(s: string): void {
    const encoded = new TextEncoder().encode(s);
    this.writeU32(encoded.length);
    this.ensure(encoded.length);
    new Uint8Array(this.buffer, this.offset, encoded.length).set(encoded);
    this.offset += encoded.length;
  }

  writeFloat32Array(arr: Float32Array): void {
    this.writeU32(arr.length);
    this.align(4);
    this.ensure(arr.length * 4);
    new Float32Array(this.buffer, this.offset, arr.length).set(arr);
    this.offset += arr.length * 4;
  }

  writeInt32Array(arr: Int32Array): void {
    this.writeU32(arr.length);
    this.align(4);
    this.ensure(arr.length * 4);
    new Int32Array(this.buffer, this.offset, arr.length).set(arr);
    this.offset += arr.length * 4;
  }

  toArrayBuffer(): ArrayBuffer {
    return this.buffer.slice(0, this.offset);
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.buffer, 0, this.offset);
  }

  /** Rewinds the write cursor to the start so this writer can be reused for the next message
   *  instead of allocating a fresh BinaryWriter (and its backing ArrayBuffer) per call. The
   *  backing buffer's capacity is kept as-is (not shrunk), so it naturally settles at whatever
   *  size the largest message written so far needed. */
  reset(): void {
    this.offset = 0;
  }

  get size(): number { return this.offset; }
}

/** Thrown by BinaryReader when a read would run past the end of the buffer — always catch
 *  this around reads of untrusted data (network messages, save files) rather than letting
 *  it propagate as a generic, harder-to-diagnose RangeError. */
export class BinaryReadError extends Error {}

export class BinaryReader {
  private view: DataView;
  private offset = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  private align(n: number): void {
    const rem = this.offset % n;
    if (rem !== 0) this.offset += n - rem;
  }

  private requireBytes(n: number): void {
    if (n < 0 || this.offset + n > this.view.byteLength) {
      throw new BinaryReadError(
        `[BinaryReader] Read past end of buffer: need ${n} bytes at offset ${this.offset}, buffer is ${this.view.byteLength} bytes`
      );
    }
  }

  readU8(): number { this.requireBytes(1); const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
  readU16(): number { this.requireBytes(2); const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  readU32(): number { this.requireBytes(4); const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  readI32(): number { this.requireBytes(4); const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
  readF32(): number { this.requireBytes(4); const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
  readF64(): number { this.requireBytes(8); const v = this.view.getFloat64(this.offset, true); this.offset += 8; return v; }

  readString(): string {
    const len = this.readU32();
    this.requireBytes(len);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
    this.offset += len;
    return new TextDecoder().decode(bytes);
  }

  readFloat32Array(): Float32Array {
    const len = this.readU32();
    this.align(4);
    this.requireBytes(len * 4);
    const arr = new Float32Array(this.view.buffer.slice(this.view.byteOffset + this.offset, this.view.byteOffset + this.offset + len * 4));
    this.offset += len * 4;
    return arr;
  }

  readInt32Array(): Int32Array {
    const len = this.readU32();
    this.align(4);
    this.requireBytes(len * 4);
    const arr = new Int32Array(this.view.buffer.slice(this.view.byteOffset + this.offset, this.view.byteOffset + this.offset + len * 4));
    this.offset += len * 4;
    return arr;
  }

  get remaining(): number { return this.view.byteLength - this.offset; }
  get position(): number { return this.offset; }
}
