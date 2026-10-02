import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { Archive } from '../apps/native-host/archive.ts';
import { batch as capture, message } from './fixtures.ts';
import type { BatchOptions, Customer } from '../packages/shared/model.ts';
const code = await readFile(new URL('../dist/extension/driver.js', import.meta.url), 'utf8');

// A virtualized UI fixture. Only rows in the current viewport can be clicked;
// history pages become visible after SQLite ACK, just as the real worker requires.
async function fixture(mode: 'date' | 'count', explicitListEnd = true, rules?: string, count = 3, requireScrollEdge = false, config: { customers?: number; pageSize?: number; queued?: number; complete?: number; repeatList?: boolean; unavailable?: number; listDelay?: number; initialViewport?: number; hiddenPool?: boolean; originalNames?: boolean } = {}) {
  const archive = await Archive.create(await mkdtemp(path.join(tmpdir(), 'salesmartly-driver-test-')));
  const options: BatchOptions = { mode, from: '2026-06-01T00:00:00.000Z', until: '2026-09-30T00:00:00.000Z', count, customerLimit: 0, scope: { view: '我的', status: '全部', search: '', filters: '0|', ...(rules ? { rules } : {}) } };
  const job: any = archive.createJob(options);
  const customers: Customer[] = Array.from({ length: config.customers || 4 }, (_, index) => ({ projectId: 'demo-project', customerId: `customer-${index}`, conversationId: `session-${index}`, name: `客户 ${index}`, channelId: 'channel', channelName: 'WhatsApp' }));
  if (config.originalNames) for (const [index, customer] of customers.entries()) { customer.profile = { originalName: customer.name, remarkName: `业务备注 ${index}`, phone: '', channelCode: '', accountName: '' }; customer.name = customer.profile.remarkName; }
  const pageSize = config.pageSize || 2;
  let loaded = Math.min(pageSize, customers.length), enumerating = true;
  archive.saveCustomers(job.id, customers.slice(0, config.queued || loaded));
  for (const customer of customers.slice(0, config.complete || 0)) archive.updateCustomer(job.id, customer.customerId, { status: 'complete' });
  let current = '', selected = '', page = 0, sequence = 1, clock = Date.now(), ended = false;
  const clicks: string[] = [], historyLoads: string[] = [];
  const discovery: { loaded: number; messages: number }[] = [];
  let discoveredAtFirstCapture = 0;
  const state: any = { active: true, projectId: 'demo-project', list: { seq: 1, customers: customers.slice(0, loaded), hasMore: loaded === customers.length && explicitListEnd ? false : true }, history: null };
  let resolve!: () => void; const completion = new Promise<void>(done => resolve = done);
  const receiveHistory = () => {
    if (!discoveredAtFirstCapture) discoveredAtFirstCapture = loaded;
    const records = [0, 1].map(index => message({ scope: { projectId: 'demo-project', customerId: current, channelAccountId: 'channel', conversationId: 'session' }, sourceId: `${current}-${page}-${index}`, sentAt: page ? `2026-05-${20 + index}T00:00:00.000Z` : `2026-09-${20 + index}T00:00:00.000Z` }));
    const info: any = archive.historyInfo('demo-project', current, options.from, options.until, records.map(row => row.sourceId));
    archive.capture({ ...capture(records.filter(row => mode !== 'date' || row.sentAt! >= options.from), `page-${++sequence}`), jobId: job.id });
    state.history = { seq: sequence, customerId: current, messages: records.map(row => ({ id: row.sourceId, time: row.sentAt, known: info.known.includes(row.sourceId) })), incremental: false, target: options.from, hasMore: true };
  };
  class Element {
    textContent = ''; attributes: any[] = []; children: Element[] = []; offsetHeight = 30;
    clientHeight = 200; scrollHeight = 400; parentElement: Element | null = null;
    private top = 0;
    get scrollTop() { return this.top; }
    set scrollTop(value: number) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
    firstElementChild: Element | null = null;
    onClick = () => {}; onScroll = () => {};
    querySelectorAll(_selector: string): any[] { return []; }
    querySelector(_selector: string): Element | null { return this.firstElementChild; }
    contains(_node: unknown): boolean { return false; }
    getBoundingClientRect(): any { return { top: 0, bottom: this.clientHeight }; }
    closest(_selector: string): Element | null { return null; }
    click() { this.onClick(); }
    dispatchEvent(_event: Event) { this.onScroll(); }
  }
  const root = new Element(), list = new Element(), history = new Element(), view = new Element(), status = new Element();
  list.parentElement = root; view.textContent = '我的99+'; status.textContent = '全部';
  const rows = customers.map((customer, index) => {
    const row = new Element(), card = new Element(), leaf = new Element(); row.attributes = [{ name: 'data-customer-id', value: customer.customerId }];
    row.firstElementChild = card; row.children = [card]; card.children = [leaf]; leaf.textContent = config.originalNames ? customer.profile!.originalName : customer.name;
    row.getBoundingClientRect = () => ({ top: index * 100 - list.scrollTop, bottom: (index + 1) * 100 - list.scrollTop });
    row.querySelectorAll = () => [card, leaf]; row.querySelector = selector => selector === '.session-item' ? card : selector === '.session-item__content__top__left__name' ? leaf : null;
    row.onClick = () => { throw new Error('A virtual-list wrapper is not a customer click target'); };
    // Observed live behavior: the name can fetch data without selecting the
    // conversation. Only the complete card changes the active history view.
    leaf.onClick = () => { assert.equal(current, customer.customerId); page = 0; receiveHistory(); };
    card.onClick = () => { assert.equal(current, customer.customerId); selected = current; clicks.push(current); page = 0; if (customer !== customers[config.unavailable ?? -1]) receiveHistory(); };
    return row;
  });
  list.scrollHeight = loaded * 100;
  list.scrollTop = (config.initialViewport || 0) * 100;
  const ghost = new Element(), ghostCard = new Element(), ghostLeaf = new Element();
  ghost.attributes = [{ name: 'data-customer-id', value: customers[config.complete || 0].customerId }];
  ghost.getBoundingClientRect = () => ({ top: -9999, bottom: -9899 });
  ghost.firstElementChild = ghostCard; ghost.querySelectorAll = () => [ghostCard, ghostLeaf];
  ghost.querySelector = () => ghostCard; ghostLeaf.textContent = customers[config.complete || 0].name;
  ghostCard.onClick = () => { throw new Error('A nonzero-height offscreen recycled card must never be clicked'); };
  list.querySelectorAll = () => [...(config.hiddenPool ? [ghost] : []), ...rows.slice(Math.floor(list.scrollTop / 100), Math.min(loaded, Math.floor(list.scrollTop / 100) + 2))];
  list.querySelector = selector => selector === '.session-item--active' ? rows[customers.findIndex(customer => customer.customerId === selected)]?.firstElementChild || null : null;
  let pendingList: { at: number; receive: () => void } | null = null;
  const firstLookupScrolls: number[] = [];
  list.onScroll = () => {
    if (!discoveredAtFirstCapture) firstLookupScrolls.push(list.scrollTop);
    if (list.scrollTop < list.scrollHeight - list.clientHeight) return;
    if (loaded < customers.length && !pendingList) {
      const receive = () => {
        const next = customers.slice(loaded, loaded + pageSize); loaded += next.length;
        archive.saveCustomers(job.id, next); list.scrollHeight = loaded * 100;
        state.list = { seq: ++sequence, customers: next, hasMore: loaded === customers.length && explicitListEnd ? false : null };
        discovery.push({ loaded, messages: (archive.stats() as any).messages });
      };
      if (config.listDelay) pendingList = { at: clock + config.listDelay, receive }; else receive();
    } else if (config.repeatList) state.list.seq = ++sequence;
  };
  let leftTopAt: number | null = null;
  history.onScroll = () => {
    assert.equal(selected, current, 'History must belong to the selected conversation, not a prefetched name');
    if (history.scrollTop >= 100) leftTopAt = clock;
    if (history.scrollTop === 0 && page < 4 && (!requireScrollEdge || leftTopAt !== null && clock > leftTopAt)) {
      leftTopAt = null; page++; historyLoads.push(current); receiveHistory();
    }
  };
  const listeners: any[] = [];
  const document = { querySelector(selector: string) { return ({ '#dynamic_scroller_list': list, '.message-list__scroller': history, '.view-list__area__item--active': view, '.session-list__filter__tabs__item--active': status } as any)[selector] || null; }, querySelectorAll() { return []; }, addEventListener() {} };
  const chrome = { runtime: { id: 'fixture', onMessage: { addListener(listener: any) { listeners.push(listener); } }, async sendMessage(request: any) {
    let result: any;
    switch (request.op) {
      case 'batchScopeConfirmed': break;
      case 'batchSnapshot': result = structuredClone(state); break;
      case 'batchStatus': result = { enumerating, job: archive.job(job.id) }; break;
      case 'batchPhase': result = archive.updateJob(job.id, { phase: request.phase }); break;
      case 'batchEnumerated': enumerating = false; result = archive.updateJob(job.id, { enumerationComplete: request.complete }); break;
      case 'batchCustomers': result = archive.jobCustomers(job.id, request.offset); break;
      case 'batchSelect': current = request.customerId; archive.updateCustomer(job.id, current, { status: 'running' }); break;
      case 'batchCustomerDone': archive.updateCustomer(job.id, request.customerId, { status: request.complete ? 'complete' : 'partial', reason: request.reason, oldest: request.oldest }); break;
      case 'batchFinish': { const value: any = archive.job(job.id); result = archive.updateJob(job.id, { status: value.enumeration_complete && value.totals.complete === value.totals.total ? 'complete' : 'partial' }); state.active = false; ended = true; resolve(); break; }
      case 'batchPause': archive.updateJob(job.id, { status: 'paused', error: request.reason }); state.active = false; ended = true; resolve(); break;
      default: throw new Error(`Unexpected operation ${request.op}`);
    }
    return { ok: true, result };
  } } };
  class Clock extends Date { static override now() { return clock; } }
  const context = { window: {}, document, chrome, HTMLElement: Element, Event, Date: Clock, setTimeout(callback: () => void, ms: number) {
    clock += ms;
    if (pendingList && clock >= pendingList.at) { const value = pendingList; pendingList = null; value.receive(); }
    return setTimeout(callback, 1);
  } };
  runInNewContext(code, context); runInNewContext(code, context); assert.equal(listeners.length, 1, 'Reopening panel must not start duplicate drivers');
  listeners[0]({ op: 'driverRun', options }, { id: 'fixture' }, () => {});
  const timer = setTimeout(() => { if (!ended) { state.active = false; resolve(); } }, 15000);
  await completion; clearTimeout(timer);
  return { archive, job: archive.job(job.id) as any, clicks, historyLoads, discovery, discoveredAtFirstCapture, firstLookupScrolls };
}
test('targets above the current viewport rewind promptly; recycled ghost cards and original-name display do not break selection', async () => {
  const value = await fixture('date', true, undefined, 3, true, { customers: 100, pageSize: 100, queued: 100, complete: 40, initialViewport: 80, hiddenPool: true, originalNames: true });
  try {
    assert.equal(value.job.status, 'complete', value.job.error);
    assert.equal(value.job.totals.complete, 100); assert.equal(value.clicks[0], 'customer-40');
    assert.equal(value.clicks.length, 60); assert.equal((value.archive.stats() as any).messages, 120);
    const rewind = value.firstLookupScrolls.indexOf(0); assert.ok(rewind >= 0);
    assert.ok(Math.max(...value.firstLookupScrolls.slice(0, rewind)) < 9000, 'The first lookup must rewind before scanning the remaining inbox');
  } finally { value.archive.close(); }
});
test('the driver captures each discovered customer page before advancing the virtual list', async () => {
  const value = await fixture('date');
  try { assert.equal(value.job.status, 'complete', value.job.error); assert.equal(value.job.totals.complete, 4); assert.equal((value.archive.stats() as any).messages, 8); assert.equal(value.clicks.length, 4); assert.equal(value.historyLoads.length, 4); assert.equal(value.discoveredAtFirstCapture, 2); assert.ok(value.discovery[0].messages > 0); }
  finally { value.archive.close(); }
});

test('an unlimited 250-customer job commits history on its first page and loses no rows between short queue pages', async () => {
  const value = await fixture('date', true, undefined, 3, true, { customers: 250, pageSize: 50 });
  try {
    assert.equal(value.job.status, 'complete', value.job.error);
    assert.equal(value.job.totals.complete, 250);
    assert.equal(value.clicks.length, 250);
    assert.equal(new Set(value.clicks).size, 250);
    assert.equal((value.archive.stats() as any).messages, 500);
    assert.equal(value.discoveredAtFirstCapture, 50);
    assert.ok(value.discovery.every(page => page.messages > 0));
  } finally { value.archive.close(); }
});

test('resuming an old 250-customer queue starts chat capture immediately and skips previously completed customers', async () => {
  const value = await fixture('date', true, undefined, 3, true, { customers: 250, pageSize: 50, queued: 250, complete: 5 });
  try {
    assert.equal(value.job.status, 'complete', value.job.error);
    assert.equal(value.job.totals.complete, 250);
    assert.equal(value.clicks[0], 'customer-5');
    assert.equal(value.clicks.length, 245);
    assert.equal(value.discoveredAtFirstCapture, 50);
    assert.equal((value.archive.stats() as any).messages, 490);
  } finally { value.archive.close(); }
});

test('resume waits for asynchronous pages before locating unfinished customers beyond the refreshed first page', async () => {
  const value = await fixture('date', true, undefined, 3, true, { customers: 250, pageSize: 50, queued: 250, complete: 215, listDelay: 1500 });
  try {
    assert.equal(value.job.status, 'complete', value.job.error);
    assert.equal(value.job.totals.complete, 250);
    assert.equal(value.job.totals.partial, 0);
    assert.equal(value.clicks[0], 'customer-215');
    assert.equal(value.clicks.length, 35);
    assert.equal((value.archive.stats() as any).messages, 70);
  } finally { value.archive.close(); }
});

test('repeated list responses cannot cause endless enumeration after discovered histories are committed', async () => {
  const value = await fixture('date', false, undefined, 3, true, { repeatList: true });
  try { assert.equal(value.job.status, 'partial', value.job.error); assert.equal(value.job.totals.complete, 4); assert.equal((value.archive.stats() as any).messages, 8); }
  finally { value.archive.close(); }
});

test('a missing customer history is recorded as a gap and remaining customers are still captured', async () => {
  const value = await fixture('date', true, undefined, 3, true, { unavailable: 1 });
  try { assert.equal(value.job.status, 'partial', value.job.error); assert.equal(value.job.totals.complete, 3); assert.equal(value.job.totals.partial, 1); assert.equal((value.archive.stats() as any).messages, 6); }
  finally { value.archive.close(); }
});
test('N-message mode counts unique messages across pages; unproven list end keeps the job partial', async () => {
  const value = await fixture('count', false);
  try { assert.equal(value.job.status, 'partial', value.job.error); assert.equal(value.job.totals.complete, 4); assert.equal((value.archive.stats() as any).messages, 16); }
  finally { value.archive.close(); }
});

test('history loading leaves and re-enters the top region on separate frames across four pages', async () => {
  const value = await fixture('count', true, undefined, 7, true);
  try {
    assert.equal(value.job.status, 'complete', value.job.error);
    assert.equal(value.job.totals.complete, 4);
    assert.equal(value.historyLoads.length, 12);
    assert.equal((value.archive.stats() as any).messages, 32);
  } finally { value.archive.close(); }
});
test('matching view labels with different detailed filters pauses before selecting or capturing customers', async () => {
  const value = await fixture('date', true, 'different-filter');
  try { assert.equal(value.job.status, 'paused'); assert.match(value.job.error, /筛选详情/); assert.equal(value.clicks.length, 0); assert.equal((value.archive.stats() as any).messages, 0); }
  finally { value.archive.close(); }
});

test('scope inspection waits for delayed member tags and only cancels read-only popups', async () => {
  let frame = 0, popupOpen = false, pickerOpen = false, cancels = 0;
  const name = { textContent: 'LeoVincent03' };
  const row = { querySelector(selector: string) { return selector === '.member-select-tags__wrap--disabled' || frame >= 3 && selector === '.member-select-tags__wrap__row__item__text' ? {} : null; }, querySelectorAll(selector: string) {
    if (selector === '.arco-select-view[title]') return ['接待成员', '值包含'].map(title => ({ getAttribute: () => title }));
    if (selector === '.member-select-tags__wrap__row__item__text') return frame >= 3 ? [name] : [];
    return [];
  } };
  const picker = {
    getBoundingClientRect: () => ({ width: pickerOpen ? 200 : 0 }),
    querySelector: () => frame >= 2 ? {} : null,
    querySelectorAll: (selector: string) => selector === 'button' ? [{ textContent: '取消', click: () => { pickerOpen = false; cancels++; } }] : [],
  };
  const popup = {
    getBoundingClientRect: () => ({ width: popupOpen ? 200 : 0 }),
    querySelector: () => ({ click: () => { pickerOpen = true; } }),
    querySelectorAll: (selector: string) => selector === '.filter-item__row' ? [row] : selector === 'button' ? [{ textContent: '取消', click: () => { popupOpen = false; cancels++; } }] : [],
  };
  const root = { querySelector: () => null, querySelectorAll: () => [] };
  const list = { closest: () => root, contains: () => false };
  const listeners: any[] = [];
  const document = {
    querySelector(selector: string) {
      if (selector === '#dynamic_scroller_list') return list;
      if (selector.includes(':has(.icon-filter)')) return { click: () => { popupOpen = true; } };
      return null;
    },
    querySelectorAll: (selector: string) => selector === '.filter-popover' ? [popup] : selector === '.select-trigger__content' ? [picker] : [],
    addEventListener() {},
  };
  const chrome = { runtime: { id: 'fixture', onMessage: { addListener: (listener: any) => listeners.push(listener) } } };
  runInNewContext(code, { window: {}, document, chrome, setTimeout(callback: () => void) { frame++; callback(); } });
  const response: any = await new Promise(resolve => listeners[0]({ op: 'driverContext' }, { id: 'fixture' }, resolve));
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(response.result.rules), { rules: [{ fields: ['接待成员', '值包含'], members: ['LeoVincent03'], values: [] }], accounts: 'all' });
  assert.equal(cancels, 2);
  assert.equal(popupOpen || pickerOpen, false);
});
