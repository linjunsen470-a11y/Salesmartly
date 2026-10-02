import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const observer = await readFile(new URL('../dist/extension/observer.js', import.meta.url), 'utf8');
function environment(fetch: typeof globalThis.fetch) {
  class XHR extends EventTarget {
    responseURL = ''; responseText = ''; responseType = ''; status = 200;
    open(_method: string, url: string): void { this.responseURL = url; }
    send(_body?: unknown): void { this.responseText = '{"mid":"m","chat_user_id":"u","msg_type":1,"text":"测试"}'; this.dispatchEvent(new Event('load')); }
    getResponseHeader(): string { return 'application/json'; }
  }
  const window = Object.assign(new EventTarget(), { fetch }) as any;
  const context = { window, XMLHttpRequest: XHR, location: { href: 'https://app.salesmartly.com/next/chat' }, Request, Response, URL, URLSearchParams, CustomEvent, TextDecoder, WeakMap };
  return { window, XHR, context };
}
test('page observer preserves the original fetch promise and response while reading a clone', async () => {
  const response = new Response('{"mid":"m","chat_user_id":"u","msg_type":1,"text":"客户 🌿"}', { headers: { 'content-type': 'application/json' } });
  const originalPromise = Promise.resolve(response), originalFetch = (() => originalPromise) as typeof fetch;
  const { window, context } = environment(originalFetch);
  const received = new Promise<any>(resolve => window.addEventListener('salesmartly-local-archive-response-v1', (event: CustomEvent) => resolve(event.detail), { once: true }));
  runInNewContext(observer, context); runInNewContext(observer, context);
  const promise = window.fetch('/chat/messages?project_id=p', { body: '{"chat_user_id":"u","password":"secret"}', method: 'POST' });
  assert.equal(promise, originalPromise); assert.equal(await (await promise).text(), '{"mid":"m","chat_user_id":"u","msg_type":1,"text":"客户 🌿"}');
  const event = await received; assert.equal(event.hints.projectId, 'p'); assert.equal(event.hints.customerId, 'u'); assert.equal(event.hints.password, undefined); assert.equal(event.source, 'https://app.salesmartly.com/chat/messages');
  window.__salesmartlyLocalArchiveObserver.stop(); assert.equal(window.fetch, originalFetch);
});
test('page observer preserves XHR behavior and restores its original methods on stop', () => {
  const { window, XHR, context } = environment((() => Promise.reject(new Error('unused'))) as typeof fetch), originalOpen = XHR.prototype.open, originalSend = XHR.prototype.send;
  const received: any[] = []; window.addEventListener('salesmartly-local-archive-response-v1', (event: CustomEvent) => received.push(event.detail));
  runInNewContext(observer, context);
  const xhr = new XHR(); xhr.open('POST', 'https://app.salesmartly.com/chat/messages'); xhr.send('{"chat_user_id":"u","authorization":"secret"}');
  assert.equal(xhr.status, 200); assert.equal(received.length, 1); assert.equal(received[0].hints.customerId, 'u'); assert.equal(received[0].hints.authorization, undefined);
  window.__salesmartlyLocalArchiveObserver.stop(); assert.equal(XHR.prototype.open, originalOpen); assert.equal(XHR.prototype.send, originalSend);
});
test('oversize responses publish a clear capture failure while preserving the original response', async () => {
  const response = new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(17 * 1024 * 1024) } });
  const { window, context } = environment((() => Promise.resolve(response)) as typeof fetch);
  const event = new Promise<any>(resolve => window.addEventListener('salesmartly-local-archive-response-v1', (event: CustomEvent) => resolve(event.detail), { once: true }));
  runInNewContext(observer, context); assert.equal(await window.fetch('/chat/messages'), response);
  const value = await event; assert.match(value.error, /16 MB/); assert.equal(value.body, undefined);
});
