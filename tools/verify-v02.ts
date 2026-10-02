import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Archive } from '../apps/native-host/archive.ts';
import type { Message } from '../packages/shared/model.ts';
import { batch, message } from '../tests/fixtures.ts';
const production = path.resolve('.local/archive'), directory = path.resolve('.local/verification/v02', randomUUID());
await mkdir(directory, { recursive: true });
const source = new DatabaseSync(path.join(production, 'archive.sqlite'), { readOnly: true });
try { await backup(source, path.join(directory, 'archive.sqlite')); } finally { source.close(); }
const archive = new Archive(directory), before: any = archive.stats();
let bytes = 0;
try {
  const records: Message[] = archive.db.prepare('SELECT m.*,c.scope_json FROM messages m JOIN conversations c ON c.id=m.conversation_id').all().map(row => ({ scope: JSON.parse(String(row.scope_json)), sourceId: String(row.source_id), text: String(row.text), type: String(row.type), sentAt: row.sent_at ? String(row.sent_at) : null, direction: row.direction as any, sender: String(row.sender), raw: JSON.parse(String(row.raw_json)), attachments: archive.db.prepare("SELECT * FROM assets WHERE message_id=? AND status<>'removed'").all(row.id).map(asset => ({ slot: String(asset.slot), kind: asset.kind as any, url: String(asset.url), filename: String(asset.filename) })) }));
  for (let index = 0; index < 3; index++) { const result = archive.capture(batch(records.map(record => ({ ...record, scope: { ...record.scope, channelAccountId: 'verified-channel', conversationId: `metadata-refresh-${index}` } })), `v02-repeat-${index}`)); assert.equal(result.inserted, 0); assert.equal(result.updated, 0); }
  const after: any = archive.stats(); assert.equal(after.messages, before.messages); assert.equal(after.versions, before.versions);
  const assets = archive.db.prepare("SELECT path,size FROM assets WHERE status='downloaded'").all();
  for (const asset of assets) { const info = await stat(path.join(production, String(asset.path))); assert.ok(info.isFile() && info.size > 0); assert.equal(info.size, asset.size); bytes += info.size; }
  const result = { legacyMessages: before.messages, legacyVersions: before.versions, media: assets.length, mediaBytes: bytes, repeatedCaptures: 3, extraMessages: after.messages - before.messages, extraVersions: after.versions - before.versions, originalDatabaseUntouched: true, sha256Validation: false };
  await writeFile(path.resolve('.local/verification/v02-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { archive.close(); }
if (process.argv.includes('--scale')) {
  const root = path.join(directory, 'scale'); const store = await Archive.create(root), start = Date.now();
  try {
    for (let customer = 0; customer < 1000; customer++) {
      const records = Array.from({ length: 100 }, (_, index) => message({ sourceId: `m-${index}`, scope: { projectId: 'scale-fixture', channelAccountId: 'channel', customerId: `customer-${customer}`, conversationId: 'session' } }));
      store.capture(batch(records, `scale-${customer}`)); store.capture(batch(records, `repeat-${customer}`));
    }
    const stats: any = store.stats(); assert.equal(stats.messages, 100000); assert.equal(stats.versions, 100000); assert.equal(stats.conversations, 1000); assert.equal((store.conversations(800) as any[]).length, 200);
    const result = { customers: 1000, messages: 100000, observedMessages: 200000, revisions: stats.versions, durationSeconds: (Date.now() - start) / 1000 };
    await writeFile(path.resolve('.local/verification/v02-scale.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { store.close(); }
}
