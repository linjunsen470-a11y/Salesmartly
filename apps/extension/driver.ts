import type { BatchOptions, Customer } from '../../packages/shared/model.ts';
import { historyDecision } from '../../packages/capture-core/decision.ts';
import { archiveContext, ensureDescending, inspectScope, pageContext, sameScope, tidy, viewName } from './scope.ts';
export { pageContext } from './scope.ts';

const widget = 'salesmartly-local-archive-widget';
async function call<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await chrome.runtime.sendMessage({ op, ...args });
  if (!response?.ok) throw new Error(response?.error || '扩展连接已中断'); return response.result;
}
let running = false;
let lastCheck = 0;
const delay = (ms = 350) => new Promise(resolve => setTimeout(resolve, ms));
async function snapshot(): Promise<any> {
  if (lastCheck && Date.now() - lastCheck > 60_000) throw new Error('采集长时间中断，可能发生了休眠；请点击继续');
  lastCheck = Date.now();
  const state = await call('batchSnapshot'); if (!state.active) throw new Error(state.error || '任务已暂停'); return state;
}
function scroller(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector); if (!node) throw new Error('页面布局已变化，未找到列表容器'); return node;
}
function scroll(node: HTMLElement, top: number): void {
  node.scrollTop = top; node.dispatchEvent(new Event('scroll', { bubbles: true }));
}
function rowFor(customer: Customer): HTMLElement | undefined {
  const list = scroller('#dynamic_scroller_list');
  const viewport = list.getBoundingClientRect?.();
  const rows = [...list.querySelectorAll<HTMLElement>('.vue-recycle-scroller__item-view')].filter(row => {
    if (row.offsetHeight <= 0) return false;
    // Vue's recycled pool keeps a nonzero height even at translateY(-9999px).
    // Only cards intersecting this viewport are valid click targets.
    const bounds = row.getBoundingClientRect?.();
    return !viewport || !bounds || bounds.bottom > viewport.top && bounds.top < viewport.bottom;
  });
  const identified = rows.filter(row => [...row.querySelectorAll('*'), row].some(node => [...node.attributes].some(attribute => /^(data-|id$)/.test(attribute.name) && (attribute.value === customer.customerId || attribute.name === 'data-index' && attribute.value === customer.conversationId))));
  if (identified.length === 1) return identified[0].querySelector<HTMLElement>('.session-item') || (identified[0].firstElementChild as HTMLElement) || identified[0];
  const names = new Set([customer.name, customer.profile?.originalName, customer.profile?.remarkName].filter(Boolean));
  const named = rows.flatMap(row => [...row.querySelectorAll<HTMLElement>('*')].filter(node => !node.children.length && names.has((node.textContent || '').trim())));
  // Names are a DOM locator only; identity comes from the resulting structured response.
  if (named.length === 1) return named[0].closest<HTMLElement>('.session-item') || named[0];
  if (named.length > 1) throw new Error(`客户“${customer.name}”在当前视窗重名，无法安全自动选择`);
  return undefined;
}
async function locateCustomer(customer: Customer): Promise<HTMLElement> {
  const node = scroller('#dynamic_scroller_list');
  // Keep the viewport for sequential customers, avoiding a full scan from the top each time.
  for (let pass = 0; pass < 2; pass++) {
    if (pass) { scroll(node, 0); await delay(150); }
    // Sequential customers are close to the current viewport. If the target
    // moved above it, rewind promptly instead of discovering the entire inbox.
    for (let step = 0; step < (pass ? 1500 : 4); step++) {
      await snapshot(); const row = rowFor(customer); if (row) return row;
      const before = node.scrollTop, height = node.scrollHeight;
      scroll(node, before + node.clientHeight * .8); await delay(150);
      if (node.scrollTop !== before) continue;
      // After a refresh, the persisted queue can be far beyond the first page.
      // Reaching the current bottom does not prove the customer is absent: Vue
      // still has to receive and render the asynchronous next customer page.
      await call('batchPhase', { phase: `定位 ${customer.name} · 等待下一批客户列表` });
      scroll(node, Math.max(0, node.scrollHeight - node.clientHeight * 2)); await delay(150);
      scroll(node, node.scrollHeight);
      const end = Date.now() + 8_000; let changed = false;
      while (Date.now() < end) {
        const state = await snapshot(), target = rowFor(customer); if (target) return target;
        if (node.scrollHeight !== height) { changed = true; break; }
        if (state.list.hasMore === false) {
          // The end flag may precede Vue's last render by a frame.
          await delay(150);
          const last = rowFor(customer); if (last) return last;
          changed = node.scrollHeight !== height; break;
        }
        await delay(250);
      }
      if (!changed) break;
    }
  }
  throw new Error(`未能在已加载的筛选列表中定位客户“${customer.name}”；可重试未完成部分`);
}
async function waitHistory(customerId: string, after: number): Promise<any> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { const state = await snapshot(); if (state.history?.seq > after && state.history.customerId === customerId) return state.history; await delay(); }
  throw new Error('等待聊天历史响应超时；未把超时当成历史末尾');
}
async function pullOlder(customerId: string, after: number): Promise<any> {
  // The history response arrives before Vue paints it. Scrolling then is a no-op,
  // and the virtual list afterwards anchors to the newest messages. Wait until the
  // scroller is actually taller than the viewport, leave the top, then re-enter it.
  // Repeat that gesture until an older page is committed; one early scroll is not enough.
  const end = Date.now() + 15_000;
  let nudgedAt = 0;
  while (Date.now() < end) {
    const state = await snapshot();
    if (state.history?.seq > after && state.history.customerId === customerId) return state.history;
    const node = document.querySelector<HTMLElement>('.message-list__scroller');
    const overflow = node ? Math.max(0, node.scrollHeight - node.clientHeight) : 0;
    if (node && overflow > 40 && Date.now() - nudgedAt >= 750) {
      scroll(node, Math.min(node.clientHeight, overflow));
      await delay(150);
      const current = document.querySelector<HTMLElement>('.message-list__scroller') || node;
      scroll(current, 0);
      nudgedAt = Date.now();
      continue;
    }
    await delay(200);
  }
  throw new Error('等待聊天历史响应超时；未把超时当成历史末尾');
}
async function selectCustomer(customer: Customer): Promise<void> {
  (await locateCustomer(customer)).click();
  const end = Date.now() + 8_000;
  while (Date.now() < end) {
    await snapshot();
    const selected = scroller('#dynamic_scroller_list').querySelector('.session-item--active'), target = rowFor(customer);
    // A name click may prefetch messages without changing the active chat. Do
    // not scroll a previous customer's history just because a response arrived.
    if (selected && target && (selected === target || selected.contains(target))) return;
    await delay(150);
  }
  throw new Error(`客户“${customer.name}”未成为当前会话，未继续滚动其他客户的历史`);
}
async function alignScope(scope: BatchOptions['scope']): Promise<boolean> {
  let changed = false;
  let current: BatchOptions['scope'];
  for (let attempt = 0; attempt < 50; attempt++) { try { current = pageContext(); break; } catch { await delay(); } }
  current = pageContext();
  if (current.view !== scope.view) {
    changed = true;
    const matches = [...document.querySelectorAll<HTMLElement>('.view-list__area__item')].filter(node => viewName(node) === scope.view);
    if (matches.length !== 1) throw new Error('采集页客户视图不同，请在此页选择与原页相同的筛选后继续'); matches[0].click(); await delay();
  }
  if (pageContext().status !== scope.status) {
    changed = true;
    const matches = [...document.querySelectorAll<HTMLElement>('.session-list__filter__tabs__item')].filter(node => tidy(node.textContent || '') === scope.status);
    if (matches.length !== 1) throw new Error('无法同步会话状态筛选，请在此页设置后继续'); matches[0].click(); await delay();
  }
  current = pageContext();
  if (!sameScope(current, scope)) throw new Error('采集页的渠道、搜索或其他筛选与原页不同，请使用已保存的相同视图后重试');
  const end = Date.now() + 8_000;
  for (;;) {
    const detailed = await inspectScope();
    if (detailed.rules === scope.rules) break;
    if (Date.now() >= end) throw new Error('采集页筛选详情与原页不同；临时筛选刷新后会恢复，请使用已保存的自定义视图后重试');
    await delay(350);
  }
  return changed;
}
async function prepareCustomers(): Promise<void> {
  await call('batchPhase', { phase: '确认首批客户，随后立即采集聊天' });
  let state: any;
  const end = Date.now() + 20_000;
  while (Date.now() < end) { state = await snapshot(); if (state.list.seq) break; await delay(); }
  if (!state?.list.seq) throw new Error('尚未观察到客户列表响应，请在采集页切换一次视图后继续');
  if (!state.projectId && state.list.customers.length) {
    const first = state.list.customers[0]; await call('batchSelect', { customerId: first.customerId });
    await selectCustomer(first);
    await waitHistory(first.customerId, 0);
    state = await snapshot();
  }
  if (!state.projectId) throw new Error('未能确认当前项目身份，请打开一个客户会话后继续');
}
async function collect(customer: Customer, options: BatchOptions): Promise<void> {
  await call('batchPhase', { phase: `打开 ${customer.name}，采集聊天历史` });
  const before = await snapshot(); await call('batchSelect', { customerId: customer.customerId });
  await selectCustomer(customer);
  // An initial project-discovery response is already committed and can be reused.
  let page = before.history?.customerId === customer.customerId ? before.history : await waitHistory(customer.customerId, before.history?.seq || 0);
  const unique = new Set<string>(), known = new Set<string>(); let oldest: string | null = null, unknownTime = false;
  for (let step = 0; step < 20_000; step++) {
    for (const message of page.messages) {
      if (message.time && message.time > options.until) continue;
      unique.add(message.id); if (message.known) known.add(message.id);
      if (!message.time) unknownTime = true; else if (!oldest || message.time < oldest) oldest = message.time;
    }
    await call('batchPhase', { phase: `采集 ${customer.name} · 已检查 ${unique.size} 条${oldest ? ' · 加载到 ' + new Date(Date.parse(oldest) + 8 * 3600_000).toISOString().slice(0, 10) : ''}` });
    const result = historyDecision(options, { unique: unique.size, known: known.size, oldest, unknownTime, hasMore: page.hasMore, incremental: page.incremental, target: page.target, restricted: page.restricted });
    if (result.done) { await call('batchCustomerDone', { customerId: customer.customerId, complete: result.complete, reason: result.reason, oldest }); return; }
    try { page = await pullOlder(customer.customerId, page.seq); }
    catch (error) { await call('batchCustomerDone', { customerId: customer.customerId, complete: false, reason: (error as Error).message, oldest }); return; }
  }
  await call('batchCustomerDone', { customerId: customer.customerId, complete: false, reason: '单客户加载次数达到上限，请缩小日期范围', oldest });
}
async function run(options: BatchOptions): Promise<void> {
  if (running) return; running = true; lastCheck = Date.now();
  try {
    const changed = await alignScope(options.scope);
    if (options.scope.sort === 'desc') await ensureDescending();
    await call('batchScopeConfirmed', { scope: { ...pageContext(), rules: options.scope.rules, ...(options.scope.sort ? { sort: options.scope.sort } : {}) }, unchanged: !changed });
    await prepareCustomers();
    const status = await call('batchStatus');
    let offset = 0, noProgress = 0;
    // Drain the persisted queue before requesting another list page. On resume,
    // this also handles old tasks which discovered hundreds of customers first.
    // Use the actual row count: a 50-row page must not advance a 200-row offset.
    for (;;) {
      const state = await snapshot();
      if (!sameScope(pageContext(), options.scope)) throw new Error('采集页筛选发生变化，已暂停');
      const rows = await call<any[]>('batchCustomers', { offset });
      if (rows.length) {
        for (const row of rows) {
          if (options.customerLimit && offset >= options.customerLimit) break;
          await snapshot(); offset++;
          if (row.status === 'complete') continue;
          try { await collect(row.customer, options); }
          catch (error) { await snapshot(); await call('batchCustomerDone', { customerId: row.customerId || row.customer_id, complete: false, reason: (error as Error).message }); }
        }
        noProgress = 0;
        if (!options.customerLimit || offset < options.customerLimit) continue;
      }
      if (options.customerLimit && offset >= options.customerLimit) { await call('batchEnumerated', { complete: true }); break; }
      if (status.enumerating === false) break;
      if (state.list.hasMore === false) { await call('batchEnumerated', { complete: true }); break; }
      if (noProgress >= 6) {
        await call('batchEnumerated', { complete: false });
        await call('batchPhase', { phase: '已采集发现的客户；网页未确认客户列表末尾' });
        break;
      }
      await call('batchPhase', { phase: `已处理 ${offset} 位客户，加载下一批客户` });
      const node = scroller('#dynamic_scroller_list');
      // Re-enter the bottom loading region on a separate frame, including after
      // a customer click leaves the list parked at its previous bottom.
      scroll(node, Math.max(0, node.scrollHeight - node.clientHeight * 2)); await delay(150);
      scroll(node, node.scrollHeight); await delay(800);
      const next = await snapshot();
      // Only new queue rows count as progress. Polls or repeated list responses
      // must not keep an exhausted/unknown list scrolling forever.
      if (next.list.scannedUnique > (state.list.scannedUnique || 0)) noProgress = 0; else noProgress++;
    }
    await call('batchFinish');
  } catch (error) { await call('batchPause', { reason: (error as Error).message }).catch(() => {}); }
  finally { running = false; }
}
const driverWindow = window as unknown as Record<string, unknown>;
if (driverWindow.__saleArchiveDriverInstalled !== '0.3.0') {
driverWindow.__saleArchiveDriverInstalled = '0.3.0';
chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (request.op === 'driverContext') { void (request.archiveAll ? archiveContext(request.dateMode === true) : inspectScope()).then(result => reply({ ok: true, result }), error => reply({ ok: false, error: (error as Error).message })); return true; }
  if (request.op === 'driverRun') { reply({ ok: true }); void run(request.options); }
  return false;
});
document.addEventListener('visibilitychange', () => {
  if (running && document.hidden) void call('batchPause', { reason: '采集页进入后台，任务已暂停；请保持采集页可见后点击继续，原聊天页可在另一窗口使用' }).catch(() => {});
});
for (const event of ['pointerdown', 'keydown', 'change']) document.addEventListener(event, input => {
  if (!running || !input.isTrusted || input.composedPath().some(node => node instanceof HTMLElement && node.id === widget)) return;
  const target = input.target as HTMLElement;
  if (target.closest('#dynamic_scroller_list,.message-list__scroller,.session-list__filter,.view-list__area') || target.closest('[contenteditable]')) void call('batchPause', { reason: '你在采集页进行了操作，任务已暂停；请使用原来的聊天页工作' }).catch(() => {});
}, true);
}
