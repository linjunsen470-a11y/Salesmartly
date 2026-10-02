import { hintsFromRequest } from '../../packages/capture-core/normalize.ts';
import { isObservedEndpoint } from '../../packages/capture-core/endpoints.ts';
import { RESPONSE_LIMIT } from '../../packages/shared/model.ts';
import { pageContext } from './scope.ts';
const marker = '__salesmartlyLocalArchiveObserver';
const eventName = 'salesmartly-local-archive-response-v1';
const page = window as unknown as Record<string, any>;
if (!page[marker]) {
  const requests = new WeakMap<XMLHttpRequest, { url: string; hints: ReturnType<typeof hintsFromRequest> }>();
  const active: Record<string, AnyHook> = {};
  type AnyHook = ((...args: any[]) => any) & { __salesmartlyArchiveHook?: boolean; __salesmartlyArchiveInner?: AnyHook; __salesmartlyArchiveDisabled?: boolean };
  function hints(url: string, body?: string): ReturnType<typeof hintsFromRequest> { const value = hintsFromRequest(url, body); try { value.scopeContext = pageContext(); } catch { /* Initial UI may not have mounted yet. */ } return value; }
  function eligible(url: string): boolean { return isObservedEndpoint(url); }
  function failure(url: string, error: string): void { if (eligible(url)) window.dispatchEvent(new CustomEvent(eventName, { detail: { source: new URL(url, location.href).origin + new URL(url, location.href).pathname, error } })); }
  function publish(url: string, body: string, requestHints: ReturnType<typeof hintsFromRequest>, mime: string): void {
    if (body.length > RESPONSE_LIMIT) { failure(url, '聊天响应超过 16 MB，已暂停；该页未被当成空历史'); return; }
    try {
      const parsed = new URL(url, location.href);
      if (!eligible(url)) return;
      window.dispatchEvent(new CustomEvent(eventName, { detail: { source: parsed.origin + parsed.pathname, body, hints: requestHints, mime } }));
    } catch { /* Not a readable application response. */ }
  }
  function mark(fn: AnyHook, inner: AnyHook): AnyHook {
    Object.defineProperty(fn, '__salesmartlyArchiveHook', { value: true });
    Object.defineProperty(fn, '__salesmartlyArchiveInner', { value: inner });
    return fn;
  }
  function hookFetch(inner: typeof fetch): AnyHook {
    const wrapped: AnyHook = function(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (wrapped.__salesmartlyArchiveDisabled) return Reflect.apply(inner, window, [input, init]);
      const result = inner.call(window, input, init);
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
    return mark(wrapped, inner as AnyHook);
  }
  function hookOpen(inner: typeof XMLHttpRequest.prototype.open): AnyHook {
    const wrapped: AnyHook = function(this: XMLHttpRequest, ...args: unknown[]) {
      if (wrapped.__salesmartlyArchiveDisabled) return Reflect.apply(inner, this, args);
      Reflect.apply(inner, this, args);
      try { const url = new URL(String(args[1]), location.href).href; requests.set(this, { url, hints: hints(url) }); } catch { requests.delete(this); }
    };
    return mark(wrapped, inner as AnyHook);
  }
  function hookSend(inner: typeof XMLHttpRequest.prototype.send): AnyHook {
    const wrapped: AnyHook = function(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      if (wrapped.__salesmartlyArchiveDisabled) return Reflect.apply(inner, this, [body]);
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
      return Reflect.apply(inner, this, [body]);
    };
    return mark(wrapped, inner as AnyHook);
  }
  function install(key: string, owner: Record<string, any>, name: string, factory: (inner: any) => AnyHook): void {
    const current = owner[name] as AnyHook;
    if (current?.__salesmartlyArchiveHook && !current.__salesmartlyArchiveDisabled) return;
    const wrapped = factory(current);
    if (active[key] && active[key] !== wrapped) active[key].__salesmartlyArchiveDisabled = true;
    active[key] = wrapped; owner[name] = wrapped;
  }
  function ensure(): void {
    install('fetch', window, 'fetch', hookFetch);
    install('open', XMLHttpRequest.prototype, 'open', hookOpen);
    install('send', XMLHttpRequest.prototype, 'send', hookSend);
  }
  ensure();
  const timer = setInterval(ensure, 500);
  function restore(owner: Record<string, any>, name: string): void {
    const current = owner[name] as AnyHook;
    if (!current?.__salesmartlyArchiveHook) return;
    current.__salesmartlyArchiveDisabled = true;
    owner[name] = current.__salesmartlyArchiveInner;
  }
  page[marker] = { ensure, stop() {
    clearInterval(timer);
    for (const hook of Object.values(active)) hook.__salesmartlyArchiveDisabled = true;
    restore(window, 'fetch'); restore(XMLHttpRequest.prototype, 'open'); restore(XMLHttpRequest.prototype, 'send');
    delete page[marker];
  } };
}
