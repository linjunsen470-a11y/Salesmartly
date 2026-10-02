import type { Attachment, CaptureBatch, MediaKind, Message, RequestHints, Scope } from '../shared/model.ts';

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const asText = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
const first = (value: Obj, keys: string[]): string => keys.map(key => asText(value[key])).find(Boolean) ?? '';
const projectKeys = ['project_id', 'projectId', 'team_id', 'teamId'];
const channelKeys = ['channel_account_id', 'channelAccountId', 'platform_account_id', 'channel_id', 'app_id', 'page_id'];
const customerKeys = ['chat_user_id', 'chatUserId', 'customer_id', 'contact_id', 'contactId'];
const conversationKeys = ['chat_session_id', 'chatSessionId', 'conversation_id', 'conversationId', 'session_id'];
const idKeys = ['mid', 'message_id', 'messageId', 'msg_id', 'msgId'];
const typeKeys = ['msg_type', 'msgType', 'message_type', 'messageType', 'type'];
const timeKeys = ['send_time', 'sendTime', 'sent_at', 'sentAt', 'create_time', 'created_at', 'timestamp'];
const mediaTypes: Record<string, MediaKind> = { '2': 'image', image: 'image', picture: 'image', '4': 'file', file: 'file', document: 'file', '6': 'video', video: 'video', '12': 'audio', audio: 'audio', voice: 'audio', '22': 'sticker', sticker: 'sticker', '34': 'file' };

// Quote only integer tokens outside the safe range, never characters within a JSON string.
export function parseLosslessJson(input: string): unknown {
  let out = '', inString = false, escaped = false;
  for (let i = 0; i < input.length;) {
    const c = input[i];
    if (inString) {
      out += c; i++;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') { inString = true; out += c; i++; }
    else if (c === '-' || /[0-9]/.test(c)) {
      const token = input.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
      if (!token) { out += c; i++; continue; }
      out += /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token;
      i += token.length;
    } else { out += c; i++; }
  }
  return JSON.parse(out);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 24) return '[depth limit]';
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (!isObj(value)) return value;
  const result: Obj = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = /^(authorization|cookie|set-cookie|password|access_token|refresh_token|api_token|api_key|external-sign|secret)$/i.test(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return result;
}

function dateOf(value: string): string | null {
  if (!value) return null;
  const number = Number(value);
  const date = /^\d+(?:\.\d+)?$/.test(value) ? new Date(number < 1e12 ? number * 1000 : number) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function decoded(value: unknown): unknown {
  if (typeof value !== 'string' || !/^[\s]*[\[{]/.test(value)) return value;
  try { return parseLosslessJson(value); } catch { return value; }
}

function attachmentsOf(message: Obj, kind: MediaKind | undefined): Attachment[] {
  if (!kind) return [];
  const found: Attachment[] = [];
  const seen = new Set<string>();
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 8 || found.length >= 32) return;
    value = decoded(value);
    if (typeof value === 'string') {
      if (/^(https?:\/\/|blob:)/.test(value) && !seen.has(value)) {
        seen.add(value); found.push({ slot: String(found.length), kind, url: value });
      }
    } else if (Array.isArray(value)) value.forEach(item => walk(item, depth + 1));
    else if (isObj(value)) {
      const primary = first(value, ['original_url', 'download_url', 'file_url', 'play_url', 'media_url', 'image_url', 'video_url', 'audio_url', 'url', 'src']);
      if (primary && /^(https?:\/\/|blob:)/.test(primary) && !seen.has(primary)) {
        seen.add(primary); found.push({ slot: String(found.length), kind, url: primary, filename: first(value, ['file_name', 'filename', 'name']) || undefined });
      }
      for (const [key, child] of Object.entries(value)) {
        if (/^(attachments?|files?|images?|videos?|audios?|data|content|media|payload|msg)$/i.test(key)) walk(child, depth + 1);
      }
    }
  };
  walk(message);
  return found;
}

export function hintsFromRequest(url: string, postData?: string): RequestHints {
  const fields: Obj = {};
  try { for (const [key, value] of new URL(url).searchParams) fields[key] = value; } catch { /* not an HTTP URL */ }
  if (postData && postData.length < 128_000) {
    try { const body = parseLosslessJson(postData); if (isObj(body)) Object.assign(fields, body); }
    catch { try { for (const [key, value] of new URLSearchParams(postData)) fields[key] = value; } catch { /* ignore */ } }
  }
  return {
    projectId: first(fields, projectKeys) || undefined,
    channelAccountId: first(fields, channelKeys) || undefined,
    customerId: first(fields, customerKeys) || undefined,
    conversationId: first(fields, conversationKeys) || undefined,
    parameters: Object.fromEntries(Object.entries(fields).filter(([key]) => /^(page|page_size|limit|offset|sequence_id|last_sequence_id|start_time|end_time|chat_user_id|chat_session_id|project_id|channel_id|channel|view_id|session_status|status|search|keyword|type|filter|sort)$/i.test(key))),
  };
}

export function normalizeResponse(data: unknown, hints: RequestHints, source: string, batchId: string): CaptureBatch {
  const messages: Message[] = [], warnings = new Set<string>();
  let candidates = 0, visited = 0;
  const walk = (value: unknown, inherited: RequestHints, depth = 0): void => {
    if (depth > 20 || visited++ > 20_000) { warnings.add('响应过大或嵌套过深，部分内容未解析'); return; }
    value = decoded(value);
    if (Array.isArray(value)) { value.forEach(item => walk(item, inherited, depth + 1)); return; }
    if (!isObj(value)) return;
    const current: RequestHints = {
      ...inherited,
      projectId: first(value, projectKeys) || inherited.projectId,
      channelAccountId: first(value, channelKeys) || inherited.channelAccountId,
      customerId: first(value, customerKeys) || inherited.customerId,
      conversationId: first(value, conversationKeys) || inherited.conversationId,
    };
    const strongId = first(value, idKeys);
    const type = first(value, typeKeys);
    const hasContent = ['content', 'text', 'message', 'msg', 'body'].some(key => value[key] !== undefined);
    const time = first(value, timeKeys);
    const id = strongId || (type && time && hasContent ? asText(value.id) : '');
    if (id && (hasContent || type && time)) {
      candidates++;
      const projectId = current.projectId || (hints.namespace ? `local:${hints.namespace}` : '');
      const customerId = current.customerId || (current.conversationId ? `session:${current.conversationId}` : '');
      if (!projectId || !customerId) warnings.add('发现消息但缺少项目或客户标识，已保留诊断数据，请先校准字段');
      else {
        const scope: Scope = { projectId, channelAccountId: current.channelAccountId || 'unknown', customerId, conversationId: current.conversationId || 'customer-history' };
        if (!current.projectId) warnings.add('使用手工项目归档标识，请勿将不同项目填入相同标识');
        if (!current.channelAccountId) warnings.add('响应未提供渠道账号标识');
        const content = decoded(value.content ?? value.body ?? value.message ?? value.msg);
        const text = asText(value.text) || (isObj(content) ? first(content, ['text', 'body', 'caption']) : typeof content === 'string' && !mediaTypes[type.toLowerCase()] ? content : '');
        const directionValue = first(value, ['direction', 'message_direction']).toLowerCase();
        const senderType = asText(value.sender_type);
        const direction = value.is_system === '1' || value.is_system === 1 || value.is_system === true ? 'unknown' : ['outgoing', 'out', 'sent'].includes(directionValue) || value.is_self === true || senderType === '2' ? 'outgoing' : ['incoming', 'in', 'received'].includes(directionValue) || value.is_self === false || senderType === '1' ? 'incoming' : 'unknown';
        messages.push({ scope, sourceId: id, type: type || 'unknown', text, sentAt: dateOf(time), sender: first(value, ['sender_name', 'senderName', 'from_name', 'sender_id', 'from_id']) || '未知发送者', direction, attachments: attachmentsOf(value, mediaTypes[type.toLowerCase()]), raw: redact(value) });
        if (mediaTypes[type.toLowerCase()] && !messages.at(-1)!.attachments.length) warnings.add(`媒体消息 ${id} 未找到可下载的地址`);
        if (messages.at(-1)!.attachments.some(asset => /(?:resize|thumbnail|thumb)/i.test(asset.url))) warnings.add('发现可能经过缩放的媒体地址，请打开原图预览后再次观察；当前文件不保证为原始分辨率');
      }
      return; // Nested quoted/replied messages must not inherit this message's identity.
    }
    for (const child of Object.values(value)) if (typeof child === 'object' && child) walk(child, current, depth + 1);
  };
  walk(data, hints);
  if (!candidates) warnings.add('未识别出具有稳定消息 ID 的记录');
  const unique = new Map(messages.map(message => [JSON.stringify([message.scope, message.sourceId]), message]));
  return { batchId, capturedAt: new Date().toISOString(), source, messages: [...unique.values()], warnings: [...warnings], diagnostic: messages.length ? undefined : redact(data), boundary: 'unknown' };
}
