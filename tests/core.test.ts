import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { Archive, sniffMedia } from '../apps/native-host/archive.ts';
import { parseLosslessJson, normalizeResponse, hintsFromRequest } from '../packages/capture-core/normalize.ts';
import { encodeFrame, FrameDecoder, MAX_FRAME } from '../apps/native-host/framing.ts';
import { BatchAssembler } from '../apps/native-host/chunks.ts';
import { batch, message, png } from './fixtures.ts';

const testBase = path.resolve('.local/test-results'); await mkdir(testBase, { recursive: true });
test('large raw records reassemble losslessly, partial chunks are not ACKed, and repeated chunks are safe', () => {
  const original = batch([message({ raw: { thumbnail: '图片🌿'.repeat(80_000) } })], 'large-batch'), data = JSON.stringify(original), count = Math.ceil(data.length / 48_000), assembler = new BatchAssembler();
  for (let index = 0; index < count - 1; index++) { const payload = { batchId: original.batchId, index, count, text: data.slice(index * 48_000, (index + 1) * 48_000) }; assert.equal(assembler.accept(payload), null); assert.equal(assembler.accept(payload), null); assert.ok(encodeFrame(payload).length < MAX_FRAME); }
  assert.deepEqual(assembler.accept({ batchId: original.batchId, index: count - 1, count, text: data.slice((count - 1) * 48_000) }), original);
});
async function archive(): Promise<Archive> { return Archive.create(await mkdtemp(path.join(testBase, 'archive-'))); }

test('large numeric IDs remain exact, including nested JSON content and escaped strings', () => {
  const value = parseLosslessJson('{"mid":9223372036854775807,"safe":123,"text":"\\\"9223372036854775807\\\"","fraction":1.5}') as Record<string, unknown>;
  assert.equal(value.mid, '9223372036854775807'); assert.equal(value.safe, 123); assert.equal(value.text, '"9223372036854775807"'); assert.equal(value.fraction, 1.5);
});
test('text hyperlinks are never automatically treated as media', () => {
  const result = normalizeResponse({ project_id: 'p', data: [{ mid: 'a', chat_user_id: 'u', msg_type: 1, content: 'https://example.com/catalog.jpg', send_time: 1780000000 }] }, {}, 'fixture', 'b');
  assert.equal(result.messages.length, 1); assert.deepEqual(result.messages[0].attachments, []); assert.equal(result.messages[0].text, 'https://example.com/catalog.jpg');
});
test('media inside string JSON uses original URL and retains caption', () => {
  const result = normalizeResponse({ mid: 'a', chat_user_id: 'u', msg_type: 2, content: '{"original_url":"https://example.com/a.jpg","thumbnail":"https://example.com/thumb.jpg","caption":"图"}' }, { projectId: 'p' }, 'fixture', 'b');
  assert.equal(result.messages[0].attachments.length, 1); assert.equal(result.messages[0].attachments[0].url, 'https://example.com/a.jpg'); assert.equal(result.messages[0].text, '图');
});
test('verified SaleSmartly content.msg media and sender_type normalize correctly', () => {
  for (const [type, kind] of [['2', 'image'], ['6', 'video'], ['12', 'audio']]) {
    const result = normalizeResponse({ mid: 'real-schema-fixture', project_id: 'p', chat_user_id: 'u', chat_session_id: 's', sender_type: '2', msg_type: type, content: { msg: 'https://assets.salesmartly.com/synthetic-file', client_expand_info: [] }, send_time: '1783525217702' }, {}, 'fixture', 'b');
    assert.equal(result.messages[0].direction, 'outgoing'); assert.equal(result.messages[0].attachments[0].kind, kind); assert.equal(result.messages[0].attachments[0].url, 'https://assets.salesmartly.com/synthetic-file');
  }
});
test('late responses use their own customer identity before request hints', () => {
  const result = normalizeResponse({ mid: 'a', chat_user_id: 'actual-u', msg_type: 1, text: '晚返回' }, { projectId: 'p', customerId: 'other-u' }, 'fixture', 'b');
  assert.equal(result.messages[0].scope.customerId, 'actual-u');
});
test('missing stable identity preserves diagnostic and declines false message dedup', () => {
  const result = normalizeResponse({ data: [{ text: '同样一句话', send_time: 1780000000 }] }, { namespace: 'n' }, 'fixture', 'b');
  assert.equal(result.messages.length, 0); assert.ok(result.diagnostic); assert.ok(result.warnings.length);
});
test('request hints contain only identity fields and credentials are redacted from raw', () => {
  const hints = hintsFromRequest('https://app.salesmartly.com/messages?project_id=p&access_token=secret', '{"chat_user_id":"u","password":"secret"}');
  assert.equal(hints.projectId, 'p'); assert.equal(hints.customerId, 'u'); assert.equal((hints as any).access_token, undefined);
  const result = normalizeResponse({ mid: 'm', msg_type: 1, text: '客户正文', access_token: 'secret' }, hints, 'fixture', 'b');
  assert.equal((result.messages[0].raw as any).access_token, '[redacted]'); assert.equal(result.messages[0].text, '客户正文');
});
test('capture ACK is idempotent, repeated text with different IDs survives, and projects remain separate', async () => {
  const store = await archive();
  try {
    const same = message(), differentId = message({ sourceId: 'm2' }), otherProject = message({ scope: { ...same.scope, projectId: 'other-project' } });
    assert.deepEqual(store.capture(batch([same, differentId, otherProject])), { accepted: 3, duplicate: false, inserted: 3, updated: 0, unchanged: 0, stale: 0 });
    assert.equal(store.capture(batch([same, differentId, otherProject])).duplicate, true);
    const stats = store.stats() as any; assert.equal(stats.messages, 3); assert.equal(stats.conversations, 2); assert.equal(stats.batches, 1);
    store.capture(batch([message({ text: '编辑后的内容' })], 'batch-2')); assert.equal((store.stats() as any).versions, 4); assert.equal((store.stats() as any).messages, 3);
  } finally { store.close(); }
});
test('invalid batch never commits partial records', async () => {
  const store = await archive();
  try {
    const invalid = batch([message(), message({ sourceId: '' })]); assert.throws(() => store.capture(invalid)); assert.equal((store.stats() as any).messages, 0); assert.equal((store.stats() as any).batches, 0);
  } finally { store.close(); }
});
test('a transaction error rolls back every row and does not ACK the batch', async () => {
  const store = await archive();
  try {
    store.db.exec("CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'test disk failure'); END");
    assert.throws(() => store.capture(batch()), /test disk failure/); assert.equal((store.stats() as any).batches, 0); assert.equal((store.stats() as any).conversations, 0);
  } finally { store.close(); }
});
test('registered download import validates ID/path/format and creates portable safe HTML', async () => {
  const store = await archive();
  try {
    store.capture(batch([message({ text: '<script>alert(1)</script>', attachments: [{ slot: '0', kind: 'image', url: 'https://example.com/a', filename: '图像 "名字".png' }] }), message({ sourceId: 'm2', type: '12', attachments: [{ slot: '0', kind: 'audio', url: 'https://example.com/missing' }] })]));
    const asset = store.pendingMedia()[0], plan = store.planDownload(asset.id); store.bindDownload(plan.jobId, 17);
    const staging = path.join(store.root, 'downloads', plan.suffix.replace(/\.[a-z]+$/, '.png')); await mkdir(path.dirname(staging), { recursive: true }); await writeFile(staging, png);
    await assert.rejects(store.importDownload(plan.jobId, 18, staging), /registered/);
    await assert.rejects(store.importDownload(plan.jobId, 17, path.join(store.root, 'archive.sqlite')), /staging/);
    const result = await store.importDownload(plan.jobId, 17, staging) as any; assert.equal(result.mime, 'image/png'); assert.equal(result.size, png.length);
    assert.deepEqual(await store.importDownload(plan.jobId, 17, staging), { duplicate: true });
    const id = (store.conversations() as any[])[0].id, output = await store.exportConversation(id);
    assert.equal(output.messages, 2); assert.equal(output.missingMedia, 1);
    const document = await readFile(output.path, 'utf8'); assert.ok(document.includes('&lt;script&gt;')); assert.ok(!document.includes('<script>')); assert.ok(!document.includes('src="https:')); assert.ok(document.includes('未取得文件'));
    const manifest = JSON.parse(await readFile(path.join(path.dirname(output.path), 'manifest.json'), 'utf8')); assert.equal(manifest.historyBoundary, 'unknown');
    const assetCopy = await readFile(path.join(path.dirname(output.path), 'media', path.basename(result.path))); assert.deepEqual(assetCopy, png);
  } finally { store.close(); }
});
test('HTML error responses and media with the wrong type are rejected', () => {
  assert.throws(() => sniffMedia(Buffer.from('<!DOCTYPE html><html>login</html>'), 'audio'), /error\/login/);
  assert.throws(() => sniffMedia(png, 'video'), /does not match/);
  assert.throws(() => sniffMedia(Buffer.from(''), 'file'));
});
test('media without a URL is included in missing-media manifest', async () => {
  const store = await archive();
  try { store.capture(batch([message({ type: '12' })])); const id = (store.conversations() as any[])[0].id; assert.equal((await store.exportConversation(id)).missingMedia, 1); }
  finally { store.close(); }
});
test('Native Messaging handles fragmented/coalesced Unicode frames', async () => {
  const decoder = new FrameDecoder(), received: unknown[] = [];
  decoder.on('data', value => received.push(value));
  const completion = new Promise<void>((resolve, reject) => { decoder.on('end', resolve); decoder.on('error', reject); });
  const values = [{ id: '你好', text: '🌿' }, { id: '2', ok: true }], encoded = Buffer.concat(values.map(encodeFrame));
  for (let offset = 0; offset < encoded.length; offset += 3) decoder.write(encoded.subarray(offset, offset + 3));
  decoder.end(); await completion; assert.deepEqual(received, values);
});
test('Native Messaging rejects oversized or truncated frames', async () => {
  const decoder = new FrameDecoder(), header = Buffer.alloc(4); header.writeUInt32LE(MAX_FRAME + 1);
  const error = new Promise<Error>(resolve => decoder.on('error', resolve)); decoder.end(header); assert.match((await error).message, /frame size/);
  const truncated = new FrameDecoder(); const failure = new Promise<Error>(resolve => truncated.on('error', resolve)); truncated.resume(); truncated.end(Buffer.from([3, 0, 0, 0, 123])); assert.match((await failure).message, /Truncated/);
});
