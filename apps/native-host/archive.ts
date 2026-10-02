import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, realpath, rename, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { BatchOptions, CaptureBatch, CaptureResult, Customer, MediaJob, Message, Scope } from '../../packages/shared/model.ts';
import { assertMediaDownloadUrl } from '../../packages/capture-core/endpoints.ts';
import { isSystem, mediaIdentity, sourceUpdatedAt } from '../../packages/capture-core/history.ts';

// Compare user-visible content, not parser output, delivery/read metadata or signed URL credentials.
function contentOf(message: Pick<Message, 'type' | 'text' | 'attachments'>): string {
  return JSON.stringify([message.type, message.text, message.attachments.map(asset => [asset.slot, asset.kind, mediaIdentity(asset.url)])]);
}
const html = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const portableUrl = (value: string): string => value.split('/').map(encodeURIComponent).join('/');
const csvCell = (value: unknown): string => '"' + String(value ?? '').replaceAll('"', '""').replace(/^([=+@-])/, "'$1") + '"';
type Row = Record<string, string | number | null>;
function assertText(value: unknown, label: string, max = 256): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`Invalid ${label}`);
}
export function validateBatch(value: unknown): asserts value is CaptureBatch {
  const batch = value as CaptureBatch;
  if (!batch || typeof batch !== 'object') throw new Error('Invalid capture batch');
  assertText(batch.batchId, 'batch id'); assertText(batch.source, 'source', 2048);
  if (!Array.isArray(batch.messages) || batch.messages.length > 250 || !Array.isArray(batch.warnings) || batch.warnings.some(item => typeof item !== 'string') || batch.boundary !== 'unknown') throw new Error('Invalid capture batch shape');
  if (!Number.isFinite(Date.parse(batch.capturedAt))) throw new Error('Invalid capture time');
  for (const message of batch.messages) {
    if (!message?.scope) throw new Error('Missing message scope');
    for (const key of ['projectId', 'channelAccountId', 'customerId', 'conversationId'] as const) assertText(message.scope[key], key, 512);
    assertText(message.sourceId, 'message id', 512);
    if (typeof message.text !== 'string' || message.text.length > 180_000 || typeof message.type !== 'string' || typeof message.sender !== 'string' || !['incoming', 'outgoing', 'unknown'].includes(message.direction) || !Array.isArray(message.attachments) || message.attachments.length > 32) throw new Error('Invalid message');
    if (message.sentAt !== null && !Number.isFinite(Date.parse(message.sentAt))) throw new Error('Invalid message time');
    for (const media of message.attachments) {
      assertText(media.slot, 'attachment slot', 128); assertText(media.url, 'attachment URL', 16_384);
      if (!['image', 'sticker', 'audio', 'video', 'file'].includes(media.kind)) throw new Error('Invalid attachment type');
      const url = new URL(media.url);
      if (!['https:', 'http:', 'blob:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported media URL');
    }
  }
}

export function sniffMedia(buffer: Buffer, kind: string): { extension: string; mime: string } {
  const ascii = buffer.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (!buffer.length || /^(?:<!doctype\s+html|<html|<head|<body|<\?xml|\{\s*"(?:error|code|message)")/.test(ascii)) throw new Error('Downloaded response is empty or an error/login page');
  let result: { extension: string; mime: string } | undefined;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) result = { extension: 'png', mime: 'image/png' };
  else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) result = { extension: 'jpg', mime: 'image/jpeg' };
  else if (/^GIF8[79]a/.test(buffer.toString('ascii', 0, 6))) result = { extension: 'gif', mime: 'image/gif' };
  else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') result = { extension: 'webp', mime: 'image/webp' };
  else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') result = { extension: 'wav', mime: 'audio/wav' };
  else if (buffer.toString('ascii', 0, 4) === 'OggS') result = { extension: 'ogg', mime: 'audio/ogg' };
  else if (buffer.toString('ascii', 0, 4) === 'fLaC') result = { extension: 'flac', mime: 'audio/flac' };
  else if (buffer.toString('ascii', 0, 3) === 'ID3' || buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) result = { extension: 'mp3', mime: 'audio/mpeg' };
  else if (buffer.toString('ascii', 0, 6) === '#!AMR\n') result = { extension: 'amr', mime: 'audio/amr' };
  else if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const avif = /avif|avis/.test(buffer.toString('ascii', 8, 32));
    result = avif ? { extension: 'avif', mime: 'image/avif' } : kind === 'audio' ? { extension: 'm4a', mime: 'audio/mp4' } : { extension: 'mp4', mime: 'video/mp4' };
  } else if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) result = { extension: 'webm', mime: kind === 'audio' ? 'audio/webm' : 'video/webm' };
  else if (buffer.toString('ascii', 0, 5) === '%PDF-') result = { extension: 'pdf', mime: 'application/pdf' };
  if (!result && kind !== 'file') throw new Error('Media format could not be validated; retained as missing');
  result ??= { extension: 'bin', mime: 'application/octet-stream' };
  if ((kind === 'image' || kind === 'sticker') && !result.mime.startsWith('image/') || kind === 'audio' && !result.mime.startsWith('audio/') || kind === 'video' && !result.mime.startsWith('video/')) throw new Error('Downloaded format does not match the message type');
  return result;
}

export class Archive {
  readonly db: DatabaseSync;
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
    this.db = new DatabaseSync(path.join(this.root, 'archive.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), source_id TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, sent_at TEXT, sender TEXT NOT NULL, direction TEXT NOT NULL, raw_json TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(message_id TEXT NOT NULL REFERENCES messages(id), digest TEXT NOT NULL, observed_at TEXT NOT NULL, normalized_json TEXT NOT NULL, PRIMARY KEY(message_id,digest));
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, captured_at TEXT NOT NULL, source TEXT NOT NULL, count INTEGER NOT NULL, warnings_json TEXT NOT NULL, diagnostic_json TEXT);
      CREATE TABLE IF NOT EXISTS observations(batch_id TEXT NOT NULL REFERENCES batches(id), message_id TEXT NOT NULL REFERENCES messages(id), PRIMARY KEY(batch_id,message_id));
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id), slot TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL, filename TEXT NOT NULL, status TEXT NOT NULL, sha256 TEXT, size INTEGER, path TEXT, mime TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS downloads(job_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), suffix TEXT NOT NULL, download_id INTEGER, state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,sent_at);
      CREATE INDEX IF NOT EXISTS assets_status ON assets(status);
      CREATE TABLE IF NOT EXISTS customers(project_id TEXT NOT NULL,customer_id TEXT NOT NULL,name TEXT NOT NULL,channel_id TEXT NOT NULL,channel_name TEXT NOT NULL,conversation_id TEXT NOT NULL,PRIMARY KEY(project_id,customer_id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,options_json TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL,error TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,enumeration_complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS job_customers(job_id TEXT NOT NULL REFERENCES jobs(id),customer_id TEXT NOT NULL,project_id TEXT NOT NULL,metadata_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'waiting',reason TEXT NOT NULL DEFAULT '',oldest TEXT,observed INTEGER NOT NULL DEFAULT 0,inserted INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL DEFAULT 0,unchanged INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job_id,customer_id));
      CREATE TABLE IF NOT EXISTS coverage(project_id TEXT NOT NULL,customer_id TEXT NOT NULL,from_time TEXT NOT NULL,until_time TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES jobs(id),PRIMARY KEY(project_id,customer_id,job_id));`);
    if (!this.db.prepare('PRAGMA table_info(downloads)').all().some(column => column.name === 'created_at')) this.db.exec("ALTER TABLE downloads ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
    if (!this.db.prepare('PRAGMA table_info(customers)').all().some(column => column.name === 'profile_json')) this.db.exec("ALTER TABLE customers ADD COLUMN profile_json TEXT NOT NULL DEFAULT '{}'");
    for (const [table, column, definition] of [['downloads', 'asset_url', "TEXT NOT NULL DEFAULT ''"], ['messages', 'source_updated_at', 'TEXT'], ['messages', 'is_system', 'INTEGER NOT NULL DEFAULT 0'], ['messages', 'recalled', 'INTEGER NOT NULL DEFAULT 0']] as const) {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_source ON messages(conversation_id,source_id);
      CREATE INDEX IF NOT EXISTS conversations_customer ON conversations(json_extract(scope_json,'$.projectId'),json_extract(scope_json,'$.customerId'));
      CREATE VIEW IF NOT EXISTS analysis_messages AS SELECT m.id,m.source_id,json_extract(c.scope_json,'$.projectId') AS project_id,json_extract(c.scope_json,'$.customerId') AS customer_id,coalesce(u.name,'') AS customer_name,coalesce(u.channel_name,'') AS channel_name,m.sent_at,m.type,m.text,m.sender,m.direction,m.is_system,m.recalled,m.raw_json FROM messages m JOIN conversations c ON c.id=m.conversation_id LEFT JOIN customers u ON u.project_id=json_extract(c.scope_json,'$.projectId') AND u.customer_id=json_extract(c.scope_json,'$.customerId');
      CREATE VIEW IF NOT EXISTS analysis_attachments AS SELECT message_id,id,kind,path AS local_path,mime,size,status,error FROM assets;
      CREATE VIEW IF NOT EXISTS analysis_customers AS SELECT project_id,customer_id,name AS display_name,channel_name AS account_name,json_extract(profile_json,'$.originalName') AS original_name,json_extract(profile_json,'$.remarkName') AS remark_name,json_extract(profile_json,'$.phone') AS phone,json_extract(profile_json,'$.channelCode') AS channel_code,json_extract(profile_json,'$.latestMessageAt') AS latest_message_at FROM customers;
      UPDATE messages SET is_system=1 WHERE is_system=0 AND json_extract(raw_json,'$.is_system') IN (1,'1');
      PRAGMA user_version=2;`);
  }
  static async create(root: string): Promise<Archive> { await mkdir(root, { recursive: true }); return new Archive(root); }
  close(): void { this.db.close(); }
  capture(batch: CaptureBatch): CaptureResult {
    validateBatch(batch);
    const counts = { accepted: batch.messages.length, inserted: 0, updated: 0, unchanged: 0, stale: 0 };
    if (this.db.prepare('SELECT id FROM batches WHERE id=?').get(batch.batchId)) return { duplicate: true, ...counts };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?,?)').run(batch.batchId, batch.capturedAt, batch.source, batch.messages.length, JSON.stringify(batch.warnings), batch.diagnostic === undefined ? null : JSON.stringify(batch.diagnostic));
      for (const message of batch.messages) {
        const previousConversation = this.db.prepare("SELECT * FROM conversations WHERE json_extract(scope_json,'$.projectId')=? AND json_extract(scope_json,'$.customerId')=? ORDER BY first_seen LIMIT 1").get(message.scope.projectId, message.scope.customerId) as Row | undefined;
        const conversationId = String(previousConversation?.id ?? randomUUID());
        const priorScope = previousConversation ? JSON.parse(String(previousConversation.scope_json)) : {};
        const customer = this.db.prepare('SELECT channel_id FROM customers WHERE project_id=? AND customer_id=?').get(message.scope.projectId, message.scope.customerId);
        const scope = { ...message.scope, channelAccountId: message.scope.channelAccountId === 'unknown' ? customer?.channel_id || priorScope.channelAccountId || 'unknown' : message.scope.channelAccountId };
        this.db.prepare('INSERT INTO conversations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope_json=excluded.scope_json,last_seen=excluded.last_seen').run(conversationId, JSON.stringify(scope), batch.capturedAt, batch.capturedAt);
        const previous = this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND source_id=? LIMIT 1').get(conversationId, message.sourceId) as Row | undefined;
        const id = String(previous?.id ?? randomUUID()), assets = this.db.prepare('SELECT * FROM assets WHERE message_id=?').all(id) as Row[];
        const oldContent = previous ? contentOf({ type: String(previous.type), text: String(previous.text), attachments: assets.filter(row => row.status !== 'removed').map(row => ({ slot: String(row.slot), kind: row.kind as any, url: String(row.url) })) }) : '';
        const changed = !!previous && oldContent !== contentOf(message);
        const updatedAt = sourceUpdatedAt(message.raw), oldUpdatedAt = previous?.source_updated_at ? String(previous.source_updated_at) : previous ? sourceUpdatedAt(JSON.parse(String(previous.raw_json))) : null;
        const stale = !!previous && !!updatedAt && !!oldUpdatedAt && (updatedAt < oldUpdatedAt || changed && updatedAt === oldUpdatedAt);
        if (stale) { counts.stale++; this.db.prepare('UPDATE messages SET last_seen=? WHERE id=?').run(batch.capturedAt, id); }
        else {
          const recalled = [true, 1, '1'].includes((message.raw as any)?.is_recalled ?? (message.raw as any)?.is_revoke ?? (message.raw as any)?.recalled);
          this.db.prepare(`INSERT INTO messages(id,conversation_id,source_id,type,text,sent_at,sender,direction,raw_json,first_seen,last_seen,source_updated_at,is_system,recalled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type,text=excluded.text,sent_at=excluded.sent_at,sender=excluded.sender,direction=excluded.direction,raw_json=excluded.raw_json,last_seen=excluded.last_seen,source_updated_at=coalesce(excluded.source_updated_at,messages.source_updated_at),is_system=excluded.is_system,recalled=max(messages.recalled,excluded.recalled)`).run(id, conversationId, message.sourceId, message.type, message.text, message.sentAt, message.sender, message.direction, JSON.stringify(message.raw) ?? 'null', batch.capturedAt, batch.capturedAt, updatedAt, Number(isSystem(message.raw)), Number(recalled));
          if (!previous || changed) {
            // Legacy digests remain readable. New revision IDs are UUIDs, with no hashing pass.
            this.db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(id, randomUUID(), batch.capturedAt, JSON.stringify({ ...message, raw: undefined }));
            if (previous) counts.updated++; else counts.inserted++;
          } else counts.unchanged++;
        }
        this.db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?)').run(batch.batchId, id);
        if (stale) continue;
        for (const asset of message.attachments) {
          const old = assets.find(row => row.slot === asset.slot), assetId = String(old?.id ?? randomUUID());
          const replaced = !!old && (mediaIdentity(String(old.url)) !== mediaIdentity(asset.url) || old.kind !== asset.kind);
          this.db.prepare(`INSERT INTO assets(id,message_id,slot,kind,url,filename,status) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,url=excluded.url,filename=excluded.filename,status=CASE WHEN ? OR assets.status='removed' OR assets.status='failed' AND assets.url<>excluded.url THEN excluded.status ELSE assets.status END,path=CASE WHEN ? THEN NULL ELSE assets.path END,sha256=CASE WHEN ? THEN NULL ELSE assets.sha256 END,size=CASE WHEN ? THEN NULL ELSE assets.size END,error=CASE WHEN ? THEN NULL ELSE assets.error END`).run(assetId, id, asset.slot, asset.kind, asset.url, asset.filename ?? '', asset.url.startsWith('blob:') ? 'unsupported' : 'pending', Number(replaced), Number(replaced), Number(replaced), Number(replaced), Number(replaced));
        }
        for (const old of assets) if (!message.attachments.some(asset => asset.slot === old.slot)) this.db.prepare("UPDATE assets SET status='removed' WHERE id=?").run(old.id);
        if (batch.jobId) this.db.prepare('UPDATE job_customers SET observed=observed+1,inserted=inserted+?,updated=updated+?,unchanged=unchanged+? WHERE job_id=? AND customer_id=? AND project_id=?').run(Number(!previous), Number(changed), Number(!!previous && !changed), batch.jobId, message.scope.customerId, message.scope.projectId);
      }
      this.db.exec('COMMIT');
      return { duplicate: false, ...counts };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  stats(): unknown {
    const count = (table: string): number => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);
    return { root: this.root, conversations: count('conversations'), messages: count('messages'), batches: count('batches'), versions: count('versions'), media: this.db.prepare('SELECT status,COUNT(*) AS count FROM assets GROUP BY status').all(), boundary: 'unknown', recentWarnings: this.db.prepare('SELECT captured_at,source,warnings_json FROM batches WHERE warnings_json<>? ORDER BY rowid DESC LIMIT 8').all('[]') };
  }
  conversations(offset = 0, jobId?: string): unknown {
    const job = jobId ? this.job(jobId) as any : null;
    if (jobId && !job) throw new Error('任务不存在');
    const from = job?.options.mode === 'date' ? job.options.from : null, until = job?.options.until || null;
    return this.db.prepare("SELECT c.id,c.scope_json,c.last_seen,coalesce(u.name,'未命名客户') AS name,coalesce(u.channel_name,'') AS channel_name,COUNT(m.id) AS message_count FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id AND (? IS NULL OR m.sent_at IS NULL OR julianday(m.sent_at)>=julianday(?)) AND (? IS NULL OR m.sent_at IS NULL OR julianday(m.sent_at)<=julianday(?)) LEFT JOIN customers u ON u.project_id=json_extract(c.scope_json,'$.projectId') AND u.customer_id=json_extract(c.scope_json,'$.customerId') WHERE (? IS NULL OR EXISTS(SELECT 1 FROM job_customers q WHERE q.job_id=? AND q.project_id=u.project_id AND q.customer_id=u.customer_id)) GROUP BY c.id HAVING COUNT(m.id)>0 ORDER BY c.last_seen DESC LIMIT 200 OFFSET ?").all(from,from,until,until,jobId || null,jobId || null,Math.max(0, offset)).map(row => ({ ...row, scope: JSON.parse(row.scope_json as string) }));
  }
  createJob(options: BatchOptions): unknown {
    if (!options || !['date', 'count', 'all'].includes(options.mode) || !Number.isFinite(Date.parse(options.until)) || options.mode === 'date' && !Number.isFinite(Date.parse(options.from)) || !Number.isInteger(options.count) || options.count < 1 || options.count > 100_000 || !Number.isInteger(options.customerLimit) || options.customerLimit < 0 || options.customerLimit > 100_000 || !options.scope) throw new Error('无效的批量采集范围');
    if (options.mode === 'date' && options.from > options.until) throw new Error('起始日期不能晚于任务开始时间');
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO jobs(id,options_json,status,phase,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, JSON.stringify(options), 'running', '准备采集页', '', now, now);
    return this.job(id);
  }
  job(id?: string): unknown {
    const row = (id ? this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 1').get()) as Row | undefined;
    if (!row) return null;
    const totals = this.db.prepare('SELECT COUNT(*) AS total,SUM(status=\'complete\') AS complete,SUM(status=\'partial\') AS partial,SUM(status IN (\'waiting\',\'running\')) AS waiting,SUM(inserted) AS inserted,SUM(updated) AS changed,SUM(unchanged) AS unchanged,SUM(observed) AS observed FROM job_customers WHERE job_id=?').get(row.id);
    const current = this.db.prepare("SELECT metadata_json FROM job_customers WHERE job_id=? AND status='running' LIMIT 1").get(row.id);
    const gaps = this.db.prepare("SELECT metadata_json,reason FROM job_customers WHERE job_id=? AND status='partial' ORDER BY rowid LIMIT 20").all(row.id).map(item => ({ name: JSON.parse(String(item.metadata_json)).name, reason: item.reason }));
    return { ...row, options: JSON.parse(String(row.options_json)), totals, current: current ? JSON.parse(String(current.metadata_json)) : null, gaps };
  }
  updateJob(id: string, value: { status?: string; phase?: string; error?: string; enumerationComplete?: boolean }): unknown {
    if (value.status && !['running', 'paused', 'complete', 'partial', 'cancelled'].includes(value.status)) throw new Error('无效的任务状态');
    this.db.prepare('UPDATE jobs SET status=coalesce(?,status),phase=coalesce(?,phase),error=coalesce(?,error),enumeration_complete=coalesce(?,enumeration_complete),updated_at=? WHERE id=?').run(value.status ?? null, value.phase?.slice(0, 128) ?? null, value.error?.slice(0, 1000) ?? null, value.enumerationComplete === undefined ? null : Number(value.enumerationComplete), new Date().toISOString(), id);
    return this.job(id);
  }
  saveCustomers(jobId: string, customers: Customer[], frozen = false): void {
    if (!Array.isArray(customers) || customers.length > 250 || !this.db.prepare('SELECT id FROM jobs WHERE id=?').get(jobId)) throw new Error('无效的客户队列');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const options = JSON.parse(String(this.db.prepare('SELECT options_json FROM jobs WHERE id=?').get(jobId)!.options_json)) as BatchOptions;
      let count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM job_customers WHERE job_id=?').get(jobId)!.n);
      for (const customer of customers) {
        assertText(customer.customerId, 'customer id', 512); assertText(customer.projectId, 'project id', 512);
        if (options.mode === 'date' && customer.latestAt && customer.latestAt < options.from) continue;
        const exists = this.db.prepare('SELECT customer_id FROM job_customers WHERE job_id=? AND customer_id=?').get(jobId, customer.customerId);
        if (frozen && !exists) continue;
        if (!exists && options.customerLimit && count >= options.customerLimit) continue;
        if (!exists) count++;
        const previous = this.db.prepare('SELECT profile_json FROM customers WHERE project_id=? AND customer_id=?').get(customer.projectId, customer.customerId);
        const profile = JSON.parse(String(previous?.profile_json || '{}')) as Record<string, unknown>;
        for (const [key, value] of Object.entries(customer.profile || {})) if (typeof value === 'string' && value) { if (value.length > 1024) throw new Error('客户资料字段过长'); profile[key] = value; }
        if (customer.latestAt) profile.latestMessageAt = customer.latestAt;
        this.db.prepare('INSERT INTO customers(project_id,customer_id,name,channel_id,channel_name,conversation_id,profile_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,customer_id) DO UPDATE SET name=excluded.name,channel_id=excluded.channel_id,channel_name=excluded.channel_name,conversation_id=excluded.conversation_id,profile_json=excluded.profile_json').run(customer.projectId, customer.customerId, customer.name, customer.channelId, customer.channelName, customer.conversationId, JSON.stringify(profile));
        this.db.prepare('INSERT INTO job_customers(job_id,customer_id,project_id,metadata_json) VALUES(?,?,?,?) ON CONFLICT(job_id,customer_id) DO UPDATE SET metadata_json=excluded.metadata_json').run(jobId, customer.customerId, customer.projectId, JSON.stringify(customer));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  jobCustomers(jobId: string, offset = 0): unknown {
    return this.db.prepare('SELECT * FROM job_customers WHERE job_id=? ORDER BY rowid LIMIT 200 OFFSET ?').all(jobId, Math.max(0, offset)).map(row => ({ ...row, customer: JSON.parse(String(row.metadata_json)) }));
  }
  updateCustomer(jobId: string, customerId: string, value: { status: string; reason?: string; oldest?: string }): void {
    if (!['waiting', 'running', 'complete', 'partial'].includes(value.status)) throw new Error('无效的客户状态');
    if (value.status === 'running') this.db.prepare("UPDATE job_customers SET status='waiting' WHERE job_id=? AND status='running' AND customer_id<>?").run(jobId, customerId);
    this.db.prepare('UPDATE job_customers SET status=?,reason=?,oldest=coalesce(?,oldest) WHERE job_id=? AND customer_id=?').run(value.status, value.reason?.slice(0, 1000) ?? '', value.oldest ?? null, jobId, customerId);
    const job = this.job(jobId) as any, row = this.db.prepare('SELECT project_id FROM job_customers WHERE job_id=? AND customer_id=?').get(jobId, customerId);
    // Only a proven date-range boundary can authorize the next incremental shortcut.
    if (row && value.status === 'complete' && job.options.mode === 'date') this.db.prepare('INSERT OR REPLACE INTO coverage VALUES(?,?,?,?,?)').run(row.project_id, customerId, job.options.from, job.options.until, jobId);
  }
  historyInfo(projectId: string, customerId: string, from: string, until: string, ids: string[] = []): unknown {
    if (ids.length > 250) throw new Error('历史检查分页过大');
    const conversation = this.db.prepare("SELECT id FROM conversations WHERE json_extract(scope_json,'$.projectId')=? AND json_extract(scope_json,'$.customerId')=? ORDER BY first_seen LIMIT 1").get(projectId, customerId);
    const known = conversation ? ids.filter(id => !!this.db.prepare('SELECT id FROM messages WHERE conversation_id=? AND source_id=?').get(conversation.id, id)) : [];
    const coverage = this.db.prepare('SELECT * FROM coverage WHERE project_id=? AND customer_id=? AND from_time<=? AND until_time<=? ORDER BY until_time DESC LIMIT 1').get(projectId, customerId, from, until) as Row | undefined;
    let target = from, incremental = false;
    if (coverage && conversation) {
      const recent = this.db.prepare('SELECT sent_at FROM messages WHERE conversation_id=? AND is_system=0 AND sent_at>=? AND sent_at<=? ORDER BY sent_at DESC LIMIT 50').all(conversation.id, from, coverage.until_time);
      if (recent.length === 50) {
        const sevenDays = new Date(Date.parse(String(coverage.until_time)) - 7 * 86400_000).toISOString();
        target = [sevenDays, String(recent[49].sent_at)].sort()[0]; if (target < from) target = from;
        incremental = true;
      }
    }
    return { known, incremental, target, previousUntil: coverage?.until_time ?? null };
  }
  pendingMedia(retry = false): MediaJob[] {
    return this.db.prepare(`SELECT id,message_id AS messageKey,kind,url,filename,status FROM assets WHERE status IN (${retry ? "'pending','failed'" : "'pending'"}) LIMIT 50`).all() as unknown as MediaJob[];
  }
  retryMedia(): void { this.db.prepare("UPDATE assets SET status='pending',error=NULL WHERE status='failed'").run(); }
  planDownload(assetId: string): { jobId: string; suffix: string; url: string } {
    assertText(assetId, 'asset id', 64);
    const asset = this.db.prepare('SELECT * FROM assets WHERE id=?').get(assetId) as Row | undefined;
    if (!asset || !['pending', 'failed'].includes(String(asset.status))) throw new Error('Media is not ready for download');
    assertMediaDownloadUrl(String(asset.url));
    const jobId = randomUUID();
    const extensions: Record<string, string> = { image: 'jpg', sticker: 'webp', audio: 'ogg', video: 'mp4', file: 'bin' };
    const suffix = `SaleSmartlyArchive/${jobId}/${assetId}.${extensions[String(asset.kind)] || 'bin'}`;
    this.db.prepare('INSERT INTO downloads(job_id,asset_id,suffix,download_id,state,error,created_at,asset_url) VALUES(?,?,?,NULL,?,NULL,?,?)').run(jobId, assetId, suffix, 'planned', new Date().toISOString(), asset.url);
    this.db.prepare("UPDATE assets SET status='downloading',error=NULL WHERE id=?").run(assetId);
    return { jobId, suffix, url: String(asset.url) };
  }
  bindDownload(jobId: string, downloadId: number): void {
    if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new Error('Invalid browser download id');
    const result = this.db.prepare("UPDATE downloads SET download_id=?,state='bound' WHERE job_id=? AND state='planned'").run(downloadId, jobId);
    if (!result.changes) throw new Error('Unknown download job');
  }
  failDownload(jobId: string, error: string): void {
    const job = this.db.prepare('SELECT asset_id FROM downloads WHERE job_id=?').get(jobId) as Row | undefined;
    if (!job) throw new Error('Unknown download job');
    this.db.prepare("UPDATE downloads SET state='failed',error=? WHERE job_id=?").run(error.slice(0, 1000), jobId);
    const asset = this.db.prepare('SELECT url FROM assets WHERE id=?').get(job.asset_id);
    const original = this.db.prepare('SELECT asset_url FROM downloads WHERE job_id=?').get(jobId);
    if (!original?.asset_url || mediaIdentity(String(original.asset_url)) === mediaIdentity(String(asset?.url))) this.db.prepare("UPDATE assets SET status='failed',error=? WHERE id=? AND status<>'downloaded'").run(error.slice(0, 1000), job.asset_id);
  }
  async importDownload(jobId: string, downloadId: number, filename: string): Promise<unknown> {
    const job = this.db.prepare('SELECT d.*,a.kind,a.url AS current_url FROM downloads d JOIN assets a ON a.id=d.asset_id WHERE job_id=?').get(jobId) as Row | undefined;
    if (!job || job.download_id !== downloadId || !['bound', 'imported'].includes(String(job.state))) throw new Error('Download does not match a registered browser job');
    if (job.state === 'imported') return { duplicate: true };
    if (job.asset_url && mediaIdentity(String(job.asset_url)) !== mediaIdentity(String(job.current_url))) throw new Error('媒体已更新，旧下载不会覆盖新附件');
    const source = await realpath(filename);
    const normalized = source.replaceAll('\\', '/').toLowerCase();
    const expected = String(job.suffix).toLowerCase(), expectedDirectory = path.posix.dirname(expected);
    const actualDirectory = path.posix.dirname(normalized), actualName = path.posix.basename(normalized);
    // Chrome may replace the requested extension based on the response MIME type.
    const actualStem = actualName.slice(0, actualName.indexOf('.'));
    if (!actualDirectory.endsWith('/' + expectedDirectory) || actualStem !== job.asset_id || !/^[a-f0-9-]{32,64}\.(?:[a-z0-9]{1,12}\.){0,2}[a-z0-9]{1,12}$/.test(actualName)) throw new Error('Download path does not match the registered staging path');
    const info = await stat(source);
    if (!info.isFile() || !info.size) throw new Error('Downloaded file is empty');
    const handle = await open(source, 'r');
    let format: { extension: string; mime: string };
    try { const buffer = Buffer.alloc(Math.min(info.size, 4096)); await handle.read(buffer, 0, buffer.length, 0); format = sniffMedia(buffer, String(job.kind)); }
    finally { await handle.close(); }
    const dir = path.join(this.root, 'media'); await mkdir(dir, { recursive: true });
    const temporary = path.join(dir, `${jobId}.part`);
    try {
      await copyFile(source, temporary);
      const relative = `media/${job.asset_id}-${jobId}.${format.extension}`, destination = path.join(this.root, relative);
      await rename(temporary, destination);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("UPDATE assets SET status='downloaded',sha256=NULL,size=?,path=?,mime=?,error=NULL WHERE id=?").run(info.size, relative, format.mime, job.asset_id);
        this.db.prepare("UPDATE downloads SET state='imported' WHERE job_id=?").run(jobId);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      // This exact registered staging file is our own copy; no directory-wide cleanup.
      await rm(source).catch(() => {});
      return { size: info.size, path: destination, mime: format.mime };
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  downloads(): unknown { return this.db.prepare("SELECT job_id,download_id,suffix,state,created_at FROM downloads WHERE state IN ('planned','bound') LIMIT 100").all(); }
  async exportCustomers(jobId?: string): Promise<{ path: string; customers: number }> {
    const job = this.job(jobId) as any; if (!job) throw new Error('没有可导出的客户任务');
    const rows = this.db.prepare('SELECT q.customer_id,q.metadata_json,q.status,c.profile_json FROM job_customers q JOIN customers c ON c.project_id=q.project_id AND c.customer_id=q.customer_id WHERE q.job_id=? ORDER BY q.rowid').all(job.id);
    const directory = path.join(this.root, 'exports'); await mkdir(directory, { recursive: true });
    const output = path.join(directory, `customers-${job.id}.csv`);
    const body = rows.map(row => { const customer = JSON.parse(String(row.metadata_json)), profile = JSON.parse(String(row.profile_json)); return [row.customer_id,customer.name,profile.originalName,profile.remarkName,profile.phone,customer.channelName,customer.channelId,profile.latestMessageAt,row.status].map(csvCell).join(','); }).join('\r\n');
    await writeFile(output, '\uFEFF客户ID,显示名,客户原名,备注名,客户手机号,所属社媒账号,社媒账号ID,最后消息时间UTC,采集状态\r\n' + body + '\r\n', 'utf8');
    return { path: output, customers: rows.length };
  }
  async exportConversation(conversationId: string, jobId?: string): Promise<{ path: string; messages: number; missingMedia: number }> {
    assertText(conversationId, 'conversation id', 64);
    const conversation = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId) as Row | undefined;
    if (!conversation) throw new Error('Conversation not found');
    const scope = JSON.parse(String(conversation.scope_json)) as Scope;
    const job = jobId ? this.job(jobId) as any : null;
    if (jobId && !job) throw new Error('任务不存在');
    const taskCustomer = jobId ? this.db.prepare('SELECT status,reason FROM job_customers WHERE job_id=? AND project_id=? AND customer_id=?').get(jobId,scope.projectId,scope.customerId) : null;
    if (jobId && !taskCustomer) throw new Error('该客户不在本次采集任务中');
    const from = job?.options.mode === 'date' ? job.options.from : null, until = job?.options.until || null;
    const range = job ? { jobId: job.id, from, until, customerStatus: taskCustomer!.status, reason: taskCustomer!.reason } : null;
    const customerRow = this.db.prepare('SELECT name,channel_name,profile_json FROM customers WHERE project_id=? AND customer_id=?').get(scope.projectId, scope.customerId);
    const customer = { displayName: customerRow?.name || '', accountName: customerRow?.channel_name || '', ...JSON.parse(String(customerRow?.profile_json || '{}')) };
    const rows = this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND (? IS NULL OR sent_at IS NULL OR julianday(sent_at)>=julianday(?)) AND (? IS NULL OR sent_at IS NULL OR julianday(sent_at)<=julianday(?)) ORDER BY COALESCE(sent_at,first_seen),source_id').all(conversationId,from,from,until,until) as Row[];
    const directory = path.join(this.root, 'exports', `${conversationId.slice(0, 12)}-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await mkdir(path.join(directory, 'media'), { recursive: true });
    const missing: Row[] = [], exported: unknown[] = [], rendered: string[] = [];
    for (const row of rows) {
      const assets = this.db.prepare('SELECT * FROM assets WHERE message_id=? ORDER BY slot').all(row.id) as Row[];
      const blocks: string[] = [];
      for (const asset of assets) {
        let relative = '';
        if (asset.status === 'downloaded' && asset.path) {
          try {
            const source = await realpath(path.join(this.root, String(asset.path)));
            const allowed = await realpath(path.join(this.root, 'media'));
            const rel = path.relative(allowed, source);
            if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Asset path is outside archive');
            relative = `media/${path.basename(source)}`;
            await copyFile(source, path.join(directory, relative));
          } catch (error) { missing.push({ ...asset, status: 'missing-file', error: (error as Error).message }); }
        } else missing.push(asset);
        if (!relative) { blocks.push(`<p class="missing">${html(asset.kind)}：未取得文件（${html(asset.error || asset.status)}）</p>`); continue; }
        const url = html(portableUrl(relative)), label = html(asset.filename || path.basename(relative));
        if (asset.kind === 'image' || asset.kind === 'sticker') blocks.push(`<a href="${url}"><img src="${url}" alt="${label}" loading="lazy"></a>`);
        else if (asset.kind === 'audio') blocks.push(`<audio controls preload="none" src="${url}"></audio>`);
        else if (asset.kind === 'video') blocks.push(`<video controls preload="metadata" src="${url}"></video>`);
        blocks.push(`<p><a href="${url}" download>${label}</a></p>`);
      }
      if (['2', '4', '6', '12', '22', '34', 'image', 'audio', 'video', 'voice', 'file', 'sticker'].includes(String(row.type)) && !assets.length) {
        missing.push({ message_id: row.id, id: '', kind: row.type, status: 'no-url', error: '消息未包含可下载地址' });
        blocks.push('<p class="missing">媒体消息尚未取得可下载地址</p>');
      }
      exported.push({ ...row, scope, raw: JSON.parse(String(row.raw_json)), assets });
      const readableTime = row.sent_at ? new Date(String(row.sent_at)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (UTC+8)' : '时间未知';
      const rawPlaceholder = !row.text && !blocks.length ? `<details><summary>查看未识别消息的原始结构</summary><pre class="text">${html(row.raw_json)}</pre></details>` : '';
      rendered.push(`<article class="${html(row.direction)}"><div class="meta">${html(row.sender)} · ${html(readableTime)} · ID ${html(row.source_id)} · ${html(row.type)}</div><p class="text">${html(row.text)}</p>${blocks.join('')}${rawPlaceholder}</article>`);
    }
    const versions = this.db.prepare('SELECT v.* FROM versions v JOIN messages m ON m.id=v.message_id WHERE m.conversation_id=? AND (? IS NULL OR m.sent_at IS NULL OR julianday(m.sent_at)>=julianday(?)) AND (? IS NULL OR m.sent_at IS NULL OR julianday(m.sent_at)<=julianday(?)) ORDER BY v.observed_at').all(conversationId,from,from,until,until);
    const warningRows = this.db.prepare('SELECT DISTINCT b.id,b.captured_at,b.source,b.warnings_json FROM batches b JOIN observations o ON o.batch_id=b.id JOIN messages m ON m.id=o.message_id WHERE m.conversation_id=?').all(conversationId);
    const confirmed = !!from && taskCustomer?.status === 'complete';
    const notice = range ? `本副本按本次任务时间范围导出：${from ? new Date(from).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '可访问历史'}至任务启动时。${confirmed ? '该客户的所选日期范围已确认。' : '范围尚未完整确认，仅包含已观察到的消息。'}时间未知的消息单独标记。` : '仅包含已观察到的消息。历史边界尚未确认，不能据此认为整段会话已完整导出。';
    const manifest = { version: 3, createdAt: new Date().toISOString(), scope, customer, range, messages: rows.length, unknownTimeMessages: rows.filter(row => !row.sent_at).length, missingMedia: missing.length, historyBoundary: confirmed ? 'date-range-confirmed' : 'unknown', completeness: notice, integrity: '浏览器下载完成、文件存在且非空；不进行整文件哈希或解码校验', warnings: warningRows };
    const csv = (value: unknown): string => '"' + String(value ?? '').replaceAll('"', '""').replace(/^([=+@-])/, "'$1") + '"';
    await Promise.all([
      writeFile(path.join(directory, 'messages.jsonl'), exported.map(value => JSON.stringify(value)).join('\n') + '\n', 'utf8'),
      writeFile(path.join(directory, 'versions.jsonl'), versions.map(value => JSON.stringify(value)).join('\n') + '\n', 'utf8'),
      writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8'),
      writeFile(path.join(directory, 'customer.json'), JSON.stringify({ ...scope, ...customer }, null, 2), 'utf8'),
      writeFile(path.join(directory, 'missing-media.csv'), '\uFEFFmessage_id,asset_id,kind,status,error\r\n' + missing.map(row => [row.message_id, row.id, row.kind, row.status, row.error].map(csv).join(',')).join('\r\n'), 'utf8'),
      writeFile(path.join(directory, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>SaleSmartly 本地聊天档案</title><style>body{font:16px/1.65 system-ui;background:#f1f5f9;color:#172438;margin:0}main{max-width:920px;margin:auto;padding:28px}header{margin-bottom:24px}h1{font-size:24px}.notice{background:#fff4d4;padding:14px;border-radius:10px}article{background:white;border:1px solid #dbe3ed;border-radius:14px;padding:16px;margin:14px 50px 14px 0}.outgoing{margin:14px 0 14px 50px;background:#e8f5ee}.meta{font-size:12px;color:#57677e;overflow-wrap:anywhere}.text{white-space:pre-wrap;overflow-wrap:anywhere}img,video{max-width:100%;max-height:420px;border-radius:8px}audio{max-width:100%}.missing{color:#a44818}a{color:#176f5d}@media(max-width:600px){main{padding:12px}article,.outgoing{margin:12px 0}}</style><main><header><h1>${html(customer.displayName || customer.originalName || 'SaleSmartly 本地聊天档案')}</h1><div>客户原名：${html(customer.originalName || '未取得')} · 备注名：${html(customer.remarkName || '无')}</div><div>客户手机号：${html(customer.phone || '未取得')} · 所属社媒账号：${html(customer.accountName || scope.channelAccountId)}</div><div class="meta">客户 ${html(scope.customerId)} · 项目 ${html(scope.projectId)}</div><p>${rows.length} 条消息 · ${missing.length} 项媒体缺失</p><div class="notice">${html(notice)}消息正文按最近一次观察保存，历次记录见 versions.jsonl。</div></header>${rendered.join('')}</main></html>`, 'utf8'),
    ]);
    return { path: path.join(directory, 'index.html'), messages: rows.length, missingMedia: missing.length };
  }
}

export async function loadConfig(filename: string): Promise<{ archiveRoot: string; extensionId: string }> {
  const value = JSON.parse(await readFile(filename, 'utf8'));
  assertText(value.archiveRoot, 'archive root', 4096); assertText(value.extensionId, 'extension id', 32);
  if (!/^[a-p]{32}$/.test(value.extensionId) || !path.isAbsolute(value.archiveRoot)) throw new Error('Invalid host configuration');
  return value;
}
