import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const proof = path.resolve('.local/verification');
const first = JSON.parse(await readFile(path.join(proof, 'v02-live-first.json'), 'utf8'));
const repeat = JSON.parse(await readFile(path.join(proof, 'v02-live-repeat.json'), 'utf8'));
const date = JSON.parse(await readFile(path.join(proof, 'v02-live-date.json'), 'utf8'));
for (const sample of [first, repeat, date]) {
  assert.equal(sample.job.status, 'complete');
  assert.equal(sample.customers.length, 2);
  assert.ok(sample.customers.every((customer: any) => customer.status === 'complete'));
}
assert.deepEqual(repeat.counts, first.counts, 'Repeating the same history must not duplicate messages, versions or media');
assert.ok(repeat.customers.every((customer: any) => customer.inserted === 0 && customer.updated === 0));
assert.equal(date.job.mode, 'date');
assert.equal(date.job.from, '2026-09-28T16:00:00.000Z', 'Dates use UTC+8');
const root = path.resolve('.local/archive'), db = new DatabaseSync(path.join(root, 'archive.sqlite'), { readOnly: true });
let mediaBytes = 0;
try {
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(date.job.id)!.status, 'complete', 'Closing a completed capture tab must not pause its finished job');
  assert.equal(db.prepare('SELECT count(*) AS n FROM coverage WHERE job_id=?').get(date.job.id)!.n, 2);
  const assets = db.prepare("SELECT path,size FROM assets WHERE status='downloaded'").all();
  for (const asset of assets) {
    const file = await stat(path.join(root, String(asset.path)));
    assert.ok(file.isFile() && file.size > 0);
    assert.equal(file.size, asset.size);
    mediaBytes += file.size;
  }
  const result = {
    customersPerTask: 2, countTarget: first.job.count, countTask: first.job.status,
    dateTask: date.job.status, dateFromUtc: date.job.from, provenDateCoverage: 2,
    repeatObserved: repeat.customers.reduce((sum: number, customer: any) => sum + customer.observed, 0),
    extraMessages: repeat.counts.messages - first.counts.messages,
    extraVersions: repeat.counts.versions - first.counts.versions,
    extraAssets: repeat.counts.assets - first.counts.assets,
    databaseMessages: date.counts.messages, databaseVersions: date.counts.versions,
    downloadedMedia: assets.length, mediaBytes,
    mediaTypes: db.prepare("SELECT mime,count(*) AS count FROM assets WHERE status='downloaded' GROUP BY mime").all(),
    completedTabClosedWithoutPause: true, sha256Validation: false,
  };
  await writeFile(path.join(proof, 'v02-live-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { db.close(); }
