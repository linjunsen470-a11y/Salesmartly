export const HOST_NAME = 'com.salesmartly.local_archive';
export const PROTOCOL_VERSION = 1;
export type MediaKind = 'image' | 'audio' | 'video' | 'file' | 'sticker';
export interface Scope {
  projectId: string;
  channelAccountId: string;
  customerId: string;
  conversationId: string;
}
export interface Attachment {
  slot: string;
  kind: MediaKind;
  url: string;
  filename?: string;
}
export interface Message {
  scope: Scope;
  sourceId: string;
  type: string;
  text: string;
  sentAt: string | null;
  sender: string;
  direction: 'incoming' | 'outgoing' | 'unknown';
  attachments: Attachment[];
  raw: unknown;
}
export interface CaptureBatch {
  batchId: string;
  capturedAt: string;
  source: string;
  messages: Message[];
  warnings: string[];
  diagnostic?: unknown;
  boundary: 'unknown';
  jobId?: string;
}
export interface RequestHints extends Partial<Scope> { namespace?: string; parameters?: Record<string, unknown>; scopeContext?: BatchOptions['scope'] }
export interface CustomerProfile {
  originalName: string;
  remarkName: string;
  phone: string;
  channelCode: string;
  accountName: string;
}
export interface Customer {
  projectId: string;
  customerId: string;
  conversationId: string;
  name: string;
  channelId: string;
  channelName: string;
  latestAt?: string | null;
  pinned?: boolean;
  profile?: CustomerProfile;
}
export interface BatchOptions {
  mode: 'date' | 'count' | 'all';
  from: string;
  until: string;
  count: number;
  customerLimit: number;
  scope: { view: string; status: string; search: string; filters: string; rules?: string; sort?: 'desc' };
}
export interface CaptureResult { duplicate: boolean; accepted: number; inserted: number; updated: number; unchanged: number; stale: number }
export const RESPONSE_LIMIT = 16 * 1024 * 1024;
export interface HostRequest { id: string; op: string; payload?: unknown }
export interface HostReply { id: string; ok: boolean; result?: unknown; error?: string }
export interface MediaJob {
  id: string;
  messageKey: string;
  kind: MediaKind;
  url: string;
  filename: string;
  status: string;
}
export function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.projectId, scope.channelAccountId, scope.customerId, scope.conversationId]);
}
export function messageKey(message: Pick<Message, 'scope' | 'sourceId'>): string {
  return JSON.stringify([scopeKey(message.scope), message.sourceId]);
}
export function isSaleSmartlyUrl(value: string | undefined): boolean {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && url.hostname === 'app.salesmartly.com'; }
  catch { return false; }
}
