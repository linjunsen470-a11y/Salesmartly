export {};
const proxyWindow = window as unknown as Record<string, any>;
if (!proxyWindow.__salesmartlyLocalArchiveProxy) {
  proxyWindow.__salesmartlyLocalArchiveProxy = true;
  window.addEventListener('salesmartly-local-archive-response-v1', event => {
    const detail = (event as CustomEvent).detail;
    if (!detail || typeof detail.source !== 'string' || !(typeof detail.error === 'string' || typeof detail.body === 'string' && detail.body.length <= RESPONSE_LIMIT)) return;
    // Page events can carry untrusted archive data, never native-host commands or local file paths.
    void chrome.runtime.sendMessage({ op: 'pageResponse', payload: detail }).catch(() => {});
  });
}
import { RESPONSE_LIMIT } from '../../packages/shared/model.ts';
