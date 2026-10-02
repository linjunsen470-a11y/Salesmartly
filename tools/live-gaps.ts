import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('.local/archive/archive.sqlite', { readOnly: true });
try {
  const job = db.prepare('SELECT id FROM jobs ORDER BY created_at DESC LIMIT 1').get()!;
  const gaps = db.prepare("SELECT metadata_json,reason,oldest,observed FROM job_customers WHERE job_id=? AND status='partial' ORDER BY rowid LIMIT 20").all(job.id).map(row => ({ ...row, metadata_json: undefined, customer: JSON.parse(String(row.metadata_json)) }));
  const exports = db.prepare("SELECT m.conversation_id,count(distinct m.id) AS messages,count(a.id) AS media,coalesce(sum(a.size),0) AS bytes,group_concat(distinct a.kind) AS kinds FROM messages m LEFT JOIN assets a ON a.message_id=m.id WHERE a.status='downloaded' GROUP BY m.conversation_id HAVING count(distinct m.id)<=100 AND sum(a.size)<50000000 ORDER BY count(distinct a.kind) DESC LIMIT 3").all();
  console.log(JSON.stringify({ gaps, exportCandidates: exports }, null, 2));
} finally { db.close(); }
