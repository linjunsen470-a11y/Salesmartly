import { HOST_NAME, type HostReply } from '../../packages/shared/model.ts';
let port: chrome.runtime.Port | undefined;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let onFailure: (error: string) => void = () => {};
export function setFailureHandler(handler: typeof onFailure): void { onFailure = handler; }
function connect(): chrome.runtime.Port {
  if (port) return port;
  const current = chrome.runtime.connectNative(HOST_NAME); port = current;
  current.onMessage.addListener((message: HostReply) => {
    const request = pending.get(message.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.ok) request.resolve(message.result); else request.reject(new Error(message.error ?? 'Native host error'));
  });
  current.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? '本地归档程序连接已断开';
    if (port === current) port = undefined;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(reason)); }
    pending.clear(); onFailure(reason);
  });
  return current;
}
export function host<T = unknown>(op: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('本地程序响应超时，未确认的数据会保留待重试')); }, 120_000);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    try { connect().postMessage({ id, op, payload }); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error as Error); }
  });
}
