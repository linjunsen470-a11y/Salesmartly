import type { CaptureBatch } from '../../packages/shared/model.ts';
export class BatchAssembler {
  private batches = new Map<string, { parts: (string | undefined)[]; count: number; bytes: number }>();
  accept(payload: Record<string, unknown>): CaptureBatch | null {
    const { batchId, index, count, text } = payload;
    if (typeof batchId !== 'string' || batchId.length > 256 || !Number.isInteger(index) || !Number.isInteger(count) || Number(count) < 1 || Number(count) > 256 || Number(index) < 0 || Number(index) >= Number(count) || typeof text !== 'string' || text.length > 48_000) throw new Error('Invalid capture chunk');
    let assembly = this.batches.get(batchId);
    if (!assembly) { if (this.batches.size >= 2) throw new Error('Too many incomplete capture batches'); assembly = { parts: [], count: Number(count), bytes: 0 }; this.batches.set(batchId, assembly); }
    if (assembly.count !== count) throw new Error('Capture chunk count changed');
    const position = Number(index), previous = assembly.parts[position];
    assembly.bytes += Buffer.byteLength(text) - (previous === undefined ? 0 : Buffer.byteLength(previous));
    if (assembly.bytes > 8 * 1024 * 1024) { this.batches.delete(batchId); throw new Error('Capture batch exceeds 8 MB'); }
    assembly.parts[position] = text;
    if (assembly.parts.filter(part => part !== undefined).length !== assembly.count) return null;
    this.batches.delete(batchId);
    const batch = JSON.parse(assembly.parts.join('')) as CaptureBatch;
    if (batch.batchId !== batchId) throw new Error('Capture batch identity mismatch');
    return batch;
  }
}
