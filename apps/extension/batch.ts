import { host } from './bridge.ts';
import { customerPagePlan, customersFromList, isSystem, pageBoundary, paginationDetails } from '../../packages/capture-core/history.ts';
import { archiveEndpoint } from '../../packages/capture-core/endpoints.ts';
import { reachedCustomerCap } from './job-text.ts';
import { sameScope } from './scope.ts';
import { isSaleSmartlyUrl, type BatchOptions, type CaptureBatch, type Customer, type RequestHints } from '../../packages/shared/model.ts';

interface BatchState { jobId: string; tabId: number | null; originalTabId: number; active: boolean; projectId: string; currentId: string; error: string; enumerating: boolean; scopeVerified: boolean }
let batch: BatchState | null = null;
const emptyList = () => ({ seq: 0, customers: [] as Customer[], hasMore: null as boolean | null, page: '', dateBoundary: false, scannedUnique: 0 });
let list = emptyList();
const seenListCustomers = new Set<string>();
let history: any = null;
let seq = 0;
let navigationExpected = false;
const pendingCustomers = new Map<string, Customer>();
let initialList: { data: any; hints: RequestHints; source: string } | null = null;
let initialHistory: { data: any; hints: RequestHints; source: string; capture: CaptureBatch } | null = null;
export const batchNavigationExpected = () => navigationExpected;
const save = () => chrome.storage.local.set({ batchState: batch });
const ready = chrome.storage.local.get('batchState').then(async saved => {
  if (saved.batchState) { batch = { ...(saved.batchState as BatchState), active: false, error: '浏览器或扩展已重启，请点击继续；当前客户将重新加载并去重' }; await save(); }
});
export const batchActive = (): boolean => !!batch?.active;
export const batchTab = (): number | null => batch?.tabId ?? null;
export async function batchPause(reason: string): Promise<void> {
  await ready; if (!batch) return; batch.active = false; batch.error = reason; await save();
  await host('updateJob', { jobId: batch.jobId, status: 'paused', phase: '已暂停', error: reason }).catch(() => {});
}
export async function batchStart(originalTabId: number, options: Omit<BatchOptions, 'until' | 'scope'>, startCapture: (tabId: number) => Promise<void>): Promise<unknown> {
  await ready;
  if (batch?.active) throw new Error('已有批量任务运行中，请先暂停');
  const scopeReply = await chrome.tabs.sendMessage(originalTabId, { op: 'driverContext', archiveAll: true, dateMode: options.mode === 'date' });
  if (!scopeReply?.ok) throw new Error(scopeReply?.error || '请刷新 SaleSmartly 页面并打开新版归档面板');
  if (scopeReply.result.view !== '全部' || options.mode === 'date' && scopeReply.result.sort !== 'desc') throw new Error('新任务必须确认左侧“全部”视图及消息时间倒序；请刷新后使用新版面板');
  const source = await chrome.tabs.get(originalTabId);
  const job = await host<any>('createJob', { ...options, until: new Date().toISOString(), scope: scopeReply.result });
  batch = { jobId: job.id, tabId: null, originalTabId, active: true, projectId: '', currentId: '', error: '', enumerating: true, scopeVerified: false };
  list = emptyList(); seenListCustomers.clear(); history = null; await save();
  pendingCustomers.clear(); navigationExpected = true;
  initialList = null; initialHistory = null;
  try {
    const tab = await chrome.tabs.create({ url: source.url!, active: true }); batch.tabId = tab.id!; await save();
    await waitForTab(tab.id!);
    await startCapture(tab.id!);
    await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id!, { op: 'driverRun', options: job.options, resume: false });
    navigationExpected = false;
    return job;
  } catch (error) { navigationExpected = false; await batchPause((error as Error).message); throw error; }
}
async function waitForTab(tabId: number, previousDocument?: string): Promise<void> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId);
    // An unrelated image can keep Chrome "loading" after the chat UI is ready.
    try {
      if (isSaleSmartlyUrl(tab.url)) {
        const results = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!document.querySelector('#dynamic_scroller_list') });
        if (results.some(result => result.result === true && (!previousDocument || result.documentId !== previousDocument))) return;
      }
    } catch { /* The document may still be navigating. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('采集标签页未能加载，请检查网络或登录状态');
}
export async function batchResume(startCapture: (tabId: number) => Promise<void>): Promise<void> {
  await ready; if (!batch?.tabId) throw new Error('没有可继续的任务');
  const job = await host<any>('job', { jobId: batch.jobId });
  if (['complete', 'cancelled'].includes(job.status)) throw new Error('任务已结束，请新建任务');
  if (job.status === 'partial' && !job.enumeration_complete) batch.enumerating = true;
  navigationExpected = true;
  try {
  try { await chrome.tabs.get(batch.tabId); }
  catch { batch.tabId = (await chrome.tabs.create({ url: 'https://app.salesmartly.com/next/chat', active: true })).id!; }
  await chrome.tabs.update(batch.tabId, { active: true });
  batch.active = true; batch.currentId = ''; batch.scopeVerified = false; batch.error = ''; list = emptyList(); seenListCustomers.clear(); history = null; initialList = null; initialHistory = null; await save();
  await host('updateJob', { jobId: batch.jobId, status: 'running', phase: '恢复客户队列', error: '' });
  // Refresh only our dedicated tab. Original work tab and drafts are untouched.
  navigationExpected = true;
  const before = await chrome.scripting.executeScript({ target: { tabId: batch.tabId }, func: () => true }).catch(() => []);
  await chrome.tabs.reload(batch.tabId); await waitForTab(batch.tabId, before[0]?.documentId); await startCapture(batch.tabId);
  await chrome.scripting.executeScript({ target: { tabId: batch.tabId }, files: ['content.js'] });
  await chrome.tabs.sendMessage(batch.tabId, { op: 'driverRun', options: job.options, resume: true });
  } catch (error) { await batchPause((error as Error).message); throw error; }
  finally { navigationExpected = false; }
}
export async function batchReceive(data: any, hints: RequestHints, source: string, capture: CaptureBatch, store: (capture: CaptureBatch) => Promise<void>): Promise<boolean> {
  await ready;
  if (!batch?.active) return false;
  if (archiveEndpoint(source) === 'list') {
    const job = await host<any>('job', { jobId: batch.jobId });
    // Request-time UI scope prevents a late response from a different filter joining this queue.
    if (hints.scopeContext && !sameScope(hints.scopeContext, job.options.scope)) return true;
    if (!hints.scopeContext || !batch.scopeVerified) { initialList = { data, hints, source }; return true; }
    const customers = customersFromList(data, hints), boundary = pageBoundary(data), plan = customerPagePlan(customers, job.options);
    const project = hints.projectId || customers.find(row => row.projectId)?.projectId || batch.projectId;
    if (batch.projectId && project && batch.projectId !== project) throw new Error('采集页项目发生变化，已暂停');
    if (project) batch.projectId = project;
    for (const customer of customers) seenListCustomers.add(customer.customerId);
    // A proven cutoff remains valid when clicking a customer triggers a delayed
    // repeat of an earlier list page. Such a response must not reopen discovery.
    const dateBoundary = list.dateBoundary || plan.dateBoundary;
    list = { seq: ++seq, customers: plan.eligible.map(row => ({ ...row, projectId: project || '' })), ...boundary, hasMore: dateBoundary ? false : boundary.hasMore, dateBoundary, scannedUnique: seenListCustomers.size };
    for (const customer of list.customers) pendingCustomers.set(customer.customerId, customer);
    if (project) await host('saveCustomers', { jobId: batch.jobId, customers: list.customers, frozen: !batch.enumerating });
    await host('capture', { batchId: crypto.randomUUID(), capturedAt: new Date().toISOString(), source: 'customer-list', messages: [], warnings: [], boundary: 'unknown', diagnostic: { event: 'customer-list', customers: list.customers.length, listed: customers.length, skippedBeforeDate: plan.skipped, dateBoundary: plan.dateBoundary, dataKeys: Object.keys(data?.data || {}), pagination: paginationDetails(data), request: hints.parameters } });
    await save(); return true;
  }
  const kind = archiveEndpoint(source);
  if (kind !== 'history' && kind !== 'pin') return true;
  // Pinned messages are archived, but a short pin list must not end the history scroll.
  if (kind === 'pin' && (!batch.scopeVerified || !batch.currentId)) return true;
  if (kind === 'history' && (!batch.scopeVerified || !batch.currentId)) { initialHistory = { data, hints, source, capture }; return true; }
  if (data?.code !== undefined && ![0, '0', 200, '200'].includes(data.code)) { if (kind === 'pin') return true; throw new Error(`聊天加载失败：${String(data.msg || data.code)}`); }
  if (capture.warnings.some(warning => /部分内容未解析|缺少项目或客户/.test(warning))) { if (kind === 'pin') return true; throw new Error(capture.warnings.join('；')); }
  const project = capture.messages[0]?.scope.projectId || hints.projectId;
  if (project?.startsWith('local:')) throw new Error('未识别真实项目 ID，已暂停以防跨账号混合');
  if (project && batch.projectId && project !== batch.projectId) throw new Error('消息来自不同项目，已暂停');
  if (project && !batch.projectId) {
    batch.projectId = project;
    list.customers = list.customers.map(row => ({ ...row, projectId: project }));
    const discovered = [...pendingCustomers.values()].map(row => ({ ...row, projectId: project }));
    for (let offset = 0; offset < discovered.length; offset += 250) await host('saveCustomers', { jobId: batch.jobId, customers: discovered.slice(offset, offset + 250), frozen: !batch.enumerating });
    if (batch.currentId) await host('updateCustomer', { jobId: batch.jobId, customerId: batch.currentId, status: 'running' });
  }
  const customerId = capture.messages[0]?.scope.customerId || hints.customerId;
  if (!batch.currentId || customerId !== batch.currentId) { await save(); return true; }
  if (capture.messages.some(message => message.scope.customerId !== customerId || message.scope.projectId !== batch!.projectId)) throw new Error('历史响应混入其他客户，已暂停');
  const job = await host<any>('job', { jobId: batch.jobId }), records = capture.messages.filter(message => !isSystem(message.raw));
  if (!capture.messages.length) {
    if (kind === 'pin') return true;
    const value = data?.data, rows = Array.isArray(value) ? value : value?.list ?? value?.messages ?? value?.message_list;
    if (!Array.isArray(rows) || rows.length) throw new Error('消息响应未匹配已知列表结构，未把解析失败当成历史末尾');
  }
  const known: string[] = []; let info: any;
  for (let offset = 0; offset < Math.max(1, records.length); offset += 250) {
    info = await host<any>('historyInfo', { projectId: batch.projectId, customerId, from: job.options.from || '1970-01-01T00:00:00.000Z', until: job.options.until, ids: records.slice(offset, offset + 250).map(message => message.sourceId) }); known.push(...info.known);
  }
  const customer = pendingCustomers.get(customerId);
  const messages = capture.messages.filter(message => !message.sentAt || message.sentAt <= job.options.until && (job.options.mode !== 'date' || message.sentAt >= job.options.from)).map(message => ({ ...message, scope: { ...message.scope, channelAccountId: customer?.channelId || message.scope.channelAccountId } }));
  const envelope = data?.data;
  const pagination = paginationDetails(data);
  await store({ ...capture, messages, jobId: batch.jobId, diagnostic: { rootKeys: Object.keys(data || {}), dataKeys: envelope && !Array.isArray(envelope) ? Object.keys(envelope) : [], pagination, request: hints.parameters } });
  // Exposed only after all native ACKs. Driver cannot advance on uncommitted responses.
  if (kind === 'history') history = { seq: ++seq, customerId, projectId: batch.projectId, messages: records.map(message => ({ id: message.sourceId, time: message.sentAt, known: known.includes(message.sourceId) })), ...pageBoundary(data), incremental: info.incremental, target: info.target, warnings: capture.warnings };
  await save(); return true;
}
export async function batchCommand(request: any, senderTabId?: number, store?: (capture: CaptureBatch) => Promise<void>): Promise<unknown> {
  await ready;
  if (request.op === 'batchStatus') {
    const job = await host<any>('job', { jobId: batch?.jobId });
    if (batch && !batch.active && job?.status === 'running') await host('updateJob', { jobId: batch.jobId, status: 'paused', phase: '已暂停', error: batch.error });
    return { ...batch, job: await host('job', { jobId: batch?.jobId }) };
  }
  if (request.op === 'batchCancel' && batch) { batch.active = false; batch.error = ''; await save(); return host('updateJob', { jobId: batch.jobId, status: 'cancelled', phase: '已结束', error: '' }); }
  if (!batch || senderTabId !== batch.tabId) throw new Error('该动作只能由专用采集标签页执行');
  if (request.op === 'batchSnapshot') return { active: batch.active, error: batch.error, projectId: batch.projectId, list, history };
  if (!batch.active) throw new Error(batch.error || '任务已暂停');
  const jobId = batch.jobId;
  switch (request.op) {
    case 'batchScopeConfirmed': {
      const job = await host<any>('job', { jobId });
      if (!sameScope(request.scope, job.options.scope) || request.scope.rules !== job.options.scope.rules || request.scope.sort !== job.options.scope.sort) throw new Error('采集页筛选或排序不匹配');
      batch.scopeVerified = true; await save();
      // Initial requests can precede Vue mounting. Reuse that list only when the
      // newly opened tab required no filter change and its rendered scope matches.
      if (!list.seq && initialList && (request.unchanged === true || initialList.hints.scopeContext && sameScope(initialList.hints.scopeContext, request.scope))) {
        const value = initialList; initialList = null;
        await batchReceive(value.data, { ...value.hints, scopeContext: request.scope }, value.source, {} as CaptureBatch, async () => {});
      }
      return null;
    }
    case 'batchPhase': return host('updateJob', { jobId, phase: String(request.phase) });
    case 'batchEnumerated': batch.enumerating = false; await save(); return host('updateJob', { jobId, enumerationComplete: request.complete === true });
    case 'batchCustomers': return host('jobCustomers', { jobId, offset: request.offset });
    case 'batchSelect': {
      batch.currentId = String(request.customerId); await save();
      if (batch.projectId) await host('updateCustomer', { jobId, customerId: batch.currentId, status: 'running' });
      const firstId = initialHistory?.capture.messages[0]?.scope.customerId || initialHistory?.hints.customerId;
      if (initialHistory && firstId === batch.currentId) {
        if (!store) throw new Error('初始聊天响应缺少本地提交处理器');
        const first = initialHistory; initialHistory = null;
        await batchReceive(first.data, first.hints, first.source, first.capture, store);
      }
      return null;
    }
    case 'batchCustomerDone': return host('updateCustomer', { jobId, customerId: String(request.customerId), status: request.complete ? 'complete' : 'partial', reason: request.reason, oldest: request.oldest });
    case 'batchFinish': {
      const job = await host<any>('job', { jobId });
      batch.active = false; await save();
      const complete = job.enumeration_complete && Number(job.totals.complete || 0) === Number(job.totals.total || 0);
      const capped = complete && reachedCustomerCap(job);
      return host('updateJob', { jobId, status: complete ? 'complete' : 'partial', phase: complete ? capped ? `已达到 ${job.options.customerLimit} 位客户上限` : job.totals.total ? '任务结束' : '所选日期后没有可采集会话' : !job.enumeration_complete ? '已处理发现的客户；客户列表范围未确认' : `${job.totals.partial || 0} 位客户的历史范围未确认`, error: '' });
    }
    default: throw new Error('未知的批量操作');
  }
}
