import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { customerPagePlan, customersFromList } from '../packages/capture-core/history.ts';
import { Archive } from '../apps/native-host/archive.ts';
import { batch, message } from './fixtures.ts';
import type { BatchOptions, Customer } from '../packages/shared/model.ts';
const options: BatchOptions = { mode: 'date', from: '2026-07-31T16:00:00.000Z', until: '2026-10-01T00:00:00.000Z', count: 1000, customerLimit: 0, scope: { view: '全部', status: '全部', search: '', filters: '', sort: 'desc' } };
const row = (id: string, at: string | null, pinned = false): Customer => ({ projectId: 'demo-project', customerId: id, conversationId: id, name: id, channelId: 'channel', channelName: 'Our page', latestAt: at, pinned });

test('verified list fields retain original name, remark, phone and actual latest message time independently of reply direction', () => {
  const [customer] = customersFromList({ code: 0, data: { list: [{ project_id: 'demo-project', chat_user_id: 'c', id: 's', name: 'Messenger full name', remark_name: 'Order 1000', phone: '+63 9001234567', channel: '1', channel_name: 'Our page', snippet_time: Date.parse('2026-09-25T00:00:00Z'), last_reply_time: Date.parse('2026-06-13T00:00:00Z'), user_last_reply_time: Date.parse('2026-09-25T00:00:00Z'), pin_time: '0' }] } }, {});
  assert.equal(customer.name, 'Order 1000');
  assert.equal(customer.latestAt, '2026-09-25T00:00:00.000Z');
  assert.deepEqual(customer.profile, { originalName: 'Messenger full name', remarkName: 'Order 1000', phone: '+63 9001234567', channelCode: '1', accountName: 'Our page' });
});
test('old pinned customers never enter a date queue and never establish its cutoff', () => {
  const plan = customerPagePlan([row('old-pin', '2026-06-13T00:00:00.000Z', true), row('recent-pin', '2026-09-25T00:00:00.000Z', true)], options);
  assert.deepEqual(plan.eligible.map(customer => customer.customerId), ['recent-pin']);
  assert.equal(plan.skipped, 1); assert.equal(plan.dateBoundary, false);
});
test('verified descending ordinary rows stop discovery at the date boundary including timezone and equality', () => {
  const plan = customerPagePlan([row('new', '2026-09-25T00:00:00.000Z'), row('boundary', options.from), row('old', '2026-07-31T15:59:59.999Z')], options);
  assert.deepEqual(plan.eligible.map(customer => customer.customerId), ['new', 'boundary']);
  assert.equal(plan.dateBoundary, true);
});
test('unknown times, unverified ordering and out-of-order pages cannot prematurely stop discovery', () => {
  assert.equal(customerPagePlan([row('old', '2026-06-13T00:00:00.000Z'), row('recent', '2026-09-25T00:00:00.000Z')], options).dateBoundary, false);
  const unknown = customerPagePlan([row('unknown', null), row('old', '2026-06-13T00:00:00.000Z')], options);
  assert.equal(unknown.dateBoundary, false); assert.equal(unknown.eligible[0].customerId, 'unknown');
  assert.equal(customerPagePlan([row('old', '2026-06-13T00:00:00.000Z')], { ...options, scope: { ...options.scope, sort: undefined } }).dateBoundary, false);
});
test('profiles persist without duplicate customers, survive missing later fields, and accompany CSV and safe HTML exports', async () => {
  const archive = await Archive.create(await mkdtemp(path.join(tmpdir(), 'salesmartly-profile-')));
  try {
    const job: any = archive.createJob(options);
    const profile = { originalName: '<script>Customer</script>', remarkName: 'Order 1000', phone: '+63 9001234567', channelCode: '1', accountName: 'Our page' };
    const customer = { ...row('demo-customer', '2026-09-25T00:00:00.000Z'), profile };
    archive.saveCustomers(job.id, [customer, row('old', '2026-06-13T00:00:00.000Z')]);
    archive.saveCustomers(job.id, [{ ...customer, profile: { ...profile, phone: '' } }]);
    assert.equal((archive.job(job.id) as any).totals.total, 1);
    assert.equal(archive.db.prepare('SELECT count(*) AS n FROM customers').get()!.n, 1);
    assert.equal(JSON.parse(String(archive.db.prepare('SELECT profile_json FROM customers').get()!.profile_json)).phone, profile.phone);
    archive.capture(batch([message()]));
    const conversationId = String(archive.db.prepare('SELECT id FROM conversations').get()!.id);
    const exported = await archive.exportConversation(conversationId), html = await readFile(exported.path, 'utf8');
    assert.ok(html.includes('&lt;script&gt;Customer&lt;/script&gt;')); assert.ok(!html.includes('<script>'));
    assert.ok(html.includes(profile.phone)); assert.ok(html.includes('所属社媒账号：Our page'));
    const manifest = JSON.parse(await readFile(path.join(path.dirname(exported.path), 'manifest.json'), 'utf8'));
    assert.equal(manifest.customer.phone, profile.phone); assert.equal(manifest.customer.originalName, profile.originalName);
    const csv = await archive.exportCustomers(job.id), body = await readFile(csv.path, 'utf8');
    assert.equal(csv.customers, 1); assert.ok(body.includes('客户原名')); assert.ok(body.includes(profile.phone));
  } finally { archive.close(); }
});
test('a new date task exports only its own customers and time range even when earlier and later messages already exist locally', async () => {
  const archive = await Archive.create(await mkdtemp(path.join(tmpdir(), 'salesmartly-export-range-')));
  try {
    const job: any = archive.createJob({ ...options, from: '2026-09-26T16:00:00.000Z', until: '2026-10-01T00:00:00.500Z', customerLimit: 5 });
    archive.saveCustomers(job.id, [row('demo-customer', '2026-09-28T00:00:00.000Z')]);
    archive.capture(batch([
      message({ sourceId: 'before', sentAt: '2026-08-10T00:00:00.000Z' }),
      message({ sourceId: 'at-start', sentAt: '2026-09-26T16:00:00Z' }),
      message({ sourceId: 'during', sentAt: '2026-09-28T00:00:00.000Z' }),
      message({ sourceId: 'end-second', sentAt: '2026-10-01T00:00:00Z' }),
      message({ sourceId: 'end-plus-millisecond', sentAt: '2026-10-01T00:00:00.501Z' }),
      message({ sourceId: 'after', sentAt: '2026-10-02T00:00:00.000Z' }),
    ]));
    archive.updateCustomer(job.id, 'demo-customer', { status: 'complete', reason: '已加载至指定起始日期' });
    const conversations = archive.conversations(0, job.id) as any[];
    assert.equal(conversations.length, 1); assert.equal(conversations[0].message_count, 3);
    const exported = await archive.exportConversation(conversations[0].id, job.id);
    assert.equal(exported.messages, 3);
    const directory = path.dirname(exported.path), manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const lines = await readFile(path.join(directory, 'messages.jsonl'), 'utf8');
    assert.deepEqual(lines.trim().split('\n').map(line => JSON.parse(line).source_id), ['at-start', 'during', 'end-second']);
    assert.equal(manifest.range.from, '2026-09-26T16:00:00.000Z'); assert.equal(manifest.historyBoundary, 'date-range-confirmed');
    assert.ok((await readFile(exported.path, 'utf8')).includes('2026/9/27'));
    assert.equal((archive.stats() as any).messages, 6, 'Filtering an export never deletes earlier archive data');
  } finally { archive.close(); }
});
