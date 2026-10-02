import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('.local/archive/archive.sqlite', { readOnly: true });
try {
  const batches = db.prepare("SELECT captured_at,diagnostic_json FROM batches WHERE source LIKE '%get-chat-list' AND diagnostic_json IS NOT NULL ORDER BY captured_at DESC LIMIT 2").all();
  console.log(JSON.stringify(batches.map(row => {
    const data = JSON.parse(String(row.diagnostic_json)), list = data?.data?.list || [];
    return { at: row.captured_at, rootKeys: Object.keys(data), dataKeys: Object.keys(data?.data || {}), count: list.length,
      channels: [...new Set(list.map((customer: any) => customer.channel))],
      laterThanLastReply: list.filter((customer: any) => Number(customer.snippet_time) > Number(customer.last_reply_time)).length,
      laterThanVisitorReply: list.filter((customer: any) => Number(customer.snippet_time) > Number(customer.user_last_reply_time)).length,
      relationShapes: list.slice(0, 3).map((customer: any) => ({ type: typeof customer.social_relation, value: customer.social_relation && typeof customer.social_relation === 'object' ? Object.keys(customer.social_relation) : typeof customer.social_relation === 'string' ? {length:customer.social_relation.length} : null })),
      rows: list.slice(0, 3).map((customer: any) => ({
      keys: Object.keys(customer),
      metadata: Object.fromEntries(Object.entries(customer).filter(([key]) => /time|date|sort|pin|top|phone|channel|platform|name|mobile|last|updated/i.test(key)).map(([key,value]) => [key, typeof value === 'object' && value ? { keys: Object.keys(value), time: (value as any).send_time } : /time|date|sort|pin|top|updated/i.test(key) ? value : typeof value === 'string' ? { length: value.length, present: !!value } : value])),
    })) };
  }), null, 2));
} finally { db.close(); }
