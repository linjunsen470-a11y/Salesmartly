import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Archive } from '../apps/native-host/archive.ts';
import { batch, message, png } from './fixtures.ts';
import { historyDecision } from '../packages/capture-core/decision.ts';
import { customersFromList, pageBoundary } from '../packages/capture-core/history.ts';
import type { BatchOptions, Customer } from '../packages/shared/model.ts';
const options: BatchOptions = { mode: 'date', from: '2026-06-01T00:00:00.000Z', until: '2026-09-30T00:00:00.000Z', count: 1000, customerLimit: 0, scope: { view: '我的', status: '全部', search: '', filters: '' } };
async function archive(): Promise<Archive> { return Archive.create(await mkdtemp(path.join(tmpdir(), 'salesmartly-v02-test-'))); }
const customer: Customer = { projectId: 'demo-project', customerId: 'demo-customer', conversationId: 'demo-session', name: '测试客户', channelId: 'channel-1', channelName: 'WhatsApp' };

test('three repeats and changing session/channel metadata keep one message, one revision and one asset', async () => {
  const store = await archive();
  try {
    const item = message({ attachments: [{ slot: '0', kind: 'image', url: 'https://assets.salesmartly.com/image.jpg?X-Amz-Signature=a' }] });
    store.capture(batch([item]));
    for (let index = 0; index < 3; index++) {
      const result = store.capture(batch([{ ...item, direction: 'outgoing', scope: { ...item.scope, channelAccountId: 'filled-in-channel', conversationId: 'new-session' }, raw: { ...item.raw as any, read_time: index } }], `repeat-${index}`));
      assert.equal(result.inserted, 0); assert.equal(result.updated, 0); assert.equal(result.unchanged, 1);
    }
    const stats = store.stats() as any; assert.equal(stats.messages, 1); assert.equal(stats.versions, 1); assert.equal(stats.conversations, 1); assert.equal(store.pendingMedia().length, 1);
    assert.equal(store.db.prepare('SELECT direction FROM messages').get()!.direction, 'outgoing');
  } finally { store.close(); }
});
test('real edits get revisions; an older or conflicting source revision cannot overwrite newer content', async () => {
  const store = await archive();
  try {
    store.capture(batch([message({ raw: { updated_time: 100 } })]));
    const edited = message({ text: 'edited', raw: { updated_time: 200 } });
    assert.equal(store.capture(batch([edited], 'edit')).updated, 1);
    assert.equal(store.capture(batch([message({ raw: { updated_time: 100 } })], 'late')).stale, 1);
    assert.equal(store.capture(batch([message({ raw: { updated_time: 200 } })], 'conflict')).stale, 1);
    assert.equal(store.db.prepare('SELECT text FROM messages').get()!.text, 'edited'); assert.equal((store.stats() as any).versions, 2);
  } finally { store.close(); }
});
test('signed URL refresh preserves downloaded files; replacement detaches old file and stale download', async () => {
  const store = await archive();
  try {
    const media = (url: string) => message({ type: '2', attachments: [{ slot: '0', kind: 'image' as const, url }] });
    store.capture(batch([media('https://assets.salesmartly.com/a.png?X-Amz-Signature=one')]));
    const asset = store.pendingMedia()[0], plan = store.planDownload(asset.id); store.bindDownload(plan.jobId, 1);
    const staging = path.join(store.root, 'downloads', plan.suffix.replace(/\.jpg$/, '.png')); await mkdir(path.dirname(staging), { recursive: true }); await writeFile(staging, png);
    const result: any = await store.importDownload(plan.jobId, 1, staging);
    assert.equal(store.db.prepare('SELECT sha256 FROM assets').get()!.sha256, null); assert.ok((await stat(result.path)).size);
    await assert.rejects(stat(staging), /ENOENT/);
    store.capture(batch([media('https://assets.salesmartly.com/a.png?X-Amz-Signature=two')], 'refresh'));
    assert.equal(store.db.prepare('SELECT status FROM assets').get()!.status, 'downloaded'); assert.equal((store.stats() as any).versions, 1);
    store.capture(batch([media('https://assets.salesmartly.com/b.png')], 'replace'));
    assert.equal(store.db.prepare('SELECT path FROM assets').get()!.path, null); assert.equal(store.pendingMedia().length, 1); assert.ok((await stat(result.path)).size);
    const stale = store.planDownload(asset.id); store.bindDownload(stale.jobId, 2);
    const oldStaging = path.join(store.root, 'downloads', stale.suffix); await mkdir(path.dirname(oldStaging), { recursive: true }); await writeFile(oldStaging, png);
    store.capture(batch([media('https://assets.salesmartly.com/c.png')], 'replace-again'));
    await assert.rejects(store.importDownload(stale.jobId, 2, oldStaging), /旧下载/); store.failDownload(stale.jobId, 'stale');
    assert.equal(store.pendingMedia().length, 1);
  } finally { store.close(); }
});
test('pagination requires explicit source flags and empty/error responses are not inferred as completion', () => {
  assert.equal(pageBoundary({ data: { list: [] } }).hasMore, null);
  assert.equal(pageBoundary({ data: { next_page: '0' } }).hasMore, false);
  assert.equal(pageBoundary({ data: { next_page: '1' } }).hasMore, true);
  assert.throws(() => customersFromList({ code: 401, msg: 'login' }, {}));
  assert.throws(() => customersFromList({ code: 0, data: {} }, {}));
  const base = { unique: 100, known: 100, oldest: '2026-09-20T00:00:00.000Z', unknownTime: false, hasMore: true, incremental: false, target: '2026-09-25T00:00:00.000Z' };
  assert.equal(historyDecision(options, base).done, false);
  assert.equal(historyDecision(options, { ...base, incremental: true, known: 49 }).done, false);
  assert.equal(historyDecision(options, { ...base, incremental: true, known: 50 }).done, true);
  assert.equal(historyDecision(options, { ...base, oldest: '2026-05-01T00:00:00.000Z', unknownTime: true }).done, false);
  assert.equal(historyDecision({ ...options, mode: 'count', count: 101 }, base).done, false);
});

test('verified browser history cursors distinguish a short conversation end from a restricted or unknown response', () => {
  const page = { list: [], page: 1, page_size: 20, next_pk: {}, package_limit: '0' };
  assert.equal(pageBoundary({ data: page }).hasMore, false);
  assert.equal(pageBoundary({ data: { ...page, next_pk: { chat_user_id: 'c1', sequence_id: '1790618900575000' } } }).hasMore, true);
  assert.equal(pageBoundary({ data: { list: [], next_pk: {} } }).hasMore, null);
  assert.equal(pageBoundary({ data: { ...page, package_limit: '1' } }).hasMore, null);
  const base = { unique: 2, known: 0, oldest: '2026-09-20T00:00:00.000Z', unknownTime: false, hasMore: false, incremental: false, target: options.from };
  assert.equal(historyDecision(options, base).complete, true);
  assert.equal(historyDecision(options, { ...base, restricted: true }).complete, false);
});

test('resuming an interrupted customer does not leave two customers marked running', async () => {
  const store = await archive();
  try {
    const job: any = store.createJob(options);
    store.saveCustomers(job.id, [customer, { ...customer, customerId: 'next-customer' }]);
    store.updateCustomer(job.id, customer.customerId, { status: 'running' });
    store.updateJob(job.id, { status: 'paused' });
    store.updateCustomer(job.id, 'next-customer', { status: 'running' });
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM job_customers WHERE status='running'").get()!.n, 1);
    assert.equal((store.jobCustomers(job.id) as any[])[0].status, 'waiting');
  } finally { store.close(); }
});
test('customer queues exceed 100, persist across restart, and only proven coverage enables incremental review', async () => {
  const store = await archive(); const root = store.root;
  const job: any = store.createJob(options);
  const customers = Array.from({ length: 230 }, (_, index) => ({ ...customer, customerId: `c-${index}` })); store.saveCustomers(job.id, customers);
  assert.equal((store.jobCustomers(job.id, 200) as any[]).length, 30);
  const data = Array.from({ length: 80 }, (_, index) => message({ sourceId: `m-${index}`, sentAt: new Date(Date.parse(options.until) - index * 86400_000).toISOString() }));
  store.saveCustomers(job.id, [customer]); store.capture({ ...batch(data), jobId: job.id });
  assert.equal((store.historyInfo(customer.projectId, customer.customerId, options.from, options.until) as any).incremental, false);
  store.updateCustomer(job.id, customer.customerId, { status: 'partial', reason: 'timeout' });
  assert.equal((store.historyInfo(customer.projectId, customer.customerId, options.from, options.until) as any).incremental, false);
  store.updateCustomer(job.id, customer.customerId, { status: 'complete', reason: '指定日期' });
  const info: any = store.historyInfo(customer.projectId, customer.customerId, options.from, '2026-10-02T00:00:00.000Z');
  assert.equal(info.incremental, true); assert.ok(info.target < '2026-09-01T00:00:00.000Z');
  store.updateJob(job.id, { status: 'paused' }); store.close();
  const reopened = new Archive(root);
  try { assert.equal((reopened.job(job.id) as any).status, 'paused'); assert.equal((reopened.jobCustomers(job.id, 200) as any[]).length, 31); }
  finally { reopened.close(); }
});
test('an explicit customer limit never populates an oversized queue', async () => {
  const store = await archive();
  try {
    const job: any = store.createJob({ ...options, customerLimit: 2 });
    store.saveCustomers(job.id, Array.from({ length: 50 }, (_, index) => ({ ...customer, customerId: `c-${index}` })));
    assert.equal((store.job(job.id) as any).totals.total, 2);
  } finally { store.close(); }
});
