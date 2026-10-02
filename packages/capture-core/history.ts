import type { BatchOptions, Customer, RequestHints } from '../shared/model.ts';

const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
// Only explicit server pagination flags establish the end. An empty viewport does not.
export function pageBoundary(data: any): { hasMore: boolean | null; page: string; restricted: boolean } {
  const value = data?.data ?? data;
  const flag = value?.has_more ?? value?.hasMore ?? value?.next_page;
  let hasMore = [false, 0, '0'].includes(flag) ? false : [true, 1, '1'].includes(flag) ? true : null;
  const restricted = [true, 1, '1'].includes(value?.package_limit);
  // Verified SaleSmartly browser history contract: next_pk supplies a sequence
  // cursor while older messages exist, and {} when the server has no next page.
  // Require the complete envelope; an arbitrary empty list/object is not EOF.
  const cursor = value?.next_pk;
  if (hasMore === null && Array.isArray(value?.list) && Number(value?.page_size) > 0 && [false, 0, '0'].includes(value?.package_limit) && cursor && typeof cursor === 'object' && !Array.isArray(cursor)) {
    if (!Object.keys(cursor).length) hasMore = false;
    else if (text(cursor.chat_user_id) && /^\d+$/.test(text(cursor.sequence_id)) && !/^0+$/.test(text(cursor.sequence_id))) hasMore = true;
  }
  if (restricted) hasMore = null;
  return { hasMore, page: text(value?.page), restricted };
}
// Keep pagination structure for adapting actual site responses, without storing
// customer-list bodies or request credentials in the diagnostic record.
export function paginationDetails(data: any): Record<string, unknown> {
  const value = data?.data ?? data;
  const compact = (entry: unknown, depth = 0): unknown => {
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'number') return entry;
    if (typeof entry === 'string') return entry.slice(0, 120);
    if (typeof entry !== 'object' || depth >= 3) return '[object]';
    return Object.fromEntries(Object.entries(entry).slice(0, 24).filter(([key]) => !/token|auth|cookie|secret|password/i.test(key)).map(([key, child]) => [key, compact(child, depth + 1)]));
  };
  return Object.fromEntries(Object.entries(value && !Array.isArray(value) ? value : {}).filter(([key]) => /page|more|next|total|count|cursor|sequence|is_last|is_end|limit/i.test(key)).map(([key, entry]) => [key, compact(entry)]));
}
export function customersFromList(data: any, hints: RequestHints): Customer[] {
  if (data?.code !== undefined && ![0, '0', 200, '200'].includes(data.code)) throw new Error(`客户列表加载失败：${text(data.msg)}`);
  const list = data?.data?.list;
  if (!Array.isArray(list)) throw new Error('客户列表结构已变化，未把该响应当成空列表');
  return list.map((row: any) => ({
    projectId: text(row.project_id) || hints.projectId || '', customerId: text(row.chat_user_id),
    conversationId: text(row.id), name: text(row.remark_name || row.name || row.nickname) || '未命名客户',
    channelId: text(row.channel_id), channelName: text(row.channel_name || row.channel),
    latestAt: latestMessageTime(row), pinned: Number(row.pin_time) > 0,
    profile: { originalName: text(row.name), remarkName: text(row.remark_name), phone: text(row.phone), channelCode: text(row.channel), accountName: text(row.channel_name) },
  })).filter((row: Customer) => !!row.customerId);
}
function timestamp(value: unknown): string | null {
  const input = text(value); if (!input || /^0+$/.test(input)) return null;
  const numeric = Number(input), date = /^\d+(?:\.\d+)?$/.test(input) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(input);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function latestMessageTime(row: any): string | null {
  // snippet_time is the actual latest message time, independent of its sender.
  // Creation time and the operator's last reply cannot substitute for it.
  return timestamp(row.snippet_time) || [timestamp(row.last_reply_time), timestamp(row.user_last_reply_time)].filter((value): value is string => !!value).sort().at(-1) || null;
}
export function customerPagePlan(customers: Customer[], options: BatchOptions): { eligible: Customer[]; skipped: number; dateBoundary: boolean } {
  if (options.mode !== 'date') return { eligible: customers, skipped: 0, dateBoundary: false };
  const eligible = customers.filter(customer => !customer.latestAt || customer.latestAt >= options.from);
  const ordinary = customers.filter(customer => !customer.pinned);
  // The browser's message-time descending setting is explicitly verified.
  // Pinned rows form their own prefix and never establish the date cutoff.
  const ordered = ordinary.every((customer, index) => !!customer.latestAt && (!index || ordinary[index - 1].latestAt! >= customer.latestAt));
  const dateBoundary = options.scope.sort === 'desc' && !!ordinary.length && ordered && ordinary.at(-1)!.latestAt! < options.from;
  return { eligible, skipped: customers.length - eligible.length, dateBoundary };
}
export function isSystem(raw: any): boolean { return [true, 1, '1'].includes(raw?.is_system); }
export function sourceUpdatedAt(raw: any): string | null {
  const value = raw?.updated_time ?? raw?.updated_at;
  if (value === undefined || value === null || value === '' || value === '0' || value === 0) return null;
  const number = Number(value), date = /^\d+(\.\d+)?$/.test(String(value)) ? new Date(number < 1e12 ? number * 1000 : number) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function mediaIdentity(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (/^(x-amz-|x-goog-)|^(signature|expires|policy|key-pair-id)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort(); return url.href;
  } catch { return value; }
}
