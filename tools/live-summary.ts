import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('.local/archive/archive.sqlite', { readOnly: true });
function shape(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return { type: 'string', chars: value.length, format: /^(https?:|blob:|data:)/.exec(value)?.[1] ?? 'text' };
  if (Array.isArray(value)) return { type: 'array', length: value.length, example: depth < 2 ? shape(value[0], depth + 1) : undefined };
  if (value && typeof value === 'object') return depth < 3 ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item, depth + 1)])) : { type: 'object' };
  return { type: typeof value };
}
try {
  const largest = db.prepare('SELECT source_id,type,length(raw_json) AS chars,raw_json FROM messages ORDER BY length(raw_json) DESC LIMIT 2').all();
  console.log(JSON.stringify({
    messages: db.prepare('SELECT COUNT(*) AS count FROM messages').get(),
    types: db.prepare('SELECT type,COUNT(*) AS count FROM messages GROUP BY type').all(),
    media: db.prepare('SELECT kind,status,COUNT(*) AS count FROM assets GROUP BY kind,status').all(),
    sources: db.prepare('SELECT source,MAX(captured_at) AS latest,SUM(count) AS observations FROM batches GROUP BY source').all(),
    largest: largest.map(row => ({ sourceId: row.source_id, type: row.type, chars: row.chars, content: shape(JSON.parse(String(row.raw_json)).content) })),
  }, null, 2));
} finally { db.close(); }
