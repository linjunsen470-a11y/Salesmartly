export function reachedCustomerCap(job: { options?: { customerLimit?: number }; totals?: { total?: number | null } }): boolean {
  const limit = Number(job.options?.customerLimit || 0);
  const total = Number(job.totals?.total || 0);
  return limit > 0 && total >= limit;
}

export function jobHeadline(job: { status?: string; options?: { customerLimit?: number }; totals?: { total?: number | null } }): string {
  const labels: Record<string, string> = { running: '采集中', paused: '已暂停', complete: '消息采集完成', partial: '已结束，部分范围未确认', cancelled: '已结束' };
  if (job.status === 'complete' && reachedCustomerCap(job)) return `已完成设定的 ${job.options?.customerLimit} 位客户`;
  return labels[job.status || ''] || job.status || '';
}
