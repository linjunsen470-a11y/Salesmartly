import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.local/archive');
const db = new DatabaseSync(path.join(root, 'archive.sqlite'), { readOnly: true });
try {
  db.exec('BEGIN');
  const job = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 1').get()!;
  const options = JSON.parse(String(job.options_json));
  const totals = db.prepare("SELECT count(*) AS discovered,sum(status='complete') AS complete,sum(status='partial') AS gaps,sum(status IN ('waiting','running')) AS waiting,sum(observed) AS observed,sum(inserted) AS inserted,sum(updated) AS updated,sum(unchanged) AS unchanged FROM job_customers WHERE job_id=?").get(job.id)!;
  assert.equal(options.customerLimit, 0, 'Live proof must use the unlimited customer path');
  assert.equal(options.mode, 'date');
  assert.ok(Number(totals.discovered) >= 50);
  assert.ok(Number(totals.complete) >= 50, 'Verify at least a complete list page of customers');
  assert.ok(Number(totals.observed) > 0);
  const first = db.prepare('SELECT * FROM job_customers WHERE job_id=? ORDER BY rowid LIMIT 1').get(job.id)!;
  assert.equal(first.status, 'complete', String(first.reason));
  assert.ok(String(first.oldest) <= options.from || first.reason === '网页明确返回历史末尾', 'The first long chat must reach its date boundary or proven EOF');
  const pages = db.prepare("SELECT captured_at,count,diagnostic_json FROM batches WHERE captured_at>=? AND json_type(diagnostic_json,'$.pagination.next_pk') IS NOT NULL").all(job.created_at).map(row => ({ at: row.captured_at, count: row.count, diagnostic: JSON.parse(String(row.diagnostic_json)) }));
  const cursorPages = pages.filter(page => page.diagnostic.request?.sequence_id);
  const terminalPages = pages.filter(page => page.diagnostic.pagination?.package_limit === '0' && page.diagnostic.pagination.next_pk && Object.keys(page.diagnostic.pagination.next_pk).length === 0);
  assert.ok(cursorPages.length >= 2, 'Real history requests must advance their sequence cursor');
  assert.ok(terminalPages.length > 0, 'Short chats must have explicit server cursor exhaustion');
  const duplicates = Number(db.prepare('SELECT count(*) AS n FROM (SELECT conversation_id,source_id FROM messages GROUP BY conversation_id,source_id HAVING count(*)>1)').get()!.n);
  assert.equal(duplicates, 0, 'Repeated observations must not create duplicate message rows');
  const downloaded = db.prepare("SELECT size,path,mime FROM assets WHERE status='downloaded'").all();
  for (const file of downloaded) {
    const info = await stat(path.join(root, String(file.path)));
    assert.ok(info.isFile() && info.size > 0); assert.equal(info.size, file.size);
  }
  const result = {
    version: '0.2.1', verifiedAt: new Date().toISOString(),
    jobId: job.id, status: job.status, enumerationComplete: !!job.enumeration_complete,
    mode: options.mode, from: options.from, until: options.until, customerLimit: options.customerLimit,
    totals, firstCustomer: { status: first.status, oldest: first.oldest, reason: first.reason },
    confirmedBoundaries: db.prepare("SELECT reason,count(*) AS customers FROM job_customers WHERE job_id=? AND status='complete' GROUP BY reason").all(job.id),
    completedWithNoRangeMessages: db.prepare("SELECT count(*) AS n FROM job_customers WHERE job_id=? AND status='complete' AND observed=0").get(job.id)!.n,
    historyCursorRequests: cursorPages.length, explicitHistoryEnds: terminalPages.length, duplicateMessageRows: duplicates,
    gaps: db.prepare("SELECT metadata_json,reason FROM job_customers WHERE job_id=? AND status='partial' ORDER BY rowid LIMIT 20").all(job.id).map(row => ({ name: JSON.parse(String(row.metadata_json)).name, reason: row.reason })),
    database: Object.fromEntries(['messages', 'versions', 'conversations', 'assets'].map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n])),
    media: { downloaded: downloaded.length, bytes: downloaded.reduce((sum, file) => sum + Number(file.size), 0), states: db.prepare('SELECT status,count(*) AS n FROM assets GROUP BY status').all() },
    fullJobCompleted: job.status === 'complete', sha256Validation: false,
  };
  db.exec('COMMIT');
  await writeFile('.local/verification/v021-live-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { db.close(); }
