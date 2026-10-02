import type { BatchOptions } from '../shared/model.ts';
export function historyDecision(options: BatchOptions, state: { unique: number; known: number; oldest: string | null; unknownTime: boolean; hasMore: boolean | null; incremental: boolean; target: string; restricted?: boolean }): { done: boolean; complete: boolean; reason: string } {
  if (options.mode === 'count' && state.unique >= options.count) return { done: true, complete: true, reason: `已取得至少 ${options.count} 条消息` };
  if (options.mode === 'date' && state.oldest && !state.unknownTime) {
    if (state.oldest <= options.from) return { done: true, complete: true, reason: '已加载至指定起始日期' };
    if (state.incremental && state.oldest <= state.target && state.known >= 50) return { done: true, complete: true, reason: '已完成增量采集及 7 天 / 50 条回看' };
  }
  if (state.restricted) return { done: true, complete: false, reason: '网页限制了更早的消息，所选历史范围未确认' };
  if (state.hasMore === false) return { done: true, complete: !state.unknownTime || options.mode !== 'date', reason: state.unknownTime && options.mode === 'date' ? '网页已到历史末尾，但部分消息时间未知' : '网页明确返回历史末尾' };
  return { done: false, complete: false, reason: '' };
}
