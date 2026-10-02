export type ArchiveEndpoint = 'history' | 'list' | 'pin' | 'session' | 'legacy';

const patterns: [ArchiveEndpoint, RegExp][] = [
  ['history', /\/(?:get-message-list|get-chat-history-message-list)$/],
  ['list', /\/get-chat-list$/],
  ['pin', /\/get-pin-message-list$/],
  ['session', /\/get-session-detail-list$/],
  ['legacy', /\/messages(?:\/|$)/],
];

// History scrolling can use get-chat-history-message-list. A text-search list is
// intentionally absent: it is not a page of the conversation.
export function archiveEndpoint(value: string): ArchiveEndpoint | null {
  try {
    const url = new URL(value, 'https://app.salesmartly.com');
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    if (url.hostname !== 'salesmartly.com' && !url.hostname.endsWith('.salesmartly.com')) return null;
    if (/\/(?:login|oauth|token|auth)(?:\/|$)/i.test(url.pathname)) return null;
    return patterns.find(([, pattern]) => pattern.test(url.pathname))?.[0] ?? null;
  } catch { return null; }
}

export function isObservedEndpoint(value: string): boolean {
  return archiveEndpoint(value) !== null;
}

export function assertMediaDownloadUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('媒体地址无法解析'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('只下载 https 媒体地址');
  const host = url.hostname.toLowerCase();
  const cdn = host === 'assets.salesmartly.com' || host === 'assets-cdn.salesmartly.com';
  const oss = host.endsWith('.aliyuncs.com') && host.includes('.oss');
  if (!cdn && !oss) throw new Error('媒体地址不在已确认的文件域名内，已跳过以免用当前浏览器下载未知链接');
}
