import { hintsFromRequest } from '../../packages/capture-core/normalize.ts';
import { RESPONSE_LIMIT } from '../../packages/shared/model.ts';
import { pageContext } from './scope.ts';
const marker = '__salesmartlyLocalArchiveObserver';
const eventName = 'salesmartly-local-archive-response-v1';
const page = window as unknown as Record<string, any>;
if (!page[marker]) {
  const originalFetch = window.fetch, originalOpen = XMLHttpRequest.prototype.open, originalSend = XMLHttpRequest.prototype.send;
  const requests = new WeakMap<XMLHttpRequest, { url: string; hints: ReturnType<typeof hintsFromRequest> }>();
  function hints(url: string, body?: string): ReturnType<typeof hintsFromRequest> { const value = hintsFromRequest(url, body); try { value.scopeContext = pageContext(); } catch { /* Initial UI may not have mounted yet. */ } return value; }
  function eligible(url: string): boolean { try { const u = new URL(url, location.href); return (u.hostname === 'salesmartly.com' || u.hostname.endsWith('.salesmartly.com')) && /get-message-list|get-chat-list|get-session-detail-list|\/messages(?:\/|$)/.test(u.pathname); } catch { return false; } }
  function failure(url: string, error: string): void { if (eligible(url)) window.dispatchEvent(new CustomEvent(eventName, { detail: { source: new URL(url, location.href).origin + new URL(url, location.href).pathname, error } })); }
  function publish(url: string, body: string, hints: ReturnType<typeof hintsFromRequest>, mime: string): void {
    if (body.length > RESPONSE_LIMIT) { failure(url, '聊天响应超过 16 MB，已暂停；该页未被当成空历史'); return; }
    try {
      const parsed = new URL(url, location.href);
      if (!eligible(url)) return;
      if (!['http:', 'https:'].includes(parsed.protocol) || /\/(?:login|oauth|token|auth)(?:\/|$)/i.test(parsed.pathname)) return;
      window.dispatchEvent(new CustomEvent(eventName, { detail: { source: parsed.origin + parsed.pathname, body, hints, mime } }));
    } catch { /* Not a readable application response. */ }
  }
  const fetchWrapper: typeof fetch = function(input, init) {
    const result = originalFetch.call(window, input, init);
    let url = '', requestHints = {};
    try { url = input instanceof Request ? input.url : String(input); requestHints = hints(new URL(url, location.href).href, typeof init?.body === 'string' ? init.body : undefined); }
    catch { return result; }
    if (!eligible(url)) return result;
    void result.then(response => {
      const mime = response.headers.get('content-type') ?? '';
      if (!response.ok) { failure(url, `聊天加载失败（HTTP ${response.status}），请检查登录和网络`); return; }
      if (!/json|text/.test(mime)) return;
      if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) { failure(url, '聊天响应超过 16 MB，已暂停'); return; }
      const clone = response.clone();
      void (async () => {
        const reader = clone.body?.getReader(); if (!reader) return;
        const decoder = new TextDecoder(); let text = '', bytes = 0;
        try {
          while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > RESPONSE_LIMIT) { await reader.cancel(); failure(url, '聊天响应超过 16 MB，已暂停'); return; } text += decoder.decode(part.value, { stream: true }); }
          text += decoder.decode(); publish(response.url || url, text, requestHints, mime);
        } finally { reader.releaseLock(); }
      })().catch(() => failure(url, '读取聊天响应失败，请重试'));
    }).catch(() => failure(url, '聊天请求中断，请检查网络'));
    return result;
  };
  const openWrapper = function(this: XMLHttpRequest, ...args: any[]): void {
    Reflect.apply(originalOpen, this, args);
    try { const url = new URL(String(args[1]), location.href).href; requests.set(this, { url, hints: hints(url) }); } catch { requests.delete(this); }
  } as typeof XMLHttpRequest.prototype.open;
  const sendWrapper = function(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    const request = requests.get(this);
    if (request && eligible(request.url)) {
      request.hints = hints(request.url, typeof body === 'string' ? body : undefined);
      this.addEventListener('load', () => {
        try {
          const mime = this.getResponseHeader('content-type') ?? '';
          if (this.status < 200 || this.status >= 300) { failure(request.url, `聊天加载失败（HTTP ${this.status}），请检查登录和网络`); return; }
          if (!/json|text/.test(mime)) return;
          const response = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
          if (response) publish(this.responseURL || request.url, response, request.hints, mime);
        } catch { /* Binary response or request aborted. */ }
      }, { once: true });
    }
    Reflect.apply(originalSend, this, [body]);
  };
  window.fetch = fetchWrapper; XMLHttpRequest.prototype.open = openWrapper; XMLHttpRequest.prototype.send = sendWrapper;
  page[marker] = { stop() {
    if (window.fetch === fetchWrapper) window.fetch = originalFetch;
    if (XMLHttpRequest.prototype.open === openWrapper) XMLHttpRequest.prototype.open = originalOpen;
    if (XMLHttpRequest.prototype.send === sendWrapper) XMLHttpRequest.prototype.send = originalSend;
    delete page[marker];
  } };
}
