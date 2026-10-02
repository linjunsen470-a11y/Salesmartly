import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Read-only live checks: no chat text, phone numbers, credentials or media hashes
// are printed. The evidence file distinguishes progress from full completion.
const root = path.resolve('.local/archive');
const db = new DatabaseSync(path.join(root, 'archive.sqlite'), { readOnly: true });
try {
  db.exec('BEGIN');
  const job = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 1').get()!;
  const options = JSON.parse(String(job.options_json));
  assert.equal(options.mode, 'date'); assert.ok(Number.isInteger(options.customerLimit) && options.customerLimit >= 0);
  const bounded = options.customerLimit > 0;
  if (bounded) {
    assert.equal(options.customerLimit, 5, 'The authorized live sample is limited to five customers');
    assert.equal(Date.parse(options.from), Date.parse('2026-09-26T16:00:00Z'), 'The live sample starts on September 27 in Beijing');
  }
  assert.equal(options.scope.view, '全部'); assert.equal(options.scope.status, '全部');
  assert.equal(options.scope.sort, 'desc'); assert.equal(options.scope.search, '');
  const rules = JSON.parse(options.scope.rules);
  assert.ok(!rules.rules.some((row: any) => row.fields.includes('接待成员') && row.members.some((name: string) => name !== '全部')));
  const queue = db.prepare('SELECT * FROM job_customers WHERE job_id=? ORDER BY rowid').all(job.id);
  if (bounded) assert.ok(queue.length <= options.customerLimit);
  const metadata = queue.map(row => JSON.parse(String(row.metadata_json)));
  const old = metadata.filter(row => row.latestAt && row.latestAt < options.from);
  assert.equal(old.length, 0, 'Customers whose last message predates the range must not enter the queue');
  assert.ok(metadata.length > 0, 'Verify a real nonempty all-member job');
  assert.ok(queue.some(row => row.status === 'complete' && Number(row.observed) > 0), 'Real customer history must be committed');
  const duplicateMessages = Number(db.prepare('SELECT count(*) AS n FROM (SELECT conversation_id,source_id FROM messages GROUP BY conversation_id,source_id HAVING count(*)>1)').get()!.n);
  const duplicateCustomers = Number(db.prepare('SELECT count(*) AS n FROM (SELECT project_id,customer_id FROM customers GROUP BY project_id,customer_id HAVING count(*)>1)').get()!.n);
  assert.equal(duplicateMessages, 0); assert.equal(duplicateCustomers, 0);
  const contacts = db.prepare("SELECT count(*) AS customers,sum(coalesce(json_extract(c.profile_json,'$.phone'),'')<>'') AS withPhone,sum(coalesce(json_extract(c.profile_json,'$.originalName'),'')<>'') AS withOriginalName,sum(coalesce(json_extract(c.profile_json,'$.remarkName'),'')<>'') AS withRemarkName,sum(coalesce(json_extract(c.profile_json,'$.accountName'),'')<>'') AS withAccountName FROM customers c JOIN job_customers q ON q.customer_id=c.customer_id AND q.project_id=c.project_id WHERE q.job_id=?").get(job.id)!;
  assert.equal(contacts.customers, queue.length);
  assert.ok(Number(contacts.withPhone) > 0 && Number(contacts.withOriginalName) > 0 && Number(contacts.withAccountName) > 0);
  const diagnostics = db.prepare("SELECT diagnostic_json FROM batches WHERE captured_at>=? AND json_extract(diagnostic_json,'$.event')='customer-list'").all(job.created_at).map(row => JSON.parse(String(row.diagnostic_json)));
  const history = db.prepare("SELECT diagnostic_json FROM batches WHERE captured_at>=? AND json_type(diagnostic_json,'$.pagination.next_pk') IS NOT NULL").all(job.created_at).map(row => JSON.parse(String(row.diagnostic_json)));
  const scopedAssets = db.prepare(`SELECT a.status,a.size,a.path FROM assets a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id JOIN job_customers q ON q.customer_id=json_extract(c.scope_json,'$.customerId') AND q.project_id=json_extract(c.scope_json,'$.projectId') WHERE q.job_id=? AND (m.sent_at IS NULL OR julianday(m.sent_at)>=julianday(?)) AND (m.sent_at IS NULL OR julianday(m.sent_at)<=julianday(?))`).all(job.id, options.from, options.until);
  const downloaded = scopedAssets.filter(row => row.status === 'downloaded');
  for (const file of downloaded) { const info = await stat(path.join(root, String(file.path))); assert.ok(info.isFile() && info.size > 0); assert.equal(info.size, file.size); }
  const result = {
    version: '0.3.0', verifiedAt: new Date().toISOString(), jobId: job.id,
    status: job.status, phase: job.phase, error: job.error,
    scope: options.scope, from: options.from, until: options.until, customerLimit: options.customerLimit,
    verificationScope: bounded ? 'bounded-customer-sample' : 'all-accessible-customers-in-date-range',
    boundedByCustomerLimit: bounded,
    enumerationComplete: !!job.enumeration_complete, configuredJobCompleted: job.status === 'complete',
    fullAccountRangeVerified: !bounded && job.status === 'complete' && !!job.enumeration_complete,
    totals: db.prepare("SELECT count(*) AS candidates,sum(status='complete') AS complete,sum(status='partial') AS gaps,sum(status IN ('waiting','running')) AS waiting,sum(observed) AS observed,sum(inserted) AS inserted,sum(updated) AS updated,sum(unchanged) AS unchanged FROM job_customers WHERE job_id=?").get(job.id),
    knownBeforeDateQueued: old.length, unknownLatestDate: metadata.filter(row => !row.latestAt).length,
    oldestCandidateLatestMessage: metadata.map(row => row.latestAt).filter(Boolean).sort()[0],
    latestCandidateMessage: metadata.map(row => row.latestAt).filter(Boolean).sort().at(-1),
    listResponses: diagnostics.length, skippedBeforeDate: diagnostics.reduce((n, row) => n + Number(row.skippedBeforeDate || 0), 0),
    dateCutoffObserved: diagnostics.some(row => row.dateBoundary === true), lastListPage: diagnostics.at(-1),
    contacts, duplicateMessages, duplicateCustomers,
    historyCursorRequests: history.filter(row => row.request?.sequence_id).length,
    explicitHistoryEnds: history.filter(row => String(row.pagination?.package_limit) === '0' && row.pagination.next_pk && Object.keys(row.pagination.next_pk).length === 0).length,
    boundaries: db.prepare("SELECT reason,count(*) AS customers FROM job_customers WHERE job_id=? AND status='complete' GROUP BY reason").all(job.id),
    gaps: queue.filter(row => row.status === 'partial').map(row => ({ customerId: row.customer_id, reason: row.reason })),
    media: { downloaded: downloaded.length, bytes: downloaded.reduce((n, file) => n + Number(file.size), 0), states: Object.entries(scopedAssets.reduce<Record<string, number>>((counts, row) => { counts[String(row.status)] = (counts[String(row.status)] || 0) + 1; return counts; }, {})).map(([status, n]) => ({ status, n })) },
    sha256Validation: false,
  };
  db.exec('COMMIT');
  await mkdir('.local/verification', { recursive: true });
  await writeFile('.local/verification/v03-live-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { db.close(); }
