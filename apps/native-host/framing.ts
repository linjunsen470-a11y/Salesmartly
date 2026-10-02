import { Transform } from 'node:stream';
export const MAX_FRAME = 512 * 1024;
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (!body.length || body.length > MAX_FRAME) throw new Error('Native Messaging frame exceeds limit');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
export class FrameDecoder extends Transform {
  private pending = Buffer.alloc(0);
  constructor() { super({ readableObjectMode: true }); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    try {
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 4) {
        const length = this.pending.readUInt32LE(0);
        if (!length || length > MAX_FRAME) throw new Error('Invalid Native Messaging frame size');
        if (this.pending.length < length + 4) break;
        const message = JSON.parse(this.pending.subarray(4, length + 4).toString('utf8'));
        this.pending = this.pending.subarray(length + 4);
        this.push(message);
      }
      done();
    } catch (error) { done(error as Error); }
  }
  override _flush(done: (error?: Error | null) => void): void { done(this.pending.length ? new Error('Truncated Native Messaging frame') : undefined); }
}
