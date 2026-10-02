import './driver.ts';
const widgetId = 'salesmartly-local-archive-widget';
document.getElementById(widgetId)?.remove();
const container = document.createElement('div'); container.id = widgetId;
const shadow = container.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = `:host{all:initial;font:13px/1.55 "Segoe UI","Microsoft YaHei",sans-serif;color:#233c32;position:fixed;right:20px;bottom:20px;z-index:2147483640}*{box-sizing:border-box}.panel{width:350px;max-height:85vh;overflow:auto;background:#fff;border:1px solid #cbd8d0;border-radius:16px;box-shadow:0 8px 36px #163c3026;padding:18px}h2{font-size:17px;margin:0}p{margin:10px 0}.muted{color:#6c7d74;font-size:12px}label{display:block;margin:12px 0 4px}input,select{width:100%;padding:8px;border:1px solid #cbd8d0;border-radius:8px;font:inherit;color:inherit}button{padding:8px 12px;border:1px solid #cbd8d0;border-radius:8px;background:white;color:#245c44;font:inherit;cursor:pointer}button.primary{background:#166a50;color:white;border-color:#166a50}button:disabled{opacity:.5;cursor:default}.actions{display:flex;gap:8px;margin:14px 0}.close{float:right;padding:0 8px;font-size:20px;border:0}#progress{white-space:pre-line;background:#eef5f0;border-radius:10px;padding:12px}#error{color:#963d25;white-space:pre-line;overflow-wrap:anywhere}details{border-top:1px solid #e4ebe7;padding-top:10px;margin-top:14px}summary{cursor:pointer;color:#6c7d74}.small{font-size:11px;overflow-wrap:anywhere}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #4b9879;outline-offset:2px}[hidden]{display:none!important}`;
const panel = document.createElement('section'); panel.className = 'panel';
panel.innerHTML = `<button id="minimize" class="close" aria-label="收起归档面板">−</button><h2>本地聊天归档 <span class="muted">0.3.0</span></h2><div id="controls"><p id="scope" class="muted">正在读取客户范围…</p><label for="from">历史起始日期</label><input id="from" type="date"><p class="muted">仅排队最后消息不早于该日期的客户，再向上加载并保存这段期间的聊天。</p><div class="actions"><button id="start" class="primary">开始采集全部会话</button><button id="pause" hidden>暂停</button><button id="resume" hidden>继续</button></div><div id="progress" role="status" aria-live="polite">正在连接本地程序…</div><p id="error" role="alert"></p><p id="location" class="muted small"></p><details id="advanced"><summary>更多选项</summary><label for="mode">历史范围</label><select id="mode"><option value="date">从指定日期开始</option><option value="count">每位客户至少最近 N 条</option><option value="all">全部可访问历史</option></select><label for="count">N 条消息<input id="count" type="number" min="1" max="100000" value="1000"></label><label for="limit">客户数上限（0 = 全部筛选结果）<input id="limit" type="number" min="0" max="100000" value="0"></label><p class="muted">采集页需保持可见；原聊天页可放在另一窗口使用。打开客户可能触发平台已读。</p><div class="actions"><button id="retry">重试缺失媒体</button><button id="manual">手动观察此页</button><button id="stop">停止观察</button><button id="update">应用本地更新</button></div><label for="conversation">已归档客户</label><select id="conversation"><option value="">展开后读取</option></select><button id="export">生成离线 HTML 副本</button><p id="detail" class="small muted"></p></details></div>`;
shadow.append(style, panel); document.body.append(container);
const node = <T extends HTMLElement = HTMLElement>(id: string): T => shadow.getElementById(id) as T;
const endButton = document.createElement('button'); endButton.id = 'end'; endButton.textContent = '结束任务'; endButton.hidden = true; node('resume').after(endButton);
async function request<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await chrome.runtime.sendMessage({ op, ...args }); if (!result?.ok) throw new Error(result?.error ?? '扩展未响应，请刷新此页'); return result.result;
}
let localError = '';
function error(value: string): void { localError = value; node('error').textContent = value; }
function preferences() {
  const mode = node<HTMLSelectElement>('mode').value, date = node<HTMLInputElement>('from').value;
  return { mode, from: date ? new Date(`${date}T00:00:00+08:00`).toISOString() : '', count: Number(node<HTMLInputElement>('count').value), customerLimit: Number(node<HTMLInputElement>('limit').value) };
}
const range = document.createElement('p'); range.className = 'muted'; range.id = 'range'; node('scope').after(range);
const gaps = document.createElement('p'); gaps.className = 'small'; gaps.id = 'gaps'; node('advanced').append(gaps);
const customerExport = document.createElement('button'); customerExport.id = 'exportCustomers'; customerExport.textContent = '导出本次客户清单 CSV'; node('export').after(customerExport);
const contact = document.createElement('p'); contact.className = 'small muted'; contact.id = 'contact'; node('progress').after(contact);
const exportResult = document.createElement('p'); exportResult.className = 'small'; exportResult.id = 'exportResult'; node('detail').after(exportResult);
function showOptions(): void {
  const value = preferences(), date = node<HTMLInputElement>('from');
  date.hidden = value.mode !== 'date'; (date.previousElementSibling as HTMLElement).hidden = date.hidden; (date.nextElementSibling as HTMLElement).hidden = date.hidden;
  node('count').closest('label')!.hidden = value.mode !== 'count';
  range.textContent = `下一次：左侧“全部”视图 · ${value.mode === 'date' ? value.from ? '从 ' + date.value + ' 至任务启动时' : '请选择起始日期' : value.mode === 'count' ? '每位至少 ' + value.count + ' 条' : '全部可访问历史'}${value.customerLimit ? ' · 最多 ' + value.customerLimit + ' 位' : ''}`;
}
for (const id of ['from', 'mode', 'count', 'limit']) node(id).addEventListener('change', () => { error(''); showOptions(); void chrome.storage.local.set({ batchPreferences: preferences() }); });
let refreshing = false;
let currentJobId: string | undefined;
async function refresh(): Promise<void> {
  if (!container.isConnected || refreshing) return; refreshing = true;
  try {
    const [state, stats, status] = await Promise.all([request('state'), request('stats'), request('batchStatus')]);
    const job = status?.job, media = stats.media, downloaded = media.find((entry: any) => entry.status === 'downloaded')?.count || 0;
    currentJobId = job?.id;
    node('scope').textContent = job ? `本次客户范围：左侧“${job.options.scope.view}”视图${job.options.scope.view === '全部' ? ' · 全部接待成员' : '（旧任务）'}` : '客户范围：左侧“全部”视图 · 全部接待成员';
    const missing = media.filter((entry: any) => ['failed', 'unsupported'].includes(entry.status)).reduce((sum: number, entry: any) => sum + entry.count, 0);
    const pending = media.filter((entry: any) => ['pending', 'downloading'].includes(entry.status)).reduce((sum: number, entry: any) => sum + entry.count, 0);
    if (job) {
      const totals = job.totals, labels: Record<string, string> = { running: '采集中', paused: '已暂停', complete: '消息采集完成', partial: '已结束，部分范围未确认', cancelled: '已结束' };
      const processed = (totals.complete || 0) + (totals.partial || 0);
      const waiting = totals.waiting ?? Math.max(0, (totals.total || 0) - processed);
      const from = job.options.mode === 'date' ? new Date(Date.parse(job.options.from) + 8 * 3600_000).toISOString().slice(0, 10) : '';
      node('progress').textContent = `${labels[job.status] || job.status} · ${job.phase}\n${from ? '本次范围：' + from + ' 至任务启动时\n' : ''}${from && job.options.scope.sort === 'desc' ? '日期内候选客户' : '已发现'} ${totals.total || 0} 位 · 已处理 ${processed} 位 · 待处理 ${waiting} 位\n范围已确认 ${totals.complete || 0} 位 · 缺口 ${totals.partial || 0} 位\n本次消息观察 ${totals.observed || 0} 次 · 新增 ${totals.inserted || 0} · 更新 ${totals.changed || 0} · 重复跳过 ${totals.unchanged || 0}\n档案库媒体：已保存 ${downloaded} · 待处理 ${pending} · 缺失 ${missing}`;
      contact.textContent = job.current?.profile ? `客户原名：${job.current.profile.originalName || '未取得'} · 手机：${job.current.profile.phone || '未取得'} · 所属账号：${job.current.channelName}` : '';
      node('pause').hidden = job.status !== 'running'; node('resume').hidden = !['paused', 'partial'].includes(job.status); node('resume').textContent = job.status === 'partial' ? '重试未完成部分' : job.options.scope.view !== '全部' ? '继续旧任务' : '继续'; node('start').hidden = job.status === 'running'; node('start').textContent = job.status === 'paused' ? '新建“全部”采集' : '开始采集全部会话';
      gaps.textContent = (job.gaps || []).map((item: any) => `${item.name}：${item.reason}`).join('\n'); gaps.style.whiteSpace = 'pre-line';
      node('end').hidden = !['running', 'paused'].includes(job.status); node<HTMLButtonElement>('manual').disabled = job.status === 'running';
    } else node('progress').textContent = `本机已有 ${stats.messages} 条消息 · ${downloaded} 个媒体\n选择起始日期，开始采集左侧“全部”中的客户。`;
    node('error').textContent = localError || job?.error || state.error || '';
    node('location').textContent = `保存到：${stats.root}`;
    node('detail').textContent = `待写入 ${state.queued} 批。${(state.warnings || []).join('；')}`;
  } finally { refreshing = false; }
}
function bind(id: string, action: () => Promise<void>): void {
  const button = node<HTMLButtonElement>(id); button.addEventListener('click', () => { button.disabled = true; error(''); void action().then(refresh).catch(reason => error((reason as Error).message)).finally(() => button.disabled = false); });
}
bind('start', async () => {
  const mode = node<HTMLSelectElement>('mode').value, date = node<HTMLInputElement>('from').value;
  if (mode === 'date' && !date) throw new Error('请先选择历史起始日期');
  const options = preferences();
  await chrome.storage.local.set({ batchPreferences: options }); await request('batchStart', { options });
});
bind('pause', async () => { await request('batchPause'); });
bind('end', async () => { await request('batchCancel'); });
bind('resume', async () => { await request('batchResume'); });
bind('retry', async () => { await request('download', { retry: true }); });
bind('manual', async () => { await request('startHere', { namespace: 'browser-project' }); node('progress').textContent = '手动观察中，请打开客户并向上加载历史。'; });
bind('stop', async () => { await request('stop'); });
bind('update', async () => { await request('reloadExtension'); node('progress').textContent = '正在应用本地更新，已保存任务断点；面板恢复后点击继续。'; });
bind('export', async () => { const conversationId = node<HTMLSelectElement>('conversation').value; if (!conversationId) throw new Error('请选择已归档客户'); const output = await request('export', { payload: { conversationId, jobId: currentJobId } }); exportResult.textContent = output.path; });
bind('exportCustomers', async () => { const output = await request('exportCustomers', { payload: { jobId: currentJobId } }); exportResult.textContent = `已导出 ${output.customers} 位客户：${output.path}`; });
node('advanced').addEventListener('toggle', () => {
  if (!(node('advanced') as HTMLDetailsElement).open) return;
  void request<any[]>('conversations', { payload: { jobId: currentJobId } }).then(rows => { const select = node<HTMLSelectElement>('conversation'); select.replaceChildren(); for (const row of rows) select.add(new Option(`${row.name} ${row.channel_name} · ${row.message_count} 条`, row.id)); }).catch(reason => error(reason.message));
});
node('minimize').addEventListener('click', () => { node('controls').hidden = !node('controls').hidden; node('minimize').textContent = node('controls').hidden ? '+' : '−'; });
void chrome.storage.local.get('batchPreferences').then(saved => { if (saved.batchPreferences) { const value = saved.batchPreferences as any; node<HTMLSelectElement>('mode').value = value.mode; node<HTMLInputElement>('from').value = value.from ? new Date(Date.parse(value.from) + 8 * 3600_000).toISOString().slice(0, 10) : ''; node<HTMLInputElement>('count').value = String(value.count); node<HTMLInputElement>('limit').value = String(value.customerLimit); } showOptions(); });
node('scope').textContent = '客户范围：左侧“全部”视图 · 全部接待成员';
void request('connect').then(refresh).catch(reason => error(`无法连接本地程序：${reason.message}`));
const timer = setInterval(() => { if (!container.isConnected) clearInterval(timer); else void refresh().catch(reason => error(reason.message)); }, 2500);
