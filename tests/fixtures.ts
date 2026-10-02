import type { Message, CaptureBatch } from '../packages/shared/model.ts';
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VkgAAAAASUVORK5CYII=', 'base64');
export function wav(): Buffer {
  const samples = 8000, value = Buffer.alloc(44 + samples * 2);
  value.write('RIFF'); value.writeUInt32LE(value.length - 8, 4); value.write('WAVEfmt ', 8); value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22); value.writeUInt32LE(8000, 24); value.writeUInt32LE(16000, 28); value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34); value.write('data', 36); value.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) value.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 8000) * 2400), 44 + i * 2);
  return value;
}
export function message(overrides: Partial<Message> = {}): Message {
  return { scope: { projectId: 'demo-project', channelAccountId: 'demo-account', customerId: 'demo-customer', conversationId: 'demo-session' }, sourceId: 'm1', type: '1', text: '测试消息：你好 🌿', sentAt: '2026-09-30T00:00:00.000Z', sender: '演示客户', direction: 'incoming', attachments: [], raw: { mid: 'm1', text: '测试消息：你好 🌿' }, ...overrides };
}
export function batch(messages: Message[] = [message()], id = 'batch-1'): CaptureBatch {
  return { batchId: id, capturedAt: '2026-09-30T00:00:01.000Z', source: 'synthetic-fixture', messages, warnings: [], boundary: 'unknown' };
}
