import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Archive } from './archive.ts';
import { normalizeResponse, parseLosslessJson } from '../../packages/capture-core/normalize.ts';
const [op = 'stats', argument, namespace] = process.argv.slice(2);
const archive = await Archive.create(path.resolve('.local/archive'));
try {
  switch (op) {
    case 'stats': console.log(JSON.stringify(archive.stats(), null, 2)); break;
    case 'list': console.log(JSON.stringify(archive.conversations(), null, 2)); break;
    case 'export': console.log(JSON.stringify(await archive.exportConversation(argument ?? '', namespace), null, 2)); break;
    case 'export-customers': console.log(JSON.stringify(await archive.exportCustomers(argument), null, 2)); break;
    case 'import-response': {
      if (!argument || !namespace) throw new Error('Usage: npm run inspect -- import-response <json-file> <project-namespace>');
      const batch = normalizeResponse(parseLosslessJson(await readFile(argument, 'utf8')), { namespace }, 'manual-import', randomUUID());
      if (batch.messages.length > 250 || Buffer.byteLength(JSON.stringify(batch)) > 400_000) throw new Error('Response is too large for manual CLI import; use browser capture chunking');
      console.log(JSON.stringify({ ...archive.capture(batch), warnings: batch.warnings }, null, 2)); break;
    }
    default: throw new Error('Commands: stats, list, export <id> [job-id], export-customers [job-id], import-response <file> <namespace>');
  }
} finally { archive.close(); }
