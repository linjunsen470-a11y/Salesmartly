import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('.local/archive/archive.sqlite', { readOnly: true });
try {
  const ids = process.argv.slice(2);
  if (ids.length) {
    console.log(JSON.stringify(ids.map(customerId => ({ customerId, history: db.prepare("SELECT b.captured_at,b.count,json_extract(b.diagnostic_json,'$.request') AS request,json_extract(b.diagnostic_json,'$.pagination') AS pagination FROM batches b WHERE b.captured_at>=(SELECT max(created_at) FROM jobs) AND json_extract(b.diagnostic_json,'$.request.chat_user_id')=? ORDER BY b.captured_at DESC LIMIT 5").all(customerId) })), null, 2));
  } else {
  console.log(JSON.stringify({
    recentConversations: db.prepare('SELECT scope_json,last_seen FROM conversations ORDER BY last_seen DESC LIMIT 3').all().map(row => ({ scope: JSON.parse(String(row.scope_json)), lastSeen: row.last_seen })),
    recentRecords: db.prepare("SELECT source_id,sent_at,json_extract(raw_json,'$.project_id') AS projectId,json_extract(raw_json,'$.chat_user_id') AS customerId,json_extract(raw_json,'$.chat_session_id') AS sessionId FROM messages ORDER BY first_seen DESC LIMIT 3").all(),
    gapHistory: db.prepare("SELECT b.captured_at,b.count,json_extract(b.diagnostic_json,'$.request') AS request,json_extract(b.diagnostic_json,'$.pagination') AS pagination FROM batches b WHERE json_extract(b.diagnostic_json,'$.request.chat_user_id') IN (SELECT customer_id FROM job_customers WHERE status='partial') ORDER BY b.captured_at DESC LIMIT 5").all(),
  }, null, 2));
  }
} finally { db.close(); }
