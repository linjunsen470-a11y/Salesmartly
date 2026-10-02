import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Archive } from '../apps/native-host/archive.ts';
import { batch, message } from './fixtures.ts';
import type { CaptureBatch } from '../packages/shared/model.ts';

test('initial active-chat responses survive scope verification, bind to the selected customer, and wait for SQLite ACK', async () => {
  const archive = await Archive.create(await mkdtemp(path.join(tmpdir(), 'salesmartly-bootstrap-')));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const listeners: ((reply: unknown) => void)[] = [];
  let documentVersion = 0;
  const scope = { view: '全部', status: '全部', search: '', filters: '0|', sort: 'desc' as const };
  const port = {
    onMessage: { addListener(listener: (reply: unknown) => void) { listeners.push(listener); } },
    onDisconnect: { addListener() {} },
    postMessage(request: any) {
      queueMicrotask(() => {
        try {
          const p = request.payload; let result: unknown;
          switch (request.op) {
            case 'createJob': result = archive.createJob(p); break;
            case 'job': result = archive.job(p.jobId); break;
            case 'updateJob': result = archive.updateJob(p.jobId, p); break;
            case 'saveCustomers': result = archive.saveCustomers(p.jobId, p.customers, p.frozen); break;
            case 'updateCustomer': result = archive.updateCustomer(p.jobId, p.customerId, p); break;
            case 'historyInfo': result = archive.historyInfo(p.projectId, p.customerId, p.from, p.until, p.ids); break;
            case 'capture': result = archive.capture(p); break;
            default: throw new Error(`Unexpected native operation ${request.op}`);
          }
          for (const listener of listeners) listener({ id: request.id, ok: true, result });
        } catch (error) { for (const listener of listeners) listener({ id: request.id, ok: false, error: (error as Error).message }); }
      });
    },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime: { connectNative: () => port },
    storage: { local: { async get() { return {}; }, async set() {} } },
    tabs: {
      async get() { return { url: 'https://app.salesmartly.com/next/chat' }; },
      async create() { return { id: 2 }; },
      async update() {},
      async reload() { documentVersion++; },
      async sendMessage(_tab: number, request: any) { if (request.op === 'driverContext') { assert.equal(request.archiveAll, true); return { ok: true, result: scope }; } return { ok: true }; },
    },
    scripting: { async executeScript() { return [{ result: true, documentId: `fixture-page-${documentVersion}` }]; } },
  } });
  try {
    const manager = await import('../apps/extension/batch.ts');
    const source = 'https://api.salesmartly.com/chat/chat-user/get-message-list';
    const list = { code: 0, data: { list: [
      { project_id: 'demo-project', chat_user_id: 'demo-customer', id: 'demo-session', name: 'First' },
      { project_id: 'demo-project', chat_user_id: 'other-customer', id: 'other-session', name: 'Other' },
    ], next_page: '0' } };
    const hints = { projectId: 'demo-project', customerId: 'demo-customer' };
    const data = { code: 0, data: { list: [{}], page: 1, page_size: 20, next_pk: {}, package_limit: '0' } };
    const options = { mode: 'date' as const, from: '2026-09-01T00:00:00.000Z', count: 1000, customerLimit: 0 };
    const store = async (value: CaptureBatch) => { archive.capture(value); };
    for (const arrival of ['before-scope', 'after-scope']) {
      const job: any = await manager.batchStart(1, options, async () => {});
      await manager.batchReceive(list, { projectId: 'demo-project' }, 'https://api.salesmartly.com/chat/chat/get-chat-list', batch([], `list-${arrival}`), store);
      if (arrival === 'before-scope') await manager.batchReceive(data, hints, source, batch([message({ sourceId: arrival })], arrival), store);
      await manager.batchCommand({ op: 'batchScopeConfirmed', scope, unchanged: true }, 2, store);
      if (arrival === 'after-scope') await manager.batchReceive(data, hints, source, batch([message({ sourceId: arrival })], arrival), store);
      assert.equal((archive.job(job.id) as any).totals.observed || 0, 0, 'An unselected response must remain buffered');
      let acknowledge!: () => void, entered!: () => void;
      const ack = new Promise<void>(resolve => acknowledge = resolve), submitted = new Promise<void>(resolve => entered = resolve);
      const selection = manager.batchCommand({ op: 'batchSelect', customerId: hints.customerId }, 2, async value => { entered(); await ack; archive.capture(value); });
      await submitted;
      assert.equal((await manager.batchCommand({ op: 'batchSnapshot' }, 2) as any).history, null, 'History cannot advance before ACK');
      acknowledge(); await selection;
      const snapshot: any = await manager.batchCommand({ op: 'batchSnapshot' }, 2);
      assert.equal(snapshot.history.customerId, hints.customerId);
      assert.equal(snapshot.history.messages[0].id, arrival);
      assert.equal(snapshot.history.hasMore, false);
      assert.equal((archive.job(job.id) as any).totals.observed, 1);
      await manager.batchPause('fixture finished');
    }
    const job: any = await manager.batchStart(1, options, async () => {});
    await manager.batchReceive(list, { projectId: 'demo-project' }, 'https://api.salesmartly.com/chat/chat/get-chat-list', batch([], 'list-other'), store);
    await manager.batchReceive(data, { ...hints, customerId: 'other-customer' }, source, batch([message({ sourceId: 'other', scope: { ...message().scope, customerId: 'other-customer' } })], 'other'), store);
    await manager.batchCommand({ op: 'batchScopeConfirmed', scope, unchanged: true }, 2, store);
    await manager.batchCommand({ op: 'batchSelect', customerId: hints.customerId }, 2, store);
    assert.equal((await manager.batchCommand({ op: 'batchSnapshot' }, 2) as any).history, null);
    assert.equal((archive.job(job.id) as any).totals.observed || 0, 0, 'Another active customer must not be attributed to the selected one');
    await manager.batchCommand({ op: 'batchSelect', customerId: 'other-customer' }, 2, store);
    assert.equal((await manager.batchCommand({ op: 'batchSnapshot' }, 2) as any).history.customerId, 'other-customer');
    await manager.batchCommand({ op: 'batchCustomerDone', customerId: 'demo-customer', complete: false, reason: 'temporary timeout' }, 2);
    await manager.batchCommand({ op: 'batchCustomerDone', customerId: 'other-customer', complete: true, reason: 'EOF' }, 2);
    await manager.batchCommand({ op: 'batchEnumerated', complete: true }, 2);
    await manager.batchCommand({ op: 'batchFinish' }, 2);
    assert.equal((archive.job(job.id) as any).status, 'partial');
    assert.deepEqual((archive.job(job.id) as any).gaps, [{ name: 'First', reason: 'temporary timeout' }]);
    const messages = (archive.stats() as any).messages;
    await manager.batchResume(async () => {});
    assert.equal((archive.job(job.id) as any).status, 'running', 'Partial jobs can retry their saved gaps');
    assert.equal((archive.stats() as any).messages, messages, 'Resume preserves existing archive rows');
    assert.equal(manager.batchActive(), true);
    await manager.batchPause('fixture finished');
    const dateJob: any = await manager.batchStart(1, options, async () => {});
    await manager.batchReceive({ code: 0, data: { list: [
      { chat_user_id: 'old-pinned', id: 'old-pinned-session', name: 'Old pinned', snippet_time: Date.parse('2026-06-13T00:00:00Z'), pin_time: 1 },
      { chat_user_id: 'recent', id: 'recent-session', name: 'Recent', snippet_time: Date.parse('2026-09-20T00:00:00Z'), pin_time: 0 },
      { chat_user_id: 'old-ordinary', id: 'old-ordinary-session', name: 'Old', snippet_time: Date.parse('2026-06-13T00:00:00Z'), pin_time: 0 },
    ], next_page: '1' } }, { projectId: 'demo-project' }, 'https://api.salesmartly.com/chat/chat/get-chat-list', batch([], 'date-list'), store);
    await manager.batchCommand({ op: 'batchScopeConfirmed', scope, unchanged: true }, 2, store);
    const planned: any = await manager.batchCommand({ op: 'batchSnapshot' }, 2);
    assert.equal(planned.list.hasMore, false);
    assert.equal(planned.list.dateBoundary, true);
    assert.deepEqual((archive.jobCustomers(dateJob.id) as any[]).map(row => row.customerId || row.customer_id), ['recent']);
    await manager.batchReceive({ code: 0, data: { list: [
      { chat_user_id: 'recent', id: 'recent-session', name: 'Recent', snippet_time: Date.parse('2026-09-20T00:00:00Z'), pin_time: 0 },
    ], next_page: '1' } }, { projectId: 'demo-project', scopeContext: scope }, 'https://api.salesmartly.com/chat/chat/get-chat-list', batch([], 'late-earlier-list'), store);
    assert.equal((await manager.batchCommand({ op: 'batchSnapshot' }, 2) as any).list.hasMore, false, 'A delayed earlier page cannot reopen a proven date cutoff');
    await manager.batchPause('fixture finished');
    const historyJob: any = await manager.batchStart(1, options, async () => {});
    await manager.batchCommand({ op: 'batchScopeConfirmed', scope, unchanged: true }, 2, store);
    await manager.batchReceive({ code: 0, data: { list: [
      { project_id: 'demo-project', chat_user_id: 'demo-customer', id: 'demo-session', name: 'First' },
    ], next_page: '0' } }, { projectId: 'demo-project', scopeContext: scope }, 'https://api.salesmartly.com/chat/chat/get-chat-list', batch([], 'history-list'), store);
    await manager.batchCommand({ op: 'batchSelect', customerId: 'demo-customer' }, 2, store);
    const historyBody = { code: 0, data: { list: [{}], page: 1, page_size: 20, next_pk: { chat_user_id: 'demo-customer', sequence_id: '20' }, package_limit: '0' } };
    await manager.batchReceive(historyBody, { projectId: 'demo-project', customerId: 'demo-customer' }, 'https://api.salesmartly.com/chat/chat-user/get-chat-history-message-list', batch([message({ sourceId: 'older-page' })], 'older-page'), store);
    let snap: any = await manager.batchCommand({ op: 'batchSnapshot' }, 2);
    assert.equal(snap.history.messages[0].id, 'older-page');
    assert.equal(snap.history.hasMore, true);
    const historySeq = snap.history.seq;
    await manager.batchReceive({ code: 0, data: { list: [{}] } }, { projectId: 'demo-project', customerId: 'demo-customer' }, 'https://api.salesmartly.com/chat/chat-user/get-pin-message-list', batch([message({ sourceId: 'pinned' })], 'pinned'), store);
    snap = await manager.batchCommand({ op: 'batchSnapshot' }, 2);
    assert.equal(snap.history.seq, historySeq, 'Pinned messages must not replace the history page');
    assert.equal(snap.history.messages[0].id, 'older-page');
    assert.equal((archive.job(historyJob.id) as any).totals.observed, 2);
    await manager.batchReceive({ code: 0, data: { unexpected: true } }, { projectId: 'demo-project', customerId: 'demo-customer' }, 'https://api.salesmartly.com/chat/chat-user/get-chat-history-message-text-list', batch([message({ sourceId: 'search-hit' })], 'search-hit'), store);
    snap = await manager.batchCommand({ op: 'batchSnapshot' }, 2);
    assert.equal(snap.history.seq, historySeq);
    assert.equal((archive.job(historyJob.id) as any).totals.observed, 2);
    await manager.batchPause('fixture finished');
    const capped: any = await manager.batchStart(1, { ...options, customerLimit: 1 }, async () => {});
    await manager.batchCommand({ op: 'batchScopeConfirmed', scope, unchanged: true }, 2, store);
    await manager.batchReceive(list, { projectId: 'demo-project', scopeContext: scope }, 'https://api.salesmartly.com/chat/chat/get-chat-list', batch([], 'cap-list'), store);
    const queued = archive.jobCustomers(capped.id) as any[];
    assert.equal(queued.length, 1);
    await manager.batchCommand({ op: 'batchEnumerated', complete: true }, 2);
    await manager.batchCommand({ op: 'batchCustomerDone', customerId: queued[0].customer_id, complete: true, reason: 'fixture' }, 2);
    await manager.batchCommand({ op: 'batchFinish' }, 2);
    const finished: any = archive.job(capped.id);
    assert.equal(finished.status, 'complete');
    assert.match(finished.phase, /1 位客户上限/);
  } finally {
    archive.close();
    if (previous) Object.defineProperty(globalThis, 'chrome', previous); else Reflect.deleteProperty(globalThis, 'chrome');
  }
});
