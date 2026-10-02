import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

// Read-only verification; does not need a browser, native helper, or network.
const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Usage: node tools/verify-export.ts <path-to-index.html> [...]');
const results: unknown[] = [];
for (const entry of paths) {
  const htmlPath = path.resolve(entry), directory = path.dirname(htmlPath);
  const [document, manifestText, lines] = await Promise.all([
    readFile(htmlPath, 'utf8'), readFile(path.join(directory, 'manifest.json'), 'utf8'),
    readFile(path.join(directory, 'messages.jsonl'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText), messages = lines.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const customer = JSON.parse(await readFile(path.join(directory, 'customer.json'), 'utf8'));
  for (const field of ['originalName', 'remarkName', 'phone', 'accountName']) assert.equal(customer[field], manifest.customer[field]);
  assert.equal(messages.length, manifest.messages);
  assert.equal([...document.matchAll(/<article\b/g)].length, messages.length);
  assert.equal([...document.matchAll(/<p class="missing">/g)].length, manifest.missingMedia);
  assert.ok(['unknown', 'date-range-confirmed'].includes(manifest.historyBoundary));
  if (manifest.range) for (const message of messages) if (message.sent_at) {
    assert.ok(!manifest.range.from || Date.parse(message.sent_at) >= Date.parse(manifest.range.from));
    assert.ok(Date.parse(message.sent_at) <= Date.parse(manifest.range.until));
  }
  assert.ok(!/<script\b/i.test(document), 'Export must not contain executable scripts');
  const media = new Map<string, { size: number }>();
  for (const message of messages) for (const asset of message.assets) {
    if (asset.status === 'downloaded' && asset.path) media.set(`media/${path.basename(asset.path)}`, asset);
  }
  const references = [...document.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  for (const reference of references) {
    assert.ok(/^media\/[a-f0-9-]{32,110}\.[a-z0-9]+$/.test(reference), `Unexpected external or unsafe reference: ${reference}`);
    assert.ok(media.has(reference), 'Media reference must match a recorded asset');
  }
  let bytes = 0;
  for (const [relative, asset] of media) {
    const info = await stat(path.join(directory, relative));
    assert.ok(info.isFile() && info.size > 0); assert.equal(info.size, asset.size);
    bytes += info.size;
  }
  await Promise.all(['versions.jsonl', 'missing-media.csv'].map(name => readFile(path.join(directory, name))));
  results.push({ path: htmlPath, messages: messages.length, media: media.size, mediaBytes: bytes, missingMedia: manifest.missingMedia, unknownTimeMessages: manifest.unknownTimeMessages || 0, range: manifest.range, historyBoundary: manifest.historyBoundary, customerProfileConsistent: true, portableReferences: true, filesPresentAndNonempty: true });
}
console.log(JSON.stringify(results, null, 2));
