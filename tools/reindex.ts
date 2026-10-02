import { Archive } from '../apps/native-host/archive.ts';
import { normalizeResponse } from '../packages/capture-core/normalize.ts';
import { randomUUID } from 'node:crypto';
import type { Scope } from '../packages/shared/model.ts';
import path from 'node:path';
const archive = await Archive.create(path.resolve('.local/archive'));
try {
  const rows = archive.db.prepare('SELECT m.raw_json,c.scope_json FROM messages m JOIN conversations c ON c.id=m.conversation_id').all();
  let indexed = 0;
  for (const row of rows) {
    const scope = JSON.parse(String(row.scope_json)) as Scope;
    const batch = normalizeResponse(JSON.parse(String(row.raw_json)), scope, 'local-reindex', randomUUID());
    indexed += archive.capture(batch).accepted;
  }
  console.log(JSON.stringify({ indexed, stats: archive.stats() }, null, 2));
} finally { archive.close(); }
