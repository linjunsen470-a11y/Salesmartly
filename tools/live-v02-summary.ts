import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('.local/archive/archive.sqlite', { readOnly: true });
try {
  const job = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 1').get();
  const options = job ? JSON.parse(String(job.options_json)) : null;
  console.log(JSON.stringify({
    counts: Object.fromEntries(['messages', 'versions', 'conversations', 'assets'].map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n])),
    assets: db.prepare('SELECT status,count(*) AS n FROM assets GROUP BY status').all(),
    job: job && { id: job.id, status: job.status, phase: job.phase, error: job.error, enumerationComplete: job.enumeration_complete, mode: options.mode, count: options.count, customerLimit: options.customerLimit, from: options.from, until: options.until },
    customerTotals: job ? db.prepare('SELECT status,count(*) AS n,sum(observed) AS observed,sum(inserted) AS inserted,sum(updated) AS updated,sum(unchanged) AS unchanged FROM job_customers WHERE job_id=? GROUP BY status').all(job.id) : [],
    customers: job ? db.prepare('SELECT metadata_json,status,reason,observed,inserted,updated,unchanged,oldest FROM job_customers WHERE job_id=? ORDER BY rowid LIMIT 5').all(job.id).map(row => ({ ...row, metadata_json: undefined, customer: JSON.parse(String(row.metadata_json)).name })) : [],
    jobBatches: job ? db.prepare('SELECT count(*) AS batches,coalesce(sum(count),0) AS messages FROM batches WHERE captured_at>=?').get(job.created_at) : null,
    pages: db.prepare('SELECT count,diagnostic_json FROM batches WHERE diagnostic_json IS NOT NULL ORDER BY captured_at DESC LIMIT 8').all().map(row => {
      const value = JSON.parse(String(row.diagnostic_json));
      return { count: row.count, diagnostic: { source: value.source, event: value.event, rootKeys: value.rootKeys, dataKeys: value.dataKeys, pagination: value.pagination, request: value.request } };
    }),
  }, null, 2));
} finally { db.close(); }
