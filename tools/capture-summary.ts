import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('.local/archive/archive.sqlite', { readOnly: true });
try {
  console.log(JSON.stringify({ types: db.prepare('SELECT type,COUNT(*) AS count FROM messages GROUP BY type').all(), media: db.prepare('SELECT kind,status,COUNT(*) AS count FROM assets GROUP BY kind,status').all() }, null, 2));
  const rows = db.prepare("SELECT type,raw_json FROM messages WHERE type IN ('2','4','6','12','22','34') LIMIT 5").all();
  console.log(JSON.stringify(rows.map(row => {
    const raw = JSON.parse(String(row.raw_json));
    return { type: row.type, keys: Object.keys(raw), content: raw.content, sender_type: raw.sender_type };
  }), null, 2));
} finally { db.close(); }
