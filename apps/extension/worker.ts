import { hintsFromRequest, normalizeResponse, parseLosslessJson } from '../../packages/capture-core/normalize.ts';
import { archiveEndpoint, isObservedEndpoint } from '../../packages/capture-core/endpoints.ts';
import { isSaleSmartlyUrl, RESPONSE_LIMIT, type CaptureBatch, type MediaJob, type RequestHints } from '../../packages/shared/model.ts';
import { batchActive, batchTab, batchNavigationExpected, batchStart, batchResume, batchPause, batchReceive, batchCommand } from './batch.ts';
import { acknowledge, enqueue, queued } from './queue.ts';
import { host, setFailureHandler } from './bridge.ts';

interface CaptureState { tabId: number | null; namespace: string; running: boolean; hostConnected: boolean; observations: number; error: string; warnings: string[]; downloads: number; mode: 'page' | 'debugger' }
let state: CaptureState = { tabId: null, namespace: '', running: false, hostConnected: false, observations: 0, error: '', warnings: [], downloads: 0, mode: 'page' };
const observedEndpoints = new Set<string>();
const requests = new Map<string, { source: string; hints: RequestHints; eligible?: boolean; size?: number }>();
let flushing: Promise<void> | undefined;
let responseTurn = Promise.resolve();
const ready = (async () => {
  const saved = await chrome.storage.local.get('captureState');
  if (saved.captureState) {
    state = { ...state, ...saved.captureState, running: false, hostConnected: false };
    if (state.running && state.tabId !== null && state.mode === 'debugger') {
      const targets = await chrome.debugger.getTargets();
      if (!targets.some(target => target.tabId === state.tabId && target.attached)) { state.running = false; state.error = '采集已中断，请重新开始'; }
    }
  }
})();
const save = (): Promise<void> => chrome.storage.local.set({ captureState: state });
const fail = async (error: unknown): Promise<void> => { state.error = error instanceof Error ? error.message : String(error); await save(); };
setFailureHandler(error => { state.hostConnected = false; state.running = false; void batchPause(error); void fail(error); });
async function flush(): Promise<void> {
  if (flushing) return flushing;
  return flushing = (async () => {
    try {
      for (const batch of await queued()) {
        const serialized = JSON.stringify(batch);
        if (new TextEncoder().encode(serialized).length <= 240_000) await host('capture', batch);
        else {
          const count = Math.ceil(serialized.length / 48_000);
          let complete = false;
          for (let index = 0; index < count; index++) { const result = await host<{ complete: boolean }>('captureChunk', { batchId: batch.batchId, index, count, text: serialized.slice(index * 48_000, (index + 1) * 48_000) }); complete = result.complete; }
          if (!complete) throw new Error('大消息尚未提交，批次保留待重试');
        }
        await acknowledge(batch.batchId);
      }
      if (state.hostConnected) await save();
    } catch (error) { state.hostConnected = false; await fail(error); await batchPause((error as Error).message); throw error; }
    finally { flushing = undefined; }
  })();
}
async function storeResponse(data: unknown, hints: RequestHints, source: string): Promise<void> {
  const batch = normalizeResponse(data, hints, source, crypto.randomUUID());
  await storeBatch(batch);
}
async function storeBatch(batch: CaptureBatch): Promise<void> {
  state.warnings = batch.warnings; state.observations += batch.messages.length;
  const max = 240_000, bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
  if (batch.diagnostic !== undefined && bytes(batch) > max) batch.diagnostic = { truncated: true, reason: '未匹配响应超过单批诊断上限', preview: JSON.stringify(batch.diagnostic).slice(0, 40_000) };
  const parts: CaptureBatch[] = [];
  let part: CaptureBatch = { ...batch, messages: [] };
  for (const message of batch.messages) {
    if (bytes({ ...part, messages: [message] }) > max) { if (part.messages.length) { parts.push(part); part = { ...batch, batchId: crypto.randomUUID(), messages: [] }; } parts.push({ ...batch, batchId: crypto.randomUUID(), messages: [message] }); continue; }
    if (part.messages.length >= 100 || bytes({ ...part, messages: [...part.messages, message] }) > max) { parts.push(part); part = { ...batch, batchId: crypto.randomUUID(), messages: [] }; }
    part.messages.push(message);
  }
  if (part.messages.length || !parts.length) parts.push(part);
  // Commit each bounded part before adding the next. Never advance the history driver on a failed ACK.
  try { for (const item of parts) { await enqueue(item); do { await flush(); } while ((await queued()).some(pending => pending.batchId === item.batchId)); } }
  catch (error) { state.running = false; await fail(error); await batchPause((error as Error).message); throw error; }
  await save();
  if (batch.jobId) void pumpMedia().catch(fail);
}
async function start(tabId: number, namespace: string, mode: 'page' | 'debugger' = 'page'): Promise<void> {
  await ready;
  const tab = await chrome.tabs.get(tabId);
  if (!isSaleSmartlyUrl(tab.url || tab.pendingUrl)) throw new Error('请选择当前 Profile 中 app.salesmartly.com 的已登录标签页');
  if (!namespace.trim() || namespace.length > 128) throw new Error('请填写项目归档标识');
  await connectHost(); await flush();
  if (state.running) await stop();
  if (mode === 'debugger') {
    await chrome.debugger.attach({ tabId }, '1.3');
    try { await chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxTotalBufferSize: RESPONSE_LIMIT, maxResourceBufferSize: RESPONSE_LIMIT }); }
    catch (error) { await chrome.debugger.detach({ tabId }); throw error; }
  } else {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['proxy.js'] });
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', files: ['observer.js'] });
  }
  requests.clear(); observedEndpoints.clear(); state = { ...state, tabId, namespace: namespace.trim(), running: true, hostConnected: true, error: '', warnings: [], mode }; await save();
  await enqueue({ batchId: crypto.randomUUID(), capturedAt: new Date().toISOString(), source: 'capture-monitor', messages: [], warnings: [], boundary: 'unknown', diagnostic: { mode, tabId, version: '0.3.0', event: 'started' } }); await flush();
}
async function stop(): Promise<void> {
  const tabId = state.tabId; state.running = false; state.tabId = null; requests.clear();
  if (tabId !== null) {
    if (state.mode === 'debugger') await chrome.debugger.detach({ tabId }).catch(() => {});
    else await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', files: ['observer-stop.js'] }).catch(() => {});
  }
  await save(); await flush();
}
function allowedEndpoint(url: string): boolean {
  try { const host = new URL(url).hostname; return host === 'salesmartly.com' || host.endsWith('.salesmartly.com'); }
  catch { return false; }
}
const keepResponse = (source: string, messages: number): boolean => {
  const kind = archiveEndpoint(source);
  return kind === 'history' || kind === 'list' || kind === 'pin' || kind === 'legacy' || (kind === 'session' && messages > 0);
};
chrome.debugger.onEvent.addListener((target, method, event) => {
  void (async () => {
    await ready;
    if (!state.running || target.tabId !== state.tabId) return;
    const data = event as Record<string, any>;
    if (method === 'Network.requestWillBeSent') {
      const request = data.request;
      if (!allowedEndpoint(request.url) || !['Fetch', 'XHR'].includes(data.type)) return;
      if (requests.size > 1000) requests.delete(requests.keys().next().value!);
      const url = new URL(request.url);
      requests.set(data.requestId, { source: `${url.origin}${url.pathname}`, hints: { ...hintsFromRequest(request.url, request.postData), namespace: state.namespace } });
    } else if (method === 'Network.responseReceived') {
      const request = requests.get(data.requestId); if (!request) return;
      request.eligible = data.response.status >= 200 && data.response.status < 300 && isObservedEndpoint(request.source);
    } else if (method === 'Network.loadingFinished') {
      const request = requests.get(data.requestId); requests.delete(data.requestId);
      if (!request?.eligible) return;
      if (data.encodedDataLength > RESPONSE_LIMIT) { state.warnings = ['响应超过 16 MB，未采集；该页未被当成空历史']; await save(); return; }
      try {
        const response = await chrome.debugger.sendCommand({ tabId: state.tabId! }, 'Network.getResponseBody', { requestId: data.requestId }) as { body: string; base64Encoded: boolean };
        if (response.body.length > RESPONSE_LIMIT) { state.warnings = ['响应超过 16 MB，未采集；该页未被当成空历史']; await save(); return; }
        const body = response.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(response.body), c => c.charCodeAt(0))) : response.body;
        const parsed = parseLosslessJson(body);
        const batch = normalizeResponse(parsed, request.hints, request.source, 'probe');
        if (keepResponse(request.source, batch.messages.length)) await storeResponse(parsed, request.hints, request.source);
      } catch (error) { if (isObservedEndpoint(request.source)) await fail(`响应采集失败：${(error as Error).message}`); }
    } else if (method === 'Network.loadingFailed') requests.delete(data.requestId);
    else if (method === 'Network.webSocketFrameReceived' && data.response.opcode === 1 && data.response.payloadData.length < 240_000) {
      try {
        const parsed = parseLosslessJson(data.response.payloadData), hints = { namespace: state.namespace };
        if (normalizeResponse(parsed, hints, 'websocket', 'probe').messages.length) await storeResponse(parsed, hints, 'websocket');
      } catch { /* binary/unknown frames are not claimed as captured */ }
    }
  })().catch(fail);
});
chrome.debugger.onDetach.addListener(target => { void ready.then(async () => { if (target.tabId === state.tabId) { state.running = false; state.error = '浏览器已结束采集连接，请重新开始'; await save(); } }); });

let recovering: Promise<void> | undefined;
async function recoverDownloads(): Promise<void> {
  if (recovering) return recovering;
  return recovering = recoverDownloadsInner().finally(() => { recovering = undefined; });
}
async function recoverDownloadsInner(): Promise<void> {
  const jobs = await host<{ job_id: string; download_id: number | null; suffix: string; state: string; created_at: string }[]>('downloads');
  for (const job of jobs) {
    if (job.download_id === null) {
      // Reconcile the gap between starting a browser download and persisting its ID.
      if (Date.now() - Date.parse(job.created_at) < 60_000) continue;
      const suffix = job.suffix.split('/').map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[/\\\\]');
      const matches = await chrome.downloads.search({ filenameRegex: suffix + '$', limit: 2 });
      if (matches.length !== 1) { await host('failDownload', { jobId: job.job_id, error: '下载启动被中断，请重试该媒体' }); continue; }
      job.download_id = matches[0].id;
      await host('bindDownload', { jobId: job.job_id, downloadId: job.download_id });
    }
    const [item] = await chrome.downloads.search({ id: job.download_id });
    if (!item) { await host('failDownload', { jobId: job.job_id, error: '浏览器下载记录已不存在' }); continue; }
    if (item.state === 'complete') {
      try { await host('importDownload', { jobId: job.job_id, downloadId: item.id, filename: item.filename }); }
      catch (error) { await host('failDownload', { jobId: job.job_id, error: (error as Error).message }); }
    } else if (item.state === 'interrupted') await host('failDownload', { jobId: job.job_id, error: item.error ?? '浏览器下载中断' });
  }
}
let mediaRunning = false;
let mediaTimer: ReturnType<typeof setTimeout> | undefined;
let automaticMedia = false;
async function connectHost(): Promise<{ textOnly?: boolean }> {
  const hello = await host<{ textOnly?: boolean }>('hello');
  if (hello?.textOnly === true) await chrome.storage.local.set({ textOnly: true });
  return hello;
}
async function textOnly(): Promise<boolean> {
  const stored = await chrome.storage.local.get('textOnly');
  return stored.textOnly === true;
}
async function pumpMedia(): Promise<void> {
  if (await textOnly()) { automaticMedia = false; return; }
  automaticMedia = true;
  if (mediaRunning) return;
  await downloadMedia(false);
  const stats = await host<any>('stats');
  if (stats.media.some((item: any) => ['pending', 'downloading'].includes(item.status) && item.count > 0)) {
    clearTimeout(mediaTimer); mediaTimer = setTimeout(() => { void pumpMedia().catch(fail); }, 1500);
  } else automaticMedia = false;
}
async function downloadMedia(retry: boolean): Promise<{ scheduled: number }> {
  if (await textOnly()) return { scheduled: 0 };
  if (mediaRunning) throw new Error('媒体下载任务正在调度');
  mediaRunning = true; let scheduled = 0;
  try {
    await recoverDownloads();
    if (retry) await host('retryMedia');
    const jobs = await host<MediaJob[]>('media');
    const active = await host<any[]>('downloads');
    // At most two registered browser downloads at a time.
    for (const asset of jobs.slice(0, Math.max(0, 2 - active.length))) {
      const plan = await host<{ jobId: string; suffix: string; url: string }>('planDownload', { assetId: asset.id });
      try {
        const downloadId = await chrome.downloads.download({ url: plan.url, filename: plan.suffix, conflictAction: 'overwrite', saveAs: false });
        await host('bindDownload', { jobId: plan.jobId, downloadId }); scheduled++;
      } catch (error) { await host('failDownload', { jobId: plan.jobId, error: (error as Error).message }); }
    }
    state.downloads += scheduled; await save(); await recoverDownloads();
    return { scheduled };
  } finally { mediaRunning = false; }
}
chrome.downloads.onChanged.addListener(delta => { if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') void recoverDownloads().then(() => { if (automaticMedia) return pumpMedia(); }).catch(fail); });
chrome.alarms.create('archive-retry', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => { void ready.then(flush).catch(fail); void recoverDownloads().then(() => { if (automaticMedia || batchActive()) return pumpMedia(); }).catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => { if (tabId === batchTab() && batchActive()) { state.running = false; void batchPause('专用采集标签页已关闭，任务断点已保留'); } });
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tabId === batchTab() && info.status === 'loading' && batchActive() && !batchNavigationExpected()) { state.running = false; void save(); void batchPause('采集页刷新或导航导致任务中断，请点击继续'); }
  // Keep controls available after an intentional reload of our dedicated tab.
  if (info.status === 'complete' && isSaleSmartlyUrl(tab.url)) void ready.then(async () => {
    if (tabId === batchTab()) await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }).catch(fail);
});
chrome.action.onClicked.addListener(tab => {
  void (async () => {
    const candidates = tab.id && isSaleSmartlyUrl(tab.url) ? [tab] : await chrome.tabs.query({ url: 'https://app.salesmartly.com/*' });
    const chats = candidates.filter(candidate => candidate.id !== undefined && candidate.url && new URL(candidate.url).pathname === '/next/chat');
    if (!chats.length) { await chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') }); return; }
    // Show controls in existing chat tabs, even when the toolbar was clicked from another tab.
    for (const chat of chats) await chrome.scripting.executeScript({ target: { tabId: chat.id! }, files: ['content.js'] });
    await chrome.tabs.update(chats[0].id!, { active: true });
  })().catch(fail);
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.tabs.query({ url: 'https://app.salesmartly.com/next/chat*' }).then(tabs => Promise.all(tabs.map(tab => chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] })))).catch(fail);
});
chrome.runtime.onMessage.addListener((request, sender, reply) => {
  const saleSmartlySender = isSaleSmartlyUrl(sender.tab?.url);
  if (sender.id !== chrome.runtime.id || sender.tab?.url && !sender.tab.url.startsWith(chrome.runtime.getURL('')) && !saleSmartlySender) return false;
  void (async () => {
    await ready;
    let release = () => {};
    if (request.op === 'pageResponse') { const previous = responseTurn; responseTurn = new Promise<void>(resolve => { release = resolve; }); await previous; }
    try {
    switch (request.op) {
      case 'tabs': return (await chrome.tabs.query({ url: 'https://app.salesmartly.com/*' })).map(tab => ({ id: tab.id, title: tab.title, url: tab.url }));
      case 'showPanel': { const tab = await chrome.tabs.get(Number(request.tabId)); if (!isSaleSmartlyUrl(tab.url)) throw new Error('请选择 SaleSmartly 聊天页'); await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] }); await chrome.tabs.update(tab.id!, { active: true }); return null; }
      case 'state': return { ...state, queued: (await queued()).length };
      case 'connect': { const hello = await connectHost(); state.hostConnected = true; state.error = ''; await flush(); await recoverDownloads(); return hello; }
      case 'start': await start(Number(request.tabId), String(request.namespace)); return state;
      case 'startHere': if (!saleSmartlySender || sender.tab?.id === undefined) throw new Error('请在 SaleSmartly 页面开始采集'); await start(sender.tab.id, String(request.namespace)); return state;
      case 'batchStart': {
        if (!saleSmartlySender || sender.tab?.id === undefined) throw new Error('请在 SaleSmartly 聊天页启动批量采集');
        const result = await batchStart(sender.tab.id, request.options, tabId => start(tabId, 'browser-project'));
        void pumpMedia().catch(fail); return result;
      }
      case 'batchResume': await batchResume(tabId => start(tabId, 'browser-project')); void pumpMedia().catch(fail); return null;
      case 'batchPause': await batchPause(String(request.reason || '你已暂停任务')); await stop(); return null;
      case 'batchCancel': await batchCommand(request, sender.tab?.id); await stop(); return null;
      case 'batchStatus': case 'batchSnapshot': case 'batchScopeConfirmed': case 'batchPhase': case 'batchEnumerated': case 'batchCustomers': case 'batchSelect': case 'batchCustomerDone': return batchCommand(request, sender.tab?.id, storeBatch);
      case 'reloadExtension': if (batchActive()) await batchPause('扩展更新已保留断点，请点击继续'); await stop(); setTimeout(() => chrome.runtime.reload(), 250); return null;
      case 'batchFinish': { const result = await batchCommand(request, sender.tab?.id); await stop(); return result; }
      case 'pageResponse': {
        const initializingBatch = batchActive() && sender.tab?.id === batchTab();
        if (!saleSmartlySender || !initializingBatch && (sender.tab?.id !== state.tabId || !state.running || state.mode !== 'page')) return null;
        const payload = request.payload;
        if (!payload || typeof payload.source !== 'string') throw new Error('Invalid page response');
        const url = new URL(payload.source); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid response source');
        const source = url.origin + url.pathname;
        if (!allowedEndpoint(source)) throw new Error('Invalid response host');
        if (typeof payload.error === 'string') { await batchPause(payload.error); await stop(); throw new Error(payload.error); }
        if (typeof payload.body !== 'string' || payload.body.length > RESPONSE_LIMIT) throw new Error('聊天响应超过上限，任务已暂停');
        if (!observedEndpoints.has(source) && observedEndpoints.size < 40) {
          observedEndpoints.add(source);
          await enqueue({ batchId: crypto.randomUUID(), capturedAt: new Date().toISOString(), source: 'page-endpoint', messages: [], warnings: [], boundary: 'unknown', diagnostic: { source, mime: String(payload.mime).slice(0, 100), size: payload.body.length } }); await flush();
        }
        try {
          const parsed = parseLosslessJson(payload.body), hints = { ...payload.hints, namespace: state.namespace };
          const normalized = normalizeResponse(parsed, hints, source, crypto.randomUUID());
          if (!await batchReceive(parsed, hints, source, normalized, storeBatch) && keepResponse(source, normalized.messages.length)) await storeBatch(normalized);
        } catch (error) { if (isObservedEndpoint(source)) { await batchPause((error as Error).message); state.running = false; await fail(`页面响应采集失败：${(error as Error).message}`); throw error; } }
        return null;
      }
      case 'stop': await stop(); return state;
      case 'download': { const result = await downloadMedia(request.retry === true); void pumpMedia().catch(fail); return result; }
      case 'stats': case 'conversations': case 'export': case 'exportCustomers': return host(request.op, request.payload);
      default: throw new Error('未知操作');
    }
    } finally { release(); }
  })().then(result => reply({ ok: true, result }), error => { void fail(error); reply({ ok: false, error: (error as Error).message }); });
  return true;
});
