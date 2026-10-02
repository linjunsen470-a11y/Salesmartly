const select = document.getElementById('tab') as HTMLSelectElement;
const status = document.getElementById('status')!;
async function request(op: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await chrome.runtime.sendMessage({ op, ...args }); if (!result?.ok) throw new Error(result?.error || '扩展未响应'); return result.result;
}
async function refresh(): Promise<void> {
  const tabs = await request('tabs'); select.replaceChildren();
  for (const tab of tabs.filter((tab: any) => new URL(tab.url).pathname === '/next/chat')) select.add(new Option(tab.title || 'SaleSmartly 聊天页', String(tab.id)));
  if (!select.options.length) select.add(new Option('请先在此 Profile 打开并登录 SaleSmartly 聊天页', ''));
}
document.getElementById('open')!.addEventListener('click', () => { void (async () => { if (!select.value) throw new Error('未找到已登录的聊天页'); await request('showPanel', { tabId: Number(select.value) }); })().catch(error => { status.textContent = error.message; status.style.display = 'block'; }); });
document.getElementById('refresh')!.addEventListener('click', () => { void refresh(); });
void refresh();
export {};
