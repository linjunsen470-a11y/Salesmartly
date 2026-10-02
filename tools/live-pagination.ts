import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('.local/archive/archive.sqlite', { readOnly: true });
try {
  const job = db.prepare('SELECT id,created_at FROM jobs ORDER BY created_at DESC LIMIT 1').get()!;
  const pages = db.prepare("SELECT b.captured_at,b.count,b.diagnostic_json,min(m.sent_at) AS oldest,max(m.sent_at) AS newest FROM batches b LEFT JOIN observations o ON o.batch_id=b.id LEFT JOIN messages m ON m.id=o.message_id WHERE b.captured_at>=? AND json_type(b.diagnostic_json,'$.pagination.next_pk') IS NOT NULL GROUP BY b.id ORDER BY b.captured_at LIMIT 8").all(job.created_at);
  console.log(JSON.stringify({ jobId: job.id, pages: pages.map(row => ({ capturedAt: row.captured_at, count: row.count, oldest: row.oldest, newest: row.newest, diagnostic: JSON.parse(String(row.diagnostic_json)) })) }, null, 2));
} finally { db.close(); }
